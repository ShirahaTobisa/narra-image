import { act, fireEvent, render, screen } from "@testing-library/react";

import { ModelQuotaNotice } from "@/components/create/parts/model-quota-notice";

const response = (model: string, remaining = 7, userRemaining = 1) => new Response(JSON.stringify({ data: { models: [{ model, limit: 10, remaining, userRemaining }] } }));

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => response("h3"))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("dedicated model daily quota notice", () => {
  it("does not fetch or show dedicated limits for GPT", () => {
    const { container } = render(<ModelQuotaNotice model="gpt-image-2" />);
    expect(container).toBeEmptyDOMElement();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows both balances, refreshes every 30 seconds and releases its timer on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<ModelQuotaNotice model="h3" />);
    await act(async () => {});
    expect(screen.getByRole("status")).toHaveTextContent("全站今日剩余 7 / 10 次 · 你今日剩余 1 次");
    vi.mocked(fetch).mockResolvedValueOnce(response("h3", 0, 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole("status")).toHaveTextContent("全站今日剩余 0 / 10 次 · 你今日剩余 0 次");
    unmount();
    const calls = vi.mocked(fetch).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });

  it("ignores a late response from the previous model and refreshes when the page returns", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const { rerender } = render(<ModelQuotaNotice model="seedream-5-5" />);
    const firstSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    rerender(<ModelQuotaNotice model="h3" />);
    expect(firstSignal?.aborted).toBe(true);
    expect(await screen.findByText("全站今日剩余 7 / 10 次 · 你今日剩余 1 次")).toBeInTheDocument();
    await act(async () => { resolve(response("seedream-5-5", 0, 0)); });
    expect(screen.getByRole("status")).toHaveTextContent("全站今日剩余 7 / 10 次 · 你今日剩余 1 次");
    vi.mocked(fetch).mockResolvedValueOnce(response("h3", 6, 0));
    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByText("全站今日剩余 6 / 10 次 · 你今日剩余 0 次")).toBeInTheDocument();
  });
});
