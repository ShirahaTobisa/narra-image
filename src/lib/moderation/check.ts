import "server-only";

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { resolveModerationConfig } from "@/lib/moderation/config";
import { assertModerationImages } from "@/lib/moderation/images";
import { checkLocalImages } from "@/lib/moderation/local-images";
import { matchSensitiveWords } from "@/lib/moderation/sensitive-words";
import { moderationResponseSchema } from "@/lib/validators";

const MODERATION_TIMEOUT_MS = 8_000;
/** 站内审核和上游安全拒绝合计达到上限，暂停后续站内提交。 */
export const MODERATION_BLOCK_LIMIT = 3;
const MODERATION_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 本站自己拒绝时记下的两类记录。 */
const SITE_BLOCK_KINDS = ["sensitive_word", "ai_moderation"];
/** 上游拒绝：过了本站审核、被出图渠道以内容审核为由拒掉的任务。 */
export const PROVIDER_REFUSAL_WHERE = {
  OR: [
    { errorMessage: { contains: "moderation_blocked", mode: "insensitive" } },
    { errorMessage: { contains: "content_policy_violation", mode: "insensitive" } },
    { errorMessage: { contains: "safety system", mode: "insensitive" } },
  ],
  providerMode: "BUILT_IN",
  status: "FAILED",
} satisfies Prisma.GenerationJobWhereInput;

export const SENSITIVE_WORD_BLOCK_MESSAGE = "关键词拦截：提交内容命中了本站敏感词，已拒绝生成";
export const AI_BLOCK_MESSAGE = "AI 审核拦截：提交内容被本站 AI 审核判定违规，已拒绝生成";
/** 本站明确拒绝（不是审核出故障）时给用户的两种提示；上游拒绝的那一句在 prisma-mappers.ts。 */
export const MODERATION_BLOCK_MESSAGES: readonly string[] = [SENSITIVE_WORD_BLOCK_MESSAGE, AI_BLOCK_MESSAGE];
export const MODERATION_UNAVAILABLE_MESSAGE = "内容审核暂时无法完成，本次未生成，请稍后再试";
export const PROVIDER_COOLDOWN_MESSAGE =
  "近 24 小时内站内内容审核或模型方安全审核累计拒绝已达 3 次，已暂停提交，请稍后再试";
