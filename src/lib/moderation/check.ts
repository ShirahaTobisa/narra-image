import "server-only";

import { db } from "@/lib/db";
import { resolveModerationConfig } from "@/lib/moderation/config";
import { matchSensitiveWords } from "@/lib/moderation/sensitive-words";
import { moderationResponseSchema } from "@/lib/validators";

const MODERATION_TIMEOUT_MS = 8_000;
/** OpenAI 审核接口单张图片上限 */
const MODERATION_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 涉及未成年人的色情：不跟通用阈值走，分数稍高就拒 */
const MINORS_THRESHOLD = 0.02;
/** 24 小时内被上游（OpenAI）拦截达到这个次数，就暂停该用户使用内置渠道 */
const PROVIDER_BLOCK_LIMIT = 3;
const PROVIDER_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;

export const MODERATION_BLOCK_MESSAGE = "提交内容包含违规描述，已拒绝生成";
export const MODERATION_UNAVAILABLE_MESSAGE = "内容审核暂时无法完成，本次未生成，请稍后再试";
export const PROVIDER_COOLDOWN_MESSAGE =
  "近 24 小时内多次被模型方拒绝生成，已暂停使用站内渠道，请稍后再试";

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
  /** 这次会用站内渠道（站长的 key）出图：额外检查该用户最近是否被上游拦截过多次 */
  builtIn?: boolean;
};

export type ModerationCheckResult =
  | { allowed: true }
  | { allowed: false; message: string };

type AiModerationOutcome =
  | { blocked: false }
  | { blocked: true; score: number; category: string | null };

/**
 * 内容审核：敏感词命中或 AI 判定违规 → 记录 ContentReview 并阻断。
 * AI 审核开启时，接口异常、超时或没配好一律拒绝（宁可不出图，也不让没审过的请求打到上游）。
 */
export async function checkGenerationInput(
  input: ModerationCheckInput,
): Promise<ModerationCheckResult> {
  if (input.builtIn && (await countRecentProviderBlocks(input.userId)) >= PROVIDER_BLOCK_LIMIT) {
    return { allowed: false, message: PROVIDER_COOLDOWN_MESSAGE };
  }

  const cfg = await resolveModerationConfig();
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

  // 2. AI 审核：提示词 + 参考图
  const images = input.images ?? [];
  if (cfg.aiEnabled && (input.prompt || images.length > 0)) {
    if (!cfg.aiBaseUrl || !cfg.aiApiKey) {
      console.error("[moderation] AI 审核已开启但缺少接口地址或密钥，拒绝本次生成");
      return { allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE };
    }

    let outcome: AiModerationOutcome;
    try {
      outcome = await callModerationAi(cfg, input.prompt ?? "", images);
    } catch (error) {
      console.error("[moderation] AI 审核异常，拒绝本次生成:", error);
      return { allowed: false, message: MODERATION_UNAVAILABLE_MESSAGE };
    }

    if (outcome.blocked) {
      await db.contentReview.create({
        data: {
          aiModel: cfg.aiModel,
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

/** 该用户 24 小时内用站内渠道出图、被上游内容审核拦下（OpenAI 返回 moderation_blocked）的次数 */
async function countRecentProviderBlocks(userId: string) {
  return db.generationJob.count({
    where: {
      createdAt: { gte: new Date(Date.now() - PROVIDER_BLOCK_WINDOW_MS) },
      OR: [
        { errorMessage: { contains: "moderation_blocked" } },
        { errorMessage: { contains: "safety system" } },
      ],
      providerMode: "BUILT_IN",
      status: "FAILED",
      userId,
    },
  });
}

async function callModerationAi(
  cfg: Awaited<ReturnType<typeof resolveModerationConfig>>,
  text: string,
  images: ModerationImage[],
): Promise<AiModerationOutcome> {
  if (images.some((image) => image.data.byteLength > MODERATION_IMAGE_MAX_BYTES)) {
    throw new Error("参考图超过审核接口 20MB 上限");
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

  const baseUrl = (cfg.aiBaseUrl ?? "").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/moderations`, {
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
    const scores = Object.entries(result.category_scores);
    const [topCategory, topScore] = scores.reduce<readonly [string | null, number]>(
      (top, entry) => (entry[1] > top[1] ? entry : top),
      [null, 0],
    );
    const minorsScore = scores.find(([category]) => category === "sexual/minors")?.[1] ?? 0;

    if (minorsScore >= MINORS_THRESHOLD) {
      return { blocked: true, category: "sexual/minors", score: minorsScore };
    }
    if (result.flagged || topScore >= cfg.aiThreshold) {
      return { blocked: true, category: topCategory, score: topScore };
    }
  }

  return { blocked: false };
}
