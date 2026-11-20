import "server-only";

import sharp from "sharp";

import { verifyCanvasImage } from "@/lib/canvas/image-container";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const STATIC_IMAGE_MESSAGE = "参考图仅支持静态 PNG、JPEG、WebP 或 GIF 图片";

/** Validate the original bytes; moderation and generation must use the same image. */
export async function assertModerationImages(
  images: ReadonlyArray<{ data: Buffer | Uint8Array; mimeType: string }>,
): Promise<void> {
  for (const image of images) {
    if (image.data.byteLength > MAX_IMAGE_BYTES) throw new Error("参考图超过审核接口 20MB 上限");
    const bytes = Buffer.from(image.data);
    const metadata = await sharp(bytes).metadata();
    if (!["png", "jpeg", "webp", "gif"].includes(metadata.format)
      || image.mimeType !== `image/${metadata.format}`) {
      throw new Error(STATIC_IMAGE_MESSAGE);
    }
    if ((metadata.pages ?? 1) > 1) throw new Error(STATIC_IMAGE_MESSAGE);
    if (metadata.format !== "gif") verifyCanvasImage(bytes, image.mimeType, MAX_IMAGE_BYTES);

    // libvips reads APNG as a still PNG, so inspect verified chunk boundaries.
    if (metadata.format === "png") {
      for (let offset = 8; offset + 12 <= bytes.length; offset += bytes.readUInt32BE(offset) + 12) {
        if (["acTL", "fcTL", "fdAT"].includes(bytes.toString("latin1", offset + 4, offset + 8))) {
          throw new Error(STATIC_IMAGE_MESSAGE);
        }
      }
    }
    if (metadata.format === "webp" && bytes.toString("latin1", 12, 16) === "VP8X" && (bytes[20] & 2)) {
      throw new Error(STATIC_IMAGE_MESSAGE);
    }
  }
}
