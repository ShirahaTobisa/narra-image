import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("motion/react", () => ({ motion: { div: ({ children }: { children?: ReactNode }) => <div>{children}</div> } }));

import { AdminWorksBoard } from "@/components/admin/admin-works-board";
import { serializeAdminWork } from "@/lib/prisma-mappers";
import { createPrivacyWork } from "./helpers/work-privacy-fixtures";

afterEach(() => vi.unstubAllGlobals());

describe("admin image viewer follows current media presentation", () => {
  it.each([null, "已送审署名"])("shows the submitted public authorship %j instead of the current profile name", (publicAuthorName) => {
    const work = serializeAdminWork(createPrivacyWork({ publicAuthorName, showcaseStatus: "PENDING" }));
    render(<AdminWorksBoard works={[work]} />);
    expect(screen.getByText(`公开署名：${publicAuthorName ?? "匿名创作者"}`)).toBeInTheDocument();
    expect(screen.queryByText("Public author nickname")).not.toBeInTheDocument();
  });

  it.each([false, true])("single/batch=%s approval submits the displayed revision", async (batch) => {
    const user = userEvent.setup();
    const work = serializeAdminWork(createPrivacyWork({ publicAuthorName: "已送审署名", showcaseStatus: "PENDING" }));
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: { updatedCount: 1, skippedCount: 0 } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminWorksBoard works={[work]} activeStatus="PENDING" enableBatch={batch} />);
    if (batch) await user.click(screen.getByRole("button", { name: "全选本页" }));
    await user.click(screen.getByRole("button", { name: batch ? "批量通过投稿" : "通过投稿" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(batch ? body.items[0].submittedAt : body.submittedAt).toBe(work.submittedAt);
    expect(body.action).toBe("approve_feature");
  });
  it("refreshes an already-open viewer when an available historical image gains a managed URL", async () => {
    const user = userEvent.setup();
    const original = serializeAdminWork(createPrivacyWork());
    const publicUrl = `https://app.history.invalid/media/images/${"b".repeat(64)}`;
    const { rerender } = render(<AdminWorksBoard works={[original]} />);
    await user.click(screen.getByRole("button", { name: "作品缩略图" }));
    await screen.findByRole("img", { name: "作品大图" });
    rerender(<AdminWorksBoard works={[{ ...original, url: publicUrl }]} />);
    for (const image of screen.getAllByRole("img")) {
      expect(new URL(image.getAttribute("src")!, "https://admin.unit.invalid").searchParams.get("url")).toBe(publicUrl);
    }
    expect(original.url).not.toBe(publicUrl);
  });

  it.each(["cleaned", "removed"])("does not keep an old viewer after the image is %s", async (change) => {
    const user = userEvent.setup();
    const original = serializeAdminWork(createPrivacyWork());
    const { rerender } = render(<AdminWorksBoard works={[original]} />);
    await user.click(screen.getByRole("button", { name: "作品缩略图" }));
    await screen.findByRole("img", { name: "作品大图" });
    rerender(<AdminWorksBoard works={change === "removed" ? [] : [{ ...original, availability: "cleaned", url: "" }]} />);
    expect(screen.queryByRole("img", { name: "作品大图" })).not.toBeInTheDocument();
  });
});
