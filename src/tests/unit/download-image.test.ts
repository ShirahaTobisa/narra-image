import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadImage } from "@/components/works/download-image";

const createObjectURL = vi.fn(() => "blob:downloaded-image");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(new Date(2026, 0, 2, 3, 4, 5).getTime());
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("image download filenames", () => {
  it.each([
    ["/api/images/signed-token", "image/webp", "01-02-03-04.webp"],
    ["/api/images/signed-token", "image/jpeg", "01-02-03-04.jpg"],
    ["/api/images/signed-token", "image/gif", "01-02-03-04.gif"],
    ["/api/images/signed-token", "image/png", "01-02-03-04.png"],
    ["https://images.invalid/sunset.png?token=test", "image/webp", "01-02-03-04.webp"],
    ["https://images.invalid/sunset.webp", "image/jpeg", "01-02-03-04.jpg"],
    ["https://images.invalid/sunset.png", "image/png", "01-02-03-04.png"],
    ["https://images.invalid/sunset.png", "", "01-02-03-04.png"],
    ["/api/images/signed-token", "application/octet-stream", "01-02-03-04.png"],
  ])("downloads %s as %s with filename %s", async (url, mimeType, filename) => {
    const blob = new Blob(["original image bytes"], { type: mimeType });
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => blob });
    vi.stubGlobal("fetch", fetch);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    await downloadImage(url);

    expect(fetch).toHaveBeenCalledWith(url);
    expect(click).toHaveBeenCalledOnce();
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe(filename);
    expect(link.href).toBe("blob:downloaded-image");
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:downloaded-image");
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("keeps the existing direct-link fallback when fetching is unavailable", async () => {
    const url = "https://public-images.invalid/image.webp";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await downloadImage(url);
    expect(open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
