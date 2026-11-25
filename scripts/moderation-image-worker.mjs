import { createRequire } from "node:module";
import path from "node:path";
import { parentPort } from "node:worker_threads";
import sharp from "sharp";
import { load } from "nsfwjs/core";
import { MobileNetV2MidModel } from "nsfwjs/models/mobilenet_v2_mid";

import { readModerationRgb } from "./lib/moderation-image-input.mjs";

const require = createRequire(import.meta.url);
const tf = require("@tensorflow/tfjs");
const wasm = require("@tensorflow/tfjs-backend-wasm");

sharp.cache(false);
sharp.concurrency(1);
wasm.setThreadsCount(1);
// Next bundles this worker, and a bundled require.resolve() returns a module number instead of
// a path, so the model never loaded in production. The app always starts from its own root.
wasm.setWasmPaths(
  path.join(process.cwd(), "node_modules/@tensorflow/tfjs-backend-wasm/dist") + path.sep,
);
if (!(await tf.setBackend("wasm"))) throw new Error("Image model unavailable");
await tf.ready();
// Keep native ESM imports: CJS model wrappers expand large base64 strings.
const model = await load("MobileNetV2Mid", {
  modelDefinitions: [MobileNetV2MidModel],
});

parentPort.postMessage({ type: "ready", model: "nsfwjs/MobileNetV2Mid@4.4.0" });
parentPort.on("message", async ({ id, data }) => {
  let tensor;
  let error = "decode_failed";
  try {
    const rgb = await readModerationRgb(data);
    error = "inference_failed";
    tensor = tf.tensor3d(new Uint8Array(rgb), [224, 224, 3], "int32");
    const predictions = await model.classify(tensor, 5);
    parentPort.postMessage({
      id,
      scores: Object.fromEntries(
        predictions.map(({ className, probability }) => [className, probability]),
      ),
    });
  } catch {
    parentPort.postMessage({ id, error });
  } finally {
    tensor?.dispose();
  }
});
