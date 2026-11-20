// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(), user: vi.fn(), parse: vi.fn(), persist: vi.fn(), reserve: vi.fn(), close: vi.fn(),
  findJob: vi.fn(), conversation: vi.fn(), transactionConversation: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  $transaction: mocks.transaction, conversation: { findFirst: mocks.conversation },
  generationJob: { findFirst: mocks.findJob, findMany: async () => [] },
} }));
vi.mock("@/lib/server/current-user", () => ({ requireCurrentUserRecord: mocks.user, getCurrentUserRecord: mocks.user }));
vi.mock("@/lib/generation/parse-generate-request", () => ({ parseGenerateRequest: mocks.parse }));
vi.mock("@/lib/auth/turnstile", () => ({ requireTurnstile: vi.fn() }));
vi.mock("@/lib/moderation/check", () => ({ checkGenerationInput: async () => ({ allowed: true }) }));
vi.mock("@/lib/storage/persist-generated-image", () => ({ persistGeneratedImage: mocks.persist }));
vi.mock("@/lib/storage/managed-image-storage", () => ({
  reserveManagedImageOutputs: mocks.reserve, closeManagedImageReservation: mocks.close,
  bindManagedImageOutputs: vi.fn(), resolveManagedImageUrl: vi.fn(),
}));
vi.mock("@/lib/storage/image-input-aliases", () => ({ bindManagedImageInputAliases: vi.fn() }));
vi.mock("@/lib/storage/image-source-presentation", () => ({ projectGenerationSourceUrls: async (jobs: unknown[]) => jobs }));
vi.mock("@/lib/providers/built-in-provider", () => ({
  getGenerationChannelForModel: async () => ({ id: "channel", creditCost: 5, defaultModel: "gpt-image-2", models: [] }),
  generationChannelModelSnapshot: () => ["gpt-image-2"],
}));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ BUILTIN_PROVIDER_CREDIT_COST: 5, WORKER_CONTRACTS_V1_ENABLED: false }) }));
vi.mock("@/lib/prisma-mappers", () => ({
  serializeGeneration: (job: unknown) => job,
  serializeGenerationForClient: async (job: unknown) => job,
  toPrismaGenerationType: (value: string) => value.toUpperCase(),
  toPrismaProviderMode: (value: string) => value.toUpperCase(),
}));
vi.mock("@/lib/server/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/rate-limit")>();
  return { ...actual, createRateLimiter: (options: Parameters<typeof actual.createRateLimiter>[0]) => ({
    ...actual.createRateLimiter(options), isLimited: () => false, record: () => undefined,
  }) };
});

import { POST } from "@/app/api/generate/route";
import { GET, DELETE } from "@/app/api/me/generations/[id]/route";
import { failGenerationJobAndRefund } from "@/lib/generation/job-refund";

type Job = Record<string, unknown> & {
  id: string; userId: string; status: string; workerManaged: boolean; creditsSpent: number;
  refundAppliedAt: Date | null; cancelRequestedAt: Date | null; sourceImageUrls: string[];
};
type State = { jobs: Map<string, Job>; credits: number; bannedAt: Date | null };
let state: State;
let queue: Promise<void>;
let loseEnableAck: boolean;
let loseAdmissionAck: boolean;
let events: string[];

function row(data: Record<string, unknown>): Job {
  return {
    id: "job", userId: "owner", status: "PENDING", workerManaged: true, creditsSpent: 5,
    contractVersion: 0, handoffState: null, attemptCount: 0, nextAttemptAt: null,
    refundAppliedAt: null, cancelRequestedAt: null, sourceImageUrls: [], images: [], videos: [], ...data,
  };
}

function matches(job: Job, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && "in" in value) return (value.in as unknown[]).includes(job[key]);
    return job[key] === value;
  });
}

