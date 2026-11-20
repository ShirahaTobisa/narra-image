"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { CheckCircle2, Loader2, ShieldAlert } from "lucide-react";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        options: {
          sitekey: string;
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
          "timeout-callback"?: () => void;
          theme?: "light" | "dark" | "auto";
          size?: "normal" | "compact" | "flexible";
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SCRIPT_TIMEOUT_MS = 15_000;

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]`,
    );
    const script = existing ?? document.createElement("script");
    const finish = (error?: Error) => {
      clearTimeout(timer);
      script.removeEventListener("load", onLoad);
      script.removeEventListener("error", onError);
      scriptPromise = null;
      if (error) {
        script.remove();
        reject(error);
      } else resolve();
    };
    const onLoad = () => finish(window.turnstile ? undefined : new Error("验证脚本未就绪"));
    const onError = () => finish(new Error("脚本加载失败"));
    const timer = setTimeout(() => finish(new Error("脚本加载超时")), SCRIPT_TIMEOUT_MS);
    script.addEventListener("load", onLoad);
    script.addEventListener("error", onError);
    if (!existing) {
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return scriptPromise;
}

export type TurnstileWidgetHandle = {
  reset: () => void;
};

type TurnstileStatus = "loading" | "ready" | "verified" | "expired" | "error";

type TurnstileWidgetProps = {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "compact" | "flexible";
  className?: string;
  ref?: Ref<TurnstileWidgetHandle>;
};

export function TurnstileWidget({
  siteKey,
  onVerify,
  onExpire,
  onError,
  theme = "auto",
  size = "flexible",
  className,
  ref,
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<TurnstileStatus>("loading");
  const [attempt, setAttempt] = useState(0);
  // 回调存进 ref：父组件每次渲染都传新函数也不重建验证框。
  // 否则 验证通过 → 父组件存 token 重新渲染 → 验证框重建再验证，会一直转圈
  const callbacksRef = useRef({ onError, onExpire, onVerify });
  useEffect(() => {
    callbacksRef.current = { onError, onExpire, onVerify };
  });

  useImperativeHandle(ref, () => ({
    reset() {
      callbacksRef.current.onExpire?.();
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.reset(widgetIdRef.current);
          setStatus("ready");
          return;
        } catch { /* 已失效的组件重新创建 */ }
      }
      setAttempt((value) => value + 1);
    },
  }), []);

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;

    Promise.resolve().then(() => {
      if (!cancelled) setStatus("loading");
    });

    loadScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        setStatus("ready");
        widgetId = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          size,
          callback: (token) => {
            if (cancelled) return;
            setStatus("verified");
            callbacksRef.current.onVerify(token);
          },
          "expired-callback": () => {
            if (cancelled) return;
            setStatus("expired");
            callbacksRef.current.onExpire?.();
          },
          "error-callback": () => {
            if (cancelled) return;
            setStatus("error");
            callbacksRef.current.onError?.();
          },
          "timeout-callback": () => {
            if (cancelled) return;
            setStatus("expired");
            callbacksRef.current.onExpire?.();
          },
        });
        widgetIdRef.current = widgetId;
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
          callbacksRef.current.onError?.();
        }
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch {
          // widget 已经被移除时静默忽略
        }
      }
      widgetIdRef.current = null;
    };
  }, [siteKey, theme, size, attempt]);

  return (
    <div className={className}>
      {status === "loading" && (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--line)] bg-white/60 px-4 py-3 text-sm text-[var(--ink-soft)]">
          <Loader2 className="size-4 animate-spin" />
          <span>正在加载人机验证...</span>
        </div>
      )}
      {status === "verified" && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-sm text-emerald-700">
          <CheckCircle2 className="size-4" />
          <span>验证通过</span>
        </div>
      )}
      {status === "error" && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-sm text-rose-600">
          <ShieldAlert className="size-4" />
          <span>验证加载失败，请重试</span>
        </div>
      )}
      {status === "expired" && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-700">
          <ShieldAlert className="size-4" />
          <span>验证已过期，请重新验证</span>
        </div>
      )}
      {(status === "error" || status === "expired") && (
        <button type="button" className="mt-2 text-sm text-[var(--accent)] underline"
          onClick={() => {
            callbacksRef.current.onExpire?.();
            setAttempt((value) => value + 1);
          }}>
          重新验证
        </button>
      )}
      <div
        ref={containerRef}
        className={status === "verified" ? "hidden" : undefined}
      />
    </div>
  );
}
