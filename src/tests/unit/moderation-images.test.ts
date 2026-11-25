import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { CANVAS_LIMITS } from "@/lib/canvas/contracts";
import { verifyCanvasImage } from "@/lib/canvas/image-container";
import { assertModerationImages } from "@/lib/moderation/images";
import { canvasPng, canvasPngChunk } from "./helpers/canvas-api-fixtures";

function animatedPng() {
  const png = canvasPng();
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2);
  const frame = Buffer.alloc(26); frame.writeUInt32BE(1, 4); frame.writeUInt32BE(1, 8); frame.writeUInt16BE(10, 20); frame.writeUInt16BE(100, 22);
  const secondFrame = Buffer.from(frame); secondFrame.writeUInt32BE(1);
  const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
  return Buffer.concat([
    png.subarray(0, 33), canvasPngChunk("acTL", animation), canvasPngChunk("fcTL", frame),
    png.subarray(33, png.length - 12), canvasPngChunk("fcTL", secondFrame),
    canvasPngChunk("fdAT", Buffer.concat([sequence, deflateSync(Buffer.from([0, 255, 255, 255, 255]))])),
    png.subarray(png.length - 12),
  ]);
}

describe("moderation reference image validation", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)("accepts an actual still %s without changing the original bytes", async (format) => {
    const data = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } }).toFormat(format).toBuffer();
    const original = Buffer.from(data);
    await expect(assertModerationImages([{ data, mimeType: `image/${format}` }])).resolves.toBeUndefined();
    expect(data).toEqual(original);
  });

  it("accepts Uint8Array views without reading unrelated surrounding bytes", async () => {
    const png = canvasPng();
    const padded = Buffer.concat([Buffer.from("outside"), png, Buffer.from("outside")]);
    const data = new Uint8Array(padded.buffer, padded.byteOffset + 7, png.length);
    await expect(assertModerationImages([{ data, mimeType: "image/png" }])).resolves.toBeUndefined();
  });

  it("rejects an oversized image before decoding", async () => {
    await expect(assertModerationImages([{ data: Buffer.alloc(20 * 1024 * 1024 + 1), mimeType: "image/png" }]))
      .rejects.toMatchObject({ code: "image_byte_limit", message: expect.stringMatching(/20/) });
  });

  it("accepts a valid PNG over 8 MiB for moderation while preserving the Canvas upload limit", async () => {
    const data = await sharp({ create: { width: 1700, height: 1700, channels: 3, background: "white" } })
      .png({ compressionLevel: 0 }).toBuffer();
    expect(data.byteLength).toBeGreaterThan(CANVAS_LIMITS.importBytes);
    expect(data.byteLength).toBeLessThan(20 * 1024 * 1024);
    expect(() => verifyCanvasImage(data, "image/png")).toThrow(expect.objectContaining({ code: "CANVAS_LIMIT_EXCEEDED" }));
    await expect(assertModerationImages([{ data, mimeType: "image/png" }])).resolves.toBeUndefined();
  });

  it.each([
    { data: Buffer.from("not an image"), mimeType: "image/png" },
    { data: canvasPng(), mimeType: "image/jpeg" },
    { data: canvasPng().subarray(0, 30), mimeType: "image/png" },
    { data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), mimeType: "image/svg+xml" },
  ])("rejects fake, mismatched, incomplete or unsupported image data: $mimeType", async (image) => {
    await expect(assertModerationImages([image])).rejects.toThrow();
  });

  it.each(["gif", "webp"] as const)("rejects animated %s even when its first frame is a harmless pixel", async (format) => {
    const data = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    }).toFormat(format, { delay: [100, 100], loop: 0 }).toBuffer();
    expect((await sharp(data).metadata()).pages).toBe(2);
    await expect(assertModerationImages([{ data, mimeType: `image/${format}` }]))
      .rejects.toMatchObject({ code: "image_animated", message: expect.stringMatching(/静态/) });
  });

  it("distinguishes unsupported formats, MIME mismatch, decode and container failures", async () => {
    const avif = await sharp(canvasPng()).avif().toBuffer();
    const invalidContainer = Buffer.from(canvasPng());
    invalidContainer[29] ^= 1; // Metadata remains readable, but IHDR CRC is invalid.
    for (const [data, mimeType, code, actualFormat] of [
      [avif, "image/avif", "image_format_unsupported", "heif"],
      [canvasPng(), "image/jpeg", "image_mime_mismatch", "png"],
      [Buffer.from("private-image-payload"), "image/png", "image_decode_failed", undefined],
      [invalidContainer, "image/png", "image_container_invalid", undefined],
    ] as const) {
      await expect(assertModerationImages([{ data, mimeType }])).rejects.toMatchObject({ code, actualFormat });
    }
  });

  it("rejects APNG even when the decoder reports only PNG metadata", async () => {
    const data = animatedPng();
    expect((await sharp(data).metadata()).format).toBe("png");
    await expect(assertModerationImages([{ data, mimeType: "image/png" }])).rejects.toThrow(/静态/);
  });

  it("checks every reference, including later images", async () => {
    await expect(assertModerationImages([
      { data: canvasPng(), mimeType: "image/png" },
      { data: animatedPng(), mimeType: "image/png" },
    ])).rejects.toThrow(/静态/);
  });
});
