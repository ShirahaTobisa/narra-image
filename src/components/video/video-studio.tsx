"use client";

// 视频工作区容器：左参数面板 · 中预览舞台 · 底部历史时间线。
// 复用 create 的 useImagePoller（仅看 status，媒体类型无关）；提交沿用 /api/generate。
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { useImagePoller } from "@/components/create/hooks/use-image-poller";
import type { GenerationItem, StudioTurnstile, ViewerUser } from "@/components/create/types";
import type { GenerationType } from "@/lib/types";
import { filterChannelsByKind, getDedicatedModelLimits } from "@/lib/generation/model-limits";
import { canReuseGenerationSources, getGenerationSourceImageUrls } from "@/components/create/utils";
import { saveLink } from "@/components/works/download-image";
import { imageDownloadTimestamp } from "@/lib/image-download";
import {
  TurnstileWidget,
  type TurnstileWidgetHandle,
} from "@/components/auth/turnstile-widget";

import { getVideoDurationOptions, getVideoResolutionOptions, resolveVideoSize } from "./constants";
import type { VideoAspectRatio, VideoChannelInfo, VideoReferenceImage, VideoResolution } from "./types";
import { VideoComposer } from "./parts/video-composer";
import { VideoStage } from "./parts/video-stage";
import { VideoHistoryRail } from "./parts/video-history-rail";

type VideoStudioProps = {
  currentUser: ViewerUser;
  initialGenerations?: GenerationItem[];
  channels?: VideoChannelInfo[];
  turnstile?: StudioTurnstile | null;
};

const EMPTY_GENERATIONS: GenerationItem[] = [];
const EMPTY_CHANNELS: VideoChannelInfo[] = [];

type VideoSnapshot = {
  prompt: string;
  generationType: Extract<GenerationType, "text_to_video" | "image_to_video">;
  referenceImage: VideoReferenceImage | null;
  referenceImageUrl?: string;
  model: string;
  channelId: string | null;
  durationSeconds: number;
  aspectRatio: VideoAspectRatio;
  size: string;
};

