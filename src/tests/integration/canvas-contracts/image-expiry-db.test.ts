// @vitest-environment node

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { assertDisposableTestDatabaseUrl } from "../../../../scripts/lib/disposable-test-environment.mjs";
import { imageLocalLocation, type ImageErrorCode } from "@/lib/storage/image-contract";
import { ImageRepository, type ImageQueryer } from "@/lib/storage/image-repository";
import { createRetentionFixture } from "./fixtures/retention-fixture.mjs";

function databaseUrl() {
  if (process.env.CANVAS_CONTRACTS_REQUIRE_DB !== "1" || !process.env.TEST_DATABASE_URL || process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL) throw new Error("Image expiry tests require the disposable runner");
  const url = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  if (!/^\/narra_canvas_(full|additive)_[a-f0-9]{16}$/.test(url.pathname) || url.username !== "narra_canvas" || !/^[0-9a-f-]{36}$/.test(process.env.CANVAS_CONTRACTS_OWNER_TOKEN ?? "")) throw new Error("Not a runner-owned image expiry database");
  url.search = "";
  return url.toString();
}
const url = databaseUrl();
const connections = new Set<Client>();
const origin = "https://expiry.invalid";

async function rollback(body: (client: Client, repo: ImageRepository) => Promise<void>) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000, statement_timeout: 8000, query_timeout: 10000 });
  await client.connect(); connections.add(client);
  expect((await client.query('SELECT token::text FROM "_canvas_contracts_owner"')).rows).toEqual([{ token: process.env.CANVAS_CONTRACTS_OWNER_TOKEN }]);
  await client.query("BEGIN");
  const adapter = { $queryRaw: async (sql: Prisma.Sql) => (await client.query(sql.text, [...sql.values])).rows } as unknown as ImageQueryer;
  try { await body(client, new ImageRepository(adapter)); await client.query("SET CONSTRAINTS ALL IMMEDIATE"); }
  finally { await client.query("ROLLBACK"); await client.end(); connections.delete(client); }
}
/** The repository reports the code; a guard reached through plain SQL reports it as the message. */
async function refused(client: Client, code: ImageErrorCode, action: () => Promise<unknown>) {
  await client.query("SAVEPOINT refused");
  try { await expect(action()).rejects.toSatisfy((error: { code?: string; message?: string }) => error.code === code || error.message === code); }
  finally { await client.query("ROLLBACK TO SAVEPOINT refused"); await client.query("RELEASE SAVEPOINT refused"); }
}
async function user(client: Client) {
  const id = randomUUID();
  await client.query('INSERT INTO "User" (id,email,credits,"updatedAt") VALUES ($1,$2,100,clock_timestamp())', [id, `${id}@expiry.invalid`]);
  return id;
}
async function job(client: Client, ownerId: string, fields: { status?: string; workerId?: string; sourceImageUrls?: string[] } = {}) {
  const id = randomUUID(); const sources = fields.sourceImageUrls ?? [];
  await client.query(`INSERT INTO "GenerationJob" (id,"userId","providerMode",model,prompt,size,count,status,"workerId","generationType","sourceImageUrls","updatedAt")
    VALUES ($1,$2,'BUILT_IN','gpt-image-2','到期清理验证','auto',1,$3::"GenerationStatus",$4,$5::"GenerationType",$6::text[],clock_timestamp())`,
  [id, ownerId, fields.status ?? "PENDING", fields.workerId ?? null, sources.length ? "IMAGE_TO_IMAGE" : "TEXT_TO_IMAGE", sources]);
  return id;
}
/** Like the retention fixture: the original lease is short before any object exists; no object timestamp is edited. */
async function reserve(client: Client, ownerId: string, output?: { jobId: string; workerId: string }) {
  const reserved = { reservationId: randomUUID(), token: randomUUID() };
  await client.query("SELECT image_lock_quota()");
  await client.query(`INSERT INTO "ImageWriteReservation" (id,token,"ownerId","intentKey",kind,"slotBytes","remainingBytes","outputJobId","workerId","leaseExpiresAt")
    VALUES ($1::uuid,$2::uuid,$3,$4,$5,ARRAY[$6::bigint],$6::bigint,$7,$8,clock_timestamp()+interval '1 second')`,
  [reserved.reservationId, reserved.token, ownerId, `expiry-fixture:${reserved.reservationId}`, output ? "OUTPUT" : "INPUT", output ? 52428800 : 10, output?.jobId ?? null, output?.workerId ?? null]);
  return reserved;
}
const bytes = { slot: 0, byteLength: 10, mimeType: "image/png", sha256: "e".repeat(64) } as const;
async function confirm(repo: ImageRepository, reserved: { reservationId: string; token: string }, ticket: { object: { id: string; writeToken: string } }) {
  expect(await repo.finishObject({ objectId: ticket.object.id, writeToken: ticket.object.writeToken, outcome: "CONFIRMED" })).toMatchObject({ accepted: true, asset: { state: "AVAILABLE" } });
  await repo.closeReservation(reserved);
}
async function temporaryReference(client: Client, repo: ImageRepository, ownerId: string, locationId: string) {
  const reserved = await reserve(client, ownerId);
  const ticket = await repo.beginObject({ ...reserved, ...bytes, locationId, key: `temporary/images/${randomUUID()}.png`, purpose: "REFERENCE", temporary: true });
  await confirm(repo, reserved, ticket);
  const address = `${origin}/media/temporary-images/${ticket.asset.publicToken}`;
  await repo.registerAlias({ assetId: ticket.asset.id, url: address });
  return { assetId: ticket.asset.id, objectId: ticket.object.id, url: address };
}
async function temporaryOutput(client: Client, repo: ImageRepository, ownerId: string, locationId: string) {
  const jobId = await job(client, ownerId, { status: "PROCESSING", workerId: "expiry-worker" });
  const reserved = await reserve(client, ownerId, { jobId, workerId: "expiry-worker" });
  const input = { ...reserved, ...bytes, locationId, purpose: "GENERATED" as const };
  await refused(client, "IMAGE_INVALID_INPUT", () => repo.beginObject({ ...input, key: `images/${randomUUID()}.png`, temporary: true }));
  await refused(client, "IMAGE_INVALID_INPUT", () => repo.beginObject({ ...input, key: `temporary/images/${randomUUID()}.png` }));
  const ticket = await repo.beginObject({ ...input, key: `temporary/images/${randomUUID()}.png`, temporary: true });
  // An output reservation can only close once its job has finished, as the worker does.
  expect(await repo.finishObject({ objectId: ticket.object.id, writeToken: ticket.object.writeToken, outcome: "CONFIRMED" })).toMatchObject({ accepted: true });
  const imageId = randomUUID();
  await client.query(`INSERT INTO "GenerationImage" (id,"jobId",url,"mediaStorage","storageKey","mediaAssetId") VALUES ($1,$2,$3,'LOCAL',$4,$5::uuid)`,
    [imageId, jobId, `${origin}/media/temporary-images/${ticket.asset.publicToken}`, ticket.object.key, ticket.asset.id]);
  await client.query(`UPDATE "GenerationJob" SET status='SUCCEEDED',"completedAt"=clock_timestamp() AT TIME ZONE 'UTC',"workerId"=NULL WHERE id=$1`, [jobId]);
  await repo.closeReservation(reserved);
  return { jobId, imageId, assetId: ticket.asset.id, objectId: ticket.object.id };
}
async function writesExpired(client: Client, ids: string[]) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((await client.query<{ expired: boolean }>('SELECT bool_and("writeExpiresAt" <= clock_timestamp()) AS expired FROM "ImageObject" WHERE id=ANY($1::uuid[])', [ids])).rows[0].expired) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fixture writer lease did not expire");
}
const expire = (client: Client, ids: string[]) => client.query(`UPDATE "ImageAsset" SET "expiresAt"=date_trunc('milliseconds',clock_timestamp()) WHERE id=ANY($1::uuid[])`, [ids]);
const cleanupReason = async (client: Client, id: string) => (await client.query("SELECT image_cleanup_reason($1::uuid) AS reason", [id])).rows[0].reason;
const deadline = async (client: Client, id: string, check: string) => (await client.query(`SELECT ${check} AS ok FROM "ImageAsset" WHERE id=$1::uuid`, [id])).rows[0].ok;

