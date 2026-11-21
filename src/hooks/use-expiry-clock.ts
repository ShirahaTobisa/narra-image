"use client";

import { useEffect, useState } from "react";

/** At each expiry or tab resume, refresh presentation without polling the server. */
export function useExpiryClock(deadlines: readonly (string | null | undefined)[]) {
  const [now, setNow] = useState(Date.now);
  const next = Math.min(...deadlines.map((value) => value ? Date.parse(value) : NaN).filter((value) => value > now));
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const resume = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = Number.isFinite(next)
      ? window.setTimeout(refresh, Math.min(2_147_483_647, Math.max(0, next - Date.now())))
      : undefined;
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [next]);
  return now;
}
