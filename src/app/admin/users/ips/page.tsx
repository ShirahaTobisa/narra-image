import { Network } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AdminPagination } from "@/components/admin/admin-pagination";
import { AdminPageHeader } from "@/components/admin/ui/admin-page-header";
import { requireAdminRecord } from "@/lib/server/current-user";
import { getUserIpReport } from "@/lib/server/user-ip-report";

export const dynamic = "force-dynamic";

const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "medium", hour12: false,
});

export default async function AdminUserIpsPage({ searchParams }: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  try {
    await requireAdminRecord();
  } catch {
    redirect("/login");
  }

  const params = await searchParams ?? {};
  const requestedPage = Number(params.page);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const sharedOnly = params.shared !== "0";
  const ip = typeof params.ip === "string" ? params.ip.trim() : "";
  const report = await getUserIpReport({ page, sharedOnly, ip });

  return (
    <main className="pb-16">
      <section className="mx-auto grid max-w-7xl gap-6 px-5 pt-7 md:px-8">
        <AdminPageHeader
          eyebrow="User IPs"
          icon={Network}
          title="全站 IP 记录"
          description="按 IP 核对关联账号及首次、最近出现时间。时间显示为 UTC+9。"
          badges={<span className="rounded-full border border-[var(--line)] bg-white px-2.5 py-0.5 text-xs text-[var(--ink-soft)]">已记录 {report.trackedUsers} / {report.totalUsers} 个账号</span>}
          actions={<Link href="/admin/users" className="text-sm font-medium text-[#b54722] hover:underline">返回用户管理</Link>}
        />

        <form action="/admin/users/ips" method="get" className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1.5 text-sm">
            IP 地址
            <input name="ip" defaultValue={ip} placeholder="输入完整 IPv4 或 IPv6" className="w-72 max-w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2 font-mono" />
          </label>
          <label className="grid gap-1.5 text-sm">
            查看范围
            <select name="shared" defaultValue={sharedOnly ? "1" : "0"} className="rounded-xl border border-[var(--line)] bg-white px-3 py-2">
              <option value="1">同 IP 的多个账号</option>
              <option value="0">全部 IP</option>
            </select>
          </label>
          <button type="submit" className="rounded-xl bg-[#c25934] px-4 py-2 text-sm font-medium text-white">查询</button>
          <Link href="/admin/users/ips" className="px-2 py-2 text-sm text-[var(--ink-soft)] hover:underline">重置</Link>
        </form>

        <p className="text-sm text-[var(--ink-soft)]">共 {report.totalGroups} 个 IP。记录从功能启用后的登录和访问开始，已有账号再次访问时也会纳入。最近出现时间每 5 分钟合并更新。</p>
        {report.invalidIp ? <p role="alert" className="text-sm text-rose-700">请输入完整有效的 IPv4 或 IPv6 地址。</p> : null}
        {!report.invalidIp && report.groups.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--line)] p-8 text-center text-sm text-[var(--ink-soft)]">
            {sharedOnly ? "暂无符合条件的同 IP 多账号记录。" : "暂无符合条件的 IP 记录。"}
          </p>
        ) : null}

        {report.groups.map((group) => (
          <section key={group.ipAddress} className="overflow-hidden rounded-2xl border border-[var(--line)] bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] bg-[#fbf8f3] px-4 py-3">
              <h2 className="break-all font-mono font-semibold">{group.ipAddress}</h2>
              <span className="text-sm text-[var(--ink-soft)]">{group.userCount} 个账号</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr><th className="px-4 py-3">账号</th><th className="px-4 py-3">首次出现</th><th className="px-4 py-3">最近出现</th></tr></thead>
                <tbody>
                  {group.users.map((user) => (
                    <tr key={user.userId} className="border-t border-[var(--line)]">
                      <td className="px-4 py-3">
                        <Link href={`/admin/users?q=${encodeURIComponent(`#${user.uid}`)}`} className="font-medium text-[#b54722] hover:underline">#{user.uid} · {user.nickname || "未设置昵称"}</Link>
                        {user.oauthProvider === "discord" && user.oauthId ? <span className="mt-1 block font-mono text-xs text-[var(--ink-soft)]">Discord {user.oauthId}</span> : null}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3"><time dateTime={user.firstSeenAt.toISOString()}>{timeFormat.format(user.firstSeenAt)}</time></td>
                      <td className="whitespace-nowrap px-4 py-3"><time dateTime={user.lastSeenAt.toISOString()}>{timeFormat.format(user.lastSeenAt)}</time></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        <AdminPagination basePath="/admin/users/ips" currentPage={report.page} totalPages={report.totalPages} extraParams={{ shared: sharedOnly ? "1" : "0", ...(ip ? { ip } : {}) }} />
      </section>
    </main>
  );
}
