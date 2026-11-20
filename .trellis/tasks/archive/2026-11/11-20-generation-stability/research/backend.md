# Research: generation submission and image reuse

- Query: identify reproducible failures in generation submission, reference reuse, moderation, channel selection and refunds.
- Scope: internal, read-only code review. No production writes or requests by this researcher.
- Date: 2026-11-20
- Baseline: commit `2087e89`; parent reports two successful production text-to-image jobs and no failed/pending jobs. Findings below describe code paths, not observed historical incidents.

## 1. Existing database/S3 images cannot be reused through the normal studio

Priority: high; applies whenever generated or uploaded reference images have not been registered in managed image storage.

Evidence:

- `src/lib/storage/persist-generated-image.ts:178` returns a complete data URL when database image storage is enabled; unmanaged S3 storage returns its public URL at lines 170-175.
- `src/components/create/generator-studio.tsx:910` puts a selected generated image URL into `sourceUrl`; retry restores prior reference URLs at line 960.
- The actual request submits these values as `referenceImageUrls` at line 796.
- `src/app/api/generate/route.ts:66-74` only accepts URLs resolved by `resolveManagedImageUrl`; a built-in request rejects every other value as an external URL.
- `readSiteReferenceImages` at lines 78-84 also reads only managed images, so changing only the assertion would accidentally skip image moderation.
- `src/app/api/proxy-image/route.ts` has the same managed-only gate, so downloading an unmanaged S3 image through the site's proxy also returns 403.

Reproduction: enable database image storage with managed storage off, generate an image successfully, click the existing image-edit/reuse action, submit. The image is sent as a data URL and rejected as an external link. Retrying an image-to-image job whose uploaded references were stored as data URLs has the same outcome. Unmanaged S3 URLs have the corresponding failure.

Smallest safe repair direction: share a source resolver/reader for managed images and explicitly verified legacy images. Establish that legacy input belongs to a persisted site image (including the owner's saved references and permitted public images), then obtain bounded bytes for moderation and the immutable generation input. Preserve ownership, availability, remote URL checks, and read failure behavior. Do not blanket-allow arbitrary data or HTTP URLs. Do not download an unchecked URL merely because its origin resembles the configured CDN. For legacy remote objects, ensure the worker consumes the bytes that were moderated, not a second mutable fetch of an arbitrary URL.

Regression coverage: own database-generated image; retry using an owner's database-stored reference; own/allowed-public legacy S3 image; unrelated data URL and external HTTP URL rejected; deleted managed image remains rejected; reference bytes reach moderation; download returns original supported-image bytes. Current `generate-route-security.test.ts` covers managed references only, and frontend tests mock the API instead of connecting this storage path to submission.

## 2. Canvas image references bypass the site's image moderation

Priority: high when Canvas is enabled; actual production Canvas setting was not inspected by this researcher.

Evidence:

- The Canvas parser creates `images: []` and `imageUrls: []`; the real references are structured IDs in `canvasRun.input.references`.
- `src/app/api/generate/route.ts:136` explicitly excludes Canvas preparations from `readSiteReferenceImages`.
- `checkGenerationInput` receives only file and non-Canvas reference images at lines 141-147.
- `readCanvasRunInputs` resolves real Canvas references only later, at line 221, and their URLs are committed to the generation job at lines 268 and 289-290.
- `src/lib/canvas/inputs.ts:26-61` already verifies reference ownership and resolves generated/imported canonical URLs; it does not perform content moderation.

Reproduction: submit an image-to-image Canvas run with an imported/result reference and innocuous text. The site's moderation function receives an empty image array while the worker receives the actual image. The model provider may still perform its own checks; that does not satisfy the site's configured pre-submit moderation.

Repair direction: resolve and read Canvas reference bytes before the shared moderation call, using the same verified image-reading path as normal studio references. Keep the existing `prepareCanvasRunCommit` lock/revalidation (run-submission.ts:80-99), so source ownership and identity are checked again during commit. Failed review must reject the preparation without creating a job or charging credits. Do not weaken result/source authorization or make Canvas input reads network operations inside a long database transaction.

Regression coverage: imported and generated Canvas references are included in the moderation payload; rejected reference creates neither job nor charge; a source changed between read and commit is still rejected; text-only Canvas runs retain empty images; idempotent replays do not repeat review.

## 3. Cancelling queued jobs makes a healthy channel appear broken

Priority: medium; affects deployments with multiple eligible channels.

Evidence:

- `src/app/api/me/generations/[id]/route.ts:116-120` records a user-cancelled queued job as FAILED with `errorCode: GENERATION_CANCELLED` and message `用户取消生成。`.
- `src/lib/providers/built-in-provider.ts:240-252` queries the last three succeeded/failed jobs, selects only status and message, and treats every failure except two content-policy message patterns as evidence of a broken channel.
- `getGenerationChannelForModel` at lines 229-233 then skips that channel for subsequent requests globally during the ten-minute window.

Reproduction: with two compatible channels, submit and cancel three pending requests on the first channel; the next generation routes to the backup despite no upstream failure. The existing per-user two-active-job limit does not prevent sequential submit/cancel operations.

Small repair: exclude `GENERATION_CANCELLED` from channel health samples, preferably before `take: 3`, so cancellations neither count as failures nor obscure real recent provider outcomes. Review similar known pre-provider failures without expanding this into a new circuit-breaker system. Preserve handling for legacy `errorCode: null` provider failures and moderation errors.

Regression coverage: three cancellations keep the primary channel eligible; three real upstream failures choose the backup; mixed cancellation/real outcomes use the last three meaningful outcomes; a real success resets the failure streak.

## 4. Malformed successful moderation responses are accepted

Priority: medium; robustness of the advertised fail-closed moderation policy.

Evidence:

- `src/lib/moderation/check.ts:196-220` only requires `results.length` to be nonzero.
- `{results:[{}]}` produces no category scores, undefined `flagged`, and returns `{blocked:false}`.
- Non-numeric scores are converted to zero via `Number(score) || 0` at line 204.
- The caller states and implements rejection on thrown moderation errors, but malformed successful JSON does not throw.

Small repair: validate the successful response before interpretation (nonempty result array, boolean flagged value, nonempty score object with finite numeric values in the expected range). Preserve normal compatibility for different returned category names; malformed responses should lead to the existing unavailable message, not a new user-facing policy.

Regression coverage: empty object result, missing/invalid flagged value, missing/empty scores, nonnumeric/negative/out-of-range score, and nonarray results all fail closed; valid safe/flagged/threshold-crossing responses retain existing behavior.

## Other observations and boundaries

- Credit cost is explicitly per request in README and `credits.test.ts`; output count not multiplying cost is existing product policy, not an established bug.
- Pending cancellation uses conditional status updates, and refunds use a conditional refund marker/credit check. No concrete duplicate-refund defect was established in this review.
- `generate/route.ts:277` skips the global per-user active-job check for Canvas preparations, relying on a per-node restriction. This permits more than two active jobs across Canvas nodes; it is an explicit code comment/design exception and should not be changed casually as part of the three confirmed failures.
- Worker handoff and UNKNOWN refund handling have strict existing shared contracts; avoid refactoring them without disposable database validation.
- No product code was modified and no runtime reproduction/test pass is claimed by this research artifact.

## Related specifications

- `.trellis/spec/frontend/directory-structure.md`
- `.trellis/spec/frontend/generation-worker-contracts.md`
- `.trellis/spec/frontend/quality-guidelines.md`
- `.trellis/spec/operations/media-storage.md`
- `.trellis/spec/operations/canvas-contracts.md`
- `.trellis/spec/operations/image-storage.md`
