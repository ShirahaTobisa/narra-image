// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ video: vi.fn(), channel: vi.fn(), user: vi.fn(), decrypt: vi.fn(), fetch: vi.fn(), env: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { generatedVideo: { findUnique: mocks.video }, providerChannel: { findUnique: mocks.channel } } }));
vi.mock("@/lib/env", () => ({ getEnv: mocks.env }));
vi.mock("@/lib/server/current-user", () => ({ getCurrentUserRecord: mocks.user }));
vi.mock("@/lib/providers/provider-secret", () => ({ decryptProviderSecret: mocks.decrypt }));
vi.mock("@/lib/server/safe-remote-url", () => ({ fetchPublicHttpUrl: mocks.fetch }));

import { GET } from "@/app/api/videos/[id]/content/route";

const source = "https://h3.coolhs.com/api/v1/jobs/42/video";
const cdn = "https://cdn.example.com/private-result.mp4?signature=secret-cdn-token";
const secret = "RB-private-channel-key";
function record() {
  return { id: "video_1", url: source, posterUrl: source.replace(/video$/, "poster"), mediaStorage: "UPSTREAM", showcaseStatus: "PRIVATE",
    job: { model: "h3", userId: "owner", providerMode: "BUILT_IN", providerChannelId: "channel_1" as string | null,
      providerBaseUrl: null as string | null, providerApiKeyEncrypted: null as string | null, user: { bannedAt: null as Date | null } } };
}
function get(query = "", init?: RequestInit) {
  return GET(new Request(`https://narra.example/api/videos/video_1/content${query}`, init), { params: Promise.resolve({ id: "video_1" }) });
}
function media(body: BodyInit = new Uint8Array([1, 2, 3]), init?: ResponseInit) {
  return new Response(body, { headers: { "content-type": "video/mp4" }, ...init });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.env.mockReturnValue({ AUTH_SECRET: "test-auth-secret" });
  mocks.user.mockResolvedValue({ id: "owner", role: "USER", bannedAt: null });
  mocks.video.mockResolvedValue(record());
  mocks.channel.mockResolvedValue({ baseUrl: "https://h3.coolhs.com", apiKeyEncrypted: "encrypted-key" });
  mocks.decrypt.mockResolvedValue(secret);
  mocks.fetch.mockImplementation(async () => media());
});

