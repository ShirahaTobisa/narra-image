import { postJson } from "@/lib/http-client";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("交互 JSON 请求", () => {
  it("解析成功响应，并保留服务器给出的错误提示", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { credits: 12 } }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "已达领取上限" }) }));
    expect(await postJson("/api/test")).toEqual({ credits: 12 });
    await expect(postJson("/api/test")).rejects.toThrow("已达领取上限");
  });

  it.each([null, {}, { data: null }, { error: { internal: "bad" } }])("拒绝不完整响应 %j", async (result) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => result })));
    await expect(postJson("/api/test")).rejects.toThrow("请求失败，请稍后再试");
  });

  it("超时中止请求并提供可读错误", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const assertion = expect(postJson("/api/test")).rejects.toThrow("请求超时，请稍后再试");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});
