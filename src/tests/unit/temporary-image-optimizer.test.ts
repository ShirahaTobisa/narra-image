// @vitest-environment node
import { readdirSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import nextConfig from "../../../next.config";

vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_URL: "https://app.invalid", IMAGE_STORAGE_MANAGED_ENABLED: true }) }));
import { proxy } from "@/proxy";

it.each(["temporary-images", "gallery-images"])("rejects manually optimized %s sources and encoded paths", (route) => {
  for (const prefix of ["", "https://app.invalid"]) {
    for (const media of ["media", "%6dedia"]) {
      const source = `${prefix}/${media}/${route}/${"a".repeat(64)}`;
      const response = proxy(new NextRequest(`https://app.invalid/_next/image?${new URLSearchParams({ url: source, w: "640", q: "75" })}`));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
  }
  expect(nextConfig.images?.localPatterns?.map((pattern) => pattern.pathname)).not.toContain(`/media/${route}/*`);
});

it("keeps every bundled public image optimizable, because a page that renders an unlisted one fails outright", () => {
  // `**` spans directories, `*` stays inside one path segment.
  const matches = (pattern: string, file: string) => {
    const [head, tail] = pattern.split("**");
    if (tail !== undefined) return file.startsWith(head) && file.endsWith(tail);
    const [before, after] = pattern.split("*");
    return after === undefined ? file === pattern
      : file.startsWith(before) && file.endsWith(after) && !file.slice(before.length, file.length - after.length).includes("/");
  };
  const patterns = (nextConfig.images?.localPatterns ?? []).map((pattern) => pattern.pathname!);
  const images = (readdirSync("public", { recursive: true }) as string[]).map((file) => `/${file.split(path.sep).join("/")}`)
    .filter((file) => [".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".svg"].some((extension) => file.endsWith(extension)));
  expect(images).toContain("/logo.png");
  expect(images.filter((file) => !patterns.some((pattern) => matches(pattern, file)))).toEqual([]);
});