export function VideoStudio({
  currentUser,
  initialGenerations = EMPTY_GENERATIONS,
  channels: availableChannels = EMPTY_CHANNELS,
  turnstile = null,
}: VideoStudioProps) {
  const router = useRouter();
  const channels = useMemo(() => filterChannelsByKind(availableChannels, "video"), [availableChannels]);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileWidgetRef = useRef<TurnstileWidgetHandle>(null);
  const needsTurnstile = Boolean(
    turnstile?.isEnabled && turnstile?.siteKey && turnstile?.protectGenerate,
  );

  const [generationType, setGenerationType] = useState<VideoSnapshot["generationType"]>("text_to_video");
  const [prompt, setPrompt] = useState("");
  const [referenceImage, setReferenceImage] = useState<VideoReferenceImage | null>(null);
  useEffect(() => () => { if (referenceImage) URL.revokeObjectURL(referenceImage.previewUrl); }, [referenceImage]);

  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(channels[0]?.id ?? null);
  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === selectedChannelId) ?? channels[0] ?? null,
    [channels, selectedChannelId],
  );
  const [selectedModel, setModel] = useState(selectedChannel?.defaultModel || "");
  const model = selectedChannel?.models.includes(selectedModel) ? selectedModel : selectedChannel?.defaultModel ?? "";
  const [requestedDuration, setDurationSeconds] = useState(8);
  const durationSeconds = getVideoDurationOptions(model).some((option) => option.value === requestedDuration) ? requestedDuration : 8;
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>("16:9");
  const [requestedResolution, setResolution] = useState<VideoResolution>("720p");
  const resolution = getVideoResolutionOptions(model).some((option) => option.value === requestedResolution) ? requestedResolution : "720p";

  const [generations, setGenerations] = useState<GenerationItem[]>(initialGenerations);
  const [selectedId, setSelectedId] = useState<string | null>(initialGenerations[0]?.id ?? null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 轮询：pending 任务持续拉取 /api/me/generations/{id}，命中终态写回。
  const handlePollerUpdate = useCallback((updated: GenerationItem) => {
    setGenerations((current) => current.map((g) => (g.id === updated.id ? updated : g)));
    if (updated.status !== "pending") {
      router.refresh();
    }
  }, [router]);
  useImagePoller({ generations, onUpdate: handlePollerUpdate });

  const selectedGeneration = useMemo(
    () => generations.find((g) => g.id === selectedId) ?? generations[0] ?? null,
    [generations, selectedId],
  );

  const modelOptions = selectedChannel?.models ?? [];

  const canSubmit =
    Boolean(model && selectedChannel && prompt.trim().length >= 2) &&
    (generationType === "text_to_video" || referenceImage !== null) &&
    (!needsTurnstile || turnstileToken !== null);

  function handleChannelChange(newChannelId: string) {
    setSelectedChannelId(newChannelId);
    const ch = channels.find((c) => c.id === newChannelId);
    if (ch && !ch.models.includes(model)) setModel(ch.defaultModel);
  }

  function handlePickReference(file: File | null) {
    if (!file) {
      setReferenceImage(null);
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 20 * 1024 * 1024) {
      setError("参考图须为 PNG、JPEG、WebP 或静态 GIF，且不超过 20 MB");
      return;
    }
    setError(null);
    setReferenceImage({ file, previewUrl: URL.createObjectURL(file) });
    setGenerationType("image_to_video");
  }

  function handleSubmit() {
    if (isPending) return;
    if (!currentUser) {
      router.push("/login");
      return;
    }
    setError(null);
    if (generationType === "image_to_video" && !referenceImage) {
      setError("图生视频请先上传首帧");
      return;
    }
    if (!canSubmit) return;

    const snapshot: VideoSnapshot = { prompt, generationType, referenceImage, model, channelId: selectedChannel?.id ?? null,
      durationSeconds, aspectRatio, size: resolveVideoSize(aspectRatio, resolution, model) };
    setPrompt("");
    startTransition(() => handleGenerate(snapshot));
  }

  function handleRetry() {
    const target = selectedGeneration;
    if (!target || isPending) return;
    const channel = channels.find((item) => item.id === target.providerChannelId && item.models.includes(target.model))
      ?? channels.find((item) => item.models.includes(target.model));
    if (!channel) { setError("原任务的模型当前不可用，请重新选择模型"); return; }
    const sources = getGenerationSourceImageUrls(target);
    if (target.generationType === "image_to_video" && (!canReuseGenerationSources(target) || sources.length !== 1)) {
      setError("原任务的参考图已不可用，请重新上传后生成"); return;
    }
    if (needsTurnstile && !turnstileToken) { setError("请先完成人机验证"); return; }
    const ratio = target.aspectRatio === "9:16" || target.aspectRatio === "1:1" ? target.aspectRatio : "16:9";
    const duration = getVideoDurationOptions(target.model).some((option) => option.value === target.durationSeconds) ? target.durationSeconds! : 8;
    const snapshot: VideoSnapshot = { prompt: target.prompt, model: target.model, channelId: channel.id,
      generationType: sources.length ? "image_to_video" : "text_to_video", referenceImage: null, referenceImageUrl: sources[0],
      aspectRatio: ratio, durationSeconds: duration,
      size: getDedicatedModelLimits(target.model) ? resolveVideoSize(ratio, "720p", target.model) : target.size };
    setError(null);
    startTransition(() => handleGenerate(snapshot));
  }

  async function handleGenerate(snapshot: VideoSnapshot) {
    function restore(message: string) {
      setError(message);
      setPrompt((current) => current || snapshot.prompt);
    }

    try {
      const { model, durationSeconds, aspectRatio, size, channelId } = snapshot;
      let response: Response;

      if (snapshot.generationType === "image_to_video") {
        const formData = new FormData();
        formData.append("generationType", "image_to_video");
        formData.append("model", model);
        formData.append("prompt", snapshot.prompt);
        formData.append("providerMode", "built_in");
        formData.append("size", size);
        formData.append("durationSeconds", String(durationSeconds));
        formData.append("aspectRatio", aspectRatio);
        if (channelId) formData.append("channelId", channelId);
        if (snapshot.referenceImage) formData.append("image", snapshot.referenceImage.file);
        if (snapshot.referenceImageUrl) formData.append("referenceImageUrls", snapshot.referenceImageUrl);
        if (turnstileToken) formData.append("turnstileToken", turnstileToken);
        response = await fetch("/api/generate", { method: "POST", body: formData });
      } else {
        response = await fetch("/api/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            aspectRatio,
            channelId,
            customProvider: null,
            durationSeconds,
            generationType: "text_to_video",
            model,
            prompt: snapshot.prompt,
            providerMode: "built_in",
            size,
            turnstileToken: turnstileToken || undefined,
          }),
        });
      }

      // Turnstile token 一次性有效，无论成败都要重置以便下次提交
      if (needsTurnstile) {
        setTurnstileToken(null);
        turnstileWidgetRef.current?.reset();
      }

      const result = (await response.json()) as {
        data?: { generation: GenerationItem };
        error?: string;
      };

      if (!response.ok) {
        restore(result.error || "生成失败，请稍后再试");
        return;
      }
      const generation = result.data?.generation;
      if (!generation) {
        restore("服务端没有返回任务");
        return;
      }

      if (snapshot.referenceImage) {
        setReferenceImage((current) => current === snapshot.referenceImage ? null : current);
      }
      setGenerations((current) => [generation, ...current]);
      setSelectedId(generation.id);
      router.refresh();
    } catch (err) {
      restore(err instanceof Error ? err.message : "生成失败，请稍后再试");
    }
  }

  async function handleDownload(url: string) {
    if (url.startsWith("/api/videos/")) {
      saveLink(`${url}${url.includes("?") ? "&" : "?"}download=1&filename=${imageDownloadTimestamp()}`, "");
      return;
    }
    try {
      const proxyUrl = `/api/proxy-video?url=${encodeURIComponent(url)}`;
      const response = await fetch(proxyUrl);
      if (!response.ok || !response.headers.get("content-type")?.startsWith("video/")) {
        throw new Error("视频下载失败");
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = "narra-video.mp4";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      setError("视频下载失败，视频可用 3 天，过期后请重新生成");
    }
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[linear-gradient(180deg,#faf6ef_0%,#f2e9dc_100%)]">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <VideoComposer
          ref={textareaRef}
          currentUser={currentUser}
          generationType={generationType}
          onChangeGenerationType={setGenerationType}
          prompt={prompt}
          onChangePrompt={setPrompt}
          referenceImage={referenceImage}
          onPickReference={handlePickReference}
          channels={channels}
          selectedChannelId={selectedChannelId}
          onChangeChannel={handleChannelChange}
          modelOptions={modelOptions}
          model={model}
          onChangeModel={setModel}
          durationSeconds={durationSeconds}
          onChangeDuration={setDurationSeconds}
          aspectRatio={aspectRatio}
          onChangeAspectRatio={setAspectRatio}
          resolution={resolution}
          onChangeResolution={setResolution}
          videoCreditCost={selectedChannel?.videoCreditCosts?.[model] ?? selectedChannel?.videoCreditCost ?? null}
          isPending={isPending}
          error={error}
          onDismissError={() => setError(null)}
          canSubmit={canSubmit}
          onSubmit={handleSubmit}
          turnstileSlot={
            needsTurnstile && turnstile?.siteKey ? (
              <TurnstileWidget
                ref={turnstileWidgetRef}
                siteKey={turnstile.siteKey}
                onVerify={(token) => setTurnstileToken(token)}
                onExpire={() => setTurnstileToken(null)}
                onError={() => setTurnstileToken(null)}
              />
            ) : undefined
          }
        />

        <VideoStage
          generation={selectedGeneration}
          onDownload={handleDownload}
          onRetry={handleRetry}
        />
      </div>

      <VideoHistoryRail
        generations={generations}
        selectedId={selectedGeneration?.id ?? null}
        onSelect={setSelectedId}
      />
    </div>
  );
}
