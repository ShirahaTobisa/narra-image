"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

const MAX_BYTES = 20 * 1024 * 1024;
const optionRow = "flex items-start gap-3 rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface-strong)]/40 px-4 py-3 text-sm text-[var(--ink)]";

export function GalleryUploadForm({ nickname }: { nickname: string | null }) {
  const router = useRouter();
  const requestKey = useRef<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const author = nickname?.trim();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.abort(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current) return;
    const data = new FormData(event.currentTarget);
    const file = data.get("file");
    if (!file || typeof file === "string" || !file.size || file.size > MAX_BYTES) {
      setError("请选择一张不超过 20MB 的图片");
      return;
    }
    // The same key is sent again after a lost reply, so a retry never stores the image twice.
    requestKey.current ??= crypto.randomUUID();
    data.set("requestKey", requestKey.current);
    data.set("showAuthorPublic", data.has("showAuthorPublic") ? "true" : "false");
    data.set("showPromptPublic", data.has("showPromptPublic") ? "true" : "false");
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/me/gallery-uploads", { method: "POST", body: data,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || "上传没成功，请再试一次");
      if (!result?.data?.work?.id) throw new Error("没收到结果，请再点一次提交，不会重复上传");
      if (!mounted.current) return;
      requestKey.current = null;
      setOpen(false);
      setNotice(response.status === 202 ? "图片还在处理，稍后刷新看看。" : "已提交，等管理员审核。通过后会出现在广场。");
      router.refresh();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error && failure.name !== "TimeoutError" ? failure.message : "没收到结果，请再点一次提交，不会重复上传");
    } finally {
      active.current = null;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section id="gallery-upload" className="studio-card flex flex-wrap items-center justify-between gap-3 rounded-3xl px-5 py-4">
      <p role="status" className="text-sm text-[var(--ink-soft)]">{notice || "想让作品长期展示？把图片上传到广场，审核通过后一直保留。"}</p>
      <button type="button" onClick={() => { setNotice(""); setError(""); setOpen(true); }}
        className="rounded-full bg-[var(--ink)] px-5 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent)]">
        上传到广场
      </button>
      {open ? createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => { if (!busy) setOpen(false); }}>
          <form role="dialog" aria-modal="true" aria-label="上传到广场" onSubmit={submit} onChange={() => { requestKey.current = null; }}
            className="studio-card w-full max-w-lg rounded-[1.8rem] p-6" onClick={(event) => event.stopPropagation()}>
            <h3 className="text-lg font-semibold text-[var(--ink)]">上传到广场</h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--ink-soft)]">
              每次一张 PNG、JPG 或 WebP，不超过 20MB。提交后等管理员审核，通过后长期展示；24 小时内没审完会自动清掉，需要重新上传。上传不扣积分。
            </p>
            <fieldset disabled={busy} className="mt-5 grid gap-3 disabled:opacity-60">
              <input name="file" type="file" accept="image/png,image/jpeg,image/webp" required aria-label="图片"
                className="text-sm text-[var(--ink-soft)] file:mr-3 file:cursor-pointer file:rounded-full file:border file:border-solid file:border-[var(--line)] file:bg-white/70 file:px-4 file:py-2 file:text-sm file:text-[var(--ink)]" />
              <textarea name="prompt" maxLength={10_000} rows={3} placeholder="提示词（选填）" aria-label="提示词"
                className="rounded-[1.2rem] border border-[var(--line)] bg-white/60 px-4 py-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]" />
              <label className={optionRow}>
                <input name="showPromptPublic" type="checkbox" className="mt-0.5 rounded border-[var(--line)]" />
                <span>公开提示词</span>
              </label>
              <label className={optionRow}>
                <input name="showAuthorPublic" type="checkbox" disabled={!author} className="mt-0.5 rounded border-[var(--line)]" />
                <span>{author ? `公开我的昵称（${author}）` : "公开我的昵称"}</span>
              </label>
              <p className="text-xs leading-relaxed text-[var(--ink-soft)]">
                {author ? "不勾选就是匿名。以后改昵称不影响这次的署名。" : "现在是匿名。想署名的话，先去个人设置里填昵称。"}
              </p>
            </fieldset>
            {error ? <p role="alert" className="mt-3 text-sm text-rose-600">{error}</p> : null}
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button type="button" disabled={busy} onClick={() => setOpen(false)}
                className="rounded-full border border-[var(--line)] px-4 py-2 text-sm text-[var(--ink-soft)] disabled:opacity-60">
                取消
              </button>
              <button type="submit" disabled={busy}
                className="rounded-full bg-[var(--ink)] px-4 py-2 text-sm font-medium text-white transition hover:bg-[var(--accent)] disabled:opacity-60">
                {busy ? "上传中..." : "提交审核"}
              </button>
            </div>
          </form>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}
