import "server-only";

import { getLoginCoverDisplayConfig } from "@/lib/server/login-cover";
import { listFeaturedWorksPage } from "@/lib/server/works";

/** 登录/注册共用封面；不用的精选不查询，装饰图故障不阻断登录。 */
export async function getAuthCover() {
  try {
    const config = await getLoginCoverDisplayConfig();
    if (config.mode === "custom") return { cover: null, coverImageUrl: config.customUrl };
    const { items } = await listFeaturedWorksPage({ limit: 1 });
    const work = items[0];
    return {
      cover: work ? { authorName: work.authorName, image: work.image, title: work.title } : null,
      coverImageUrl: null,
    };
  } catch {
    return { cover: null, coverImageUrl: null };
  }
}
