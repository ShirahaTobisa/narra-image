import "server-only";

import { fetchPublicHttpUrl } from "@/lib/server/safe-remote-url";

const MAX_EXTERNAL_IMAGE_BYTES = 10 * 1024 * 1024;
const EXTERNAL_IMAGE_TIMEOUT_MS = 10_000;
const MAX_EXTERNAL_IMAGE_REDIRECTS = 3;
const ALLOWED_EXTERNAL_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function getImageFileExtension(contentType: string) {
  return contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1] || "png";
}

export async function downloadExternalImage(url: string, index = 0) {
  const { resolveManagedImageUrl, readManagedImage } = await import("@/lib/storage/managed-image-storage");
  const image = await resolveManagedImageUrl(url);
  if (image) {
    if (BigInt(image.asset.byteLength) > BigInt(MAX_EXTERNAL_IMAGE_BYTES)) throw new Error("参考图不能超过 10MB");
    if (!ALLOWED_EXTERNAL_IMAGE_TYPES.has(image.asset.mimeType)) throw new Error("参考图 URL 必须返回 png、jpeg、webp 或 gif 图片");
    return { data: await readManagedImage(image, AbortSignal.timeout(EXTERNAL_IMAGE_TIMEOUT_MS)),
      fileName: `source-${index + 1}.${getImageFileExtension(image.asset.mimeType)}`, mimeType: image.asset.mimeType };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_IMAGE_TIMEOUT_MS);
  try {
    let current = new URL(url);
    for (let redirects = 0; redirects <= MAX_EXTERNAL_IMAGE_REDIRECTS; redirects += 1) {
      // 每跳固定到校验后的 IP；同一个截止覆盖 DNS、连接和整个正文读取。
      const response = await fetchPublicHttpUrl(current.href, { signal: controller.signal, redirect: "manual" });
      try {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) throw new Error("参考图下载重定向无效");
          current = new URL(location, current);
          continue;
        }
        if (!response.ok || !response.body) throw new Error("参考图下载失败");
        const mimeType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!ALLOWED_EXTERNAL_IMAGE_TYPES.has(mimeType)) throw new Error("参考图 URL 必须返回 png、jpeg、webp 或 gif 图片");
        if (Number(response.headers.get("content-length")) > MAX_EXTERNAL_IMAGE_BYTES) throw new Error("参考图不能超过 10MB");
        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let length = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_EXTERNAL_IMAGE_BYTES) throw new Error("参考图不能超过 10MB");
            chunks.push(Buffer.from(value));
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        return { data: Buffer.concat(chunks, length), fileName: `source-${index + 1}.${getImageFileExtension(mimeType)}`, mimeType };
      } finally {
        await response.body?.cancel().catch(() => undefined);
      }
    }
    throw new Error("参考图下载重定向次数过多");
  } finally { clearTimeout(timer); }
}
