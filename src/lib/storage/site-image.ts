import "server-only";

import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { fetchPublicHttpUrl } from "@/lib/server/safe-remote-url";
import { readManagedImage, resolveManagedImageUrl } from "./managed-image-storage";

type ReadOptions = { maximumBytes?: number; signal?: AbortSignal };
export type SiteImage = { data: Buffer; mimeType: string };
export class SiteImageError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const MAXIMUM_BYTES = 20 * 1024 * 1024;
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})(?![\s\S])/;

function isSiteStorageUrl(raw: string) {
  if (raw.length > 2048) return false;
  const env = getEnv();
  const bases = [env.S3_PUBLIC_BASE_URL, env.S3_ENDPOINT && env.S3_BUCKET
    ? `${env.S3_ENDPOINT.replace(/\/+$/, "")}/${encodeURIComponent(env.S3_BUCKET)}` : null];
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    if (url.pathname.split("/").some((part) => {
      const decoded = decodeURIComponent(part);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    })) return false;
    return bases.some((value) => {
      if (!value) return false;
      const base = new URL(value);
      return !base.username && !base.password && !base.search && !base.hash
        && url.origin === base.origin && url.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/`);
    });
  } catch { return false; }
}

async function readImage(url: string, options: ReadOptions, ownerId?: string): Promise<SiteImage | null> {
  const maximumBytes = options.maximumBytes ?? MAXIMUM_BYTES;
  const signal = options.signal ?? AbortSignal.timeout(15_000);
  const tooLarge = () => new SiteImageError("图片不能超过 20MB", 413);
  const isData = url.startsWith("data:");
  if (isData && url.length > Math.ceil(maximumBytes / 3) * 4 + 32) throw tooLarge();
  const encoded = isData ? DATA_IMAGE.exec(url) : null;
  if (isData && (!encoded || encoded[2].length % 4 === 1)) return null;
  if (encoded && Buffer.byteLength(encoded[2], "base64") > maximumBytes) throw tooLarge();
  const managed = isData ? null : await resolveManagedImageUrl(url);
  if (managed) {
    if (BigInt(managed.asset.byteLength) > BigInt(maximumBytes)) throw tooLarge();
    const data = await readManagedImage(managed, signal, ownerId === undefined ? {} : { viewerId: ownerId });
    if (data.length > maximumBytes) throw tooLarge();
    return { data, mimeType: managed.asset.mimeType };
  }

  // Only exact saved images/references qualify; a matching CDN prefix alone is not authorization.
  if (!isData && !isSiteStorageUrl(url)) return null;
  if (ownerId !== undefined) {
    const image = await db.generationImage.findFirst({
      where: { url, mediaAssetId: null, job: { status: "SUCCEEDED" },
        OR: [{ job: { userId: ownerId } }, { showcaseStatus: "FEATURED" }] },
      select: { id: true },
    });
    if (!image && !await db.generationJob.findFirst({
      where: { userId: ownerId, sourceImageUrls: { has: url } }, select: { id: true },
    })) return null;
  }
  if (encoded) return { data: Buffer.from(encoded[2], "base64"), mimeType: encoded[1] };

  // Site uploads use unique object keys; unlike arbitrary remote URLs, these objects are not overwritten.
  const response = await fetchPublicHttpUrl(url, { signal });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new SiteImageError("图片读取失败，请稍后重试", 502);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    if (Number(response.headers.get("content-length")) > maximumBytes) throw tooLarge();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) throw tooLarge();
      chunks.push(Buffer.from(value));
    }
    return { data: Buffer.concat(chunks, length), mimeType: response.headers.get("content-type")?.split(";")[0].trim() || "image/png" };
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** User-supplied URLs need a managed token or an accessible exact database record. */
export function readSiteImage(url: string, ownerId: string, options: ReadOptions = {}) {
  return readImage(url, options, ownerId);
}

/** Only for canonical inputs already resolved by readCanvasRunInputs, which verifies ownership. */
export async function readCanonicalSiteImage(url: string, options: ReadOptions = {}): Promise<SiteImage> {
  const image = await readImage(url, options);
  if (!image) throw new SiteImageError("参考图不是可读取的本站图片", 403);
  return image;
}
