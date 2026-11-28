import { Loader2 } from "lucide-react";

export function VideoGeneratingProgress() {
  return (
    <div role="status" aria-live="polite" className="flex aspect-video w-full flex-col items-center justify-center gap-4 rounded-2xl border border-[var(--line)] bg-[#1c1714] px-6 text-center text-white/90">
      <Loader2 aria-hidden className="size-10 animate-spin text-[var(--accent)]" />
      <p className="text-sm">视频正在排队或生成中，请稍候…</p>
      <p className="text-xs text-white/60">排队较多时等待时间会延长，完成后会自动更新。</p>
      <p className="text-xs text-white/50">可以离开此页面，稍后从历史记录查看结果。</p>
    </div>
  );
}
