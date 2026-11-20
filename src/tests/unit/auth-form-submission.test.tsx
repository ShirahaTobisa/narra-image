import { Component, useImperativeHandle, type ReactNode, type Ref } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthForm } from "@/components/marketing/auth-form";

const { push, reset } = vi.hoisted(() => ({ push: vi.fn(), reset: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));
vi.mock("@/components/auth/turnstile-widget", () => ({
  TurnstileWidget: ({ onVerify, ref }: { onVerify: (token: string) => void; ref: Ref<{ reset: () => void }> }) => {
    useImperativeHandle(ref, () => ({ reset }));
    return <button type="button" onClick={() => onVerify("verified-token")}>完成验证</button>;
  },
}));

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div>错误页</div> : this.props.children; }
}

const turnstile = { isEnabled: true, siteKey: "test-key", protectLogin: true, protectRegister: true };

function submit() {
  fireEvent.change(screen.getByLabelText("邮箱"), { target: { value: "user@example.com" } });
  fireEvent.change(screen.getByLabelText("密码"), { target: { value: "password123" } });
  fireEvent.submit(screen.getByLabelText("邮箱").closest("form")!);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("登录提交恢复", () => {
  it.each([
    ["网络中断", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["网关 HTML", () => Promise.resolve({ ok: false, json: () => Promise.reject(new SyntaxError("Unexpected token <")) })],
  ])("%s 留在表单内，并使验证码可以重试", async (_name, fetchResult) => {
    vi.stubGlobal("fetch", vi.fn(fetchResult));
    render(<Boundary><AuthForm mode="login" turnstile={turnstile} /></Boundary>);
    fireEvent.click(screen.getByRole("button", { name: "完成验证" }));
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/网络连接失败|请求失败/);
    expect(screen.queryByText("错误页")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "登录进入创作台" })).toBeDisabled();
    expect(reset).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("等待响应期间显示处理中，并只提交一次", async () => {
    let finish!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AuthForm mode="login" />);
    submit();
    expect(await screen.findByRole("button", { name: "处理中..." })).toBeDisabled();
    submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish({ ok: false, json: async () => ({ error: "邮箱或密码错误" }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("邮箱或密码错误");
    await waitFor(() => expect(screen.getByRole("button", { name: "登录进入创作台" })).toBeEnabled());
  });

  it("切换登录/注册模式不能复用旧验证码", () => {
    const { rerender } = render(<AuthForm mode="login" turnstile={turnstile} />);
    fireEvent.click(screen.getByRole("button", { name: "完成验证" }));
    expect(screen.getByRole("button", { name: "登录进入创作台" })).toBeEnabled();
    rerender(<AuthForm mode="register" turnstile={turnstile} />);
    expect(screen.getByRole("button", { name: "注册并进入创作台" })).toBeDisabled();
  });

  it.each(["mode", "siteKey"])("在途请求后切换 %s，旧失败不清除新验证码", async (change) => {
    let finish!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AuthForm mode="login" turnstile={turnstile} />);
    fireEvent.click(screen.getByRole("button", { name: "完成验证" }));
    submit();
    rerender(<AuthForm mode={change === "mode" ? "register" : "login"}
      turnstile={change === "siteKey" ? { ...turnstile, siteKey: "new-key" } : turnstile} />);
    fireEvent.click(screen.getByRole("button", { name: "完成验证" }));
    const buttonName = change === "mode" ? "注册并进入创作台" : "登录进入创作台";
    expect(screen.getByRole("button", { name: buttonName })).toBeEnabled();
    await act(async () => { finish({ ok: false, json: async () => ({ error: "旧请求失败" }) }); });
    expect(screen.queryByText("旧请求失败")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: buttonName })).toBeEnabled();
    expect(reset).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["切换", "卸载"])("%s后旧登录成功不导航", async (change) => {
    let finish!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender, unmount } = render(<AuthForm mode="login" />);
    submit();
    if (change === "切换") rerender(<AuthForm mode="register" />);
    else unmount();
    await act(async () => { finish({ ok: true, json: async () => ({ data: { user: { role: "user" } } }) }); });
    expect(push).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
