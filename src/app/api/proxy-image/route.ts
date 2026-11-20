import { getCurrentUserRecord } from "@/lib/server/current-user";
import { getErrorMessage } from "@/lib/server/http";
import { readSiteImage, SiteImageError } from "@/lib/storage/site-image";

type SupportedImage = {
  extension: "gif" | "jpg" | "png" | "webp";
  mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
};

function detectImage(bytes: Uint8Array): SupportedImage | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { extension: "png", mediaType: "image/png" };
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: "jpg", mediaType: "image/jpeg" };
  }

  const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
  if (signature.startsWith("GIF87a") || signature.startsWith("GIF89a")) {
    return { extension: "gif", mediaType: "image/gif" };
  }
  if (bytes.length >= 12 && signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") {
    return { extension: "webp", mediaType: "image/webp" };
  }

  return null;
}

/**
 * GET /api/proxy-image?url=...
 * Server-side proxy to fetch images from external storage (S3/R2)
 * avoiding CORS restrictions when the client needs to read image data.
 */
export async function GET(request: Request) {
  try {
    const user = await getCurrentUserRecord();
    if (!user) {
      return new Response("请先登录", { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const imageUrl = searchParams.get("url");

    if (!imageUrl) {
      return new Response("Missing url parameter", { status: 400 });
    }

    const source = await readSiteImage(imageUrl, user.id);
    if (!source) {
      return new Response("只能下载本站图片", { status: 403 });
    }
    const imageBytes = new Uint8Array(source.data);
    const image = detectImage(imageBytes);
    if (!image) {
      return new Response("Unsupported image content", { status: 415 });
    }

    const headers: Record<string, string> = {
      "Content-Type": image.mediaType,
      "Content-Disposition": `attachment; filename="image.${image.extension}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=86400, immutable",
      "Content-Length": String(imageBytes.byteLength),
    };

    return new Response(imageBytes, { headers });
  } catch (error) {
    return new Response(getErrorMessage(error), { status: error instanceof SiteImageError ? error.status : 403 });
  }
}
