import "server-only";
import { db } from "@/lib/db";
import { GenerationContractError } from "@/lib/generation/contracts";
import { isDedicatedModel } from "@/lib/generation/model-limits";
import catalog from "../../../contracts/generation/v1/dedicated-models.json";

export function modelQuotaDay(now = new Date()) {
  const dateKey = new Date(now.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
  const resetAt = new Date(Date.parse(`${dateKey}T00:00:00+09:00`) + 24 * 60 * 60_000).toISOString();
  return { dateKey, resetAt };
}

export async function getModelDailyQuotas(userId: string) {
  const day = modelQuotaDay();
  const records = await db.modelDailyUsage.findMany({ where: { dateKey: day.dateKey }, select: { model: true, userId: true } });
  return { ...day, models: catalog.models.map(({ model }) => {
    const used = records.filter((row) => row.model === model).length;
    const userUsed = records.some((row) => row.model === model && row.userId === userId);
    return { model, limit: catalog.dailyQuota.limit, used, remaining: Math.max(0, catalog.dailyQuota.limit - used), userUsed, userRemaining: userUsed ? 0 : catalog.dailyQuota.perUser };
  }) };
}

/** Early feedback only; the database trigger is the concurrent admission authority. */
export async function assertModelDailyQuotaAvailable(userId: string, model: string) {
  if (!isDedicatedModel(model)) return;
  const quota = (await getModelDailyQuotas(userId)).models.find((row) => row.model === model)!;
  if (quota.userUsed) throw new GenerationContractError("MODEL_DAILY_QUOTA_USED", { status: 429 });
  if (!quota.remaining) throw new GenerationContractError("MODEL_DAILY_QUOTA_EXHAUSTED", { status: 429 });
}

/** Extract only our fixed admission markers; never send Prisma/SQL details to clients. */
export function modelDailyQuotaError(error: unknown): GenerationContractError | null {
  const codes = ["MODEL_DAILY_QUOTA_USED", "MODEL_DAILY_QUOTA_EXHAUSTED"] as const;
  const find = (value: unknown, depth: number): typeof codes[number] | undefined => {
    if (typeof value === "string") return codes.find((code) => value.includes(code));
    if (!value || typeof value !== "object" || depth > 6) return;
    if (value instanceof Error) {
      const code = find(value.message, depth + 1) ?? find(value.cause, depth + 1);
      if (code) return code;
    }
    for (const item of Object.values(value)) { const code = find(item, depth + 1); if (code) return code; }
  };
  const code = find(error, 0);
  return code ? new GenerationContractError(code, { status: 429 }) : null;
}
