import type { InputHTMLAttributes } from "react";

/**
 * 填 Key / Secret 用的输入框。故意不用密码框：浏览器会把密码框当成登录表单，
 * 一点就把存过的密码自动填进来（Site Key、登录密码就这样被错存成密钥）。
 */
export function SecretInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <input
      autoComplete="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      {...props}
      type="text"
    />
  );
}
