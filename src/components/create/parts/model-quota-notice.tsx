"use client";

import { useEffect, useState } from "react";

import { isDedicatedModel } from "@/lib/generation/model-limits";
import { cn } from "@/lib/utils";

type ModelQuotaNoticeProps = { model: string; className?: string };
type ModelQuota = { model: string; limit: number; remaining: number; userRemaining: number };

export function ModelQuotaNotice({ model, className }: ModelQuotaNoticeProps) {
  const dedicated = isDedicatedModel(model);
  const [status, setStatus] = useState<{ model: string; quota: ModelQuota | null } | null>(null);
  useEffect(() => {
    if (!dedicated) return;
    const controller = new AbortController();
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState === "hidden") return;
      loading = true;
      try {
        const response = await fetch("/api/me/model-quotas", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
        if (!response.ok) throw new Error("quota unavailable");
        const result = await response.json() as { data?: { models?: ModelQuota[] } };
        const quota = result.data?.models?.find((item) => item.model === model) ?? null;
        if (!controller.signal.aborted) setStatus({ model, quota });
      } catch {
        if (!controller.signal.aborted) setStatus({ model, quota: null });
      } finally { loading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 30_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [dedicated, model]);
  if (!dedicated) return null;
  const quota = status?.model === model ? status.quota : undefined;
  return <div className={cn("text-xs leading-relaxed text-[var(--ink-soft)]", className)}>
    <p>此模型全站每天 10 次，每个账号每天 1 次，先到先得；每天 UTC+9 零点重置。</p>
    <p role="status" aria-live="polite">{quota ? `全站今日剩余 ${quota.remaining} / ${quota.limit} 次 · 你今日剩余 ${quota.userRemaining} 次` : quota === null ? "额度暂时无法读取，以提交时核验结果为准。" : "正在查询今日剩余额度…"}</p>
  </div>;
}
