import { getCurrentUserRecord } from "@/lib/server/current-user";
import { assertGalleryUploadRateLimit, GalleryUploadError, listGalleryUploads, readGalleryUpload, submitGalleryUpload } from "@/lib/server/gallery-uploads";
import { getErrorMessage, jsonError, jsonOk } from "@/lib/server/http";

export async function POST(request: Request) {
  try {
    const user = await getCurrentUserRecord();
    if (!user) return jsonError("未登录", 401);
    assertGalleryUploadRateLimit(user.id);
    const work = await submitGalleryUpload(user, await readGalleryUpload(request));
    return jsonOk({ work }, { status: work.availability === "available" ? 201 : 202 });
  } catch (error) {
    return jsonError(getErrorMessage(error), error instanceof GalleryUploadError ? error.status : 400);
  }
}

export async function GET(request: Request) {
  const user = await getCurrentUserRecord();
  if (!user) return jsonError("未登录", 401);
  return jsonOk(await listGalleryUploads(user.id, new URL(request.url).searchParams.get("cursor")));
}
