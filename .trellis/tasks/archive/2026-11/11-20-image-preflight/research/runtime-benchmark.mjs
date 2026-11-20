// Run from the repo/runner working directory; no credentials or network needed.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import sharp from "sharp";

sharp.cache(false);
sharp.concurrency(1);
const white = await sharp({
  create: { width: 512, height: 512, channels: 3, background: "white" },
}).png().toBuffer();
const transparent64mp = await sharp({
  create: {
    width: 8000, height: 8000, channels: 4,
    background: { r: 255, g: 0, b: 0, alpha: 0 },
  },
}).png().toBuffer();
const inputs = [
  white,
  await readFile("public/pet/character.png"),
  await readFile("public/marketing/home/jiangnan-rain-v2.png"),
];
const originals = inputs.map((data) => Buffer.from(data));
const baselineRss = process.memoryUsage.rss();
let peakRss = baselineRss;
const sampling = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
}, 5);
const deadline = setTimeout(() => {
  console.error("Runtime benchmark exceeded 30 seconds");
  process.exit(1);
}, 30_000);
const started = performance.now();
// Empty execArgv allows this same file via node --input-type=module on stdin.
const worker = new Worker(path.resolve("scripts/tests/fixtures/image-worker-offline.mjs"), { execArgv: [] });
try {
  const [ready] = await once(worker, "message");
  assert.deepEqual(ready, { type: "ready", model: "nsfwjs/MobileNetV2Mid@4.4.0" });
  const coldMs = performance.now() - started;
  let id = 0;
  const classify = async (data) => {
    const nextId = ++id;
    const response = once(worker, "message");
    worker.postMessage({ id: nextId, data: new Uint8Array(data) });
    const [message] = await response;
    assert.equal(message.id, nextId);
    assert.equal(message.error, undefined);
    assert.deepEqual(Object.keys(message.scores).sort(), ["Drawing", "Hentai", "Neutral", "Porn", "Sexy"]);
    return message.scores;
  };
  const times = [];
  for (let i = 0; i < 16; i += 1) {
    const start = performance.now();
    const scores = await classify(inputs[i % inputs.length]);
    assert.ok(scores.Porn < 0.2 && scores.Hentai < 0.2 && scores.Sexy < 0.8);
    times.push(performance.now() - start);
  }
  assert.deepEqual(inputs, originals);
  const ordinaryPeakMiB = peakRss / 1048576;
  const alphaStart = performance.now();
  const alphaCount = process.argv.includes("--alpha-batch") ? 16 : 1;
  for (let i = 0; i < alphaCount; i += 1) await classify(transparent64mp);
  const alphaBatchMs = performance.now() - alphaStart;
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  const sorted = [...times].sort((a, b) => a - b);
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch,
    coldMs, serial16Ms: times.reduce((sum, ms) => sum + ms, 0),
    hotP50Ms: sorted[8], hotMaxMs: sorted[15], alphaCount, alphaBatchMs,
    baselineMiB: baselineRss / 1048576, ordinaryPeakMiB,
    peakIncludingAlpha64mpMiB: peakRss / 1048576,
    alphaInputBytes: transparent64mp.length,
  }));
} finally {
  clearInterval(sampling);
  clearTimeout(deadline);
  await worker.terminate();
}
