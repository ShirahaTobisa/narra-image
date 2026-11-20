// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(), moderate: vi.fn(), update: vi.fn(), send: vi.fn(),
  env: { ENABLE_LOCAL_IMAGE_FALLBACK: true, S3_BUCKET: "", S3_ENDPOINT: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" },
}));
vi.mock("@/lib/server/current-user", () => ({ getCurrentUserRecord: mocks.currentUser }));
vi.mock("@/lib/moderation/check", () => ({ checkGenerationInput: mocks.moderate }));
vi.mock("@/lib/db", () => ({ db: { user: { update: mocks.update } } }));
vi.mock("@/lib/env", () => ({ getEnv: () => mocks.env }));
vi.mock("@/lib/prisma-mappers", () => ({ serializeUser: (user: unknown) => user }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { send = mocks.send; },
  PutObjectCommand: class { constructor(public input: unknown) {} },
}));

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII=", "base64");
function request(value: Blob | string = new Blob([png], { type: "image/png" })) {
  const body = new FormData();
  body.set("avatar", value);
  return new Request("https://app.unit.invalid/api/me/avatar", { method: "POST", body });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue({ id: "avatar-user" });
  mocks.moderate.mockResolvedValue({ allowed: true });
  mocks.update.mockResolvedValue({ id: "avatar-user", avatarUrl: "saved" });
  Object.assign(mocks.env, { ENABLE_LOCAL_IMAGE_FALLBACK: true, S3_BUCKET: "", S3_ENDPOINT: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" });
});
afterEach(() => vi.useRealTimers());

describe("头像上传审核", () => {
  it("先审核原始图片，通过后才写入头像", async () => {
    const { POST } = await import("@/app/api/me/avatar/route");
    expect((await POST(request())).status).toBe(200);
    expect(mocks.moderate).toHaveBeenCalledWith({ builtIn: true, userId: "avatar-user", images: [{ data: png, mimeType: "image/png" }] });
    expect(mocks.update.mock.calls[0][0].data.avatarUrl).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(mocks.moderate.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each(["内容不符合规则", "内容审核暂时无法完成"]) ("%s 时不上传 S3，也不更新账号", async (message) => {
    Object.assign(mocks.env, { S3_BUCKET: "test", S3_ENDPOINT: "https://storage.unit.invalid", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test" });
    mocks.moderate.mockResolvedValue({ allowed: false, message });
    const { POST } = await import("@/app/api/me/avatar/route");
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("审核抛错时不写入头像", async () => {
    mocks.moderate.mockRejectedValue(new Error("synthetic unavailable"));
    const { POST } = await import("@/app/api/me/avatar/route");
    expect((await POST(request())).status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("一分钟最多处理 5 次，拒绝第六次时不解析文件，不影响其他用户", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { POST } = await import("@/app/api/me/avatar/route");
    for (let i = 0; i < 5; i++) expect((await POST(request())).status).toBe(200);
    const extra = request();
    const parse = vi.spyOn(extra, "formData");
    expect((await POST(extra)).status).toBe(429);
    expect(parse).not.toHaveBeenCalled();
    mocks.currentUser.mockResolvedValueOnce({ id: "another-user" });
    expect((await POST(request())).status).toBe(200);
    vi.setSystemTime(60_000);
    expect((await POST(request())).status).toBe(200);
  });

  it.each(["text", new Blob([png], { type: "image/svg+xml" }), new Blob([new Uint8Array(200 * 1024 + 1)], { type: "image/png" })])("拒绝非文件、不支持格式或过大文件", async (value) => {
    const { POST } = await import("@/app/api/me/avatar/route");
    expect((await POST(request(value))).status).toBe(400);
    expect(mocks.moderate).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("未登录时不读取文件", async () => {
    mocks.currentUser.mockResolvedValue(null);
    const { POST } = await import("@/app/api/me/avatar/route");
    const input = request();
    const parse = vi.spyOn(input, "formData");
    expect((await POST(input)).status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
  });
});
