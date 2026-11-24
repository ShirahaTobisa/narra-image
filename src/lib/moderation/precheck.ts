import "server-only";

import sharp from "sharp";

import { getEnv } from "@/lib/env";

type PrecheckImage = { data: Buffer | Uint8Array; mimeType: string };
export type PrecheckVerdict = { refuse: false } | { refuse: true; reason: string; model: string };

const MAX_IMAGES = 4;
const IMAGE_SIDE = 1024;
const SYSTEM_PROMPT = [
  "你是生图服务的预审员。判断下面这条生图请求如果原样交给 OpenAI 的图片生成接口（gpt-image），会不会被它的安全系统拒绝。",
  "OpenAI 会拒绝：露骨的性内容、裸露，或几乎等于裸露、透明、明显情色的服装；看起来未成年或年龄不明的角色（例如穿校服或外表幼小的动漫角色）出现在性暗示、恋物、擦边的语境里；",
  "把真实人物（照片、coser）改成性暗示或羞辱的样子；露骨的暴力血腥；仇恨；自残。",
  "它对成年人的擦边也很严，这些也会被拒：刻意展示或特写臀部、胯部；女性张开双腿、跪趴、塌腰这类撩人姿势；",
  "熟女、少妇、人妻配丝袜、高跟鞋，又在强调腿脚身材或盯着看的恋物组合；整条请求只在强调女性妩媚、妖娆、丰腴、性感、撩人、诱惑。",
  "普通的人物和服装（包括人物设定里正常穿搭的丝袜、高跟、旗袍、职业装）、男性的普通坐姿、恋爱亲吻和拥抱、吸烟喝酒、不突出身体的泳装和时尚写真、",
  "没有血肉伤口特写的战斗、爆炸、战争和灾难场面（包括核爆和蘑菇云）不会被拒。",
  '只输出 JSON：{"refuse": true 或 false, "reason": "不超过 15 个字"}',
].join("");

async function imagePart(image: PrecheckImage) {
  const small = await sharp(Buffer.from(image.data)).rotate()
    .resize({ fit: "inside", height: IMAGE_SIDE, width: IMAGE_SIDE, withoutEnlargement: true })
    .jpeg({ quality: 80 }).toBuffer();
  return { image_url: { url: `data:image/jpeg;base64,${small.toString("base64")}` }, type: "image_url" };
}

/**
 * 预审：问一个能看图的大模型「这条原样交给 OpenAI 出图会不会被拒」。现有审核之外多挡一层，
 * 所以没配置、出错、超时都放行，交给上游自己判。图生图把参考图缩小后一起送（最多 4 张）。
 */
export async function precheckGeneration(text: string, images: readonly PrecheckImage[]): Promise<PrecheckVerdict> {
  const env = getEnv();
  if (!env.PRECHECK_BASE_URL || !env.PRECHECK_API_KEY || !env.PRECHECK_MODEL) return { refuse: false };
  try {
    const content = images.length === 0 ? text : [
      { text: `【图生图：附图是用户上传的参考图，生成时会以它为基础】\n${text}`, type: "text" },
      ...await Promise.all(images.slice(0, MAX_IMAGES).map(imagePart)),
    ];
    const response = await fetch(`${env.PRECHECK_BASE_URL.replace(/\/+$/, "")}/chat/completions`, {
      body: JSON.stringify({
        messages: [{ content: SYSTEM_PROMPT, role: "system" }, { content, role: "user" }],
        model: env.PRECHECK_MODEL,
        temperature: 0,
      }),
      headers: { Authorization: `Bearer ${env.PRECHECK_API_KEY}`, "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(env.PRECHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const answer = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const verdict = JSON.parse(/\{[\s\S]*\}/.exec(answer.choices?.[0]?.message?.content ?? "")?.[0] ?? "") as { refuse?: unknown; reason?: unknown };
    return verdict.refuse === true
      ? { model: env.PRECHECK_MODEL, reason: String(verdict.reason ?? "").slice(0, 60), refuse: true }
      : { refuse: false };
  } catch (error) {
    console.warn(`[moderation] 预审没有完成，已放行：${error instanceof Error ? error.message : "unknown"}`);
    return { refuse: false };
  }
}
