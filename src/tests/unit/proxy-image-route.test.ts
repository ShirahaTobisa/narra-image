import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetCurrentUserRecord, mockReadManagedImage, mockResolveManagedImageUrl, mockFindImage, mockFindJob, mockFetchPublic } = vi.hoisted(() => ({
  mockGetCurrentUserRecord: vi.fn(),
  mockReadManagedImage: vi.fn(),
  mockResolveManagedImageUrl: vi.fn(),
  mockFindImage: vi.fn(), mockFindJob: vi.fn(), mockFetchPublic: vi.fn(),
}));

vi.mock("@/lib/server/current-user", () => ({
  getCurrentUserRecord: mockGetCurrentUserRecord,
}));
vi.mock("@/lib/storage/managed-image-storage", () => ({
  readManagedImage: mockReadManagedImage,
  resolveManagedImageUrl: mockResolveManagedImageUrl,
}));
vi.mock("@/lib/db", () => ({ db: { generationImage: { findFirst: mockFindImage }, generationJob: { findFirst: mockFindJob } } }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ S3_PUBLIC_BASE_URL: "https://cdn.example.com" }) }));
vi.mock("@/lib/server/safe-remote-url", () => ({ fetchPublicHttpUrl: mockFetchPublic }));

import { GET } from "@/app/api/proxy-image/route";

function proxyRequest(download?: string) {
  const url = new URL(
    "http://localhost/api/proxy-image?url=https%3A%2F%2Fcdn.example.com%2Fimage",
  );
  if (download !== undefined) url.searchParams.set("download", download);
  return new Request(url);
}

function managedImage(bytes: Uint8Array, mimeType = "image/png") {
  mockResolveManagedImageUrl.mockResolvedValue({ asset: { byteLength: String(bytes.byteLength), mimeType } });
  mockReadManagedImage.mockResolvedValue(Buffer.from(bytes));
}

describe("图片代理接口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 0, 2, 3, 4, 5).getTime());
    mockGetCurrentUserRecord.mockResolvedValue({ id: "user_1" });
    mockResolveManagedImageUrl.mockResolvedValue(null);
    mockFindImage.mockResolvedValue(null);
    mockFindJob.mockResolvedValue(null);
  });

  afterEach(() => vi.restoreAllMocks());

  it("只代理本站图片，外站地址一律拒绝", async () => {
    const response = await GET(proxyRequest());

    expect(response.status).toBe(403);
    expect(mockReadManagedImage).not.toHaveBeenCalled();
  });

  it("允许下载数据库中属于当前用户的旧 S3 图片", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    mockFindImage.mockResolvedValue({ id: "own-image" });
    mockFetchPublic.mockResolvedValue(new Response(bytes, { headers: { "content-type": "image/png" } }));
    const response = await GET(proxyRequest());
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    [undefined, "01-02-03-04"],
    ["11-25-22-50", "11-25-22-50"],
    ['bad"\r\nX-Injected: true', "01-02-03-04"],
  ])("按文件签名下载图片，文件名参数 %s 只接受受限时间格式", async (download, filename) => {
    managedImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "text/html");

    const response = await GET(proxyRequest(download));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${filename}.png"`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("拒绝伪装成图片的 HTML", async () => {
    managedImage(new TextEncoder().encode("<script>alert(1)</script>"));

    const response = await GET(proxyRequest());

    expect(response.status).toBe(415);
  });

  it("超大图片直接拒绝", async () => {
    mockResolveManagedImageUrl.mockResolvedValue({ asset: { byteLength: String(21 * 1024 * 1024), mimeType: "image/png" } });

    const response = await GET(proxyRequest());

    expect(response.status).toBe(413);
    expect(mockReadManagedImage).not.toHaveBeenCalled();
  });
});
