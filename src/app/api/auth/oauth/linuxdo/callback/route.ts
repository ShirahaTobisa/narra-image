import { DISCORD_ONLY_MESSAGE } from "@/lib/auth/access-policy";
import { jsonError } from "@/lib/server/http";

export async function GET() {
  return jsonError(DISCORD_ONLY_MESSAGE, 403);
}
