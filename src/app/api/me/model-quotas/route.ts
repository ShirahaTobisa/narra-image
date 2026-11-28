import { getCurrentUserRecord } from "@/lib/server/current-user";
import { getModelDailyQuotas } from "@/lib/server/model-daily-quota";
import { jsonError, jsonOk } from "@/lib/server/http";

export async function GET() {
  const user = await getCurrentUserRecord();
  if (!user) return jsonError("请先登录", 401);
  return jsonOk(await getModelDailyQuotas(user.id), { headers: { "Cache-Control": "private, no-store" } });
}
