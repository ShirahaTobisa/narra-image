// @vitest-environment node
const mocks = vi.hoisted(() => ({ config: vi.fn(), featured: vi.fn() }));
vi.mock("@/lib/server/login-cover", () => ({ getLoginCoverDisplayConfig: mocks.config }));
vi.mock("@/lib/server/works", () => ({ listFeaturedWorksPage: mocks.featured }));

import { getAuthCover } from "@/lib/server/auth-cover";

beforeEach(() => vi.resetAllMocks());

it("自定义封面不等待或查询无用的精选列表", async () => {
  mocks.config.mockResolvedValue({ mode: "custom", customUrl: "/cover.png" });
  mocks.featured.mockImplementation(() => new Promise(() => {}));
  expect(await getAuthCover()).toEqual({ cover: null, coverImageUrl: "/cover.png" });
  expect(mocks.featured).not.toHaveBeenCalled();
});

it("精选模式只传递封面所需字段", async () => {
  mocks.config.mockResolvedValue({ mode: "featured" });
  mocks.featured.mockResolvedValue({ items: [{ authorName: "作者", image: "/work.png", title: "作品", prompt: "private" }] });
  expect(await getAuthCover()).toEqual({ cover: { authorName: "作者", image: "/work.png", title: "作品" }, coverImageUrl: null });
});

it.each(["config", "featured"] as const)("封面 %s 故障时保留登录表单", async (stage) => {
  mocks.config.mockResolvedValue({ mode: "featured" });
  mocks[stage].mockRejectedValue(new Error("unavailable"));
  expect(await getAuthCover()).toEqual({ cover: null, coverImageUrl: null });
});
