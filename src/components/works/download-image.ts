/** 把链接交给浏览器自己下载。 */
export function saveLink(href: string, filename: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function downloadImage(url: string, filenamePrefix = "narra-work") {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("图片下载失败");
    }
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const pathname = new URL(url, window.location.href).pathname;
    const nameFromUrl = pathname.split("/").filter(Boolean).pop();

    saveLink(blobUrl, nameFromUrl && nameFromUrl.includes(".") ? nameFromUrl : `${filenamePrefix}.png`);
    URL.revokeObjectURL(blobUrl);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