describe("H3 video authorization", () => {
  it.each([
    ["owner", { id: "owner", role: "USER" }, "PRIVATE", null, 200],
    ["admin", { id: "admin", role: "ADMIN" }, "PRIVATE", new Date(), 200],
    ["anonymous private", null, "PRIVATE", null, 404],
    ["other owner", { id: "other", role: "USER" }, "PRIVATE", null, 404],
    ["public", null, "FEATURED", null, 200],
    ["pending", null, "PENDING", null, 404],
    ["takedown pending", null, "TAKEDOWN_PENDING", null, 404],
    ["banned public author", null, "FEATURED", new Date(), 404],
    ["banned owner", { id: "owner", role: "USER", bannedAt: new Date() }, "PRIVATE", new Date(), 404],
    ["banned admin", { id: "admin", role: "ADMIN", bannedAt: new Date() }, "PRIVATE", null, 404],
  ])("%s", async (_label, user, showcaseStatus, bannedAt, status) => {
    const video = record();
    video.showcaseStatus = showcaseStatus as string;
    video.job.user.bannedAt = bannedAt as Date | null;
    mocks.video.mockResolvedValue(video);
    mocks.user.mockResolvedValue(user);
    const response = await get();
    expect(response.status).toBe(status);
    await response.body?.cancel();
    if (status !== 200) {
      expect(mocks.channel).not.toHaveBeenCalled();
      expect(mocks.decrypt).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
  });

  it.each([
    { baseUrl: "https://attacker.example", url: source },
    { baseUrl: "https://h3.coolhs.com@attacker.example", url: source },
    { baseUrl: "https://h3.coolhs.com/api/v2", url: source },
    { baseUrl: "https://h3.coolhs.com?key=secret", url: source },
    { baseUrl: "https://h3.coolhs.com", url: "https://attacker.example/api/v1/jobs/42/video" },
    { baseUrl: "https://h3.coolhs.com", url: "https://h3.coolhs.com/api/v1/jobs/42/%76ideo" },
    { baseUrl: "https://h3.coolhs.com", url: "https://h3.coolhs.com/v1/videos/video_42/content" },
    { baseUrl: "https://h3.coolhs.com", url: `${source}?key=secret` },
    { baseUrl: "https://h3.coolhs.com", url: source.replace("42", "42/../43") },
  ])("rejects untrusted stored targets before decrypting: $url $baseUrl", async ({ baseUrl, url }) => {
    mocks.video.mockResolvedValue({ ...record(), url });
    mocks.channel.mockResolvedValue({ baseUrl, apiKeyEncrypted: "cipher" });
    expect((await get()).status).toBe(503);
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("uses only the stored channel and native path, ignoring client URL and credentials", async () => {
    const response = await get("?url=https://attacker.example&apiKey=attacker", { headers: { Authorization: "Bearer attacker", Cookie: "session=private" } });
    await response.body?.cancel();
    expect(mocks.channel).toHaveBeenCalledWith({ where: { id: "channel_1" }, select: { baseUrl: true, apiKeyEncrypted: true } });
    expect(mocks.fetch.mock.calls[0][0]).toBe(source);
    const headers = new Headers(mocks.fetch.mock.calls[0][1].headers);
    expect(headers.get("authorization")).toBe(`Bearer ${secret}`);
    expect(headers.has("cookie")).toBe(false);
  });

  it("reads an existing environment channel result without a database channel", async () => {
    const video = record();
    video.job.providerChannelId = "__env__";
    mocks.video.mockResolvedValue(video);
    mocks.env.mockReturnValue({ AUTH_SECRET: "test-auth-secret", BUILTIN_PROVIDER_BASE_URL: "https://H3.COOLHS.COM:443/v1/", BUILTIN_PROVIDER_API_KEY: secret });
    const response = await get();
    expect(response.status).toBe(200);
    expect(mocks.channel).not.toHaveBeenCalled();
    expect(mocks.decrypt).not.toHaveBeenCalled();
    expect(new Headers(mocks.fetch.mock.calls[0][1].headers).get("authorization")).toBe(`Bearer ${secret}`);
    await response.body?.cancel();
  });

  it.each(["https://h3.coolhs.com/v1", "https://attacker.example/v1"])("uses the job's saved custom credential only for H3: %s", async (baseUrl) => {
    const video = record();
    video.job.providerMode = "CUSTOM";
    video.job.providerChannelId = null;
    video.job.providerBaseUrl = baseUrl;
    video.job.providerApiKeyEncrypted = "job-encrypted-key";
    mocks.video.mockResolvedValue(video);
    const response = await get();
    const trusted = baseUrl.includes("h3.coolhs.com");
    expect(response.status).toBe(trusted ? 200 : 503);
    expect(mocks.channel).not.toHaveBeenCalled();
    if (trusted) {
      expect(mocks.decrypt).toHaveBeenCalledWith("job-encrypted-key", "test-auth-secret");
      expect(new Headers(mocks.fetch.mock.calls[0][1].headers).get("authorization")).toBe(`Bearer ${secret}`);
    } else {
      expect(mocks.decrypt).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
    }
    await response.body?.cancel();
  });

  it.each(["video", "poster"])("canonicalizes valid stored host casing and default port for %s", async (variant) => {
    const video = record();
    video.url = source.replace("h3.coolhs.com", "H3.COOLHS.COM:443");
    video.posterUrl = video.url.replace(/video$/, "poster");
    mocks.video.mockResolvedValue(video);
    mocks.channel.mockResolvedValue({ baseUrl: "https://H3.COOLHS.COM:443/api/v1//", apiKeyEncrypted: "encrypted-key" });
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "content-type": variant === "video" ? "video/mp4" : "image/webp" } }));
    const response = await get(`?variant=${variant}`);
    expect(response.status).toBe(200);
    expect(mocks.fetch.mock.calls[0][0]).toBe(source.replace(/video$/, variant));
    await response.body?.cancel();
  });

  it("requires a poster from the same upstream job", async () => {
    mocks.video.mockResolvedValue({ ...record(), posterUrl: "https://h3.coolhs.com/api/v1/jobs/99/poster" });
    expect((await get("?variant=poster")).status).toBe(503);
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
});

describe("H3 streaming and privacy", () => {
  it("follows redirects privately, sends the key only once, and streams a ranged response", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: cdn } }))
      .mockResolvedValueOnce(media(new Uint8Array([8, 9]), { status: 206, headers: {
        "Content-Type": "video/mp4", "Content-Length": "2", "Content-Range": "bytes 8-9/10", "Accept-Ranges": "bytes",
        Location: source, "Content-Location": cdn, "Set-Cookie": secret, Server: "private-provider", "Content-Disposition": "attachment; filename=provider-job-42.mp4", ETag: source,
      } }));
    const response = await get("?download=1&filename=11-28-16-35", { headers: { Range: "bytes=8-9" } });
    expect(response.status).toBe(206);
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([8, 9]);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    for (const [index, call] of mocks.fetch.mock.calls.entries()) {
      const headers = new Headers(call[1].headers);
      expect(headers.get("range")).toBe("bytes=8-9");
      expect(headers.get("authorization")).toBe(index === 0 ? `Bearer ${secret}` : null);
      expect(call[1].redirect).toBe("manual");
    }
    expect(response.headers.get("content-range")).toBe("bytes 8-9/10");
    expect(response.headers.get("content-length")).toBe("2");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="11-28-16-35.mp4"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    for (const header of ["location", "content-location", "set-cookie", "server", "etag"]) expect(response.headers.has(header)).toBe(false);
    expect(JSON.stringify([...response.headers])).not.toMatch(/coolhs|secret|provider-job/);
  });

  it("serves posters from the same private route", async () => {
    mocks.fetch.mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/webp" } }));
    const response = await get("?variant=poster");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(mocks.fetch.mock.calls[0][0]).toBe(source.replace(/video$/, "poster"));
    await response.body?.cancel();
  });

  it("returns before the full video arrives and cancels upstream when the reader stops", async () => {
    const cancel = vi.fn();
    mocks.fetch.mockResolvedValue(new Response(new ReadableStream({ start(output) { output.enqueue(new Uint8Array([1])); }, cancel }), { headers: { "content-type": "video/mp4" } }));
    const response = await get();
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    await reader.cancel();
    expect(cancel).toHaveBeenCalled();
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("aborts on client disconnect and on the total deadline", async () => {
    const client = new AbortController();
    const response = await get("", { signal: client.signal });
    client.abort();
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    await response.body?.cancel();
    vi.useFakeTimers();
    try {
      const timed = await get();
      vi.advanceTimersByTime(15 * 60 * 1000);
      expect(mocks.fetch.mock.calls[1][1].signal.aborted).toBe(true);
      await timed.body?.cancel();
    } finally { vi.useRealTimers(); }
  });

  it.each(["bytes=0-1,4-5", "bytes=", "bytes=9-3", "bytes=-0", "bytes=999999999999999999999-", "secret-range"])("rejects invalid range %s", async (range) => {
    expect((await get("", { headers: { Range: range } })).status).toBe(416);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([[404, 410], [410, 410], [401, 502], [429, 503], [500, 502], [503, 503]])("replaces upstream %s bodies with a safe %s message", async (upstream, status) => {
    mocks.fetch.mockResolvedValue(new Response(`${source} ${secret} ${cdn}`, { status: upstream }));
    const response = await get();
    expect(response.status).toBe(status);
    expect(await response.text()).not.toMatch(/coolhs|secret|RB-|cdn/);
  });

  it("hides transport errors and caps redirect chains", async () => {
    mocks.fetch.mockRejectedValueOnce(new Error(`${source}: ${secret}`));
    const failed = await get();
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toMatch(/coolhs|RB-/);
    mocks.fetch.mockReset().mockImplementation(async () => new Response(null, { status: 302, headers: { Location: cdn } }));
    expect((await get()).status).toBe(502);
    expect(mocks.fetch).toHaveBeenCalledTimes(6);
    expect(mocks.fetch.mock.calls.slice(1).every((call) => !new Headers(call[1].headers).has("authorization"))).toBe(true);
  });

  it.each(["http://cdn.example.com/a", "https://user:secret@cdn.example.com/a", "file:///video.mp4"])("rejects unsafe redirect %s", async (location) => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: location } }));
    expect((await get()).status).toBe(502);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not relay HTML or URL-bearing content headers as video", async () => {
    mocks.fetch.mockResolvedValue(new Response("private upstream error", { headers: { "content-type": "text/html" } }));
    expect((await get()).status).toBe(502);
    mocks.fetch.mockResolvedValue(media(new Uint8Array([1]), { headers: { "Content-Length": source } }));
    expect((await get()).status).toBe(502);
  });

  it("returns only a safe unsatisfied-range header and replaces unsafe download names", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(secret, { status: 416, headers: { "Content-Range": "bytes */10", Location: source } }));
    const invalid = await get("", { headers: { Range: "bytes=10-" } });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
    expect(invalid.headers.has("location")).toBe(false);
    expect(await invalid.text()).not.toContain(secret);
    const response = await get("?download=1&filename=../../provider-file");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="\d{2}-\d{2}-\d{2}-\d{2}\.mp4"$/);
    await response.body?.cancel();
  });
});
