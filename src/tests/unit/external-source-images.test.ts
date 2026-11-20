// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), reply: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("@/lib/storage/managed-image-storage", () => ({ resolveManagedImageUrl: vi.fn(async () => null), readManagedImage: vi.fn() }));

import { downloadExternalImage } from "@/lib/external-api/source-images";
import { fetchPublicHttpUrl } from "@/lib/server/safe-remote-url";

const streams: PassThrough[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.reply.mockReturnValue({ status: 200, headers: { "content-type": "image/png" }, chunks: [Buffer.from([1, 2, 3])] });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unpinned fetch must not be used")));
  mocks.request.mockImplementation((options, receive) => {
    const req = Object.assign(new EventEmitter(), { end: () => {} });
    const stream = new PassThrough();
    streams.push(stream);
    const reply = mocks.reply();
    Object.assign(stream, { statusCode: reply.status, headers: reply.headers });
    const abort = () => { stream.destroy(new Error("aborted")); };
    options.signal?.addEventListener("abort", abort, { once: true });
    stream.once("close", () => options.signal?.removeEventListener("abort", abort));
    queueMicrotask(() => {
      receive(stream);
      for (const chunk of reply.chunks ?? []) stream.write(chunk);
      if (!reply.stall) stream.end();
    });
    return req;
  });
});
afterEach(() => {
  for (const stream of streams.splice(0)) stream.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("外部参考图下载安全", () => {
  it.each(["http://127.0.0.1/private.png", "http://[::1]/private.png", "http://169.254.169.254/credentials"])("拒绝内网 %s", async (url) => {
    await expect(downloadExternalImage(url)).rejects.toThrow(/内网|保留/);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("实际连接固定到已审核 DNS 地址，保留域名的 TLS 与 Host", async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const image = await downloadExternalImage("https://images.example/picture.png", 2);
    expect(image).toEqual({ data: Buffer.from([1, 2, 3]), fileName: "source-3.png", mimeType: "image/png" });
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.request.mock.calls[0][0]).toMatchObject({ hostname: "93.184.216.34", servername: "images.example", headers: { host: "images.example" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("允许公网 IPv6", async () => {
    const image = await downloadExternalImage("https://[2606:4700:4700::1111]/image.png");
    expect(image.data).toEqual(Buffer.from([1, 2, 3]));
    expect(mocks.request.mock.calls[0][0].hostname).toBe("2606:4700:4700::1111");
  });

  it("每一跳重新检查，拒绝重定向到内网且关闭旧响应", async () => {
    mocks.reply.mockReturnValue({ status: 302, headers: { location: "http://127.0.0.1/private.png" }, chunks: [] });
    await expect(downloadExternalImage("https://images.example/source.png")).rejects.toThrow(/内网|保留/);
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(streams[0].destroyed).toBe(true);
  });

  it("允许有界公网重定向，并保留原有默认禁止重定向的读取契约", async () => {
    mocks.reply.mockReturnValueOnce({ status: 302, headers: { location: "/final.png" }, chunks: [] });
    expect((await downloadExternalImage("https://images.example/start.png")).data).toEqual(Buffer.from([1, 2, 3]));
    expect(mocks.request.mock.calls[1][0].path).toBe("/final.png");
    mocks.reply.mockReturnValueOnce({ status: 302, headers: { location: "/never.png" }, chunks: [] });
    await expect(fetchPublicHttpUrl("https://images.example/start.png")).rejects.toThrow("不允许重定向");
  });

  it("没有 Content-Length 时也在读取中限制大小并断开", async () => {
    mocks.reply.mockReturnValue({ status: 200, headers: { "content-type": "image/png" }, chunks: [Buffer.alloc(6*1024*1024), Buffer.alloc(6*1024*1024)], stall: true });
    await expect(downloadExternalImage("https://images.example/large.png")).rejects.toThrow("10MB");
    expect(streams[0].destroyed).toBe(true);
  });

  it("接到响应头后，慢速正文仍受总超时限制", async () => {
    vi.useFakeTimers();
    mocks.reply.mockReturnValue({ status: 200, headers: { "content-type": "image/png" }, chunks: [], stall: true });
    const assertion = expect(downloadExternalImage("https://images.example/slow.png")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(streams[0].destroyed).toBe(true);
  });

  it("DNS 卡住时也在总超时后退出，且不建立连接", async () => {
    vi.useFakeTimers();
    mocks.lookup.mockReturnValue(new Promise(() => {}));
    const assertion = expect(downloadExternalImage("https://images.example/slow-dns.png")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each([
    { status: 502, headers: {} },
    { status: 204, headers: {} },
    { status: 205, headers: {} },
    { status: 304, headers: {} },
    { status: 999, headers: {} },
    { status: 200, headers: { "content-type": "text/html" } },
    { status: 200, headers: { "content-type": "image/png", "content-length": String(11*1024*1024) } },
  ])("拒绝不合格响应并取消读取 %j", async (reply) => {
    mocks.reply.mockReturnValue({ ...reply, chunks: [], stall: true });
    await expect(downloadExternalImage("https://images.example/bad.png")).rejects.toThrow();
    expect(streams[0].destroyed).toBe(true);
  });
});
