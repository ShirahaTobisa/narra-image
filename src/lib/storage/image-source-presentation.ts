import "server-only";

import type { Prisma } from "@prisma/client";
import { presentGenerationImage } from "./image-presentation";

type GenerationSources = { sourceImageUrls?: readonly string[]; sourceImageUrl?: string | null; sourceImagesReusable?: boolean; sourceImagesExpiresAt?: string | null };
type SourceAvailability = { sourceImagesReusable: boolean; sourceImagesExpiresAt: string | null };
export type ImageSourceUrlReader = Pick<Prisma.TransactionClient, "imageUrlAlias">;

function sourceUrls(generation: GenerationSources): readonly string[] {
  return generation.sourceImageUrls ?? (generation.sourceImageUrl ? [generation.sourceImageUrl] : []);
}

/** Batch presentation only: immutable job inputs in the database are untouched.
 * Unregistered URLs keep their legacy value; known unavailable sources are not
 * offered as browser thumbnails or reusable inputs. */
export async function projectGenerationSourceUrls<T extends GenerationSources>(generations: readonly T[], reader?: ImageSourceUrlReader): Promise<Array<T & SourceAvailability>> {
  const urls = [...new Set(generations.flatMap((generation) => [...sourceUrls(generation)]))]
    .filter((url) => /^https?:\/\//.test(url) && url.length <= 2048);
  if (!urls.length) return generations.map((generation) => ({ ...generation,
    sourceImagesReusable: generation.sourceImagesReusable !== false, sourceImagesExpiresAt: generation.sourceImagesExpiresAt ?? null }));
  const database = reader ?? (await import("@/lib/db")).db;
  const aliases = await database.imageUrlAlias.findMany({
    where: { url: { in: urls } },
    select: { url: true, asset: { select: { id: true, state: true, activeObjectId: true, publicToken: true, purpose: true, expiresAt: true } } },
  });
  const projected = new Map(aliases.map((alias) => [alias.url, presentGenerationImage({
    url: alias.url, mediaAssetId: alias.asset.id, mediaAsset: alias.asset,
  }).url]));
  const expiry = new Map(aliases.map((alias) => [alias.url, alias.asset.expiresAt == null ? undefined : new Date(alias.asset.expiresAt).getTime()]));
  return generations.map((generation) => {
    const original = sourceUrls(generation);
    const projectedUrls = original.map((url) => projected.get(url) ?? url);
    const reusable = generation.sourceImagesReusable !== false && !projectedUrls.includes("");
    const readable = reusable ? projectedUrls : [];
    const deadlines = [...original.map((url) => expiry.get(url)), generation.sourceImagesExpiresAt ? Date.parse(generation.sourceImagesExpiresAt) : undefined]
      .filter((time): time is number => time != null && Number.isFinite(time));
    return { ...generation, sourceImageUrls: readable, sourceImagesReusable: reusable,
      sourceImagesExpiresAt: deadlines.length ? new Date(Math.min(...deadlines)).toISOString() : null,
      ...("sourceImageUrl" in generation ? { sourceImageUrl: readable[0] ?? null } : {}) };
  });
}
