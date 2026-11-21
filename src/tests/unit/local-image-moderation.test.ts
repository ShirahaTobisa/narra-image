// @vitest-environment node
import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { workerConstructor } = vi.hoisted(() => ({ workerConstructor: vi.fn() }));
vi.mock("node:worker_threads", () => ({ Worker: workerConstructor }));

import { checkLocalImages, LOCAL_IMAGE_MODEL } from "@/lib/moderation/local-images";

const poolKey = Symbol.for("narra.local-image-moderation");
const instances: TestWorker[] = [];
const safeScores = { Drawing: 0.01, Hentai: 0.01, Neutral: 0.96, Porn: 0.01, Sexy: 0.01 };
type ImageInput = Parameters<typeof checkLocalImages>[0][number];
type Message = { id: number; data: Uint8Array };

class TestWorker extends EventEmitter {
  sent: Message[] = [];
  autoExit = true;
  exited = false;
  private exitPromise = new Promise<number>((resolve) => this.once("exit", resolve));
  ref = vi.fn(() => this);
  unref = vi.fn(() => this);
  postMessage = vi.fn((message: Message, transferList?: ArrayBuffer[]) => {
    this.sent.push(structuredClone(message, { transfer: transferList ?? [] }));
  });
  terminate = vi.fn(() => {
    if (this.autoExit) void Promise.resolve().then(() => this.exit(1));
    return this.exitPromise;
  });
  ready(model = LOCAL_IMAGE_MODEL) { this.emit("message", { type: "ready", model }); }
  reply(scores: unknown = safeScores) {
    this.emit("message", { id: this.sent.at(-1)?.id, scores });
  }
  exit(code = 0) {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code);
  }
}

function image(value = 1): ImageInput {
  return { data: Buffer.from([value]), mimeType: "image/png" };
}

// Observe failures immediately so simulated crashes never create unhandled rejections.
function check(images: ReadonlyArray<ImageInput> = [image()], threshold = 0.7) {
  return checkLocalImages(images, threshold).catch(() => "unavailable" as const);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  workerConstructor.mockReset();
  workerConstructor.mockImplementation(function () {
    const worker = new TestWorker();
    instances.push(worker);
    return worker;
  });
});

afterEach(async () => {
  for (const worker of instances.splice(0)) worker.exit();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  delete (globalThis as unknown as Record<symbol, unknown>)[poolKey];
  vi.useRealTimers();
});

