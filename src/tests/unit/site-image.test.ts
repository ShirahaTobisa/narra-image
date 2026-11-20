// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ image: vi.fn(), job: vi.fn(), resolve: vi.fn(), read: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { generationImage: { findFirst: mocks.image }, generationJob: { findFirst: mocks.job } } }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ S3_PUBLIC_BASE_URL: "https://cdn.example.com/images", S3_ENDPOINT: "https://s3.example.com", S3_BUCKET: "site" }) }));
vi.mock("@/lib/storage/managed-image-storage", () => ({ resolveManagedImageUrl: mocks.resolve, readManagedImage: mocks.read }));
vi.mock("@/lib/server/safe-remote-url", () => ({ fetchPublicHttpUrl: mocks.fetch }));

import { readCanonicalSiteImage, readSiteImage } from "@/lib/storage/site-image";

const bytes = Buffer.from("89504e470d0a1a0a", "hex");
const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
const storedUrl = "https://cdn.example.com/images/user/image.png";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolve.mockResolvedValue(null);
  mocks.image.mockResolvedValue(null);
  mocks.job.mockResolvedValue(null);
  mocks.fetch.mockImplementation(async () => new Response(bytes, { headers: { "content-type": "image/png" } }));
});

describe("verified site image reads", () => {
  it("reads an owner's existing database image without a network request", async () => {
    mocks.image.mockResolvedValue({ id: "image" });
    expect(await readSiteImage(dataUrl, "owner")).toMatchObject({ data: bytes, mimeType: "image/png" });
    expect(mocks.image).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      url: dataUrl, mediaAssetId: null, OR: [{ job: { userId: "owner" } }, { showcaseStatus: "FEATURED" }],
    }) }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("recognizes the owner's stored upload references when retrying", async () => {
    mocks.job.mockResolvedValue({ id: "previous-job" });
    expect(await readSiteImage(dataUrl, "owner")).toMatchObject({ data: bytes });
    expect(mocks.job).toHaveBeenCalledWith({ where: { userId: "owner", sourceImageUrls: { has: dataUrl } }, select: { id: true } });
  });

  it("does not accept an unrelated data URL or private image of another owner", async () => {
    expect(await readSiteImage(dataUrl, "other-owner")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reads an authorized legacy S3 image using the pinned, nonredirecting fetch", async () => {
    mocks.image.mockResolvedValue({ id: "image" });
    expect(await readSiteImage(storedUrl, "owner")).toMatchObject({ data: bytes, mimeType: "image/png" });
    expect(mocks.fetch).toHaveBeenCalledWith(storedUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it.each([
    "https://cdn.example.com.evil.test/images/user/image.png",
    "https://cdn.example.com/images-else/user/image.png",
    "https://cdn.example.com/images/user/image.png?redirect=internal",
    "https://user:secret@cdn.example.com/images/user/image.png",
    "http://127.0.0.1/image.png",
  ])("rejects noncanonical or external URLs even if a stale row exists: %s", async (url) => {
    mocks.image.mockResolvedValue({ id: "image" });
    expect(await readSiteImage(url, "owner")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not permit arbitrary files from the configured CDN", async () => {
    expect(await readSiteImage(storedUrl, "owner")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("preserves managed-image errors without trying a legacy fallback", async () => {
    mocks.resolve.mockResolvedValue({ asset: { byteLength: "8", mimeType: "image/png" } });
    mocks.read.mockRejectedValue(new Error("IMAGE_UNAVAILABLE"));
    await expect(readSiteImage(storedUrl, "owner")).rejects.toThrow("IMAGE_UNAVAILABLE");
    expect(mocks.image).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("bounds data URL bytes before decoding or querying the database", async () => {
    await expect(readSiteImage(dataUrl, "owner", { maximumBytes: 2 })).rejects.toMatchObject({ status: 413 });
    expect(mocks.image).not.toHaveBeenCalled();
  });

  it("bounds streamed remote bytes even without content-length", async () => {
    mocks.image.mockResolvedValue({ id: "image" });
    await expect(readSiteImage(storedUrl, "owner", { maximumBytes: 2 })).rejects.toMatchObject({ status: 413 });
  });

  it("propagates blocked redirects and private DNS targets", async () => {
    mocks.image.mockResolvedValue({ id: "image" });
    mocks.fetch.mockRejectedValue(new Error("不允许访问内网地址"));
    await expect(readSiteImage(storedUrl, "owner")).rejects.toThrow("不允许访问内网地址");
  });

  it("reads canonical Canvas originals after the caller verified ownership", async () => {
    expect(await readCanonicalSiteImage(dataUrl)).toMatchObject({ data: bytes });
    expect(await readCanonicalSiteImage(storedUrl)).toMatchObject({ data: bytes });
    expect(mocks.image).not.toHaveBeenCalled();
  });

  it("still rejects external URLs through the canonical Canvas reader", async () => {
    await expect(readCanonicalSiteImage("https://external.example.com/image.png")).rejects.toThrow();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
