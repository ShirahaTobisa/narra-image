/** 交互请求统一限制等待时间，并将网关 HTML/断网转换成可显示的错误。 */
export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const result = await response.json().catch(() => null) as { data?: T; error?: unknown } | null;
    if (!response.ok || !result || typeof result !== "object" || result.data == null) {
      throw new Error(typeof result?.error === "string" && result.error ? result.error : "请求失败，请稍后再试");
    }
    return result.data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("请求超时，请稍后再试");
    if (error instanceof TypeError) throw new Error("网络连接失败，请稍后再试");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
