import "server-only";

import path from "node:path";
import { Worker } from "node:worker_threads";

import { ModerationFailure } from "@/lib/moderation/failure";

export const LOCAL_IMAGE_MODEL = "nsfwjs/MobileNetV2Mid@4.4.0";

const MAX_REQUESTS = 3; // 一个活动请求，最多两个等待请求。
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const RESTART_DELAY_MS = 1_000;
const POOL_KEY = Symbol.for("narra.local-image-moderation");
const CLASSES = ["Drawing", "Hentai", "Neutral", "Porn", "Sexy"] as const;
/** Sexy 只是性感、不算露骨：拒绝线不低于这个值，后台阈值调严时普通人像才不会被误拒。 */
const SEXY_MIN_THRESHOLD = 0.8;

type ImageInput = { data: Buffer | Uint8Array; mimeType: string };
type LocalImageOutcome =
  | { blocked: false }
  | { blocked: true; category: "sexual"; score: number; model: string };
type Scores = Record<typeof CLASSES[number], number>;
type PendingRequest = {
  images: ReadonlyArray<ImageInput>;
  threshold: number;
  bytes: number;
  deadline: number;
  index: number;
  messageId?: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (outcome: LocalImageOutcome) => void;
  reject: (error: Error) => void;
};
type Runtime = { worker: Worker; ready: boolean; stopping: boolean };

function unavailable(code: string, imageIndex?: number) {
  return new ModerationFailure(code, { imageIndex, message: "本机图片审核暂时不可用" });
}

function readScores(value: unknown): Scores | null {
  if (!value || typeof value !== "object" || Object.keys(value).length !== CLASSES.length) return null;
  const scores = value as Record<string, unknown>;
  return CLASSES.every((name) => typeof scores[name] === "number"
    && Number.isFinite(scores[name]) && scores[name] >= 0 && scores[name] <= 1)
    ? scores as Scores : null;
}

class LocalImageQueue {
  private runtime?: Runtime;
  private active?: PendingRequest;
  private queue: PendingRequest[] = [];
  private bytes = 0;
  private nextId = 0;
  private retryAt = 0;

  check(images: ReadonlyArray<ImageInput>, threshold: number): Promise<LocalImageOutcome> {
    const bytes = images.reduce((sum, image) => sum + image.data.byteLength, 0);
    if (this.runtime?.stopping || Date.now() < this.retryAt) {
      return Promise.reject(unavailable("local_worker_restarting"));
    }
    if (this.queue.length + Number(Boolean(this.active)) >= MAX_REQUESTS) {
      return Promise.reject(unavailable("local_queue_full"));
    }
    if (!Number.isSafeInteger(bytes) || bytes + this.bytes > MAX_IMAGE_BYTES) {
      return Promise.reject(unavailable("local_byte_limit"));
    }
    return new Promise((resolve, reject) => {
      const request: PendingRequest = { images, threshold, bytes, deadline: Date.now() + REQUEST_TIMEOUT_MS, index: 0, resolve, reject };
      request.timer = setTimeout(() => this.expire(request), REQUEST_TIMEOUT_MS);
      this.bytes += bytes;
      this.queue.push(request);
      this.pump();
    });
  }

  private pump() {
    if (this.active || this.runtime?.stopping) return;
    this.active = this.queue.shift();
    if (!this.active) {
      this.runtime?.worker.unref();
      return;
    }
    if (!this.runtime) {
      try {
        const worker = new Worker(path.resolve(process.cwd(), "scripts/moderation-image-worker.mjs"));
        const runtime: Runtime = { worker, ready: false, stopping: false };
        this.runtime = runtime;
        worker.on("message", (message: unknown) => this.receive(runtime, message));
        worker.on("error", () => this.fail(runtime));
        worker.on("messageerror", () => this.fail(runtime));
        worker.once("exit", () => {
          if (this.runtime !== runtime) return;
          this.rejectPending(runtime.ready ? "local_worker_exit" : "local_worker_startup");
          this.runtime = undefined;
          this.retryAt = Date.now() + RESTART_DELAY_MS;
          worker.removeAllListeners();
          worker.on("error", () => {});
        });
      } catch {
        this.retryAt = Date.now() + RESTART_DELAY_MS;
        this.rejectPending("local_worker_startup");
        return;
      }
    }
    this.runtime.worker.ref();
    this.send(this.runtime);
  }

