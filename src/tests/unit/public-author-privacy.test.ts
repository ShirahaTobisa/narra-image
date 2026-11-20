import { describe, expect, it } from "vitest";

import { serializeAdminWork, serializeFeaturedVideo, serializeFeaturedWork, serializePublicWorkDetail, serializeWork } from "@/lib/prisma-mappers";
import { createPrivacyWork } from "./helpers/work-privacy-fixtures";

describe("公开署名只来自投稿快照", () => {
  it.each([null, "送审时的昵称"])("快照 %j 不受后续个人改名影响，也不附带身份信息", (publicAuthorName) => {
    const original = createPrivacyWork();
    const work = { ...original, publicAuthorName, job: { ...original.job,
      user: { ...original.job.user, nickname: "未审核的新昵称", avatarUrl: "https://cdn.discordapp.com/avatars/private-id/hash.png" },
    } };
    const owner = serializeWork(work);
    const admin = serializeAdminWork(work);
    const featured = serializeFeaturedWork(work);
    const detail = serializePublicWorkDetail(owner);
    const video = serializeFeaturedVideo({ ...work, durationSeconds: 8, posterUrl: null });
    expect(owner).toMatchObject({ authorNickname: "未审核的新昵称", publicAuthorName });
    expect(admin).toMatchObject({ publicAuthorName, author: { email: work.job.user.email, id: work.job.user.id } });
    expect(detail.authorNickname).toBe(publicAuthorName);
    for (const card of [featured, video]) {
      expect(card).toMatchObject({ authorAvatar: null, authorName: publicAuthorName ?? "匿名创作者" });
    }
    const exposed = JSON.stringify([featured, detail, video]);
    for (const privateValue of ["未审核的新昵称", work.job.user.avatarUrl, work.job.user.email, work.job.user.id]) {
      expect(exposed).not.toContain(privateValue);
    }
    expect(detail).not.toHaveProperty("publicAuthorName");
    expect(work.job.user.nickname).toBe("未审核的新昵称");
  });
});
