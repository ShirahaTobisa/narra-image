import "server-only";

import { usesDedicatedProvider } from "@/lib/providers/dedicated-provider";

const H3_ORIGIN = "https://h3.coolhs.com";

export type VideoMedia = {
  id: string;
  url: string;
  posterUrl: string | null;
};

function hasH3Host(raw: string | null) {
  try { return new URL(raw ?? "").hostname.toLowerCase() === "h3.coolhs.com"; }
  catch { return false; }
}

/** Public projections never hand the provider's private media address to a browser. */
export function presentGeneratedVideo(video: VideoMedia, model?: string) {
  if (model !== "h3" && !hasH3Host(video.url) && !hasH3Host(video.posterUrl)) {
    return { url: video.url, posterUrl: video.posterUrl ?? null };
  }
  const url = `/api/videos/${encodeURIComponent(video.id)}/content`;
  return { url, posterUrl: video.posterUrl ? `${url}?variant=poster` : null };
}

export function h3VideoErrorMessage(model: string, message: string | null) {
  return model === "h3" && message ? "视频生成失败，请稍后再试" : message;
}

function canonicalH3MediaUrl(raw: string) {
  const url = new URL(raw);
  const path = /^https:\/\/[^/]+(\/api\/v1\/jobs\/[1-9]\d*\/(?:video|poster))$/.exec(raw)?.[1];
  return path && url.origin === H3_ORIGIN && !url.username && !url.password && url.pathname === path
    ? `${H3_ORIGIN}${path}` : null;
}

/** Validate the channel and selected stored address before decrypting its credential. */
export function h3MediaSource(baseUrl: string, video: VideoMedia, variant: "video" | "poster") {
  try {
    usesDedicatedProvider({ baseUrl }, "h3");
    const match = /\/jobs\/([1-9]\d*)\/video$/.exec(canonicalH3MediaUrl(video.url) ?? "");
    if (!match) return null;
    const source = `${H3_ORIGIN}/api/v1/jobs/${match[1]}/${variant}`;
    return variant === "video" || canonicalH3MediaUrl(video.posterUrl ?? "") === source ? source : null;
  } catch { return null; }
}
