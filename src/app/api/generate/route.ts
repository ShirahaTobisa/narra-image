import { randomUUID } from "node:crypto";
import { GenerationStatus, type Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { imageAvailabilityInclude } from "@/lib/storage/image-availability";
import { getEnv } from "@/lib/env";
import { CANVAS_RUN_OPT_IN_HEADER, CanvasContractError, type CanvasRunSubmissionDtoV1 } from "@/lib/canvas/contracts";
import { canvasErrorResponse, canvasJson, requireCanvasOwner } from "@/lib/canvas/http";
import { isCanvasCanonicalDataUrl, readCanvasRunInputs, type CanvasResolvedRunInputs } from "@/lib/canvas/inputs";
import {
  canvasRunResponse, commitCanvasRun, createCanvasRunAttempt, prepareCanvasRunCommit, recoverCanvasRunResponse, rejectCanvasRun, reserveCanvasRun,
  type CanvasRunAttempt, type CanvasRunPreparation,
} from "@/lib/canvas/run-submission";
import { serializeCanvasGeneration } from "@/lib/canvas/runs";
import { canvasTransaction, isCanvasTransactionRetryable } from "@/lib/canvas/transactions";
import { lockImageReferenceEpoch } from "@/lib/storage/image-reference-lock";
import { bindManagedImageInputAliases } from "@/lib/storage/image-input-aliases";
import { projectGenerationSourceUrls } from "@/lib/storage/image-source-presentation";
import {
  GenerationContractError,
  channelSupportsModel,
  generationContractWriteFields,
  getGenerationErrorDefinition,
  normalizeProviderModels,
} from "@/lib/generation/contracts";
import { gifOutputProblem } from "@/lib/generation/gif-output";
import { parseGenerateRequest } from "@/lib/generation/parse-generate-request";
import { calculateGenerationCost, hasEnoughCredits, resolveCreditCost, resolveGenerationCount } from "@/lib/credits";
import {
  serializeGeneration,
  toPrismaGenerationType,
  toPrismaProviderMode,
} from "@/lib/prisma-mappers";
import {
  generationChannelModelSnapshot,
  getGenerationChannelById,
  getGenerationChannelForModel,
} from "@/lib/providers/built-in-provider";
import { decryptProviderSecret, encryptProviderSecret } from "@/lib/providers/provider-secret";
import { requireTurnstile } from "@/lib/auth/turnstile";
import { getCurrentUserRecord, requireCurrentUserRecord } from "@/lib/server/current-user";
import { createRateLimiter } from "@/lib/server/rate-limit";
import { assertGenerationRateLimit } from "@/lib/server/generation-rate-limit";
import { ApiRateLimitError } from "@/lib/api-errors";
import { checkGenerationInput } from "@/lib/moderation/check";
import { getErrorMessage, jsonError, jsonOk } from "@/lib/server/http";
import { assertPublicHttpUrl } from "@/lib/server/safe-remote-url";
import { persistGeneratedImage } from "@/lib/storage/persist-generated-image";
import { failGenerationJobAndRefund } from "@/lib/generation/job-refund";
import { ImageStorageError, type ImageReservation } from "@/lib/storage/image-contract";
import { bindManagedImageOutputs, closeManagedImageReservation, reserveManagedImageOutputs, resolveManagedImageUrl } from "@/lib/storage/managed-image-storage";
import { readCanonicalSiteImage, readSiteImage, SiteImageError } from "@/lib/storage/site-image";

async function assertGenerationPublicHttpUrl(url: string, fieldName: string) {
  try {
    await assertPublicHttpUrl(url);
  } catch {
    throw new Error(`${fieldName}仅支持公网 HTTP(S) 地址`);
  }
}

class GenerationCreditError extends Error {}

// 每人同时最多这么多个没跑完的任务：并发一次塞一堆，会绕过"被拦 3 次就暂停"，也会占满全站队列
const MAX_ACTIVE_JOBS_PER_USER = 2;
// 每个用户每分钟最多发 5 次生成请求（被这条拦下的不算次数），护住上游渠道和审核接口
const MAX_GENERATE_REQUESTS_PER_MINUTE = 5;
const generateRequests = createRateLimiter({ limit: MAX_GENERATE_REQUESTS_PER_MINUTE, windowMs: 60_000 });
const generationInclude = { images: { include: imageAvailabilityInclude }, videos: true } satisfies Prisma.GenerationJobInclude;

async function assertGenerationImageUrl(url: string) {
  const managed = await resolveManagedImageUrl(url);
  if (managed) {
    if (managed.asset.state !== "AVAILABLE" || managed.object?.state !== "READY") throw new ImageStorageError("IMAGE_UNAVAILABLE");
    return;
  }
  await assertGenerationPublicHttpUrl(url, "参考图 URL");
}

export async function POST(request: Request) {
  let jobId: string | null = null;
  const canvasTransport = request.headers.has(CANVAS_RUN_OPT_IN_HEADER);
  let canvasAttempt: CanvasRunAttempt | null = null;
  let canvasPreparation: CanvasRunPreparation | null = null;
  let canvasCommitAttempted = false;
  let canvasCommitted = false;
  let outputReservation: ImageReservation | null = null;
  const reservedJobId = randomUUID();

  async function rejectPreparationResponse(response: Response): Promise<Response> {
    if (canvasPreparation) {
      const rejected = await rejectCanvasRun(canvasPreparation, "CANVAS_RUN_REJECTED");
      if (!rejected) return recoverCanvasRunResponse(canvasPreparation);
      response.headers.set("Cache-Control", "private, no-store");
    }
    return response;
  }

  try {
    const user = canvasTransport ? await getCurrentUserRecord() : await requireCurrentUserRecord();
    if (canvasTransport) await requireCanvasOwner({ getUser: async () => user });
    if (!user) throw new CanvasContractError("CANVAS_UNAUTHENTICATED");
    if (generateRequests.isLimited(user.id)) {
      return jsonError("请求太频繁，请稍后再试", 429);
    }
    generateRequests.record(user.id);
    const body = await parseGenerateRequest(request);
    if (body.canvasRun) {
      canvasAttempt = createCanvasRunAttempt(user.id, body.canvasRun, body.customProvider);
      const reservation = await reserveCanvasRun(canvasAttempt);
      if (reservation.kind === "replay") return canvasRunResponse(reservation.lookup);
      canvasPreparation = reservation.preparation;
    }
    if (body.providerMode === "custom" && !getEnv().CUSTOM_PROVIDER_ENABLED) {
      return rejectPreparationResponse(jsonError("本站暂不支持自填 API，请使用平台渠道", 403));
    }
    if (body.generationType.endsWith("_video") && !getEnv().VIDEO_ENABLED) {
      return rejectPreparationResponse(jsonError("本站暂不支持视频生成", 403));
    }
    const count = resolveGenerationCount({ generationType: body.generationType, count: body.count });
    const gifProblem = gifOutputProblem({ count, model: body.model, outputFormat: body.outputFormat, size: body.size });
    if (gifProblem) {
      return rejectPreparationResponse(jsonError(gifProblem, 400));
    }
    assertGenerationRateLimit(user.id, count);
    await requireTurnstile("generate", body.turnstileToken);

    const fileSourceImages = await Promise.all(
      body.images.map(async (image: File) => ({
        data: Buffer.from(await image.arrayBuffer()),
        fileName: image.name || "source.png",
        mimeType: image.type || "image/png",
      })),
    );

    const canvasInputs = canvasPreparation ? await readCanvasRunInputs(user.id, canvasPreparation.run) : null;
    const referenceUrls = canvasInputs?.sourceImageUrls ?? body.imageUrls;
    const siteReferenceImages = canvasInputs
      ? await Promise.all(referenceUrls.map((url) => readCanonicalSiteImage(url)))
      : body.providerMode === "built_in" ? await Promise.all(referenceUrls.map(async (url) => {
        const image = await readSiteImage(url, user.id);
        if (!image) throw new Error("使用站内渠道时参考图请直接上传，不支持外部图片链接");
        return image;
      })) : [];

    // 内容审核：敏感词 / AI 命中则阻断本次生成（不扣积分、不建 job）；上传的和引用的参考图一起审
    const moderation = await checkGenerationInput({
      builtIn: body.providerMode === "built_in",
      images: [...fileSourceImages, ...siteReferenceImages],
      negativePrompt: body.negativePrompt,
      prompt: body.prompt,
      userId: user.id,
    });
    if (!moderation.allowed) {
      return rejectPreparationResponse(jsonError(moderation.message, 400));
    }
    const env = getEnv();

    // 用户看不到渠道，走哪条由服务器按后台排序定；只有管理员能指定渠道（防止有人专挑兜底渠道用）
    const channelId = user.role === "ADMIN" ? (body.channelId as string | undefined) : undefined;
    const builtInProvider = body.providerMode === "built_in"
      ? channelId
        ? await getGenerationChannelById(channelId, body.model)
        : await getGenerationChannelForModel(body.model)
      : null;

    const builtInCreditCost = resolveCreditCost({
      generationType: body.generationType,
      imageCreditCost:
        builtInProvider?.creditCost ?? env.BUILTIN_PROVIDER_CREDIT_COST,
      videoCreditCost:
        builtInProvider?.videoCreditCost ?? env.BUILTIN_PROVIDER_VIDEO_CREDIT_COST,
    });

    const cost = calculateGenerationCost({
      builtInCreditCost,
      count,
      providerMode: body.providerMode,
    });

    if (
      body.providerMode === "built_in" &&
      !hasEnoughCredits({
        builtInCreditCost,
        count,
        credits: user.credits,
        providerMode: body.providerMode,
      })
    ) {
      return rejectPreparationResponse(jsonError("积分不足，请联系管理员补充", 402));
    }

    let customProvider = body.customProvider ?? null;
    let customProviderRemember = body.customProvider?.remember ?? false;
    let customProviderModels = body.customProvider?.models ?? [];
    if (body.providerMode === "custom" && !customProvider) {
      const saved = await db.savedProviderConfig.findUnique({
        where: { userId: user.id },
      });

      if (!saved) {
        return rejectPreparationResponse(jsonError("请先填写自填渠道配置", 400));
      }

      customProvider = {
        apiKey: await decryptProviderSecret(
          saved.apiKeyEncrypted,
          env.AUTH_SECRET,
        ),
        baseUrl: saved.baseUrl,
        label: saved.label,
        model: body.model || saved.model,
        models: saved.models,
        remember: true,
      };
      customProviderRemember = true;
      customProviderModels = saved.models;
    }

    if (body.providerMode === "custom" && customProvider && !channelSupportsModel({
      defaultModel: customProvider.model,
      model: body.model,
      models: customProviderModels,
    })) {
      throw new GenerationContractError("MODEL_NOT_SUPPORTED_BY_CHANNEL");
    }

    // 此处做入队前校验；Worker 仍需对实际请求和重定向目标重复校验。
    const urlChecks = (body.providerMode === "built_in" && !canvasInputs ? [] : referenceUrls)
      .filter((url) => !canvasInputs || !isCanvasCanonicalDataUrl(url))
      .map((url) => assertGenerationImageUrl(url));
    if (body.providerMode === "custom" && customProvider) {
      urlChecks.push(
        assertGenerationPublicHttpUrl(customProvider.baseUrl, "自填渠道 Base URL"),
      );
    }
    await Promise.all(urlChecks);

    const inputConversationId = body.conversationId as string | undefined;
    let conversationToBind: string | null = null;
    if (inputConversationId) {
      const owned = await db.conversation.findFirst({
        where: { id: inputConversationId, userId: user.id },
        select: { id: true, generations: { select: { id: true }, take: 1 } },
      });
      if (!owned) {
        return jsonError("会话不存在或不属于当前用户", 400);
      }
      conversationToBind = owned.id;
    }

    const customProviderApiKeyEncrypted = customProvider
      ? await encryptProviderSecret(customProvider.apiKey, env.AUTH_SECRET)
      : null;

    const reserveOutputs = async () => {
      if (body.generationType === "text_to_image" || body.generationType === "image_to_image") {
        outputReservation = await reserveManagedImageOutputs({
          ownerId: user.id,
          intentKey: canvasPreparation ? `canvas-output:${canvasPreparation.run.runId}:${canvasPreparation.intentHash}` : `output:${reservedJobId}`,
          count,
        });
      }
    };
    if (canvasPreparation) await reserveOutputs();

    const contractFields = generationContractWriteFields(
      env.WORKER_CONTRACTS_V1_ENABLED,
    );

    // 普通网页先占名额、扣费；参考图准备好之前 Worker 不得领取。
    // Canvas 沿用自己的原子 run 提交，不经过普通文件上传。
    const preparation = canvasPreparation;
    const createJob = async (tx: Prisma.TransactionClient) => {
      if (!preparation) {
        await lockImageReferenceEpoch(tx);
        await tx.$executeRaw`SELECT 1 FROM "User" WHERE id = ${user.id} FOR UPDATE`;
        const currentUser = await tx.user.findUnique({ where: { id: user.id }, select: { bannedAt: true, credits: true } });
        if (!currentUser || currentUser.bannedAt) throw new Error("账号不可用，请重新登录");
        if (body.providerMode === "built_in" && currentUser.credits < cost) throw new GenerationCreditError("积分不足，请联系管理员补充");
        if (conversationToBind && !await tx.conversation.findFirst({ where: { id: conversationToBind, userId: user.id }, select: { id: true } })) {
          throw new Error("会话不存在或不属于当前用户");
        }
        const activeJobs = await tx.generationJob.count({
          where: { status: { in: [GenerationStatus.PENDING, GenerationStatus.PROCESSING] }, userId: user.id },
        });
        if (activeJobs >= MAX_ACTIVE_JOBS_PER_USER) {
          throw new Error(`同时最多 ${MAX_ACTIVE_JOBS_PER_USER} 个任务在生成，请等前面的完成后再提交`);
        }
      }
      let currentInputs: CanvasResolvedRunInputs | null = null;
      if (preparation && canvasInputs) currentInputs = await prepareCanvasRunCommit(tx, preparation, canvasInputs);
      const committedSourceUrls = currentInputs?.sourceImageUrls ?? body.imageUrls;
      await bindManagedImageInputAliases(tx, committedSourceUrls, env.APP_URL);
      const created = await tx.generationJob.create({
        data: {
          ...(outputReservation || !preparation ? { id: reservedJobId } : {}),
          ...(conversationToBind ? { conversationId: conversationToBind } : {}),
          count,
          contractVersion: contractFields.contractVersion,
          creditsSpent: body.providerMode === "built_in" ? cost : 0,
          generationType: toPrismaGenerationType(body.generationType),
          durationSeconds: body.durationSeconds ?? null,
          aspectRatio: body.aspectRatio ?? null,
          model: body.model,
          negativePrompt: body.negativePrompt,
          outputCompression: body.outputCompression,
          outputFormat: body.outputFormat,
          prompt: body.prompt,
          providerApiKeyEncrypted:
            body.providerMode === "custom" ? customProviderApiKeyEncrypted : null,
          providerBaseUrl:
            body.providerMode === "custom" ? customProvider?.baseUrl ?? null : null,
          providerChannelId:
            body.providerMode === "built_in" ? builtInProvider?.id ?? null : null,
          providerLabel:
            body.providerMode === "custom" ? customProvider?.label ?? null : null,
          providerModels:
            body.providerMode === "custom"
              ? normalizeProviderModels(customProvider?.model ?? body.model, customProviderModels)
              : generationChannelModelSnapshot(builtInProvider!),
          providerMode: toPrismaProviderMode(body.providerMode),
          providerRemember:
            body.providerMode === "custom" ? customProviderRemember : false,
          quality: body.quality,
          moderation: body.moderation,
          seed: body.seed,
          size: body.size,
          sourceImageUrls: committedSourceUrls,
          status: GenerationStatus.PENDING,
          handoffState: contractFields.handoffState,
          userId: user.id,
          workerManaged: Boolean(preparation),
        },
        include: generationInclude,
      });

      await bindManagedImageOutputs(tx, outputReservation, user.id, created.id);

      if (body.replaceGenerationId && conversationToBind) {
        await tx.generationJob.updateMany({
          where: {
            conversationId: conversationToBind,
            id: body.replaceGenerationId,
            status: GenerationStatus.FAILED,
            userId: user.id,
          },
          data: {
            conversationId: null,
          },
        });
      }

      if (conversationToBind) {
        // 触发 updatedAt 刷新；若是会话内首条 generation，把 prompt 截前 30 字符作为 title 默认。
        const existingCount = await tx.generationJob.count({
          where: { conversationId: conversationToBind, NOT: { id: created.id } },
        });
        const updateData: { updatedAt: Date; title?: string } = { updatedAt: new Date() };
        if (existingCount === 0 && body.prompt) {
          updateData.title = body.prompt.slice(0, 30);
        }
        await tx.conversation.update({
          where: { id: conversationToBind },
          data: updateData,
        });
      }

      if (body.providerMode === "built_in" && cost > 0) {
        const charged = await tx.user.updateMany({
          where: { id: user.id, credits: { gte: cost } },
          data: { credits: { decrement: cost } },
        });
        if (charged.count === 0) {
          throw new GenerationCreditError("积分不足，请联系管理员补充");
        }
      }

      if (preparation) await commitCanvasRun(tx, preparation, created.id);
      // Project browser references before committing. A failed read must not
      // enter the post-commit error/refund path for an already-created job.
      return (await projectGenerationSourceUrls([created], tx))[0];
    };
    if (preparation) canvasCommitAttempted = true;
    else jobId = reservedJobId;
    const job = preparation ? await canvasTransaction(createJob) : await db.$transaction(createJob);
    if (preparation) {
      canvasCommitted = true;
      return canvasJson({
        generation: serializeCanvasGeneration(job),
        canvasRun: { canvasId: preparation.run.canvasId, nodeId: preparation.run.nodeId, runId: preparation.run.runId, jobId: job.id },
      } satisfies CanvasRunSubmissionDtoV1);
    }
    jobId = job.id;

    await reserveOutputs();
    const uploadedUrls = await Promise.all(fileSourceImages.map((sourceImage) => persistGeneratedImage({
      buffer: sourceImage.data,
      fileExtension: sourceImage.fileName.split(".").pop() || "png",
      mimeType: sourceImage.mimeType,
      userId: user.id,
    })));
    let fileIndex = 0;
    let urlIndex = 0;
    const sourceImageUrls = body.imageInputOrder?.length
      ? body.imageInputOrder.map((kind) => kind === "file" ? uploadedUrls[fileIndex++] : body.imageUrls[urlIndex++])
      : [...uploadedUrls, ...body.imageUrls];
    const readyJob = await db.$transaction(async (tx) => {
      await lockImageReferenceEpoch(tx);
      const currentUser = await tx.user.findUnique({ where: { id: user.id }, select: { bannedAt: true } });
      if (!currentUser || currentUser.bannedAt) throw new Error("账号不可用，请重新登录");
      await bindManagedImageInputAliases(tx, sourceImageUrls, env.APP_URL);
      const enabled = await tx.generationJob.updateMany({
        where: { id: job.id, userId: user.id, status: GenerationStatus.PENDING, workerManaged: false, refundAppliedAt: null, cancelRequestedAt: null },
        data: { sourceImageUrls, workerManaged: true },
      });
      if (enabled.count === 0) throw new Error("任务已取消或结束，请重新提交");
      await bindManagedImageOutputs(tx, outputReservation, user.id, job.id);
      const ready = await tx.generationJob.findUniqueOrThrow({ where: { id: job.id }, include: generationInclude });
      return (await projectGenerationSourceUrls([ready], tx))[0];
    });
    return jsonOk({
      generation: serializeGeneration(readyJob),
    });
  } catch (error) {
    if (!jobId) await closeManagedImageReservation(outputReservation).catch(() => undefined);
    if (canvasAttempt) {
      const knownRollback = error instanceof CanvasContractError || error instanceof GenerationCreditError || error instanceof ApiRateLimitError || error instanceof ImageStorageError || error instanceof SiteImageError || isCanvasTransactionRetryable(error);
      if (canvasCommitted || (canvasCommitAttempted && !knownRollback)
        || (!canvasPreparation && !(error instanceof CanvasContractError))) {
        return recoverCanvasRunResponse(canvasAttempt);
      }
      if (canvasPreparation) {
        const rejected = await rejectCanvasRun(canvasPreparation, error instanceof CanvasContractError ? error.code : "CANVAS_RUN_REJECTED");
        if (!rejected) return recoverCanvasRunResponse(canvasAttempt);
      }
      if (error instanceof GenerationCreditError || error instanceof ApiRateLimitError) {
        const response = jsonError(error.message, error instanceof ApiRateLimitError ? error.status : 402);
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      }
      if (error instanceof GenerationContractError) {
        const response = jsonError(getGenerationErrorDefinition(error.code).userMessage, error.status, error.code);
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      }
      if (error instanceof ImageStorageError || error instanceof SiteImageError) {
        const response = jsonError(error.message, error.status, error instanceof ImageStorageError ? error.code : undefined);
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      }
      return canvasErrorResponse(error instanceof CanvasContractError ? error : new CanvasContractError("CANVAS_RUN_REJECTED"));
    }
    if (error instanceof ApiRateLimitError) return jsonError(error.message, error.status);
    if (canvasTransport || error instanceof CanvasContractError) return canvasErrorResponse(error);
    if (jobId) {
      const failed = await failGenerationJobAndRefund({
        errorMessage: getErrorMessage(error),
        jobId,
        onlyUnmanagedPending: true,
      });
      // 启用事务的回执可能丢失；已经交给 Worker 的任务保留积分和输出预留。
      if (!("blockedByWorkerState" in failed && failed.blockedByWorkerState)) {
        await closeManagedImageReservation(outputReservation).catch(() => undefined);
      }
    }

    if (error instanceof GenerationCreditError) return jsonError(error.message, 402);
    if (error instanceof GenerationContractError) {
      return jsonError(error.message, error.status, error.code);
    }
    if (error instanceof ImageStorageError) return jsonError(error.message, error.status, error.code);
    if (error instanceof SiteImageError) return jsonError(error.message, error.status);
    return jsonError(getErrorMessage(error), 400);
  }
}
