/** Only the canonical token path on this application's exact origin is ours.
 * Historical external URLs still require an exact database alias. */
export function managedImageAddress(rawUrl: string, appUrl: string): { token: string; route: "images" | "temporary-images" | "gallery-images" } | null {
  try {
    const base = new URL(appUrl);
    if (!/^https?:\/\//.test(rawUrl)) return null;
    const source = new URL(rawUrl);
    const prefix = `${base.pathname.replace(/\/+$/, "")}/media/`;
    // Go's URL.String may retain legal host casing and an explicit default
    // port. Normalize the authority for comparison, but require the original
    // path itself to be canonical (no dot segments, userinfo or extra suffix).
    const literalPath = rawUrl.match(/^https?:\/\/[^/@?#\\]+(\/[^?#]*)$/)?.[1];
    const match = source.pathname.startsWith(prefix)
      ? /^(images|temporary-images|gallery-images)\/([0-9a-f]{64})(?![\s\S])/.exec(source.pathname.slice(prefix.length)) : null;
    if (source.origin !== base.origin || source.search || source.hash || source.username || source.password || !match
      || literalPath !== source.pathname) return null;
    return { token: match[2], route: match[1] as "images" | "temporary-images" | "gallery-images" };
  } catch { return null; }
}

export function managedImagePublicToken(rawUrl: string, appUrl: string): string | null {
  return managedImageAddress(rawUrl, appUrl)?.token ?? null;
}

/** Keep registered images on the internal Next fetch path, including when the
 * public APP_URL resolves to a private address behind a reverse proxy. */
export function managedImageOptimizerRewrite(requestUrl: string, appUrl: string): URL | null {
  try {
    const request = new URL(requestUrl);
    const sources = request.searchParams.getAll("url");
    if (sources.length !== 1 || managedImageAddress(sources[0], appUrl)?.route !== "images") return null;
    const source = new URL(sources[0]);
    request.searchParams.set("url", source.pathname);
    return request;
  } catch { return null; }
}
