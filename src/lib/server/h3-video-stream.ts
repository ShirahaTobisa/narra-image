import "server-only";

import { imageDownloadTimestamp } from "@/lib/image-download";
import { fetchPublicHttpUrl } from "@/lib/server/safe-remote-url";

const MAX_REDIRECTS = 5;
const STREAM_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_POSTER_BYTES = 20 * 1024 * 1024;

function responseHeaders() {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
  });
}

export function videoContentError(status: number) {
  return new Response(status === 410 ? "视频已过保留期或已被删除，请重新生成" : "视频暂时无法读取，请稍后再试", {
    status, headers: responseHeaders(),
  });
}

function validRange(range: string) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return false;
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  return (start === null || Number.isSafeInteger(start)) && (end === null || Number.isSafeInteger(end))
    && (start === null ? end! > 0 : end === null || start <= end);
}

/** Follow provider/CDN redirects on the server, with DNS pinning on every hop. */
export async function streamH3Video(request: Request, source: string, apiKey: string, variant: "video" | "poster") {
  const range = request.headers.get("range");
  if (range && !validRange(range)) return videoContentError(416);
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) abort();
  const timeout = setTimeout(abort, STREAM_TIMEOUT_MS);
  timeout.unref?.();
  const cleanup = () => {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abort);
  };
  let upstream: Response | undefined;
  let streaming = false;
  try {
    let url = source;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers = new Headers({ Accept: variant === "video" ? "video/mp4" : "image/webp", "Accept-Encoding": "identity" });
      if (range) headers.set("Range", range);
      // A redirect never receives the channel key, even when it points back to the same host.
      if (hop === 0) headers.set("Authorization", `Bearer ${apiKey}`);
      upstream = await fetchPublicHttpUrl(url, { headers, redirect: "manual", signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      await upstream.body?.cancel();
      const location = upstream.headers.get("location");
      if (!location || hop === MAX_REDIRECTS) return videoContentError(502);
      const next = new URL(location, url);
      if (next.protocol !== "https:" || next.username || next.password || next.hash) return videoContentError(502);
      url = next.href;
    }
    if (!upstream) return videoContentError(502);
    if (upstream.status === 404 || upstream.status === 410) return videoContentError(410);
    const headers = responseHeaders();
    const contentRange = upstream.headers.get("content-range");
    if (upstream.status === 416) {
      if (contentRange && /^bytes \*\/\d+$/.test(contentRange)) headers.set("Content-Range", contentRange);
      return new Response("视频范围无效", { status: 416, headers });
    }
    if (![200, 206].includes(upstream.status) || !upstream.body) {
      return videoContentError([429, 503, 504].includes(upstream.status) ? 503 : 502);
    }
    if (upstream.status === 206 && (!range || !contentRange || !/^bytes \d+-\d+\/\d+$/.test(contentRange))) {
      return videoContentError(502);
    }
    const mimeType = variant === "video" ? "video/mp4" : "image/webp";
    const upstreamType = upstream.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (upstreamType && upstreamType !== mimeType && upstreamType !== "application/octet-stream") return videoContentError(502);
    if (upstream.headers.has("content-encoding") && upstream.headers.get("content-encoding") !== "identity") return videoContentError(502);
    const maxBytes = variant === "video" ? MAX_VIDEO_BYTES : MAX_POSTER_BYTES;
    const contentLength = upstream.headers.get("content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) return videoContentError(502);
    if (contentLength) headers.set("Content-Length", contentLength);
    if (upstream.status === 206) headers.set("Content-Range", contentRange!);
    if (upstream.headers.get("accept-ranges") === "bytes") headers.set("Accept-Ranges", "bytes");
    headers.set("Content-Type", mimeType);
    const params = new URL(request.url).searchParams;
    if (params.get("download") === "1") {
      const requestedName = params.get("filename") ?? "";
      const filename = /^\d{2}-\d{2}-\d{2}-\d{2}$/.test(requestedName) ? requestedName : imageDownloadTimestamp();
      headers.set("Content-Disposition", `attachment; filename="${filename}.${variant === "video" ? "mp4" : "webp"}"`);
    }
    const reader = upstream.body.getReader();
    let bytes = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          controller.signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) { cleanup(); output.close(); return; }
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) throw new Error("视频过大");
          output.enqueue(chunk.value);
        } catch {
          abort(); cleanup();
          await reader.cancel().catch(() => {});
          output.error(new Error("视频读取失败，请稍后再试"));
        }
      },
      async cancel() {
        abort(); cleanup();
        await reader.cancel().catch(() => {});
      },
    });
    streaming = true;
    return new Response(stream, { status: upstream.status, headers });
  } catch {
    return videoContentError(502);
  } finally {
    if (!streaming) {
      abort(); cleanup();
      await upstream?.body?.cancel().catch(() => {});
    }
  }
}
