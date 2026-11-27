import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ currentIp: vi.fn(), requestIp: vi.fn(), user: vi.fn(), apiKey: vi.fn(), cookie: vi.fn(), verify: vi.fn() }));
vi.mock("@/lib/auth/ip-tracking", () => ({ recordCurrentUserIp: mocks.currentIp, recordUserIp: mocks.requestIp }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: mocks.user }, apiKey: { findUnique: mocks.apiKey, update: vi.fn() } } }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ AUTH_SECRET: "test-secret-for-user-ip-tracking", NODE_ENV: "test" }) }));
vi.mock("@/lib/api-config", () => ({ isApiEnabled: async () => true }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookie }) }));
vi.mock("next/server", async (load) => ({ ...await load<typeof import("next/server")>(), after: vi.fn() }));
vi.mock("@/lib/auth/session-token", () => ({ createSessionToken: async () => "test-session", verifySessionToken: mocks.verify }));

import { attachSessionCookie } from "@/lib/auth/session";
import { getCurrentUserRecord } from "@/lib/server/current-user";
import { requireApiUser } from "@/lib/server/api-auth";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentIp.mockResolvedValue(undefined);
  mocks.cookie.mockReturnValue({ value: "valid-session" });
  mocks.verify.mockResolvedValue({ userId: "existing-user", role: "user" });
  mocks.user.mockResolvedValue({ id: "existing-user", bannedAt: null });
});

describe("authenticated IP hooks", () => {
  it("records successful logins", async () => {
    await attachSessionCookie(NextResponse.json({}), { userId: "new-user", role: "user" });
    expect(mocks.currentIp).toHaveBeenCalledWith("new-user");
  });
  it("records old accounts on an authenticated visit", async () => {
    await getCurrentUserRecord();
    expect(mocks.currentIp).toHaveBeenCalledWith("existing-user");
  });
  it("does not associate invalid sessions or deleted accounts", async () => {
    mocks.cookie.mockReturnValue(undefined);
    await getCurrentUserRecord();
    mocks.cookie.mockReturnValue({ value: "valid-session" });
    mocks.user.mockResolvedValue(null);
    await getCurrentUserRecord();
    expect(mocks.currentIp).not.toHaveBeenCalled();
  });
  it("records an authenticated API account, never a rejected key", async () => {
    const request = new Request("https://site.invalid/v1/models", { headers: { authorization: "Bearer test-key", "x-narra-client-ip": "192.0.2.4" } });
    mocks.apiKey.mockResolvedValue(null);
    await expect(requireApiUser(request)).rejects.toThrow();
    expect(mocks.requestIp).not.toHaveBeenCalled();
    mocks.apiKey.mockResolvedValue({ id: "key-1", revokedAt: null, user: { id: "api-user", bannedAt: null, role: "USER" } });
    await requireApiUser(request);
    expect(mocks.requestIp).toHaveBeenCalledWith("api-user", request.headers);
  });
});
