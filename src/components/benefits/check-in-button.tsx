"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { postJson } from "@/lib/http-client";

type CheckInButtonProps = {
  checkedInToday: boolean;
  onCheckedIn?: (credits: number) => void;
  rewardCredits: number;
  variant?: "compact" | "default";
};

export function CheckInButton({
  checkedInToday,
  onCheckedIn,
  rewardCredits,
  variant = "default",
}: CheckInButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [hasCheckedInToday, setHasCheckedInToday] = useState(checkedInToday);
  const [message, setMessage] = useState("");
  const isCheckedIn = checkedInToday || hasCheckedInToday;

  async function handleCheckIn() {
    setMessage("");

    try {
      const payload = await postJson<{
        checkedIn: boolean;
        credits: number;
        rewardCredits: number;
      }>("/api/me/check-in");
      if (!payload || typeof payload.checkedIn !== "boolean" || !Number.isFinite(payload.credits)) {
        throw new Error("签到结果不完整，请稍后再试");
      }
      setHasCheckedInToday(true);
      setMessage(payload.checkedIn ? `签到成功，已到账 ${payload.rewardCredits} 积分` : "今日已签");
      onCheckedIn?.(payload.credits);
      startTransition(() => router.refresh());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "签到失败，请稍后再试");
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2 whitespace-nowrap">
      <button
        type="button"
        disabled={isPending || isCheckedIn}
        onClick={() => startTransition(handleCheckIn)}
        className={
          variant === "compact"
            ? `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                isCheckedIn
                  ? "border-[var(--line)] text-[var(--ink-soft)] opacity-60"
                  : "border-[var(--accent)]/40 bg-[var(--accent)]/8 text-[var(--accent)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/14"
              } disabled:cursor-not-allowed`
            : `inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-4 py-2 text-sm font-medium transition ${
                isCheckedIn
                  ? "border-[var(--line)] text-[var(--ink-soft)] opacity-60"
                  : "border-[var(--accent)]/40 bg-[var(--accent)]/8 text-[var(--accent)] hover:border-[var(--accent)] hover:bg-[var(--accent)]/14"
              } disabled:cursor-not-allowed`
        }
      >
        {isPending ? "签到中..." : isCheckedIn ? "✓ 今日已签" : `签到 +${rewardCredits}`}
      </button>
      <span className={message ? "max-w-48 whitespace-normal text-xs" : "sr-only"} role="status" aria-live="polite">
        {message || `签到可领取 ${rewardCredits} 积分`}
      </span>
    </div>
  );
}
