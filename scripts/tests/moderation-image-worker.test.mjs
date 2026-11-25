import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";
import sharp from "sharp";

import { readModerationRgb } from "../lib/moderation-image-input.mjs";

const CLASSES = ["Drawing", "Hentai", "Neutral", "Porn", "Sexy"];

test("本地图片模型离线协议与实际解码", { timeout: 30_000 }, async (t) => {
  const started = performance.now();
  const worker = new Worker(new URL("./fixtures/image-worker-offline.mjs", import.meta.url));
  t.after(() => worker.terminate());
  const [ready] = await once(worker, "message");
  assert.deepEqual(ready, { type: "ready", model: "nsfwjs/MobileNetV2Mid@4.4.0" });
  const coldMs = performance.now() - started;
  let id = 0;
  const classify = async (data) => {
    const expectedId = ++id;
    const response = once(worker, "message");
    worker.postMessage({ id: expectedId, data: new Uint8Array(data) });
    const [message] = await response;
    assert.equal(message.id, expectedId);
    return message;
  };
  const checkScores = (message) => {
    assert.equal(message.error, undefined);
    assert.deepEqual(Object.keys(message.scores).sort(), CLASSES);
    for (const score of Object.values(message.scores)) {
      assert.equal(Number.isFinite(score) && score >= 0 && score <= 1, true);
    }
    // Only the explicitly approved harmless fixtures use this assertion.
    assert.ok(message.scores.Porn < 0.2);
    assert.ok(message.scores.Hentai < 0.2);
    assert.ok(message.scores.Sexy < 0.8);
  };
  const white = await sharp({
    create: { width: 512, height: 512, channels: 3, background: "white" },
  }).png().toBuffer();

  await t.test("无害图返回完整分数，输入字节未被改动或detach", async () => {
    const original = Buffer.from(white);
    checkScores(await classify(white));
    assert.deepEqual(white, original);
  });

  await t.test("损坏图片仅返回稳定错误，后续无害图片仍可处理", async () => {
    const response = await classify(Buffer.from("not an image"));
    assert.deepEqual(response, { id, error: "decode_failed" });
    checkScores(await classify(white));
  });

  await t.test("全透明彩色图保留隐藏RGB后缩小，和相同不透明RGB一致", async () => {
    const pixels = Buffer.from([
      255, 0, 0, 0, 0, 255, 0, 0,
      0, 0, 255, 0, 255, 255, 0, 0,
    ]);
    const transparent = await sharp(pixels, {
      raw: { width: 2, height: 2, channels: 4 },
    }).png().toBuffer();
    const opaque = await sharp(transparent).removeAlpha().png().toBuffer();
    const rgb = await readModerationRgb(transparent);
    assert.equal(rgb.length, 224 * 224 * 3);
    assert.deepEqual(Array.from(rgb.subarray(0, 3)), [255, 0, 0]);
    assert.equal(rgb.equals(await readModerationRgb(opaque)), true);
    const transparentResult = await classify(transparent);
    const opaqueResult = await classify(opaque);
    assert.equal(transparentResult.error, undefined);
    assert.equal(opaqueResult.error, undefined);
    assert.deepEqual(transparentResult.scores, opaqueResult.scores);
  });

  await t.test("EXIF方向先应用到送入模型的RGB", async () => {
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]];
    const pixels = Buffer.alloc(32 * 48 * 3);
    for (let y = 0; y < 48; y += 1) {
      for (let x = 0; x < 32; x += 1) {
        pixels.set(colors[Math.floor(y / 16) * 2 + Math.floor(x / 16)], (y * 32 + x) * 3);
      }
    }
    const oriented = await sharp(pixels, {
      raw: { width: 32, height: 48, channels: 3 },
    }).withMetadata({ orientation: 6 }).png().toBuffer();
    const actual = await readModerationRgb(oriented);
    const rotatedColors = [colors[4], colors[2], colors[0], colors[5], colors[3], colors[1]];
    for (let i = 0; i < rotatedColors.length; i += 1) {
      const x = Math.floor(((i % 3) + 0.5) * 224 / 3);
      const y = Math.floor((Math.floor(i / 3) + 0.5) * 224 / 2);
      const pixel = actual.subarray((y * 224 + x) * 3, (y * 224 + x) * 3 + 3);
      // Embedded sRGB conversion can round a channel by one.
      assert.equal(pixel.every((value, channel) => Math.abs(value - rotatedColors[i][channel]) <= 1), true);
    }
  });

  await t.test("超过64MP的完整无害图片在解码前拒绝", async () => {
    const oversized = await sharp({
      create: { width: 8001, height: 8000, channels: 3, background: "white" },
    }).png().toBuffer();
    await assert.rejects(readModerationRgb(oversized), /pixel limit/i);
    const response = await classify(oversized);
    assert.deepEqual(response, { id, error: "decode_failed" });
  });

  await t.test("站内已确认无害素材与16张串行推理可离线完成", async () => {
    const character = await readFile(new URL("../../public/pet/character.png", import.meta.url));
    const landscape = await readFile(new URL("../../public/marketing/home/jiangnan-rain-v2.png", import.meta.url));
    const inputs = [white, character, landscape];
    const originals = inputs.map((input) => Buffer.from(input));
    const batchStarted = performance.now();
    for (let i = 0; i < 16; i += 1) {
      checkScores(await classify(inputs[i % inputs.length]));
    }
    assert.deepEqual(inputs, originals);
    t.diagnostic(JSON.stringify({
      node: process.version,
      platform: process.platform,
      coldMs: Math.round(coldMs),
      serial16Ms: Math.round(performance.now() - batchStarted),
      rssMiB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    }));
  });
});
