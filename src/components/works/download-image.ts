import { imageDownloadTimestamp } from "@/lib/image-download";

/** 把链接交给浏览器自己下载。 */
export function saveLink(href: string, filename: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function imageDownloadFilename(url: string, mimeType: string) {
  const pathname = new URL(url, window.location.href).pathname;
  const format = /^image\/(png|jpeg|webp|gif)$/.exec(mimeType)?.[1]
    ?? /\.(png|jpe?g|webp|gif)$/i.exec(pathname)?.[1].toLowerCase() ?? "png";
  return `${imageDownloadTimestamp()}.${format === "jpeg" ? "jpg" : format}`;
}

export async function downloadImage(url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("图片下载失败");
    }
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);

    saveLink(blobUrl, imageDownloadFilename(url, blob.type));
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
