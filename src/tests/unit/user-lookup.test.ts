import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockQueryRaw } = vi.hoisted(() => ({ mockQueryRaw: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { $queryRaw: mockQueryRaw } }));

import { exactUserWhere, openAiSafetyIdentifier } from "@/lib/server/user-lookup";
import { formatUserUid, parseUserUidQuery } from "@/lib/user-uid";

// sha256("narra-user:user_1")，Go Worker 发给 OpenAI 的也是这个
const USER_1_IDENTIFIER = "0593d1a72add34fac7de29ae291211c42d7542a257a6a5528967cea82887bc66";

describe("用户编号", () => {
  it("显示成 #12，搜索 #12 或 12 都认", () => {
    expect(formatUserUid(12)).toBe("#12");
    expect(formatUserUid(null)).toBe("");
    expect(parseUserUidQuery(" #12 ")).toBe(12);
    expect(parseUserUidQuery("12")).toBe(12);
    expect(parseUserUidQuery("12a")).toBeNull();
    // Discord ID 这种长数字不当编号，照常模糊搜
    expect(parseUserUidQuery("123456789012345678")).toBeNull();
  });
});

describe("后台精确找人", () => {
  beforeEach(() => mockQueryRaw.mockReset());

  it("编号直接按 uid 找，不查标识", async () => {
    await expect(exactUserWhere("#7")).resolves.toEqual({ uid: 7 });
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it("OpenAI 用户标识能反查到本人", async () => {
    expect(openAiSafetyIdentifier("user_1")).toBe(USER_1_IDENTIFIER);
    mockQueryRaw.mockResolvedValueOnce([{ id: "user_1" }]);
    await expect(exactUserWhere(USER_1_IDENTIFIER.toUpperCase())).resolves.toEqual({
      id: "user_1",
    });
  });

  it("查不到的标识不匹配任何人，普通关键词交给模糊搜索", async () => {
    mockQueryRaw.mockResolvedValueOnce([]);
    await expect(exactUserWhere("f".repeat(64))).resolves.toEqual({ id: "" });
    await expect(exactUserWhere("alice@example.com")).resolves.toBeNull();
  });
});
