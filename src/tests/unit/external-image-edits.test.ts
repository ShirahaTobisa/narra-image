import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { download } = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock("@/lib/external-api/source-images", () => ({ downloadExternalImage: download }));

import { parseExternalImageEditRequest } from "@/lib/external-api/image-edits";
import { canvasPng } from "./helpers/canvas-api-fixtures";

function jsonRequest(images: Record<string, unknown>) {
  return new Request("https://app.invalid/v1/images/edits", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "make the landscape blue", ...images }),
  });
}

function multipartRequest(count: number) {
  const formData = new FormData();
  formData.set("prompt", "make the landscape blue");
  const fields = ["image[]", "image", "images", "referenceImages", "image"];
  const reads = Array.from({ length: count }, (_, index) => {
    const file = new File([new Uint8Array(canvasPng())], `source-${index + 1}.png`, { type: "image/png" });
    const read = vi.spyOn(file, "arrayBuffer");
    formData.append(fields[index], file);
    return read;
  });
  const request = new Request("https://app.invalid/v1/images/edits", {
    method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=test" },
  });
  request.formData = async () => formData;
  return { request, reads };
}

describe("images/edits reference count", () => {
  beforeEach(() => {
    download.mockReset();
    download.mockImplementation(async (_url: string, index: number) => ({
      data: canvasPng(), mimeType: "image/png", fileName: `source-${index + 1}.png`,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { images: Array.from({ length: 5 }, (_, index) => `https://media.invalid/${index}.png`) },
    {
      image: "https://media.invalid/1.png", images: ["https://media.invalid/2.png"],
      "image[]": [{ url: "https://media.invalid/3.png" }],
      image_url: { url: "https://media.invalid/4.png" }, imageUrl: { image_url: { url: "https://media.invalid/5.png" } },
    },
  ])("rejects more than four JSON references across aliases before downloading: %j", async (images) => {
    await expect(parseExternalImageEditRequest(jsonRequest(images))).rejects.toThrow("参考图最多支持 4 张");
    expect(download).not.toHaveBeenCalled();
  });

  it("accepts four JSON references across aliases", async () => {
    const urls = Array.from({ length: 4 }, (_, index) => `https://media.invalid/${index + 1}.png`);
    const result = await parseExternalImageEditRequest(jsonRequest({
      image: urls[0], images: [urls[1]], "image[]": [{ imageUrl: urls[2] }], image_url: { url: urls[3] },
    }));
    expect(result.sourceImages).toHaveLength(4);
    expect(download.mock.calls).toEqual(urls.map((url, index) => [url, index]));
  });

  it("rejects more than four multipart files across aliases before reading any bytes", async () => {
    const { request, reads } = multipartRequest(5);
    await expect(parseExternalImageEditRequest(request)).rejects.toThrow("参考图最多支持 4 张");
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("accepts four multipart files", async () => {
    const { request, reads } = multipartRequest(4);
    const result = await parseExternalImageEditRequest(request);
    expect(result.sourceImages).toEqual(Array.from({ length: 4 }, (_, index) => ({
      data: canvasPng(), mimeType: "image/png", fileName: `source-${index + 1}.png`,
    })));
    for (const read of reads) expect(read).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
  });
});
