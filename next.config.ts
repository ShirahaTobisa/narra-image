import type { NextConfig } from "next";

// 公开站点的基础安全响应头：不许别的网站把本站嵌进框里（防点击劫持）、
// 不许浏览器猜文件类型、跨站跳转不带完整地址
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; object-src 'none'; base-uri 'self'" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  experimental: {
    optimizePackageImports: ["lucide-react", "motion", "date-fns"],
  },
  images: {
    // 只替 Discord 头像做缩放；本站图片由 proxy.ts 改写成本地路径，不走远程下载。
    // 放开通配会让 /_next/image 变成谁都能用的图片代理（下载、转码、缓存全由本机承担）
    remotePatterns: [{ protocol: "https", hostname: "cdn.discordapp.com", pathname: "/avatars/**" }],
    localPatterns: ["/media/images/*", "/pet/**", "/marketing/**", "/_next/static/media/**", "/*.svg", "/logo.png"]
      .map((pathname) => ({ pathname, search: "" })),
    formats: ["image/avif", "image/webp"],
    // 缩略图常用宽度（imageSizes）+ 屏幕宽度档位（deviceSizes）
    // 调用 /_next/image?w=xxx 时，xxx 必须落在这两个集合的并集里。
    imageSizes: [16, 32, 48, 64, 96, 128, 192, 256, 384],
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    // Next.js 16 起，q 参数必须落在 qualities 列表里（默认仅允许 75），
    // 详情页和 lightbox 用 q=90 输出更清晰的大图，需在此放开。
    qualities: [75, 90],
  },
};

export default nextConfig;
