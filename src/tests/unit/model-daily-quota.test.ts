import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findMany: vi.fn(), currentUser: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { modelDailyUsage: { findMany: mocks.findMany } } }));
vi.mock("@/lib/server/current-user", () => ({ getCurrentUserRecord: mocks.currentUser }));
import { assertModelDailyQuotaAvailable, getModelDailyQuotas, modelDailyQuotaError, modelQuotaDay } from "@/lib/server/model-daily-quota";
import { GET } from "@/app/api/me/model-quotas/route";

describe("daily dedicated model quota", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.findMany.mockResolvedValue([]); });
  afterEach(() => vi.useRealTimers());

  it("resets at Tokyo midnight, not the process local timezone", () => {
    expect(modelQuotaDay(new Date("2026-11-28T14:59:59.999Z"))).toEqual({ dateKey: "2026-11-28", resetAt: "2026-11-28T15:00:00.000Z" });
    expect(modelQuotaDay(new Date("2026-11-28T15:00:00.000Z"))).toEqual({ dateKey: "2026-11-29", resetAt: "2026-11-29T15:00:00.000Z" });
  });
  it("returns independent pools and personal usage without exposing other accounts", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-28T07:00:00Z"));
    mocks.findMany.mockResolvedValue([{ model: "seedream-5-5", userId: "me" }, { model: "seedream-5-5", userId: "another-private-id" }, { model: "h3", userId: "another-private-id" }]);
    const report = await getModelDailyQuotas("me");
    expect(report.models).toEqual([
      { model: "seedream-5-5", limit: 10, used: 2, remaining: 8, userUsed: true, userRemaining: 0 },
      { model: "h3", limit: 10, used: 1, remaining: 9, userUsed: false, userRemaining: 1 },
    ]);
    expect(JSON.stringify(report)).not.toContain("private-id");
    expect(mocks.findMany).toHaveBeenCalledWith({ where: { dateKey: "2026-11-28" }, select: { model: true, userId: true } });
  });
  it("blocks only the exhausted model and retains GPT behavior", async () => {
    mocks.findMany.mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({ model: "seedream-5-5", userId: String(index) })));
    await expect(assertModelDailyQuotaAvailable("new-user", "seedream-5-5")).rejects.toMatchObject({ code: "MODEL_DAILY_QUOTA_EXHAUSTED", status: 429 });
    await expect(assertModelDailyQuotaAvailable("new-user", "h3")).resolves.toBeUndefined();
    mocks.findMany.mockClear();
    await expect(assertModelDailyQuotaAvailable("new-user", "gpt-image-2")).resolves.toBeUndefined();
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it("limits a user separately for each model", async () => {
    mocks.findMany.mockResolvedValue([{ model: "h3", userId: "me" }]);
    await expect(assertModelDailyQuotaAvailable("me", "h3")).rejects.toMatchObject({ code: "MODEL_DAILY_QUOTA_USED", status: 429 });
    await expect(assertModelDailyQuotaAvailable("me", "seedream-5-5")).resolves.toBeUndefined();
  });
  it("maps race-time Prisma database errors to safe 429 messages", () => {
    const error = Object.assign(new Error("SQL query failed"), { meta: { driverAdapterError: { cause: { originalMessage: "MODEL_DAILY_QUOTA_USED", code: "P0001" } } } });
    expect(modelDailyQuotaError(error)).toMatchObject({ code: "MODEL_DAILY_QUOTA_USED", status: 429 });
    expect(modelDailyQuotaError(error)?.message).not.toContain("SQL");
    expect(modelDailyQuotaError(new Error("unrelated"))).toBeNull();
  });
  it("requires a session and prevents quota response caching", async () => {
    mocks.currentUser.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
    mocks.currentUser.mockResolvedValue({ id: "me" });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