afterAll(async () => { await Promise.all([...connections].map((client) => client.end().catch(() => undefined))); });

describe("temporary images on disposable PostgreSQL", () => {
  it("gives a finished output one hour, then refuses reads and removes the file with the cleanup policy off", async () => {
    await rollback(async (client, repo) => {
      const ownerId = await user(client); const location = await repo.registerLocation(imageLocalLocation(randomUUID()));
      const output = await temporaryOutput(client, repo, ownerId, location.id);
      expect((await client.query(`SELECT a."expiresAt"=j."completedAt"+interval '1 hour' AS exact FROM "ImageAsset" a,"GenerationJob" j WHERE a.id=$1::uuid AND j.id=$2`, [output.assetId, output.jobId])).rows[0].exact).toBe(true);
      await refused(client, "IMAGE_WRITE_CONFLICT", () => client.query(`UPDATE "ImageAsset" SET "expiresAt"="expiresAt"+interval '1 second' WHERE id=$1::uuid`, [output.assetId]));
      await refused(client, "IMAGE_WRITE_CONFLICT", () => client.query('UPDATE "ImageAsset" SET "expiresAt"=NULL WHERE id=$1::uuid', [output.assetId]));
      await refused(client, "IMAGE_REFERENCE_CONFLICT", () => client.query(`UPDATE "GenerationImage" SET "showcaseStatus"='PENDING' WHERE id=$1`, [output.imageId]));
      expect(await cleanupReason(client, output.assetId)).toBe("NOT_EXPIRED");

      await expire(client, [output.assetId]);
      await refused(client, "IMAGE_UNAVAILABLE", () => repo.beginRead({ assetId: output.assetId }));
      expect((await repo.getUsage()).policy.enabled).toBe(false);
      await writesExpired(client, [output.objectId]);
      expect(await repo.enqueueDueCleanup()).toMatchObject({ mode: "EXPIRY", state: "QUEUED", totalItems: 1 });
      const executor = { workerId: `expiry:${randomUUID()}`, token: randomUUID() };
      expect(await repo.acquireMaintenanceLease(executor)).toBe(true);
      const [claim, ...rest] = await repo.claimMaintenance({ executorToken: executor.token, verifiedLocationIds: [location.id] });
      expect(rest).toEqual([]); expect(claim).toMatchObject({ mode: "EXPIRY", object: { id: output.objectId } });
      expect(await repo.finishMaintenanceObject({ jobId: claim.jobId, itemId: claim.itemId, objectId: claim.object.id, deleteToken: claim.deleteToken, outcome: "DELETED" }))
        .toMatchObject({ accepted: true, releasedBytes: "10", job: { state: "SUCCEEDED" } });
      expect((await repo.getByAssetId(output.assetId))?.asset.state).toBe("DELETED");
      // The next batch waits five minutes, and the generation record outlives its image.
      expect(await repo.enqueueDueCleanup()).toBeNull();
      expect((await client.query(`SELECT j.status::text,j.prompt,(SELECT count(*)::int FROM "GenerationImage" WHERE "jobId"=j.id) AS images FROM "GenerationJob" j WHERE j.id=$1`, [output.jobId])).rows)
        .toEqual([{ status: "SUCCEEDED", prompt: "到期清理验证", images: 1 }]);
    });
  });

  it("keeps an expired reference for the job that already accepted it, and for nothing else", async () => {
    await rollback(async (client, repo) => {
      const ownerId = await user(client); const location = await repo.registerLocation(imageLocalLocation(randomUUID()));
      const read = await temporaryReference(client, repo, ownerId, location.id); const kept = await temporaryReference(client, repo, ownerId, location.id);
      const accepted = await job(client, ownerId, { sourceImageUrls: [read.url, kept.url] }); const unrelated = await job(client, ownerId);
      await expire(client, [read.assetId, kept.assetId]);
      await writesExpired(client, [read.objectId, kept.objectId]);

      expect(await cleanupReason(client, kept.assetId)).toBe("REFERENCED");
      await refused(client, "IMAGE_UNAVAILABLE", () => repo.beginRead({ assetId: read.assetId }));
      await refused(client, "IMAGE_UNAVAILABLE", () => repo.beginRead({ assetId: read.assetId, jobId: unrelated }));
      await refused(client, "IMAGE_UNAVAILABLE", () => job(client, ownerId, { sourceImageUrls: [kept.url] }));
      expect((await repo.beginRead({ assetId: read.assetId, jobId: accepted }))?.image.asset.id).toBe(read.assetId);

      await client.query(`UPDATE "GenerationJob" SET status='FAILED' WHERE id=$1`, [accepted]);
      await refused(client, "IMAGE_UNAVAILABLE", () => repo.beginRead({ assetId: read.assetId, jobId: accepted }));
      expect(await cleanupReason(client, kept.assetId)).toBeNull();
    });
  });

  it("leaves permanent images and unexpired temporary images alone", async () => {
    await rollback(async (client, repo) => {
      const ownerId = await user(client); const location = await repo.registerLocation(imageLocalLocation(randomUUID()));
      const permanent = createRetentionFixture({ ownerId, locationId: location.id, key: `fixture/${randomUUID()}.png`, byteLength: 10, mimeType: "image/png", sha256: "a".repeat(64), publicUrlOrigin: origin, leaseMilliseconds: 1000, transaction: false });
      await client.query(permanent.sql);
      const fresh = await temporaryReference(client, repo, ownerId, location.id);
      await writesExpired(client, [permanent.objectId, fresh.objectId]);
      expect(await cleanupReason(client, fresh.assetId)).toBe("NOT_EXPIRED");
      expect(await repo.enqueueDueCleanup()).toBeNull();
      expect((await repo.getByAssetId(permanent.assetId))?.asset).toMatchObject({ state: "AVAILABLE", expiresAt: null });
      expect((await repo.beginRead({ assetId: fresh.assetId }))?.image.asset.id).toBe(fresh.assetId);
    });
  });

  it("keeps an upload private until review, permanent while public, and removable afterwards", async () => {
    await rollback(async (client, repo) => {
      const ownerId = await user(client); const stranger = await user(client); const admin = await user(client);
      await client.query(`UPDATE "User" SET role='ADMIN' WHERE id=$1`, [admin]);
      const location = await repo.registerLocation(imageLocalLocation(randomUUID()));
      const upload = async () => {
        const id = `gallery_${randomUUID().replaceAll("-", "")}`; const submittedAt = new Date().toISOString(); const reserved = await reserve(client, ownerId);
        const ticket = await repo.beginObject({ ...reserved, ...bytes, locationId: location.id, key: `images/${randomUUID()}.png`, purpose: "GALLERY_UPLOAD", originId: id });
        const insert = (workId: string) => client.query(`INSERT INTO "GalleryWork" (id,"userId","mediaAssetId","requestKey","payloadHash","submittedAt","updatedAt")
          VALUES ($1,$2,$3::uuid,$4,$5,$6::timestamp,$6::timestamp)`, [workId, ownerId, ticket.asset.id, randomUUID(), "f".repeat(64), submittedAt]);
        await refused(client, "IMAGE_REFERENCE_CONFLICT", () => insert(`gallery_${randomUUID().replaceAll("-", "")}`));
        await insert(id);
        await confirm(repo, reserved, ticket);
        return { id, assetId: ticket.asset.id, objectId: ticket.object.id, submittedAt };
      };
      const review = (work: { id: string; submittedAt: string }, actorId: string, action: Parameters<ImageRepository["reviewGalleryWork"]>[0]["action"], expectedSubmittedAt = work.submittedAt) =>
        repo.reviewGalleryWork({ workId: work.id, actorId, action, expectedSubmittedAt });
      const removed = await upload(); const shown = await upload(); const rejected = await upload();
      expect(await deadline(client, removed.assetId, `"expiresAt">clock_timestamp()+interval '23 hours' AND "expiresAt"<=clock_timestamp()+interval '24 hours'`)).toBe(true);

      await refused(client, "IMAGE_UNAVAILABLE", () => repo.beginRead({ assetId: shown.assetId }));
      await refused(client, "IMAGE_UNAVAILABLE", () => repo.beginRead({ assetId: shown.assetId, viewerId: stranger }));
      for (const viewerId of [ownerId, admin]) expect((await repo.beginRead({ assetId: shown.assetId, viewerId }))?.image.asset.id).toBe(shown.assetId);

      for (const actorId of [stranger, ownerId]) await refused(client, "IMAGE_REFERENCE_CONFLICT", () => review(removed, actorId, "APPROVE"));
      await refused(client, "IMAGE_REFERENCE_CONFLICT", () => review(removed, admin, "APPROVE", new Date(0).toISOString()));
      expect(await review(removed, admin, "APPROVE")).toEqual({ id: removed.id, showcaseStatus: "FEATURED", expiresAt: null });
      expect(await review(shown, admin, "APPROVE")).toMatchObject({ showcaseStatus: "FEATURED", expiresAt: null });
      expect((await repo.beginRead({ assetId: shown.assetId }))?.image.asset.id).toBe(shown.assetId);
      await writesExpired(client, [removed.objectId, rejected.objectId]);
      expect(await cleanupReason(client, removed.assetId)).toBe("REFERENCED");

      expect(await review(removed, ownerId, "REQUEST_TAKEDOWN")).toMatchObject({ showcaseStatus: "TAKEDOWN_PENDING", expiresAt: null });
      expect(await review(removed, admin, "TAKEDOWN")).toMatchObject({ showcaseStatus: "PRIVATE" });
      expect(await review(rejected, admin, "REJECT")).toMatchObject({ showcaseStatus: "PRIVATE" });
      for (const work of [removed, rejected]) {
        expect(await deadline(client, work.assetId, `"expiresAt"<=clock_timestamp()`)).toBe(true);
        expect(await cleanupReason(client, work.assetId)).toBeNull();
      }
      expect((await client.query('DELETE FROM "GalleryWork" WHERE id=$1', [rejected.id])).rowCount).toBe(1);
      // A deadline rounded up to the next millisecond used to be refused about two times in three.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const work = await upload();
        await review(work, admin, "APPROVE");
        expect(await review(work, admin, "FORCE_TAKEDOWN")).toMatchObject({ showcaseStatus: "PRIVATE" });
      }

      await client.query('UPDATE "User" SET "bannedAt"=clock_timestamp() WHERE id=$1', [ownerId]);
      await refused(client, "IMAGE_UNAVAILABLE", () => repo.beginRead({ assetId: shown.assetId }));
    });
  });
});
