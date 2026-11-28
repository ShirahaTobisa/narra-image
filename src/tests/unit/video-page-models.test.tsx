import { render } from "@testing-library/react";
import type { ComponentProps } from "react";

const mocks = vi.hoisted(() => ({ channels: vi.fn(), studio: vi.fn() }));
vi.mock("@/lib/server/current-user", () => ({ getCurrentUserRecord: async () => ({ id: "owner" }) }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ VIDEO_ENABLED: true }) }));
vi.mock("@/lib/db", () => ({ db: { generationJob: { findMany: async () => [] } } }));
vi.mock("@/lib/prisma-mappers", () => ({ serializeGenerationsForClient: async () => [], serializeUser: () => ({ credits: 100, role: "user" }) }));
vi.mock("@/lib/generation/job-refund", () => ({ failStalePendingGenerationJobs: async () => {} }));
vi.mock("@/lib/auth/turnstile", () => ({ getPublicTurnstileConfig: async () => ({ isEnabled: false }) }));
vi.mock("@/lib/providers/built-in-provider", () => ({ getActiveChannels: mocks.channels }));
vi.mock("@/components/video/video-studio", () => ({ VideoStudio: mocks.studio }));
vi.mock("@/components/marketing/site-header", () => ({ SiteHeader: () => null }));

import VideoPage from "@/app/video/page";
import type { VideoStudio } from "@/components/video/video-studio";

it("serializes H3 pricing from its first explicit channel without exposing provider configuration", async () => {
  mocks.studio.mockReturnValue(null);
  mocks.channels.mockResolvedValue([
    { id: "gpt", name: "Image provider", models: ["gpt-image-2"], defaultModel: "gpt-image-2", videoCreditCost: 5, baseUrl: "https://private.example", apiKey: "private-key" },
    { id: "wildcard", name: "Fallback", models: ["*"], defaultModel: "gpt-image-2", videoCreditCost: 1 },
    { id: "h3-first", name: "H3 first", models: ["h3"], defaultModel: "h3", videoCreditCost: 37 },
    { id: "h3-next", name: "H3 next", models: ["h3"], defaultModel: "h3", videoCreditCost: 79 },
  ]);
  render(await VideoPage());
  const props = mocks.studio.mock.calls[0][0] as ComponentProps<typeof VideoStudio>;
  expect(props.channels).toMatchObject([{ id: "", name: "平台渠道", defaultModel: "h3", models: ["h3"], videoCreditCosts: { h3: 37 } }]);
  expect(JSON.stringify(props.channels)).not.toMatch(/private|apiKey|baseUrl|h3-first|h3-next/);
});