describe("本机图片审核管理器", () => {
  it("纯文本没有图片时不创建线程", async () => {
    expect(await check([])).toEqual({ blocked: false });
    expect(workerConstructor).not.toHaveBeenCalled();
  });

  it("等待固定模型就绪，复用线程，并在空闲时 unref", async () => {
    const first = check();
    const worker = instances[0];
    expect(workerConstructor.mock.calls[0][0]).toBe(path.resolve("scripts/moderation-image-worker.mjs"));
    expect(worker.sent).toEqual([]);
    worker.ready();
    worker.reply();
    expect(await first).toEqual({ blocked: false });
    expect(worker.unref).toHaveBeenCalled();

    const second = check();
    worker.reply();
    expect(await second).toEqual({ blocked: false });
    expect(instances).toHaveLength(1);
    expect(worker.ref).toHaveBeenCalled();
  });

  it.each([
    { category: "Porn", score: 0.7, threshold: 0.7, blocked: true },
    { category: "Hentai", score: 0.7, threshold: 0.7, blocked: true },
    { category: "Sexy", score: 0.8, threshold: 0.7, blocked: true },
    { category: "Porn", score: 0.699, threshold: 0.7, blocked: false },
    { category: "Hentai", score: 0.699, threshold: 0.7, blocked: false },
    { category: "Sexy", score: 0.799, threshold: 0.7, blocked: false },
    { category: "Hentai", score: 0.2, threshold: 0.2, blocked: true },
    { category: "Sexy", score: 0.799, threshold: 0.2, blocked: false },
    { category: "Sexy", score: 0.899, threshold: 0.9, blocked: false },
  ])("$category=$score 到后台阈值 $threshold 才拒绝，Sexy 的线不低于 0.8", async ({ category, score, threshold, blocked }) => {
    const result = check([image()], threshold);
    instances[0].ready();
    instances[0].reply({ ...safeScores, [category]: score });
    expect(await result).toEqual(blocked
      ? { blocked: true, category: "sexual", score, model: LOCAL_IMAGE_MODEL }
      : { blocked: false });
  });

  it.each([
    {},
    { Drawing: 0, Hentai: 0, Neutral: 1, Porn: 0 },
    { ...safeScores, Porn: Number.NaN },
    { ...safeScores, Hentai: Number.POSITIVE_INFINITY },
    { ...safeScores, Sexy: -0.1 },
    { ...safeScores, Drawing: 1.1 },
    { ...safeScores, Porn: "0" },
  ])("五类分数缺失或无效时不可用，不放行：%j", async (scores) => {
    const result = check();
    instances[0].ready();
    instances[0].reply(scores);
    expect(await result).toBe("unavailable");
  });

  it("16张逐图检查，末张命中也会整批拒绝", async () => {
    const result = check(Array.from({ length: 16 }, (_, i) => image(i)));
    const worker = instances[0];
    worker.ready();
    for (let index = 0; index < 16; index += 1) {
      expect(worker.sent).toHaveLength(index + 1);
      expect(Array.from(worker.sent[index].data)).toEqual([index]);
      worker.reply(index === 15 ? { ...safeScores, Hentai: 0.9 } : safeScores);
    }
    expect(await result).toEqual({ blocked: true, category: "sexual", score: 0.9, model: LOCAL_IMAGE_MODEL });
  });

  it("复制当前视图的精确字节，既不 detach 原图也不发送周围字节", async () => {
    const backing = new Uint8Array([99, 1, 2, 3, 88]);
    const view = new Uint8Array(backing.buffer, 1, 3);
    const buffer = Buffer.from([4, 5]);
    const result = check([{ data: view, mimeType: "image/png" }, { data: buffer, mimeType: "image/png" }]);
    const worker = instances[0];
    worker.ready();
    expect(Array.from(worker.sent[0].data)).toEqual([1, 2, 3]);
    expect(worker.sent[0].data.buffer.byteLength).toBe(3);
    worker.sent[0].data.fill(0);
    worker.reply();
    expect(Array.from(worker.sent[1].data)).toEqual([4, 5]);
    worker.reply();
    expect(await result).toEqual({ blocked: false });
    expect(Array.from(backing)).toEqual([99, 1, 2, 3, 88]);
    expect(Array.from(buffer)).toEqual([4, 5]);
  });

  it("最多一个活动加两个等待请求，完成后按顺序释放许可", async () => {
    const pending = [check([image(1)]), check([image(2)]), check([image(3)])];
    expect(await check([image(4)])).toBe("unavailable");
    const worker = instances[0];
    worker.ready();
    for (const value of [1, 2, 3]) {
      expect(Array.from(worker.sent.at(-1)!.data)).toEqual([value]);
      worker.reply();
    }
    expect(await Promise.all(pending)).toEqual(Array(3).fill({ blocked: false }));
    const next = check();
    worker.reply();
    expect(await next).toEqual({ blocked: false });
    expect(instances).toHaveLength(1);
  });

  it("整请求预算含全部图片，256MiB可接纳、超量不创建或复制，失败后释放", async () => {
    const data = new Uint8Array(64 * 1024 * 1024);
    const large = { data, mimeType: "image/png" };
    expect(await check(Array(5).fill(large))).toBe("unavailable");
    expect(workerConstructor).not.toHaveBeenCalled();

    const full = check(Array(4).fill(large));
    expect(await check()).toBe("unavailable");
    expect(instances[0].sent).toEqual([]);
    instances[0].emit("error", new Error("mock crash"));
    expect(await full).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(1_001);
    const next = check();
    instances[1].ready();
    instances[1].reply();
    expect(await next).toEqual({ blocked: false });
  });

  it("8秒截止包括冷加载和排队，不在开始推理时重新计时", async () => {
    const first = check();
    const queued = check();
    await vi.advanceTimersByTimeAsync(7_000);
    const worker = instances[0];
    worker.ready();
    worker.reply();
    expect(await first).toEqual({ blocked: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await queued).toBe("unavailable");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it.each(["ready", "result"])("定时器尚未执行时，超过截止的 %s 不能被接受", async (stage) => {
    const result = check();
    const worker = instances[0];
    if (stage === "result") worker.ready();
    vi.setSystemTime(8_001);
    if (stage === "ready") worker.ready();
    else worker.reply();
    expect(await result).toBe("unavailable");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("活动超时真实终止，旧线程退出前不能再建；迟到结果不影响新请求", async () => {
    const timedOut = check();
    const worker = instances[0];
    worker.autoExit = false;
    worker.ready();
    const oldId = worker.sent[0].id;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await timedOut).toBe("unavailable");
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await check()).toBe("unavailable");
    expect(instances).toHaveLength(1);
    worker.exit(1);
    await vi.advanceTimersByTimeAsync(1_001);
    const next = check();
    const replacement = instances[1];
    replacement.ready();
    worker.emit("message", { id: oldId, scores: { ...safeScores, Porn: 1 } });
    replacement.reply();
    expect(await next).toEqual({ blocked: false });
  });

  it.each(["error", "messageerror", "exit-zero", "exit-one", "reply-error", "wrong-model"])("%s 清理所有请求，不留挂起或失效预算", async (failure) => {
    const pending = [check(), check(), check()];
    const worker = instances[0];
    if (failure === "wrong-model") worker.ready("different-model");
    else {
      worker.ready();
      if (failure === "exit-zero") worker.exit(0);
      else if (failure === "exit-one") worker.exit(1);
      else if (failure === "reply-error") worker.emit("message", { id: worker.sent[0].id, error: true });
      else worker.emit(failure, new Error("private runtime details"));
    }
    expect(await Promise.all(pending)).toEqual(["unavailable", "unavailable", "unavailable"]);
    expect(await check([])).toEqual({ blocked: false });
    expect(await check()).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(1_001);
    const next = check();
    instances[1].ready();
    instances[1].reply();
    expect(await next).toEqual({ blocked: false });
  });

  it("创建和发送的同步异常也释放许可", async () => {
    workerConstructor.mockImplementationOnce(function () { throw new Error("cannot create worker"); });
    expect(await check()).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(1_001);
    const sendFailure = check();
    instances[0].postMessage.mockImplementationOnce(() => { throw new Error("clone failed"); });
    instances[0].ready();
    expect(await sendFailure).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(1_001);
    const next = check();
    instances[1].ready();
    instances[1].reply();
    expect(await next).toEqual({ blocked: false });
  });

  it("上一张重复消息不能跳过下一张检查", async () => {
    const result = check([image(1), image(2)]);
    const worker = instances[0];
    worker.ready();
    const firstId = worker.sent[0].id;
    worker.reply();
    worker.emit("message", { id: firstId, scores: safeScores });
    worker.reply({ ...safeScores, Porn: 0.8 });
    expect(await result).toEqual({ blocked: true, category: "sexual", score: 0.8, model: LOCAL_IMAGE_MODEL });
  });
});