  private send(runtime: Runtime) {
    const request = this.active;
    if (!runtime.ready || runtime.stopping || !request || request.messageId !== undefined) return;
    if (Date.now() >= request.deadline) {
      this.fail(runtime, "local_timeout");
      return;
    }
    try {
      request.messageId = ++this.nextId;
      // 精确复制当前视图；原 Buffer 和同底层的其他视图仍由调用方使用。
      runtime.worker.postMessage({
        id: request.messageId,
        data: new Uint8Array(request.images[request.index].data),
      });
    } catch {
      this.fail(runtime);
    }
  }

  private receive(runtime: Runtime, value: unknown) {
    if (this.runtime !== runtime || runtime.stopping) return;
    if (!value || typeof value !== "object") {
      this.fail(runtime);
      return;
    }
    const message = value as { type?: unknown; model?: unknown; id?: unknown; error?: unknown; scores?: unknown };
    if (!runtime.ready) {
      if (message.type !== "ready" || message.model !== LOCAL_IMAGE_MODEL) {
        this.fail(runtime);
        return;
      }
      runtime.ready = true;
      this.send(runtime);
      return;
    }
    const request = this.active;
    if (!request || message.id !== request.messageId) return;
    if (Date.now() >= request.deadline) {
      this.fail(runtime, "local_timeout");
      return;
    }
    const scores = readScores(message.scores);
    if (message.error || !scores) {
      const code = message.error === "decode_failed" ? "local_decode_failed"
        : message.error === "inference_failed" ? "local_inference_failed"
          : message.error ? "local_worker_error" : "local_scores_invalid";
      this.fail(runtime, code);
      return;
    }
    // 和远程审核用同一个后台阈值：分数没到就不拒。
    const explicitScore = Math.max(scores.Porn, scores.Hentai);
    const sexyBlocked = scores.Sexy >= Math.max(request.threshold, SEXY_MIN_THRESHOLD);
    if (explicitScore >= request.threshold || sexyBlocked) {
      this.finish(request, {
        blocked: true, category: "sexual", model: LOCAL_IMAGE_MODEL,
        score: Math.max(explicitScore, sexyBlocked ? scores.Sexy : 0),
      });
      return;
    }
    request.index += 1;
    request.messageId = undefined;
    if (request.index === request.images.length) this.finish(request, { blocked: false });
    else this.send(runtime);
  }

  private finish(request: PendingRequest, outcome: LocalImageOutcome) {
    clearTimeout(request.timer);
    this.bytes -= request.bytes;
    this.active = undefined;
    request.resolve(outcome);
    this.pump();
  }

  private expire(request: PendingRequest) {
    if (this.active === request && this.runtime) {
      this.fail(this.runtime, "local_timeout");
      return;
    }
    const index = this.queue.indexOf(request);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.bytes -= request.bytes;
      request.reject(unavailable("local_timeout"));
    }
  }

  private rejectPending(code: string) {
    const pending = this.active ? [this.active, ...this.queue] : this.queue;
    this.active = undefined;
    this.queue = [];
    this.bytes = 0;
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(unavailable(code, request.messageId === undefined ? undefined : request.index));
    }
  }

  private fail(runtime: Runtime, code = runtime.ready ? "local_worker_error" : "local_worker_startup") {
    if (this.runtime !== runtime || runtime.stopping) return;
    runtime.stopping = true;
    this.retryAt = Date.now() + RESTART_DELAY_MS;
    this.rejectPending(code);
    // 保留旧实例直到 exit；terminate 失败时也不另开线程叠加负载。
    try { void runtime.worker.terminate().catch(() => undefined); }
    catch { /* 不确定已退出时继续拒绝新图片请求。 */ }
  }
}

export async function checkLocalImages(
  images: ReadonlyArray<ImageInput>,
  threshold: number,
): Promise<LocalImageOutcome> {
  if (images.length === 0) return { blocked: false };
  const processQueues = globalThis as unknown as Record<symbol, LocalImageQueue | undefined>;
  const queue = processQueues[POOL_KEY] ??= new LocalImageQueue();
  return queue.check(images, threshold);
}
