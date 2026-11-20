import "server-only";

import { db } from "@/lib/db";
import { resolveModerationConfig } from "@/lib/moderation/config";
import { assertModerationImages } from "@/lib/moderation/images";
import { checkLocalImages } from "@/lib/moderation/local-images";
import { matchSensitiveWords } from "@/lib/moderation/sensitive-words";
import { moderationResponseSchema } from "@/lib/validators";

const MODERATION_TIMEOUT_MS = 8_000;
/** 站内 NSFW 的保守拒绝策略，不代表模型分数已经校准为风险概率。 */
const BUILT_IN_SEXUAL_THRESHOLD = 0.2;
/** 涉及未成年人的色情：不跟通用阈值走，分数稍高就拒 */
const MINORS_THRESHOLD = 0.02;
/** 站内审核和上游安全拒绝合计达到上限，暂停后续站内提交。 */
const MODERATION_BLOCK_LIMIT = 3;
const MODERATION_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

export const MODERATION_BLOCK_MESSAGE = "提交内容包含违规描述，已拒绝生成";
export const MODERATION_UNAVAILABLE_MESSAGE = "内容审核暂时无法完成，本次未生成，请稍后再试";
export const PROVIDER_COOLDOWN_MESSAGE =
  "近 24 小时内站内内容审核或模型方安全审核累计拒绝已达 3 次，已暂停提交，请稍后再试";

export type ModerationImage = {
  data: Buffer | Uint8Array;
  mimeType: string;
};

type ModerationCheckInput = {
  userId: string;
  prompt?: string | null;
  negativePrompt?: string | null;
  /** 参考图原始字节（上传的文件、API 请求里带的图），和提示词一起送审 */
  images?: ModerationImage[];
  /** 站内强制审核：必须完成 AI 审核，且检查用户最近的内容拒绝次数 */
  builtIn?: boolean;
};

export type ModerationCheckResult =
  | { allowed: true }
  | { allowed: false; message: string };

type AiModerationOutcome =
  | { blocked: false }
  | { blocked: true; score: number; category: string | null; model?: string };

/**
 * 内容审核：敏感词命中或 AI 判定违规 → 记录 ContentReview 并阻断。
 * AI 审核开启时，接口异常、超时或没配好一律拒绝（宁可不出图，也不让没审过的请求打到上游）。
 */
export async function checkGenerationInput(
  input: ModerationCheckInput,
): Promise<ModerationCheckResult> {
  let cfg: Awaited<ReturnType<typeof resolveModerationConfig>>;
  try {
    if (input.builtIn && (await countRecentModerationBlocks(input.userId)) >= MODERATION_BLOCK_LIMIT) {
      return { allowed: false, message: PROVIDER_COOLDOWN_MESSAGE };
    }
    cfg = await resolveModerationConfig();
  } catch {
    console.error("[moderation] 无法读取审核配置或违规记录，拒绝本次提交");
    return { allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE };
  }
  if (input.builtIn && (!cfg.isEnabled || !cfg.aiEnabled)) {
    return { allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE };
  }
  if (!cfg.isEnabled) {
    return { allowed: true };
  }

  // 1. 敏感词
  if (cfg.sensitiveWordsEnabled) {
    const hits = matchSensitiveWords(input.prompt, input.negativePrompt);
    if (hits.length > 0) {
      await db.contentReview.create({
        data: {
          category: hits[0]?.category ?? null,
          hitWords: Array.from(new Set(hits.map((hit) => hit.word))),
          kind: "sensitive_word",
          negativePrompt: input.negativePrompt || null,
          prompt: input.prompt ?? "",
          userId: input.userId,
        },
      });
      return { allowed: false, message: MODERATION_BLOCK_MESSAGE };
    }
  }

  // 2. AI 审核覆盖实际输入，负面提示词保留“排除内容”的含义。
  const text = input.negativePrompt
    ? `Prompt:\n${input.prompt ?? ""}\n\nNegative prompt (content to avoid):\n${input.negativePrompt}`
    : input.prompt ?? "";
  const images = input.images ?? [];
  if (input.builtIn && !text && images.length === 0) {
    return { allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE };
  }
  if (cfg.aiEnabled && (text || images.length > 0)) {
    if (!cfg.aiBaseUrl?.trim() || !cfg.aiApiKey?.trim()
      || (input.builtIn && !cfg.aiModel?.trim())
      || !Number.isFinite(cfg.aiThreshold) || cfg.aiThreshold < 0 || cfg.aiThreshold > 1) {
      console.error("[moderation] AI 审核配置无效，拒绝本次生成");
      return { allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE };
    }

    let outcome: AiModerationOutcome;
    try {
      outcome = await callModerationAi(cfg, text, images, input.builtIn === true);
    } catch {
      console.error("[moderation] AI 审核未完成，拒绝本次生成");
      return { allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE };
    }

    if (outcome.blocked) {
      await db.contentReview.create({
        data: {
          aiModel: outcome.model ?? cfg.aiModel,
          aiScore: outcome.score,
          category: outcome.category,
          kind: "ai_moderation",
          negativePrompt: input.negativePrompt || null,
          prompt: input.prompt ?? "",
          userId: input.userId,
        },
      });
      return { allowed: false, message: MODERATION_BLOCK_MESSAGE };
    }
  }

  return { allowed: true };
}

