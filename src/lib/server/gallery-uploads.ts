import "server-only";

import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { User } from "@prisma/client";

import { readCanvasBody } from "@/lib/canvas/body-limit";
import { db } from "@/lib/db";
import { checkGenerationInput } from "@/lib/moderation/check";
import { createRateLimiter } from "@/lib/server/rate-limit";
import { lockImageReferenceEpoch } from "@/lib/storage/image-reference-lock";
import { abandonPreparedImageWrite, completeManagedImageWrite, prepareManagedImageWrite } from "@/lib/storage/managed-image-storage";
import { ImageStorageError } from "@/lib/storage/image-contract";
import { ImageRepository } from "@/lib/storage/image-repository";
import { serializeGalleryWork, galleryWorkInclude } from "@/lib/server/gallery-work-data";
import type { AdminWorkReviewAction, UserWorkShowcaseAction } from "@/lib/work-showcase";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const LIMITER_KEY = Symbol.for("narra.gallery-upload-rate-limit");
const uploadFields = z.object({
  requestKey: z.string().uuid(),
  prompt: z.string().trim().max(10_000).default(""),
  negativePrompt: z.string().trim().max(1000).default(""),
  showPromptPublic: z.enum(["true", "false"]).default("false"),
  showAuthorPublic: z.enum(["true", "false"]).default("false"),
}).strict();

export class GalleryUploadError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export function assertGalleryUploadRateLimit(userId: string) {
  const limiters = globalThis as unknown as Record<symbol, ReturnType<typeof createRateLimiter> | undefined>;
  const limiter = limiters[LIMITER_KEY] ??= createRateLimiter({ limit: 5, windowMs: 60_000 });
  if (!limiter.tryRecord(userId)) throw new GalleryUploadError("每分钟最多上传 5 次，请稍后再试", 429);
}

export async function readGalleryUpload(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType) || contentType.length > 256) throw new GalleryUploadError("请上传图片文件");
  const body = await readCanvasBody(request, MAX_FILE_BYTES + 64 * 1024);
  const form = await new Response(new Uint8Array(body), { headers: { "Content-Type": contentType } }).formData();
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (form.getAll(key).length !== 1) throw new GalleryUploadError("投稿字段重复");
    if (key !== "file") {
      if (typeof value !== "string") throw new GalleryUploadError("投稿字段无效");
      fields[key] = value;
    }
  }
  const input = uploadFields.parse(fields);
  const file = form.get("file");
  if (!file || typeof file === "string" || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new GalleryUploadError("只能上传 PNG、JPG 或 WebP 图片");
  }
  if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new GalleryUploadError("图片不能超过 20MB", 413);
  return { ...input, bytes: Buffer.from(await file.arrayBuffer()), mimeType: file.type };
}

type GalleryUpload = Awaited<ReturnType<typeof readGalleryUpload>>;
type UploadUser = Pick<User, "id" | "nickname">;

function matchingUpload<T extends { payloadHash: string }>(work: T, payloadHash: string): T {
  if (work.payloadHash !== payloadHash) throw new GalleryUploadError("这次提交和上一次内容不一样，请重新提交", 409);
  return work;
}

