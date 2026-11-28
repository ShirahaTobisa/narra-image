import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getChannelById } from "@/lib/providers/built-in-provider";
import { decryptProviderSecret } from "@/lib/providers/provider-secret";
import { getCurrentUserRecord } from "@/lib/server/current-user";
import { streamH3Video, videoContentError } from "@/lib/server/h3-video-stream";
import { h3MediaSource } from "@/lib/storage/h3-video";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const variant = new URL(request.url).searchParams.get("variant") ?? "video";
    if (variant !== "video" && variant !== "poster") return videoContentError(400);
    const user = await getCurrentUserRecord();
    const video = await db.generatedVideo.findUnique({
      where: { id },
      select: {
        id: true, url: true, posterUrl: true, mediaStorage: true, showcaseStatus: true,
        job: { select: {
          model: true, userId: true, providerMode: true, providerChannelId: true,
          providerBaseUrl: true, providerApiKeyEncrypted: true, user: { select: { bannedAt: true } },
        } },
      },
    });
    if (!video) return videoContentError(404);
    const privateAccess = user && !user.bannedAt && (user.role === "ADMIN" || (user.id === video.job.userId && !video.job.user.bannedAt));
    const publicAccess = video.showcaseStatus === "FEATURED" && !video.job.user.bannedAt;
    if (!privateAccess && !publicAccess) return videoContentError(404);
    if (variant === "poster" && !video.posterUrl) return videoContentError(404);
    if (video.job.model !== "h3" || video.mediaStorage !== "UPSTREAM") return videoContentError(503);
    // Disabled/exhausted channels must still allow an owner to retrieve an existing result.
    const channel = video.job.providerMode === "CUSTOM"
      ? { baseUrl: video.job.providerBaseUrl, apiKeyEncrypted: video.job.providerApiKeyEncrypted }
      : video.job.providerChannelId === "__env__" ? await getChannelById("__env__")
      : video.job.providerChannelId ? await db.providerChannel.findUnique({
        where: { id: video.job.providerChannelId }, select: { baseUrl: true, apiKeyEncrypted: true },
      }) : null;
    const source = channel?.baseUrl && h3MediaSource(channel.baseUrl, video, variant);
    if (!source || !channel) return videoContentError(503);
    const apiKey = "apiKey" in channel ? channel.apiKey
      : channel.apiKeyEncrypted ? await decryptProviderSecret(channel.apiKeyEncrypted, getEnv().AUTH_SECRET) : null;
    if (!apiKey?.trim()) return videoContentError(503);
    return await streamH3Video(request, source, apiKey, variant);
  } catch {
    return videoContentError(503);
  }
}