export class ModerationBlockedError extends Error {
  readonly code = "content_policy_violation";
  readonly status = 400;
}

/**
 * 开发者 API 的两条出图路径（直接建任务 / 走 Go 网关）都在建任务前调用这里，
 * 所以 /v1 下所有能出图的接口都会过审，新加接口也不会漏。
 */
export async function assertExternalGenerationAllowed(
  userId: string,
  input: { prompt: string; negativePrompt?: string | null; sourceImages?: ModerationImage[] },
) {
  const result = await checkGenerationInput({
    builtIn: true,
    images: input.sourceImages,
    negativePrompt: input.negativePrompt,
    prompt: input.prompt,
    userId,
  });
  if (!result.allowed) {
    throw new ModerationBlockedError(result.message);
  }
}

/** 预审拒绝后不建生成任务，两个来源不会重复记录同一次生成；故障不计入。 */
async function countRecentModerationBlocks(userId: string) {
  const createdAt = { gte: new Date(Date.now() - MODERATION_BLOCK_WINDOW_MS) };
  const [siteBlocks, providerBlocks] = await Promise.all([
    db.contentReview.count({
      where: { createdAt, kind: { in: ["sensitive_word", "ai_moderation"] }, userId },
    }),
    db.generationJob.count({
      where: {
        createdAt,
        OR: [
          { errorMessage: { contains: "moderation_blocked", mode: "insensitive" } },
          { errorMessage: { contains: "content_policy_violation", mode: "insensitive" } },
          { errorMessage: { contains: "safety system", mode: "insensitive" } },
        ],
        providerMode: "BUILT_IN",
        status: "FAILED",
        userId,
      },
    }),
  ]);
  return siteBlocks + providerBlocks;
}

async function callModerationAi(
  cfg: Awaited<ReturnType<typeof resolveModerationConfig>>,
  text: string,
  images: ModerationImage[],
  builtIn: boolean,
): Promise<AiModerationOutcome> {
  await assertModerationImages(images);
  if (images.length > 0) {
    const outcome = await checkLocalImages(images);
    if (outcome.blocked) return outcome;
  }

  const url = new URL(`${cfg.aiBaseUrl?.trim().replace(/\/+$/, "")}/moderations`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("审核接口地址无效");
  }
  const input = images.length === 0
    ? text
    : [
        ...(text ? [{ text, type: "text" }] : []),
        ...images.map((image) => ({
          image_url: {
            url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
          },
          type: "image_url",
        })),
      ];

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.aiApiKey ? { Authorization: `Bearer ${cfg.aiApiKey}` } : {}),
    },
    body: JSON.stringify({
      input,
      ...(cfg.aiModel ? { model: cfg.aiModel } : {}),
    }),
    signal: AbortSignal.timeout(MODERATION_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `moderation request failed: ${response.status}`,
    );
  }

  const data = moderationResponseSchema.parse(await response.json());

  for (const result of data.results) {
    const appliedTypes = result.category_applied_input_types;
    // 旧纯文本接口可不返回覆盖字段；明确返回时必须覆盖所有文本分类。
    if ((images.length > 0 && !appliedTypes?.sexual?.includes("image"))
      || (text && appliedTypes && (!appliedTypes.sexual?.includes("text")
        || !appliedTypes["sexual/minors"]?.includes("text")))) {
      throw new Error("审核结果未覆盖全部输入类型");
    }
    const scores = Object.entries(result.category_scores);
    const [topCategory, topScore] = scores.reduce<readonly [string | null, number]>(
      (top, entry) => (entry[1] > top[1] ? entry : top),
      [null, 0],
    );
    const minorsScore = result.category_scores["sexual/minors"];

    if (minorsScore >= MINORS_THRESHOLD) {
      return { blocked: true, category: "sexual/minors", score: minorsScore };
    }
    const flaggedCategory = Object.entries(result.categories).find(([, flagged]) => flagged)?.[0];
    if (flaggedCategory) {
      return { blocked: true, category: flaggedCategory, score: result.category_scores[flaggedCategory] ?? topScore };
    }
    if (builtIn && result.category_scores.sexual >= Math.min(cfg.aiThreshold, BUILT_IN_SEXUAL_THRESHOLD)) {
      return { blocked: true, category: "sexual", score: result.category_scores.sexual };
    }
    if (result.flagged || topScore >= cfg.aiThreshold) {
      return { blocked: true, category: topCategory, score: topScore };
    }
  }

  return { blocked: false };
}
