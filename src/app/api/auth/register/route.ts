import { INVITE_REGISTRATION_CLOSED_MESSAGE } from "@/lib/auth/access-policy";
import { jsonError } from "@/lib/server/http";

export async function POST() {
  return jsonError(INVITE_REGISTRATION_CLOSED_MESSAGE, 403);
}
