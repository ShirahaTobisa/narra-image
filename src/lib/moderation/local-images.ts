import "server-only";

import path from "node:path";
import { Worker } from "node:worker_threads";

export const LOCAL_IMAGE_MODEL = "nsfwjs/MobileNetV2Mid@4.4.0";

const MAX_REQUESTS = 3; // 一个活动请求，最多两个等待请求。
const MAX_IMAGE_BYTES = 256 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const RESTART_DELAY_MS = 1_000;
const POOL_KEY = Symbol.for("narra.local-image-moderation");
const CLASSES = ["Drawing", "Hentai", "Neutral", "Porn", "Sexy"] as const;

type ImageInput = { data: Buffer | Uint8Array; mimeType: string };
type LocalImageOutcome =
  | { blocked: false }
  | { blocked: true; category: "sexual"; score: number; model: string };
type Scores = Record<typeof CLASSES[number], number>;
type PendingRequest = {
  images: ReadonlyArray<ImageInput>;
  bytes: number;
  deadline: number;
  index: number;
  messageId?: number;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (outcome: LocalImageOutcome) => void;
  reject: (error: Error) => void;
};
type Runtime = { worker: Worker; ready: boolean; stopping: boolean };

function unavailable() {
  return new Error("本机图片审核暂时不可用");
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

  check(images: ReadonlyArray<ImageInput>): Promise<LocalImageOutcome> {
    const bytes = images.reduce((sum, image) => sum + image.data.byteLength, 0);
    if (this.runtime?.stopping || Date.now() < this.retryAt
      || this.queue.length + Number(Boolean(this.active)) >= MAX_REQUESTS
      || !Number.isSafeInteger(bytes) || bytes + this.bytes > MAX_IMAGE_BYTES) {
      return Promise.reject(unavailable());
    }
    return new Promise((resolve, reject) => {
      const request: PendingRequest = { images, bytes, deadline: Date.now() + REQUEST_TIMEOUT_MS, index: 0, resolve, reject };
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
          this.rejectPending();
          this.runtime = undefined;
          this.retryAt = Date.now() + RESTART_DELAY_MS;
          worker.removeAllListeners();
          worker.on("error", () => {});
        });
      } catch {
        this.retryAt = Date.now() + RESTART_DELAY_MS;
        this.rejectPending();
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
      this.fail(runtime);
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
      this.fail(runtime);
      return;
    }
    const scores = readScores(message.scores);
    if (message.error || !scores) {
      this.fail(runtime);
      return;
    }
    const explicitScore = Math.max(scores.Porn, scores.Hentai);
    if (explicitScore >= 0.2 || scores.Sexy >= 0.8) {
      this.finish(request, {
        blocked: true, category: "sexual", model: LOCAL_IMAGE_MODEL,
        score: Math.max(explicitScore, scores.Sexy >= 0.8 ? scores.Sexy : 0),
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
      this.fail(this.runtime);
      return;
    }
    const index = this.queue.indexOf(request);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.bytes -= request.bytes;
      request.reject(unavailable());
    }
  }

  private rejectPending() {
    const pending = this.active ? [this.active, ...this.queue] : this.queue;
    this.active = undefined;
    this.queue = [];
    this.bytes = 0;
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(unavailable());
    }
  }

  private fail(runtime: Runtime) {
    if (this.runtime !== runtime || runtime.stopping) return;
    runtime.stopping = true;
    this.retryAt = Date.now() + RESTART_DELAY_MS;
    this.rejectPending();
    // 保留旧实例直到 exit；terminate 失败时也不另开线程叠加负载。
    try { void runtime.worker.terminate().catch(() => undefined); }
    catch { /* 不确定已退出时继续拒绝新图片请求。 */ }
  }
}

export async function checkLocalImages(images: ReadonlyArray<ImageInput>): Promise<LocalImageOutcome> {
  if (images.length === 0) return { blocked: false };
  const processQueues = globalThis as unknown as Record<symbol, LocalImageQueue | undefined>;
  const queue = processQueues[POOL_KEY] ??= new LocalImageQueue();
  return queue.check(images);
}
