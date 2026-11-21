import { NextResponse, type NextRequest } from "next/server";

import { getEnv } from "@/lib/env";
import { isUncacheableImageUrl } from "@/lib/image-url";
import { externalApiCorsHeaders, isExternalApiPath } from "@/lib/external-api/cors";
import { managedImageOptimizerRewrite } from "@/lib/storage/image-optimizer";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function proxy(request: NextRequest) {
  if (isExternalApiPath(request.nextUrl.pathname)) {
    const response = request.method === "OPTIONS"
      ? new NextResponse(null, { status: 204 })
      : NextResponse.next();
    externalApiCorsHeaders(request).forEach((value, name) => {
      response.headers.set(name, value);
    });
    return response;
  }

  const environment = getEnv();
  // 站内接口只接受本站页面发来的改数据请求：别的网站借访客浏览器偷偷提交（比如把人登进攻击者的号）一律拒绝
  if (request.nextUrl.pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    if (!SAFE_METHODS.has(request.method) && origin !== null && origin !== new URL(environment.APP_URL).origin) {
      return NextResponse.json({ error: "跨站请求已拒绝" }, { status: 403 });
    }
    return NextResponse.next();
  }

  if (request.nextUrl.pathname === "/_next/image" && request.nextUrl.searchParams.getAll("url").some(isUncacheableImageUrl)) {
    return new NextResponse(null, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  const rewritten = environment.IMAGE_STORAGE_MANAGED_ENABLED
    ? managedImageOptimizerRewrite(request.url, environment.APP_URL) : null;
  return rewritten ? NextResponse.rewrite(rewritten) : NextResponse.next();
}

export const config = {
  matcher: [
    "/_next/image",
    "/api/:path*",
    "/v1/:path*",
    "/models",
    "/images/generations",
    "/images/edits",
    "/chat/completions",
    "/chat/completion",
    "/responses",
  ],
};
