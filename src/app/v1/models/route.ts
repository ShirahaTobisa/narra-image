import { NextResponse } from "next/server";

import { openAiError } from "@/lib/external-api/http";
import { getActiveChannels } from "@/lib/providers/built-in-provider";
import { mergeChannelsForUsers } from "@/lib/providers/built-in-provider-core";
import { requireApiUser } from "@/lib/server/api-auth";

export async function GET(request: Request) {
  try {
    await requireApiUser(request);
    const channels = await getActiveChannels();
    const modelIds = mergeChannelsForUsers(channels)[0]?.models ?? [];

    return NextResponse.json({
      data: modelIds.map((id) => ({
        id,
        object: "model",
        owned_by: "narra-image",
      })),
      object: "list",
    });
  } catch (error) {
    return openAiError(error);
  }
}
