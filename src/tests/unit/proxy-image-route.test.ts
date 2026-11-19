import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetCurrentUserRecord, mockReadManagedImage, mockResolveManagedImageUrl } = vi.hoisted(() => ({
  mockGetCurrentUserRecord: vi.fn(),
  mockReadManagedImage: vi.fn(),
  mockResolveManagedImageUrl: vi.fn(),
}));

vi.mock("@/lib/server/current-user", () => ({
  getCurrentUserRecord: mockGetCurrentUserRecord,
}));
vi.mock("@/lib/storage/managed-image-storage", () => ({
  readManagedImage: mockReadManagedImage,
  resolveManagedImageUrl: mockResolveManagedImageUrl,
}));

import { GET } from "@/app/api/proxy-image/route";

function proxyRequest() {
  return new Request(
    "http://localhost/api/proxy-image?url=https%3A%2F%2Fcdn.example.com%2Fimage",
  );
}

function managedImage(bytes: Uint8Array, mimeType = "image/png") {
  mockResolveManagedImageUrl.mockResolvedValue({ asset: { byteLength: String(bytes.byteLength), mimeType } });
  mockReadManagedImage.mockResolvedValue(Buffer.from(bytes));
}

describe("图片代理接口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentUserRecord.mockResolvedValue({ id: "user_1" });
    mockResolveManagedImageUrl.mockResolvedValue(null);
  });

  it("只代理本站图片，外站地址一律拒绝", async () => {
    const response = await GET(proxyRequest());

    expect(response.status).toBe(403);
    expect(mockReadManagedImage).not.toHaveBeenCalled();
  });

  it("只按文件签名返回图片并附加下载与防嗅探响应头", async () => {
    managedImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "text/html");

    const response = await GET(proxyRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toContain("attachment");
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
