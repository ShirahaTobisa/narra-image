import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TurnstileWidget } from "@/components/auth/turnstile-widget";

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
});