/** Only a confirmed original upload can become a gallery work; no generation or credit writes. */
export async function submitGalleryUpload(user: UploadUser, input: GalleryUpload) {
  const publicAuthorName = input.showAuthorPublic === "true" ? user.nickname?.trim() || null : null;
  if (input.showAuthorPublic === "true" && !publicAuthorName) throw new GalleryUploadError("请先设置昵称，或选择匿名投稿");
  const snapshot = { prompt: input.prompt, negativePrompt: input.negativePrompt,
    showPromptPublic: input.showPromptPublic === "true", publicAuthorName };
  const payloadHash = createHash("sha256").update(JSON.stringify(snapshot)).update("\0").update(input.mimeType).update("\0").update(input.bytes).digest("hex");
  const unique = { userId_requestKey: { userId: user.id, requestKey: input.requestKey } };
  const existing = await db.galleryWork.findUnique({ where: unique, include: galleryWorkInclude });
  if (existing) return serializeGalleryWork(matchingUpload(existing, payloadHash));

  const moderation = await checkGenerationInput({
    builtIn: true, userId: user.id, images: [{ data: input.bytes, mimeType: input.mimeType }],
    prompt: [input.prompt, publicAuthorName ? `Public author name:\n${publicAuthorName}` : ""].filter(Boolean).join("\n\n"),
    negativePrompt: input.negativePrompt,
  });
  if (!moderation.allowed) throw new GalleryUploadError(moderation.message);
  const dimensions = await sharp(input.bytes, { limitInputPixels: 64_000_000 }).metadata();
  if (!await db.user.findFirst({ where: { id: user.id, bannedAt: null }, select: { id: true } })) {
    throw new GalleryUploadError("账号不可用", 403);
  }

  const id = `gallery_${createHash("sha256").update(`${user.id}\0${input.requestKey}`).digest("hex")}`;
  const prepared = await prepareManagedImageWrite({ bytes: input.bytes, ownerId: user.id,
    purpose: "GALLERY_UPLOAD", originId: id, intentKey: `gallery:${user.id}:${input.requestKey}` });
  let writeStarted = false;
  try {
    const work = matchingUpload(await db.galleryWork.upsert({ where: unique, update: {}, create: {
      id, userId: user.id, requestKey: input.requestKey, payloadHash, mediaAssetId: prepared.ticket.asset.id,
      ...snapshot, width: dimensions.width ?? null, height: dimensions.height ?? null,
      showcaseStatus: "PENDING", submittedAt: new Date(),
    }, include: galleryWorkInclude }), payloadHash);
    if (!prepared.ticket.writeGranted) return serializeGalleryWork(work);
    writeStarted = true;
    await completeManagedImageWrite(prepared);
    const accepted = await db.$transaction(async (tx) => {
      await lockImageReferenceEpoch(tx);
      return tx.galleryWork.updateMany({ where: { id, showcaseStatus: "PENDING", submittedAt: work.submittedAt,
        user: { bannedAt: null }, mediaAsset: { state: "AVAILABLE", expiresAt: { gt: new Date() } } },
      data: { submittedAt: work.submittedAt } });
    });
    if (accepted.count !== 1) throw new GalleryUploadError("投稿状态变了，请刷新后再看", 409);
    return serializeGalleryWork(await db.galleryWork.findUniqueOrThrow({ where: { id }, include: galleryWorkInclude }));
  } catch (error) {
    if (!writeStarted) await abandonPreparedImageWrite(prepared, true).catch(() => undefined);
    throw error;
  }
}

export async function listGalleryUploads(userId: string, cursor?: string | null) {
  const rows = await db.galleryWork.findMany({ where: { userId }, include: galleryWorkInclude,
    orderBy: { id: "desc" }, take: 25, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
  const items = rows.slice(0, 24).map(serializeGalleryWork);
  return { items, hasMore: rows.length > 24, nextCursor: rows.length > 24 ? items.at(-1)!.id : null };
}

const reviewActions = {
  approve_feature: "APPROVE", reject_feature: "REJECT", approve_unfeature: "TAKEDOWN",
  reject_unfeature: "KEEP", force_takedown: "FORCE_TAKEDOWN", withdraw: "WITHDRAW", request_unfeature: "REQUEST_TAKEDOWN",
} as const;

export async function reviewGalleryWork(input: {
  id: string; actorId: string; action: AdminWorkReviewAction | Exclude<UserWorkShowcaseAction, "submit">;
  submittedAt?: string | null; reviewNote?: string | null;
}) {
  const changed = new GalleryUploadError("投稿状态变了，请刷新后再试", 409);
  if (!input.submittedAt) throw changed;
  try {
    await new ImageRepository().reviewGalleryWork({ workId: input.id, actorId: input.actorId,
      action: reviewActions[input.action], expectedSubmittedAt: input.submittedAt, reviewNote: input.reviewNote ?? undefined });
  } catch (error) {
    // The database refuses a stale version, a finished review and an image that ran out the same way.
    if (error instanceof ImageStorageError && (error.code === "IMAGE_REFERENCE_CONFLICT" || error.code === "IMAGE_UNAVAILABLE")) throw changed;
    throw error;
  }
}