export const MANUAL_PAUSE_MESSAGE = "管理员已暂停该账号的站内提交，如有疑问请联系管理员";

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
    const paused = input.builtIn ? await pauseMessage(input.userId) : null;
    if (paused) {
      return { allowed: false, message: paused };
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
      return { allowed: false, message: SENSITIVE_WORD_BLOCK_MESSAGE };
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
      outcome = await callModerationAi(cfg, text, images);
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
      return { allowed: false, message: AI_BLOCK_MESSAGE };
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

/**
 * 这个人现在被暂停提交就返回给他看的提示，否则返回 null。管理员手动暂停的直接拦；
 * 其余数最近 24 小时被拒的次数，管理员解除暂停之前的不算。
 * 预审拒绝后不建生成任务，两个来源不会重复记录同一次生成；故障不计入。
 */
async function pauseMessage(userId: string) {
  const user = await db.user.findUnique({ select: { generationPausedAt: true, moderationClearedAt: true }, where: { id: userId } });
  if (user?.generationPausedAt) return MANUAL_PAUSE_MESSAGE;
  const windowStart = new Date(Date.now() - MODERATION_BLOCK_WINDOW_MS);
  const cleared = user?.moderationClearedAt;
  const createdAt = { gte: cleared && cleared > windowStart ? cleared : windowStart };
  const [siteBlocks, providerBlocks] = await Promise.all([
    db.contentReview.count({ where: { createdAt, kind: { in: SITE_BLOCK_KINDS }, userId } }),
    db.generationJob.count({ where: { ...PROVIDER_REFUSAL_WHERE, createdAt, userId } }),
  ]);
  return siteBlocks + providerBlocks >= MODERATION_BLOCK_LIMIT ? PROVIDER_COOLDOWN_MESSAGE : null;
}

/**
 * 后台违规榜：本站拒绝和上游拒绝按人合计，暂停判断同上。暂停中的（手动暂停，或最近 24 小时满
 * MODERATION_BLOCK_LIMIT 次）排最前，管理员要先看的是他们；其余按累计次数排。
 * 手动暂停的人即使一条拦截记录都没有也要列出来，不然没地方解除。
 */
export async function listModerationOffenders(limit: number) {
  const windowStart = new Date(Date.now() - MODERATION_BLOCK_WINDOW_MS);
  const createdAt = { gte: windowStart };
  const [site, provider, recentSite, recentProvider, overrides] = await Promise.all([
    db.contentReview.groupBy({ _count: { _all: true }, _max: { createdAt: true }, by: ["userId"] }),
    db.generationJob.groupBy({ _count: { _all: true }, _max: { createdAt: true }, by: ["userId"], where: PROVIDER_REFUSAL_WHERE }),
    db.contentReview.findMany({ select: { createdAt: true, userId: true }, where: { createdAt, kind: { in: SITE_BLOCK_KINDS } } }),
    db.generationJob.findMany({ select: { createdAt: true, userId: true }, where: { ...PROVIDER_REFUSAL_WHERE, createdAt } }),
    db.user.findMany({
      select: { generationPausedAt: true, id: true, moderationClearedAt: true },
      where: { OR: [{ generationPausedAt: { not: null } }, { moderationClearedAt: { gte: windowStart } }] },
    }),
  ]);
  const offenders = new Map<string, { count: number; lastAt: Date | null; manual: boolean; recentCount: number; userId: string }>();
  const entry = (userId: string) => {
    if (!offenders.has(userId)) offenders.set(userId, { count: 0, lastAt: null, manual: false, recentCount: 0, userId });
    return offenders.get(userId)!;
  };
  for (const group of [...site, ...provider]) {
    const offender = entry(group.userId);
    offender.count += group._count._all;
    const lastAt = group._max.createdAt;
    if (lastAt && (!offender.lastAt || lastAt > offender.lastAt)) offender.lastAt = lastAt;
  }
  const clearedAt = new Map(overrides.map((user) => [user.id, user.moderationClearedAt]));
  for (const block of [...recentSite, ...recentProvider]) {
    const cleared = clearedAt.get(block.userId);
    if (!cleared || block.createdAt >= cleared) entry(block.userId).recentCount += 1;
  }
  for (const user of overrides) {
    if (user.generationPausedAt) entry(user.id).manual = true;
  }
  return [...offenders.values()]
    .map((offender) => ({ ...offender, paused: offender.manual || offender.recentCount >= MODERATION_BLOCK_LIMIT }))
    .sort((a, b) => Number(b.paused) - Number(a.paused) || b.count - a.count)
    .slice(0, limit);
}

async function callModerationAi(
  cfg: Awaited<ReturnType<typeof resolveModerationConfig>>,
  text: string,
  images: ModerationImage[],
): Promise<AiModerationOutcome> {
  await assertModerationImages(images);
  if (images.length === 0) return requestModeration(cfg, text);
  const local = await checkLocalImages(images, cfg.aiThreshold);
  if (local.blocked) return local;
  // 文字跟图一起审时分数会被拉低（实测同一段话单独 0.11、带图 0.02），所以先单独审一遍文字。
  if (text) {
    const textAlone = await requestModeration(cfg, text);
    if (textAlone.blocked) return textAlone;
  }
  // 审核接口一次请求最多收 1 张图（两张就报 400，整次提交会被当成审核故障拒掉），
  // 多张参考图逐张带着文字送，任何一张该拒就拒。
  const outcomes = await Promise.all(images.map((image) => requestModeration(cfg, text, image)));
  return outcomes.find((outcome) => outcome.blocked) ?? { blocked: false };
}

/** 向审核接口发一次请求：纯文字，或文字带一张图。 */
async function requestModeration(
  cfg: Awaited<ReturnType<typeof resolveModerationConfig>>,
  text: string,
  image?: ModerationImage,
): Promise<AiModerationOutcome> {
  const url = new URL(`${cfg.aiBaseUrl?.trim().replace(/\/+$/, "")}/moderations`);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("审核接口地址无效");
  }
  const input = !image
    ? text
    : [
        ...(text ? [{ text, type: "text" }] : []),
        {
          image_url: {
            url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
          },
          type: "image_url",
        },
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
    if ((image && !appliedTypes?.sexual?.includes("image"))
      || (text && appliedTypes && (!appliedTypes.sexual?.includes("text")
        || !appliedTypes["sexual/minors"]?.includes("text")))) {
      throw new Error("审核结果未覆盖全部输入类型");
    }
    const scores = Object.entries(result.category_scores);
    const [topCategory, topScore] = scores.reduce<readonly [string | null, number]>(
      (top, entry) => (entry[1] > top[1] ? entry : top),
      [null, 0],
    );

    // 涉及未成年人的色情不跟阈值走：审核模型自己判定属于这一类就拒。
    // 固定分数线试过 0.02，开站当晚连成年角色的描述也拒；模型自己的判定线实测在 0.1～0.2 之间。
    if (result.categories["sexual/minors"]) {
      return { blocked: true, category: "sexual/minors", score: result.category_scores["sexual/minors"] };
    }
    // 其余分类只看分数：没到后台设的阈值就放行，审核模型自己的标记不另算。
    if (topScore >= cfg.aiThreshold) {
      return { blocked: true, category: topCategory, score: topScore };
    }
  }

  return { blocked: false };
}
