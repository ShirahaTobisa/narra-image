import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TurnstileWidget } from "@/components/auth/turnstile-widget";

afterEach(() => {
  delete window.turnstile;
  document.querySelectorAll('script[src^="https://challenges.cloudflare.com/turnstile/"]').forEach((script) => script.remove());
  vi.useRealTimers();
});

describe("人机验证组件", () => {
  it("父组件重新渲染、换了回调也不重建验证框，验证结果交给最新的回调", async () => {
    let options: { callback: (token: string) => void } | undefined;
    const renderWidget = vi.fn((_element: HTMLElement, widgetOptions: { callback: (token: string) => void }) => {
      options = widgetOptions;
      return "widget-1";
    });
    window.turnstile = { remove: vi.fn(), render: renderWidget, reset: vi.fn() } as unknown as Window["turnstile"];
    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = render(<TurnstileWidget siteKey="site-key" onVerify={first} />);
    await act(async () => {});
    rerender(<TurnstileWidget siteKey="site-key" onVerify={second} />);
    await act(async () => {});
    act(() => options?.callback("token-1"));

    expect(renderWidget).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith("token-1");
    expect(first).not.toHaveBeenCalled();
  });

  it("脚本失败后可以就地重新加载", async () => {
    const renderWidget = vi.fn(() => "widget-retry");
    render(<TurnstileWidget siteKey="site-key" onVerify={vi.fn()} />);
    const script = document.querySelector<HTMLScriptElement>('script[src*="turnstile/v0/api.js"]')!;
    await act(async () => { fireEvent.error(script); });
    expect(screen.getByText("验证加载失败，请重试")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新验证" }));
    const replacement = document.querySelector<HTMLScriptElement>('script[src*="turnstile/v0/api.js"]')!;
    expect(replacement).not.toBe(script);
    window.turnstile = { remove: vi.fn(), render: renderWidget, reset: vi.fn() };
    await act(async () => { fireEvent.load(replacement); });
    expect(renderWidget).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("验证加载失败，请重试")).not.toBeInTheDocument();
  });

  it("脚本无响应会结束等待并给出重试入口", async () => {
    vi.useFakeTimers();
    render(<TurnstileWidget siteKey="site-key" onVerify={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.queryByText("正在加载人机验证...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新验证" })).toBeInTheDocument();
  });

  it("卸载的验证码回调不能改变新的验证状态", async () => {
    const callbacks: Array<(token: string) => void> = [];
    window.turnstile = {
      remove: vi.fn(), reset: vi.fn(),
      render: vi.fn((_element, options) => {
        callbacks.push(options.callback!);
        return `widget-${callbacks.length}`;
      }),
    };
    const onVerify = vi.fn();
    const { rerender } = render(<TurnstileWidget siteKey="old-key" onVerify={onVerify} />);
    await act(async () => {});
    rerender(<TurnstileWidget siteKey="new-key" onVerify={onVerify} />);
    await act(async () => {});
    act(() => callbacks[0]("old-token"));
    expect(onVerify).not.toHaveBeenCalled();
    act(() => callbacks[1]("new-token"));
    expect(onVerify).toHaveBeenCalledWith("new-token");
  });
});
