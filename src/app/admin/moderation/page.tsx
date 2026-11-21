import type { Prisma } from "@prisma/client";
import { ShieldAlert } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPagination } from "@/components/admin/admin-pagination";
import { ModerationReviewsBoard } from "@/components/admin/moderation-reviews-board";
import { ModerationNavTabs } from "@/components/admin/moderation/moderation-nav-tabs";
import { AdminPageHeader } from "@/components/admin/ui/admin-page-header";
import { db } from "@/lib/db";
import { listModerationOffenders, MODERATION_BLOCK_LIMIT, PROVIDER_REFUSAL_WHERE } from "@/lib/moderation/check";
import { requireAdminRecord } from "@/lib/server/current-user";
import { exactUserWhere } from "@/lib/server/user-lookup";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const KINDS = ["sensitive_word", "ai_moderation", "provider"];
const userSelect = { bannedAt: true, email: true, id: true, nickname: true, uid: true } as const;

function boardUser(user: { bannedAt: Date | null; email: string; id: string; nickname: string | null; uid: number }) {
  return { banned: user.bannedAt !== null, email: user.email, id: user.id, nickname: user.nickname, uid: user.uid };
}

export default async function AdminModerationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let admin;
  try {
    admin = await requireAdminRecord();
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const kind = typeof params.kind === "string" && KINDS.includes(params.kind) ? params.kind : "";
  const search = typeof params.q === "string" ? params.q.trim() : "";

  const exactUser = search ? await exactUserWhere(search) : null;
  const contains = { contains: search, mode: "insensitive" as const };
  const textOrUser = [
    { prompt: contains },
    { negativePrompt: contains },
    { user: { is: { OR: [{ email: contains }, { nickname: contains }] } } },
  ];
  const where: Prisma.ContentReviewWhereInput = {
    ...(kind ? { kind } : {}),
    ...(exactUser ? { user: { is: exactUser } } : {}),
    ...(search && !exactUser ? { OR: [...textOrUser, { hitWords: { has: search } }] } : {}),
  };
  // 上游拒绝的任务：筛选条件本身带一组 OR，搜索词要放进 AND 才不会把它顶掉。
  const jobWhere: Prisma.GenerationJobWhereInput = {
    ...PROVIDER_REFUSAL_WHERE,
    ...(exactUser ? { user: { is: exactUser } } : {}),
    ...(search && !exactUser ? { AND: [{ OR: textOrUser }] } : {}),
  };
  // 本站拒绝和上游拒绝按时间合成一个列表翻页：两边各取到本页为止的条数，合并后再截出这一页。
  const fromSite = kind !== "provider";
  const fromProvider = !kind || kind === "provider";
  const take = page * PAGE_SIZE;

  const [reviewRows, reviewCount, jobRows, jobCount, ranked] = await Promise.all([
    fromSite
      ? db.contentReview.findMany({
          orderBy: { createdAt: "desc" },
          select: {
            aiModel: true,
            aiScore: true,
            category: true,
            createdAt: true,
            hitWords: true,
            id: true,
            kind: true,
            negativePrompt: true,
            prompt: true,
            user: { select: userSelect },
          },
          take,
          where,
        })
      : [],
    fromSite ? db.contentReview.count({ where }) : 0,
    fromProvider
      ? db.generationJob.findMany({
          orderBy: { createdAt: "desc" },
          select: { createdAt: true, id: true, negativePrompt: true, prompt: true, user: { select: userSelect } },
          take,
          where: jobWhere,
        })
      : [],
    fromProvider ? db.generationJob.count({ where: jobWhere }) : 0,
    listModerationOffenders(50),
  ]);

  const totalCount = reviewCount + jobCount;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const reviews = [
    ...reviewRows,
    ...jobRows.map((job) => ({ ...job, aiModel: null, aiScore: null, category: null, hitWords: [], kind: "provider" })),
  ]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
    .map((record) => ({ ...record, createdAt: record.createdAt.toISOString(), user: boardUser(record.user) }));

  const users = ranked.length
    ? await db.user.findMany({ select: userSelect, where: { id: { in: ranked.map((entry) => entry.userId) } } })
    : [];
  const usersById = new Map(users.map((user) => [user.id, user]));
  const offenders = ranked.flatMap(({ lastAt, ...entry }) => {
    const user = usersById.get(entry.userId);
    return user ? [{ ...boardUser(user), ...entry, lastTriggerAt: lastAt?.toISOString() ?? null }] : [];
  });

  const extraParams: Record<string, string> = {};
  if (kind) extraParams.kind = kind;
  if (search) extraParams.q = search;

  return (
    <main className="pb-16">
      <section className="mx-auto grid max-w-7xl gap-6 px-5 pt-7 md:px-8">
        <AdminPageHeader
          eyebrow="Moderation"
          icon={ShieldAlert}
          title="内容风控与拦截中心"
          description={`集中查看被拦下的生成请求：本站敏感词和 AI 审核拒绝的（不扣积分），以及过了本站审核、被上游渠道拒绝的。24 小时内合计满 ${MODERATION_BLOCK_LIMIT} 次的账号会自动暂停提交，可以在这里看过提示词后手动封禁。`}
          badges={
            <span className="rounded-full border border-[var(--line)] bg-white px-3 py-1 font-mono text-xs font-medium text-[var(--ink-soft)]">
              当前结果 {totalCount.toLocaleString("zh-CN")} 条
            </span>
          }
        />

        <ModerationNavTabs
          activePath="/admin/moderation"
          totalReviewsCount={totalCount}
        />

        <ModerationReviewsBoard
          adminId={admin.id}
          initialSearch={search}
          kind={kind}
          offenders={offenders}
          reviews={reviews}
        />

        <AdminPagination
          basePath="/admin/moderation"
          currentPage={page}
          totalPages={totalPages}
          extraParams={Object.keys(extraParams).length ? extraParams : undefined}
        />
      </section>
    </main>
  );
}
