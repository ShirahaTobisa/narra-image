import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeClientIp } from "@/lib/auth/client-ip";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), after: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { $executeRaw: mocks.execute } }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
let pending: Array<() => Promise<void>>;
let tracking: typeof import("@/lib/auth/ip-tracking");
const requestHeaders = (ip: string) => new Headers({ "x-narra-client-ip": ip });

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); pending = [];
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  mocks.after.mockImplementation((callback) => { pending.push(callback); });
  mocks.execute.mockResolvedValue(1);
  tracking = await import("@/lib/auth/ip-tracking");
});
afterEach(() => vi.restoreAllMocks());

describe("account IP recording", () => {
  it.each([
    ["192.0.2.4", "192.0.2.4"], ["2001:0DB8:0000::1", "2001:db8::1"],
    ["::ffff:192.0.2.4", "192.0.2.4"], ["::ffff:c000:204", "192.0.2.4"],
    ["192.0.2.4, 198.51.100.1", null], ["192.0.2.4:123", null],
    ["fe80::1%eth0", null], ["192.0.2.4/24", null], ["unknown", null],
  ])("normalizes only a single IP: %s", (value, expected) => {
    expect(normalizeClientIp(value)).toBe(expected);
  });

  it("ignores spoofable forwarding headers and missing proxy identity", () => {
    tracking.recordUserIp("user-a", new Headers({ "x-forwarded-for": "192.0.2.4", "x-real-ip": "192.0.2.4" }));
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it("defers writes and coalesces one account/IP without merging other accounts or IPs", async () => {
    tracking.recordUserIp("user-a", requestHeaders("192.0.2.4"));
    tracking.recordUserIp("user-a", requestHeaders("::ffff:192.0.2.4"));
    tracking.recordUserIp("user-b", requestHeaders("192.0.2.4"));
    tracking.recordUserIp("user-a", requestHeaders("192.0.2.5"));
    expect(pending).toHaveLength(3);
    expect(mocks.execute).not.toHaveBeenCalled();
    await Promise.all(pending.map((callback) => callback()));
    expect(mocks.execute.mock.calls[0].slice(1)).toEqual(["user-a", "192.0.2.4", new Date(1_000_000), new Date(1_000_000)]);
    vi.mocked(Date.now).mockReturnValue(1_300_000);
    tracking.recordUserIp("user-a", requestHeaders("192.0.2.4"));
    expect(pending).toHaveLength(4);
  });

  it("allows retry after failed background writes without exposing database details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.execute.mockRejectedValueOnce(new Error("private-db-credentials"));
    tracking.recordUserIp("user-a", requestHeaders("192.0.2.4"));
    await expect(pending[0]()).resolves.toBeUndefined();
    tracking.recordUserIp("user-a", requestHeaders("192.0.2.4"));
    expect(pending).toHaveLength(2);
    expect(log).toHaveBeenCalledWith("[account-ip] IP record failed");
  });

  it("captures request headers before the response finishes", async () => {
    mocks.headers.mockResolvedValue(requestHeaders("2001:db8::1"));
    await tracking.recordCurrentUserIp("user-a");
    expect(pending).toHaveLength(1);
    await pending[0]();
    expect(mocks.execute.mock.calls[0][2]).toBe("2001:db8::1");
  });

  it("does not break a request when background scheduling fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.after.mockImplementationOnce(() => { throw new Error("closed"); });
    expect(() => tracking.recordUserIp("user-a", requestHeaders("192.0.2.4"))).not.toThrow();
    tracking.recordUserIp("user-a", requestHeaders("192.0.2.4"));
    expect(pending).toHaveLength(1);
  });
});
