import "server-only";

import { ImageRepository } from "./image-repository";
import { ImageStorageError, imageAssetPublicPath, type ImagePublicPath } from "./image-contract";
import { isImageExpired } from "./image-availability";
import { headManagedImage, openManagedImage, type ManagedImageReadContext } from "./managed-image-storage";

export async function serveManagedImage(request: Request, context: { params: Promise<{ token: string }> }, head: boolean, route: ImagePublicPath): Promise<Response> {
  const { token } = await context.params;
  const reject = (status: number) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  if (token.length !== 64 || !/^[0-9a-f]{64}$/.test(token)) return reject(404);
  try {
    const image = await new ImageRepository().getByToken(token);
    if (!image || imageAssetPublicPath(image.asset) !== route) return reject(404);
    if (isImageExpired(image.asset) || image.asset.state === "DELETED" || image.asset.state === "DELETING") return reject(410);
    if (image.asset.state !== "AVAILABLE" || !image.object || !image.location) return reject(404);
    const readContext: ManagedImageReadContext = {};
    if (route === "gallery-images") {
      const { getCurrentUserRecord } = await import("@/lib/server/current-user");
      const viewer = await getCurrentUserRecord();
      if (viewer) readContext.viewerId = viewer.id;
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const headers = new Headers({
      "Content-Type": image.asset.mimeType, "Content-Length": image.asset.byteLength,
      "X-Content-Type-Options": "nosniff", ETag: `"${image.asset.sha256}"`,
      // A temporary image may stay in its viewer's own browser until the deadline, never beyond it.
      "Cache-Control": route === "images" ? "public, max-age=300, must-revalidate"
        : route === "temporary-images" ? `private, max-age=${Math.max(0, Math.floor((new Date(image.asset.expiresAt!).getTime() - Date.now()) / 1000))}`
          : "private, no-store",
    });
    if (route === "gallery-images") headers.set("Vary", "Cookie");
    if (request.headers.get("if-none-match") === headers.get("etag")) {
      await headManagedImage(image, signal, readContext);
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    if (head) { await headManagedImage(image, signal, readContext); return new Response(null, { status: 200, headers }); }
    return new Response(await openManagedImage(image, signal, readContext), { status: 200, headers });
  } catch (error) {
    return reject(error instanceof ImageStorageError && error.code === "IMAGE_UNAVAILABLE" ? 404 : 503);
  }
}
