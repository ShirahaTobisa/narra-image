# Research: studio generation correctness

- Query: find reproducible studio submission, retry, reference and conversation defects.
- Scope: internal source and existing tests; no production access or product edits.
- Date: 2026-11-20.
- Baseline: 2087e89.

## Findings

### 1. Mixed reference images lose the order shown in the composer (P1)

Trigger: add an existing image URL first, upload another image second, and submit an instruction referring to image 1 and image 2. Reordering a mixture of these reference types has the same problem.

- `src/components/create/generator-studio.tsx:794` appends the two multipart field types in the visible order.
- `src/lib/generation/parse-generate-request.ts:36` and `:45` extract file and URL arrays separately, dropping their relative order.
- `src/app/api/generate/route.ts:268` concatenates all uploaded files before all URLs, so the worker receives the wrong image sequence.
- Existing `generator-studio-origins.test.tsx:166` only verifies reordering two files; `generator-studio-feedback.test.tsx:562` verifies a URL alone.

Executed the real parser in a temporary Node process, with only the `server-only` import stubbed (no DB or network): multipart `[URL(base), File(style)]` yielded `images=[style.png]`, `imageUrls=[base.png]`; reproducing the route's concatenation yielded `[uploaded:style.png, URL(base)]`.

Minimal compatible repair: parse relevant FormData entries once in order, accepting existing aliases `referenceImages`, `images`, `image` for files and `referenceImageUrls` for URLs. Keep `images` and `imageUrls` for existing validation/moderation/download consumers and add `imageInputOrder: ('file'|'url')[]`. After file persistence, consume those two arrays in that order. JSON/Canvas use empty legacy order; Canvas keeps its canonical `canvasInputs.sourceImageUrls`. Do not change URL validation, moderation, quota or persistence behavior. Regression must assert final job input order for URL/file/URL/file, file-only, URL-only and legacy aliases.

### 2. Retry silently replaces the original request with a different operation (P1)

Trigger: an image edit fails, then click its `重试` button; or fail a 4K/high-quality request and change composer settings before retrying it.

- `src/components/create/generator-studio.tsx:1044` claims original source files cannot be reused.
- `:1068` forces `generationType: 'text_to_image'`, `:1078` forces `referenceImages: []`, and surrounding fields use current composer model/size/count/output settings instead of the failed job.
- That assumption is contradicted by `src/lib/prisma-mappers.ts:511`, which returns persisted source URLs, and `src/components/create/utils.ts:126`, whose `toReusableGenerationConfig` already reads the original configuration and references for `handleReuseConfig`.
- Failed job tests currently cover only text-to-image retry and replacement of the failed bubble; they do not assert preservation of the operation or parameters.

Minimal repair: reuse `toReusableGenerationConfig` when building the retry snapshot; reconstruct URL-backed reference objects and retain original generation type, model, size, count, quality, format, compression, negative prompt and moderation. Keep CAPTCHA/current authentication request ownership and replacement IDs. Preserve the original provider mode; custom provider credentials require the existing current/saved credential resolution, not a silently selected site provider. If original references are genuinely unavailable, show that and keep the failed job rather than quietly generating an unrelated image. Regression must assert image-edit multipart input and all original parameter values after the composer was changed.

### 3. Switching conversations clears references but leaves image-edit mode active (P2)

Trigger: add an image in conversation A, switch to conversation B, type an ordinary text prompt, and submit.

- `src/components/create/generator-studio.tsx:1118` clears prompt/negative prompt/references at `:1126` but leaves `generationType` unchanged.
- `:680` then blocks the new prompt with `请先上传参考图`.
- New conversation already resets the mode at `:1113`; ordinary conversation switching should match its draft-reset behavior.

Minimal repair: reset type to `text_to_image` when clearing the switched conversation's draft; extract shared reset only if it reduces duplicated existing code. Regression: upload in A, switch to B, send text without another mode click; assert a text-to-image request bound to B and no old references.

### 4. Composer advertises an image-only submission that the API rejects (P2)

Trigger: upload a reference image without a prompt, then click the enabled send button. A one-character prompt is also enabled but rejected.

- `src/components/create/generator-studio.tsx:1299` enables Send for any reference, even with blank prompt.
- `:684` explicitly permits blank prompt when a reference exists.
- `src/lib/validators.ts:83` requires at least two characters for every generation type.
- `src/lib/generation/parse-generate-request.ts:111` turns the blank multipart prompt into null, so the error is the raw Zod `Invalid input: expected string, received null`, instead of the intended Chinese length message.

Executed the real parser with blank prompt and a reference; it rejects with the raw null/string error. Minimal repair preserving API contract: validate the two-character requirement before creating a conversation/submitting, show its Chinese message, and align Send availability. Do not invent a default instruction or loosen backend policy without product intent. Regression: blank/one-character text and image prompts never POST; valid image prompt still submits.

## Relevant project guidance

- `.trellis/spec/frontend/state-management.md`: captured draft ownership, no stale server-prop overwrite, and narrow media-fact merging.
- `.trellis/spec/frontend/hook-guidelines.md`: lifecycle cleanup and reusable feature hooks.
- `.trellis/spec/frontend/quality-guidelines.md`: behavioral regressions plus lint/types/tests/build; no real DB in tests.

## Caveats

This is source-based defect research with one real parser reproduction; no browser/server generation was performed. Existing tests were inspected, not run by this research agent. No evidence links these defects to actual historical production requests. The unbounded generation POST and exhausted poller leaving a pending UI also merit follow-up, but are deliberately excluded from confirmed scope because recovery behavior needs design and must not create automatic duplicate billable requests.

## Implementation follow-up

The same agent was reassigned to implementation. Changed only `generator-studio.tsx`, `parse-generate-request.ts`, and their `generator-studio-origins` / `parse-generate-request` tests. Route consumption of `imageInputOrder` belongs to the backend agent.

- All four findings are addressed. Retry uses the existing reusable configuration converter and persisted reference URLs, retaining provider mode. Custom credentials still come from current/saved authorized configuration because historical secrets are never exposed to the browser; a disabled custom-provider feature is reported instead of silently switching to site credits.
- Eight new regression cases failed against the original implementation and passed after repair.
- Seven relevant studio/parser suites passed: 92 tests, 15.82 seconds. Commands use the installed Vitest CLI with two workers; logs are at `D:/tools/codex/tmp/narra-studio-checks.log`.
- ESLint for the four changed code/test files and scoped `git diff --check` passed.
- A concurrent full type check reported only `site-image.test.ts` importing the backend agent's not-yet-created `site-image` module. Root must rerun after parallel implementation completes; this is not a successful type-check receipt.
