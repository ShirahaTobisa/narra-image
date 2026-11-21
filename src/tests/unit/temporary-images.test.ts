// @vitest-environment node

const mocks = vi.hoisted(() => ({ get: vi.fn(), head: vi.fn(), open: vi.fn(), aliases: vi.fn(), user: vi.fn() }));
vi.mock("@/lib/storage/image-repository", () => ({ ImageRepository: class { getByToken = mocks.get; } }));
vi.mock("@/lib/storage/managed-image-storage", () => ({ headManagedImage: mocks.head, openManagedImage: mocks.open }));
vi.mock("@/lib/server/current-user", () => ({ getCurrentUserRecord: mocks.user }));
vi.mock("@/lib/db", () => ({ db: { imageUrlAlias: { findMany: mocks.aliases } } }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_URL: "https://app.unit.invalid" }) }));

import { GET, HEAD } from "@/app/media/images/[token]/route";
import { GET as temporaryGet, HEAD as temporaryHead } from "@/app/media/temporary-images/[token]/route";
import { GET as galleryGet, HEAD as galleryHead } from "@/app/media/gallery-images/[token]/route";
import { ImageStorageError } from "@/lib/storage/image-contract";
import { presentGenerationImage } from "@/lib/storage/image-presentation";
import { projectGenerationSourceUrls } from "@/lib/storage/image-source-presentation";

const token = "a".repeat(64);
const context = { params: Promise.resolve({ token }) };
const deadline = "2026-11-21T01:00:00.000Z";
const asset = () => ({ id: "asset", purpose: "REFERENCE", state: "AVAILABLE", activeObjectId: "object", publicToken: token,
  byteLength: "3", mimeType: "image/png", sha256: "b".repeat(64), expiresAt: deadline });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-21T00:59:59.000Z")); vi.resetAllMocks();
  mocks.get.mockResolvedValue({ asset: asset(), object: {}, location: {} });
  mocks.open.mockResolvedValue(new ReadableStream()); mocks.user.mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); });

it.each([GET, HEAD])("rejects temporary assets on the permanent token route, including validators", async (serve) => {
  const response = await serve(new Request(`https://app.unit.invalid/media/images/${token}`, {
    headers: { "if-none-match": `"${"b".repeat(64)}"` },
  }), context);
  expect(response.status).toBe(404);
  expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.head).not.toHaveBeenCalled();
});

it("projects a temporary URL until its exact deadline, then keeps only the cleaned placeholder", () => {
  const image = { mediaAssetId: "asset", mediaAsset: asset(), url: "https://private.invalid/upstream-signed" };
  expect(presentGenerationImage(image)).toEqual({ availability: "available", url: `https://app.unit.invalid/media/temporary-images/${token}` });
  vi.setSystemTime(new Date(deadline));
  expect(presentGenerationImage(image)).toEqual({ availability: "cleaned", url: "" });
});

it("does not offer a shortened reference group when one original image expires", async () => {
  vi.setSystemTime(new Date(deadline));
  const old = "https://app.unit.invalid/reference-a";
  const live = "https://app.unit.invalid/reference-b";
  mocks.aliases.mockResolvedValue([{ url: old, asset: asset() }, { url: live, asset: { ...asset(), expiresAt: null } }]);
  const sourceImageUrls = Object.freeze([old, live]);
  expect(await projectGenerationSourceUrls([{ sourceImageUrls }])).toEqual([
    { sourceImageUrls: [], sourceImagesReusable: false, sourceImagesExpiresAt: deadline },
  ]);
  expect(sourceImageUrls).toEqual([old, live]);
  const twice = await projectGenerationSourceUrls(await projectGenerationSourceUrls([{ sourceImageUrls }]));
  expect(twice[0]).toMatchObject({ sourceImageUrls: [], sourceImagesReusable: false, sourceImagesExpiresAt: deadline });
});

it("lets only the viewer's own browser keep temporary bytes, and only until the deadline", async () => {
  const response = await temporaryGet(new Request(`https://app.unit.invalid/media/temporary-images/${token}`), context);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, max-age=1");
  expect(mocks.open).toHaveBeenCalledWith(expect.anything(), expect.any(AbortSignal), {});
});

it.each([temporaryGet, temporaryHead])("checks the deadline before bytes, HEAD and 304, independently of new-write flags", async (serve) => {
  const request = new Request(`https://app.unit.invalid/media/temporary-images/${token}`, { headers: { "if-none-match": `"${"b".repeat(64)}"` } });
  const before = await serve(request, context);
  expect(before.status).toBe(304); expect(before.headers.get("cache-control")).toBe("private, max-age=1");
  mocks.head.mockClear(); vi.setSystemTime(new Date(deadline));
  const expired = await serve(request, context);
  expect(expired.status).toBe(410); expect(mocks.head).not.toHaveBeenCalled(); expect(mocks.open).not.toHaveBeenCalled();
});

it.each([galleryGet, galleryHead])("lets only the server session identify a gallery viewer, including on 304", async (serve) => {
  mocks.get.mockResolvedValue({ asset: { ...asset(), purpose: "GALLERY_UPLOAD" }, object: {}, location: {} });
  const request = new Request(`https://app.unit.invalid/media/gallery-images/${token}?viewerId=admin&jobId=known`, { headers: { "if-none-match": `"${"b".repeat(64)}"` } });
  mocks.head.mockRejectedValue(new ImageStorageError("IMAGE_UNAVAILABLE"));
  expect((await serve(request, context)).status).toBe(404);
  expect(mocks.head).toHaveBeenLastCalledWith(expect.anything(), expect.any(AbortSignal), {});
  mocks.user.mockResolvedValue({ id: "owner" }); mocks.head.mockResolvedValue(undefined);
  const allowed = await serve(request, context);
  expect(allowed.status).toBe(304); expect(allowed.headers.get("cache-control")).toContain("no-store");
  expect(mocks.head).toHaveBeenLastCalledWith(expect.anything(), expect.any(AbortSignal), { viewerId: "owner" });
});

it("serves a gallery upload on the private route until approval, then only on the cacheable public route", async () => {
  mocks.get.mockResolvedValue({ asset: { ...asset(), purpose: "GALLERY_UPLOAD" }, object: {}, location: {} });
  for (const serve of [GET, temporaryGet]) expect((await serve(new Request("https://app.unit.invalid"), context)).status).toBe(404);
  mocks.get.mockResolvedValue({ asset: { ...asset(), purpose: "GALLERY_UPLOAD", expiresAt: null }, object: {}, location: {} });
  for (const serve of [galleryGet, temporaryGet]) expect((await serve(new Request("https://app.unit.invalid"), context)).status).toBe(404);
  expect(mocks.open).not.toHaveBeenCalled();
  // The database still decides whether the approved upload is public; no session is consulted here.
  const approved = await GET(new Request("https://app.unit.invalid"), context);
  expect(approved.status).toBe(200); expect(approved.headers.get("cache-control")).toContain("public");
  expect(mocks.open).toHaveBeenCalledWith(expect.anything(), expect.any(AbortSignal), {});
  expect(mocks.user).not.toHaveBeenCalled();
});