// Serialized, rollbackable transactions model the User lock. SQL execution is
// asserted separately; this fixture is not a PostgreSQL lock-conformance test.
function transaction(snapshot: State) {
  return {
    $executeRaw: async (sql: TemplateStringsArray) => { events.push(sql.join("?")); return 1; },
    user: {
      findUnique: async () => ({ id: "owner", credits: snapshot.credits, bannedAt: snapshot.bannedAt }),
      updateMany: async ({ where, data }: { where: { credits: { gte: number } }; data: { credits: { decrement: number } } }) => {
        if (snapshot.credits < where.credits.gte) return { count: 0 };
        snapshot.credits -= data.credits.decrement;
        return { count: 1 };
      },
      update: async ({ data }: { data: { credits: { increment: number } } }) => { snapshot.credits += data.credits.increment; },
    },
    conversation: { findFirst: mocks.transactionConversation },
    generationJob: {
      count: async () => [...snapshot.jobs.values()].filter((job) => ["PENDING", "PROCESSING"].includes(job.status)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const job = row({ ...data, id: data.id ?? `job_${snapshot.jobs.size + 1}` });
        snapshot.jobs.set(job.id, job);
        return structuredClone(job);
      },
      findUnique: async ({ where }: { where: { id: string } }) => snapshot.jobs.get(where.id) ?? null,
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const job = snapshot.jobs.get(where.id);
        if (!job) throw new Error("job missing");
        return job;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const jobs = [...snapshot.jobs.values()].filter((job) => matches(job, where));
        for (const job of jobs) Object.assign(job, data);
        return { count: jobs.length };
      },
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function submit() { return POST(new Request("https://app.invalid/api/generate", { method: "POST" })); }

beforeEach(() => {
  vi.clearAllMocks();
  Reflect.deleteProperty(globalThis, Symbol.for("narra.generation-rate-limit"));
  state = { jobs: new Map(), credits: 100, bannedAt: null };
  queue = Promise.resolve(); loseEnableAck = false; loseAdmissionAck = false; events = [];
  mocks.transaction.mockImplementation((operation: (tx: ReturnType<typeof transaction>) => Promise<unknown>) => {
    const result = queue.then(async () => {
      const snapshot = structuredClone(state);
      const previousJobs = state.jobs.size;
      const previousRunnable = [...state.jobs.values()].filter((job) => job.workerManaged).length;
      const value = await operation(transaction(snapshot));
      state = snapshot;
      if (loseAdmissionAck && state.jobs.size > previousJobs) throw new Error("lost admission acknowledgement");
      if (loseEnableAck && [...state.jobs.values()].filter((job) => job.workerManaged).length > previousRunnable) {
        throw new Error("lost commit acknowledgement");
      }
      return value;
    });
    queue = result.then(() => undefined, () => undefined);
    return result;
  });
  mocks.user.mockResolvedValue({ id: "owner", credits: 100 });
  mocks.findJob.mockImplementation(async ({ where }: { where: { id: string; userId: string } }) => {
    const job = state.jobs.get(where.id);
    return job?.userId === where.userId ? job : null;
  });
  mocks.conversation.mockResolvedValue({ id: "conversation" });
  mocks.transactionConversation.mockResolvedValue(null);
  mocks.parse.mockResolvedValue({
    generationType: "image_to_image", providerMode: "built_in", model: "gpt-image-2", count: 1,
    prompt: "landscape", images: [new File(["reference"], "source.png", { type: "image/png" })], imageUrls: [],
  });
  mocks.persist.mockResolvedValue("https://app.invalid/reference.png");
  mocks.reserve.mockResolvedValue({ id: "reservation" });
  mocks.close.mockResolvedValue(undefined);
});

afterEach(() => { Reflect.deleteProperty(globalThis, Symbol.for("narra.generation-rate-limit")); });

describe("网页参考图上传前准入", () => {
  it("已有两个未完成任务时不保存参考图、不新增任务、不扣费", async () => {
    state.jobs.set("first", row({ id: "first" })); state.jobs.set("second", row({ id: "second" }));
    const response = await submit();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("同时最多 2 个任务") });
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(state.jobs.size).toBe(2); expect(state.credits).toBe(100);
    expect(events[0]).toContain("image_lock_reference_epoch");
    expect(events[1]).toContain('FROM "User"');
  });

  it("两个并发请求争最后一个名额，只有取得名额的请求上传", async () => {
    state.jobs.set("existing", row({ id: "existing" }));
    const upload = deferred<string>(); const entered = deferred<void>();
    mocks.persist.mockImplementation(() => { entered.resolve(); return upload.promise; });
    const first = submit(); await entered.promise;
    const second = await submit();
    expect(second.status).toBe(400);
    expect(mocks.persist).toHaveBeenCalledOnce();
    const staged = [...state.jobs.values()].find((job) => job.id !== "existing")!;
    expect(staged).toMatchObject({ status: "PENDING", workerManaged: false, sourceImageUrls: [], creditsSpent: 5 });
    upload.resolve("https://app.invalid/reference.png");
    expect((await first).status).toBe(200);
    expect(state.jobs.get(staged.id)).toMatchObject({ workerManaged: true, sourceImageUrls: ["https://app.invalid/reference.png"] });
    expect(state.credits).toBe(95);
  });

  it.each(["banned", "credits"])("鉴权后%s变化时上传前重新检查", async (change) => {
    if (change === "banned") state.bannedAt = new Date(); else state.credits = 4;
    expect((await submit()).status).toBe(change === "credits" ? 402 : 400);
    expect(mocks.persist).not.toHaveBeenCalled(); expect(state.jobs.size).toBe(0);
  });

  it("初次校验后会话归属变化，占位事务重新拒绝且不上传", async () => {
    mocks.parse.mockResolvedValue({ ...await mocks.parse(), conversationId: "conversation" });
    const response = await submit();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "会话不存在或不属于当前用户" });
    expect(mocks.transactionConversation).toHaveBeenCalledWith({ where: { id: "conversation", userId: "owner" }, select: { id: true } });
    expect(mocks.persist).not.toHaveBeenCalled(); expect(state.jobs.size).toBe(0); expect(state.credits).toBe(100);
  });

  it("上传失败退回实际扣费且重复补偿不再增加余额", async () => {
    mocks.persist.mockRejectedValueOnce(new Error("upload failed"));
    expect((await submit()).status).toBe(400);
    const [job] = state.jobs.values();
    expect(job).toMatchObject({ status: "FAILED", workerManaged: false, creditsSpent: 0 });
    expect(state.credits).toBe(100); expect(mocks.close).toHaveBeenCalledOnce();
    await failGenerationJobAndRefund({ jobId: job.id, errorMessage: "retry cleanup" });
    expect(state.credits).toBe(100);
  });

  it("四张任务在输出预留失败时退回20积分，Worker始终不可领取", async () => {
    mocks.parse.mockResolvedValue({ generationType: "text_to_image", providerMode: "built_in", model: "gpt-image-2", count: 4, prompt: "landscape", images: [], imageUrls: [] });
    mocks.reserve.mockRejectedValueOnce(new Error("storage full"));
    expect((await submit()).status).toBe(400);
    const [job] = state.jobs.values();
    expect(job).toMatchObject({ status: "FAILED", count: 4, workerManaged: false, creditsSpent: 0 });
    expect(state.credits).toBe(100); expect(mocks.persist).not.toHaveBeenCalled();
    await failGenerationJobAndRefund({ jobId: job.id, errorMessage: "retry cleanup" });
    expect(state.credits).toBe(100);
  });

  it.each(["cancel", "ban"])("上传期间%s后不得重新启用任务", async (change) => {
    const upload = deferred<string>(); const entered = deferred<void>();
    mocks.persist.mockImplementation(() => { entered.resolve(); return upload.promise; });
    const response = submit(); await entered.promise;
    const [job] = state.jobs.values();
    expect(job.workerManaged).toBe(false);
    if (change === "cancel") {
      const request = new Request(`https://app.invalid/api/me/generations/${job.id}`);
      const context = { params: Promise.resolve({ id: job.id }) };
      expect(await (await GET(request, context)).json()).toMatchObject({ data: { generation: { status: "PENDING" } } });
      const cancelled = await DELETE(request, context);
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ data: { refundedCredits: 5, generation: { status: "FAILED" } } });
    } else state.bannedAt = new Date();
    upload.resolve("https://app.invalid/reference.png");
    expect((await response).status).toBe(400);
    expect(state.jobs.get(job.id)).toMatchObject({ status: "FAILED", workerManaged: false, sourceImageUrls: [], creditsSpent: 0 });
    expect(state.credits).toBe(100);
  });

  it("启用事务已提交但回执丢失时不退款或关闭输出预留", async () => {
    loseEnableAck = true;
    await submit();
    const [job] = state.jobs.values();
    expect(job).toMatchObject({ status: "PENDING", workerManaged: true, creditsSpent: 5 });
    expect(state.credits).toBe(95); expect(mocks.close).not.toHaveBeenCalled();
  });

  it("占位事务已提交但回执丢失时按预先生成的任务ID补偿，且不上传", async () => {
    loseAdmissionAck = true;
    expect((await submit()).status).toBe(400);
    const [job] = state.jobs.values();
    expect(job).toMatchObject({ status: "FAILED", workerManaged: false, creditsSpent: 0 });
    expect(state.credits).toBe(100); expect(mocks.persist).not.toHaveBeenCalled();
  });
});
