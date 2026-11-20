import "server-only";

export const publicWorkWhere = {
  showcaseStatus: "FEATURED" as const,
  job: { user: { bannedAt: null } },
};

/** viewerId 只能来自服务端鉴权；作者仍可查看自己的私有作品。 */
export function visibleWorkWhere(viewerId?: string | null) {
  return viewerId
    ? { OR: [publicWorkWhere, { job: { userId: viewerId } }] }
    : publicWorkWhere;
}
