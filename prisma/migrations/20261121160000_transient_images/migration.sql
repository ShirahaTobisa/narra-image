-- Existing assets remain permanent. Only new, explicitly temporary writes expire.
ALTER TABLE "ImageAsset" ADD COLUMN "expiresAt" TIMESTAMPTZ(3);
CREATE INDEX "ImageAsset_expiry_idx" ON "ImageAsset" (state,"expiresAt",id);
ALTER TABLE "ImageAsset" DROP CONSTRAINT "ImageAsset_purpose_check";
ALTER TABLE "ImageAsset" ADD CONSTRAINT "ImageAsset_purpose_check" CHECK (purpose IN ('GENERATED','REFERENCE','CANVAS_IMPORT','GALLERY_UPLOAD'));
ALTER TABLE "ImageMaintenanceJob" DROP CONSTRAINT "ImageMaintenanceJob_mode_check";
ALTER TABLE "ImageMaintenanceJob" ADD CONSTRAINT "ImageMaintenanceJob_mode_check" CHECK (mode IN ('MANUAL_AGE','MANUAL_ALL','SCHEDULE','QUOTA','SOURCE_RETIREMENT','EXPIRY'));
ALTER TABLE "ImageReplicaVerification" DROP CONSTRAINT "ImageReplicaVerification_readerProtocolRevision_check";
ALTER TABLE "ImageReplicaVerification" ADD CONSTRAINT "ImageReplicaVerification_readerProtocolRevision_check" CHECK ("readerProtocolRevision" IN (2,3,4));

CREATE TABLE "GalleryWork" (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "mediaAssetId" UUID NOT NULL UNIQUE REFERENCES "ImageAsset"(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  "requestKey" VARCHAR(64) NOT NULL,
  "payloadHash" CHAR(64) NOT NULL CHECK ("payloadHash" ~ '^[0-9a-f]{64}$'),
  prompt TEXT, "negativePrompt" TEXT,
  width INTEGER CHECK (width > 0), height INTEGER CHECK (height > 0),
  "showcaseStatus" "ShowcaseStatus" NOT NULL DEFAULT 'PENDING',
  "showPromptPublic" BOOLEAN NOT NULL DEFAULT false,
  "publicAuthorName" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL,
  "featuredAt" TIMESTAMP(3), "reviewedAt" TIMESTAMP(3), "reviewNote" TEXT,
  "reviewedById" TEXT REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GalleryWork_userId_requestKey_key" UNIQUE ("userId","requestKey")
);
CREATE INDEX "GalleryWork_userId_createdAt_id_idx" ON "GalleryWork" ("userId","createdAt" DESC,id DESC);
CREATE INDEX "GalleryWork_showcaseStatus_featuredAt_id_idx" ON "GalleryWork" ("showcaseStatus","featuredAt" DESC,id DESC);
ALTER TABLE "WorkLike" ADD COLUMN "galleryWorkId" TEXT REFERENCES "GalleryWork"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "WorkLike_galleryWorkId_userId_key" ON "WorkLike" ("galleryWorkId","userId");
CREATE INDEX "WorkLike_galleryWorkId_idx" ON "WorkLike" ("galleryWorkId");
ALTER TABLE "WorkLike" ADD CONSTRAINT "WorkLike_one_target_check" CHECK (num_nonnulls("workId","videoId","galleryWorkId") <= 1);

CREATE FUNCTION image_job_needs_inputs(p_job TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "GenerationJob" WHERE id=p_job AND
    (status::text IN ('PENDING','PROCESSING') OR "handoffState"::text IN ('SUBMITTING','SUBMITTED','UNKNOWN')))
$$;

CREATE FUNCTION image_job_has_input(p_asset UUID,p_job TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT image_job_needs_inputs(p_job) AND EXISTS (
    SELECT 1 FROM "GenerationJob" j JOIN "ImageReference" r ON r."referenceKey"='job:'||j.id
      AND r.kind='JOB_INPUT' AND r."ownerId"=j."userId" AND r."assetId"=p_asset
    JOIN "ImageUrlAlias" a ON a."assetId"=r."assetId" AND a.url=ANY(j."sourceImageUrls") WHERE j.id=p_job)
$$;

-- Author/admin preview remains private; only approved, unbanned uploads are public.
CREATE FUNCTION image_gallery_readable(p_asset UUID,p_viewer TEXT) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "GalleryWork" w JOIN "User" u ON u.id=w."userId" WHERE w."mediaAssetId"=p_asset AND
    ((w."showcaseStatus"::text IN ('FEATURED','TAKEDOWN_PENDING') AND u."bannedAt" IS NULL) OR EXISTS (
      SELECT 1 FROM "User" v WHERE v.id=p_viewer AND v."bannedAt" IS NULL AND (v.id=w."userId" OR v.role::text='ADMIN'))))
$$;

CREATE FUNCTION image_gallery_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE a "ImageAsset";
BEGIN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO a FROM "ImageAsset" WHERE id=NEW."mediaAssetId" FOR UPDATE;
  IF a.id IS NULL OR a.purpose<>'GALLERY_UPLOAD' OR a."ownerId"<>NEW."userId" OR a."originId" IS DISTINCT FROM NEW.id THEN PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
  IF TG_OP='INSERT' THEN
    IF NEW."showcaseStatus"::text<>'PENDING' OR a.state NOT IN ('PENDING','AVAILABLE') OR a."expiresAt" IS NULL OR a."expiresAt"<=clock_timestamp() THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
  ELSIF NEW.id<>OLD.id OR NEW."userId"<>OLD."userId" OR NEW."mediaAssetId"<>OLD."mediaAssetId" OR NEW."requestKey"<>OLD."requestKey" OR NEW."payloadHash"<>OLD."payloadHash" OR NEW."submittedAt"<>OLD."submittedAt" THEN
    PERFORM image_raise('IMAGE_REFERENCE_CONFLICT');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "GalleryWork_image_epoch" BEFORE INSERT OR UPDATE OR DELETE ON "GalleryWork" FOR EACH STATEMENT EXECUTE FUNCTION image_reference_epoch_trigger();
CREATE TRIGGER "GalleryWork_image_guard" BEFORE INSERT OR UPDATE ON "GalleryWork" FOR EACH ROW EXECUTE FUNCTION image_gallery_guard();

CREATE FUNCTION image_gallery_roots() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_id TEXT; v_asset UUID; v_owner TEXT; v_status TEXT;
BEGIN
  v_id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  v_asset:=CASE WHEN TG_OP='DELETE' THEN OLD."mediaAssetId" ELSE NEW."mediaAssetId" END;
  v_owner:=CASE WHEN TG_OP='DELETE' THEN OLD."userId" ELSE NEW."userId" END;
  v_status:=CASE WHEN TG_OP='DELETE' THEN 'PRIVATE' ELSE NEW."showcaseStatus"::text END;
  IF v_status IN ('FEATURED','TAKEDOWN_PENDING') THEN
    UPDATE "ImageAsset" SET "expiresAt"=NULL WHERE id=v_asset AND state='AVAILABLE';
    IF NOT FOUND THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
    PERFORM image_replace_references(jsonb_build_object('ownerId',v_owner,'kind','SHOWCASE','referenceKey','gallery:'||v_id,'assetIds',jsonb_build_array(v_asset)));
  ELSIF v_status='PRIVATE' THEN
    PERFORM image_replace_references(jsonb_build_object('ownerId',v_owner,'kind','SHOWCASE','referenceKey','gallery:'||v_id,'assetIds','[]'::jsonb));
    -- The column keeps milliseconds: truncate, or a rounded-up deadline is still in the future for the guard.
    UPDATE "ImageAsset" SET "expiresAt"=LEAST("expiresAt",date_trunc('milliseconds',clock_timestamp())) WHERE id=v_asset AND state IN ('PENDING','AVAILABLE','QUARANTINED');
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "GalleryWork_image_roots" AFTER INSERT OR UPDATE OF "showcaseStatus" OR DELETE ON "GalleryWork" FOR EACH ROW EXECUTE FUNCTION image_gallery_roots();

CREATE FUNCTION image_review_gallery_work(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE w "GalleryWork"; a "ImageAsset"; v_action TEXT:=p->>'action'; v_admin BOOLEAN; v_next "ShowcaseStatus"; v_now TIMESTAMPTZ:=clock_timestamp();
BEGIN
  PERFORM image_lock_reference_epoch();
  SELECT * INTO w FROM "GalleryWork" WHERE id=p->>'workId' FOR UPDATE;
  IF w.id IS NULL OR p->>'expectedSubmittedAt' IS NULL OR w."submittedAt" IS DISTINCT FROM (p->>'expectedSubmittedAt')::timestamptz THEN PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
  SELECT role::text='ADMIN' INTO v_admin FROM "User" WHERE id=p->>'actorId' AND "bannedAt" IS NULL FOR SHARE;
  IF NOT FOUND THEN PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
  IF (v_action NOT IN ('WITHDRAW','REQUEST_TAKEDOWN') AND NOT v_admin) OR (v_action IN ('WITHDRAW','REQUEST_TAKEDOWN') AND p->>'actorId'<>w."userId" AND NOT v_admin) THEN PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
  SELECT * INTO a FROM "ImageAsset" WHERE id=w."mediaAssetId" FOR UPDATE;
  IF v_action='APPROVE' AND w."showcaseStatus"::text='PENDING' THEN
    PERFORM 1 FROM "User" WHERE id=w."userId" AND "bannedAt" IS NULL;
    IF NOT FOUND OR a.state<>'AVAILABLE' OR a."expiresAt" IS NULL OR a."expiresAt"<=v_now THEN PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
    v_next:='FEATURED';
  ELSIF v_action IN ('REJECT','WITHDRAW') AND w."showcaseStatus"::text='PENDING' THEN v_next:='PRIVATE';
  ELSIF v_action='REQUEST_TAKEDOWN' AND w."showcaseStatus"::text='FEATURED' THEN v_next:='TAKEDOWN_PENDING';
  ELSIF v_action='TAKEDOWN' AND w."showcaseStatus"::text='TAKEDOWN_PENDING' THEN v_next:='PRIVATE';
  ELSIF v_action='KEEP' AND w."showcaseStatus"::text='TAKEDOWN_PENDING' THEN v_next:='FEATURED';
  ELSIF v_action='FORCE_TAKEDOWN' AND w."showcaseStatus"::text IN ('PENDING','FEATURED','TAKEDOWN_PENDING') THEN v_next:='PRIVATE';
  ELSE PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
  UPDATE "GalleryWork" SET "showcaseStatus"=v_next,"featuredAt"=CASE WHEN v_action='APPROVE' THEN v_now ELSE "featuredAt" END,
    "reviewedAt"=CASE WHEN v_action IN ('WITHDRAW','REQUEST_TAKEDOWN') THEN "reviewedAt" ELSE v_now END,
    "reviewedById"=CASE WHEN v_action IN ('WITHDRAW','REQUEST_TAKEDOWN') THEN "reviewedById" ELSE p->>'actorId' END,
    "reviewNote"=CASE WHEN v_action IN ('WITHDRAW','REQUEST_TAKEDOWN') THEN "reviewNote" ELSE p->>'reviewNote' END,"updatedAt"=v_now WHERE id=w.id;
  RETURN jsonb_build_object('id',w.id,'showcaseStatus',v_next,'expiresAt',(SELECT "expiresAt" FROM "ImageAsset" WHERE id=a.id));
END;
$$;

CREATE FUNCTION image_complete_temporary_outputs() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status::text='SUCCEEDED' AND OLD.status::text<>'SUCCEEDED' AND NEW."completedAt" IS NOT NULL THEN
    UPDATE "ImageAsset" a SET "expiresAt"=NEW."completedAt"+interval '1 hour'
      FROM "ImageGenerationBinding" b WHERE b."assetId"=a.id AND b."jobId"=NEW.id AND a.purpose='GENERATED' AND a."expiresAt" IS NOT NULL AND a.state='AVAILABLE';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER "GenerationJob_expiry_complete" AFTER UPDATE OF status ON "GenerationJob" FOR EACH ROW EXECUTE FUNCTION image_complete_temporary_outputs();
CREATE OR REPLACE FUNCTION image_begin_object(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_res "ImageWriteReservation"; v_asset "ImageAsset"; v_object "ImageObject"; v_location "ImageStorageLocation";
  v_id UUID; v_token UUID; v_asset_id UUID; v_slot INTEGER; v_size BIGINT; v_purpose TEXT; v_key TEXT; v_sha TEXT; v_mime TEXT; v_temporary BOOLEAN := COALESCE((p->>'temporary')::boolean,false);
BEGIN
  v_id := image_uuid(p->>'reservationId'); v_token := image_uuid(p->>'token');
  IF p->>'slot' IS NULL OR p->>'slot' !~ '^[0-3]$' THEN PERFORM image_raise('IMAGE_INVALID_INPUT'); END IF;
  v_slot := (p->>'slot')::integer; v_size := image_bytes(p->>'byteLength'); v_purpose := p->>'purpose';
  v_key := image_required_text(p->>'key',512); v_sha := p->>'sha256'; v_mime := p->>'mimeType';
  IF v_purpose IS NULL OR v_purpose NOT IN ('GENERATED','REFERENCE','CANVAS_IMPORT','GALLERY_UPLOAD') OR v_sha IS NULL OR length(v_sha) <> 64 OR v_sha !~ '^[0-9a-f]{64}$'
    OR v_mime IS NULL OR v_mime NOT IN ('image/png','image/jpeg','image/webp','image/gif','image/avif') THEN PERFORM image_raise('IMAGE_INVALID_INPUT'); END IF;
  IF p->>'assetId' IS NOT NULL THEN v_asset_id := image_uuid(p->>'assetId'); END IF;
  PERFORM image_lock_quota();
  SELECT * INTO v_res FROM "ImageWriteReservation" WHERE id = v_id FOR UPDATE;
  IF v_res.id IS NULL OR v_res.token <> v_token OR v_slot >= cardinality(v_res."slotBytes") OR v_size > v_res."slotBytes"[v_slot+1] THEN PERFORM image_raise('IMAGE_RESERVATION_CONFLICT'); END IF;
  SELECT * INTO v_object FROM "ImageObject" WHERE "reservationId" = v_id AND slot = v_slot;
  IF FOUND THEN
    SELECT * INTO v_asset FROM "ImageAsset" WHERE id = v_object."assetId";
    IF v_object.key <> v_key OR v_object."locationId" IS DISTINCT FROM p->>'locationId' OR v_object."byteLength" <> v_size OR v_object.sha256 <> v_sha
      OR v_object."mimeType" <> v_mime OR v_asset.purpose <> v_purpose OR (v_asset_id IS NOT NULL AND v_asset.id <> v_asset_id) THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT'); END IF;
    RETURN jsonb_build_object('asset',image_asset_json(v_asset),'object',image_object_json(v_object),'writeGranted',false);
  END IF;
  IF v_res.state <> 'ACTIVE' THEN PERFORM image_raise('IMAGE_RESERVATION_CONFLICT'); END IF;
  IF v_res."leaseExpiresAt" <= clock_timestamp() THEN PERFORM image_raise('IMAGE_RESERVATION_EXPIRED'); END IF;
  IF v_res.kind = 'OUTPUT' AND (v_purpose <> 'GENERATED' OR v_res."outputJobId" IS NULL OR v_res."workerId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "GenerationJob" WHERE id = v_res."outputJobId" AND "workerId" = v_res."workerId" AND status::text = 'PROCESSING')) THEN PERFORM image_raise('IMAGE_RESERVATION_CONFLICT'); END IF;
  -- Existing legacy backfill creates a new physical copy, with the same quota
  -- gate as any input. It must prove the original unassociated image identity;
  -- this is not adoption of an already-existing physical object.
  IF v_res.kind = 'INPUT' AND v_purpose = 'GENERATED' AND (
    p->>'originId' IS NULL OR v_res."intentKey" IS DISTINCT FROM 'backfill-image:' || (p->>'originId') OR NOT EXISTS (
      SELECT 1 FROM "GenerationImage" i JOIN "GenerationJob" j ON j.id = i."jobId"
      WHERE i.id = p->>'originId' AND i."mediaAssetId" IS NULL AND i."mediaStorage" IS NULL
        AND j."userId" = v_res."ownerId" AND j."generationType"::text IN ('TEXT_TO_IMAGE','IMAGE_TO_IMAGE')
    )
  ) THEN PERFORM image_raise('IMAGE_INVALID_INPUT'); END IF;
  SELECT * INTO v_location FROM "ImageStorageLocation" WHERE id = p->>'locationId';
  IF NOT FOUND THEN PERFORM image_raise('IMAGE_LOCATION_CONFLICT'); END IF;
  IF v_temporary AND (v_location.provider<>'LOCAL' OR v_purpose NOT IN ('GENERATED','REFERENCE') OR v_res.kind='COPY' OR v_key NOT LIKE 'temporary/%') THEN PERFORM image_raise('IMAGE_INVALID_INPUT'); END IF;
  IF (v_purpose='GALLERY_UPLOAD' AND (v_res.kind<>'INPUT' OR v_location.provider<>'LOCAL' OR p->>'originId' IS NULL)) OR (NOT v_temporary AND v_key LIKE 'temporary/%' AND v_res.kind<>'COPY') THEN PERFORM image_raise('IMAGE_INVALID_INPUT'); END IF;
  IF v_asset_id IS NOT NULL THEN SELECT * INTO v_asset FROM "ImageAsset" WHERE id = v_asset_id FOR UPDATE; END IF;
  IF v_asset.id IS NULL THEN
    IF v_res.kind = 'COPY' THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
    INSERT INTO "ImageAsset" (id,"ownerId",purpose,"originId","byteLength","mimeType",sha256,"expiresAt")
      VALUES (COALESCE(v_asset_id,gen_random_uuid()),v_res."ownerId",v_purpose,p->>'originId',v_size,v_mime,v_sha,CASE WHEN v_purpose='GALLERY_UPLOAD' THEN clock_timestamp()+interval '24 hours' WHEN v_temporary THEN clock_timestamp()+interval '1 hour' END) RETURNING * INTO v_asset;
  ELSE
    IF v_res.kind <> 'COPY' OR v_asset.state <> 'AVAILABLE' OR v_asset."ownerId" <> v_res."ownerId" OR v_asset.purpose <> v_purpose OR v_asset."byteLength" <> v_size
      OR v_asset.sha256 <> v_sha OR v_asset."mimeType" <> v_mime OR (v_asset."expiresAt" IS NOT NULL AND v_asset.purpose<>'GALLERY_UPLOAD' AND (v_location.provider<>'LOCAL' OR v_key NOT LIKE 'temporary/%')) THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT'); END IF;
  END IF;
  UPDATE "ImageWriteReservation" SET "remainingBytes" = "remainingBytes" - "slotBytes"[v_slot+1] WHERE id = v_id;
  INSERT INTO "ImageObject" ("assetId","reservationId",slot,"locationId","physicalNamespace",key,"byteLength","mimeType",sha256,"writeToken","writeExpiresAt")
    VALUES (v_asset.id,v_id,v_slot,v_location.id,v_location."physicalNamespace",v_key,v_size,v_mime,v_sha,v_token,v_res."leaseExpiresAt") RETURNING * INTO v_object;
  RETURN jsonb_build_object('asset',image_asset_json(v_asset),'object',image_object_json(v_object),'writeGranted',true);
EXCEPTION WHEN unique_violation THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT');
END;
$$;

CREATE OR REPLACE FUNCTION image_has_historical_reference(p_asset UUID) RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM "ImageReference" WHERE "assetId" = p_asset AND ((SELECT "expiresAt" IS NULL FROM "ImageAsset" WHERE id=p_asset) OR kind<>'JOB_INPUT' OR "referenceKey" NOT LIKE 'job:%'))
    OR EXISTS (SELECT 1 FROM "ImageGenerationBinding" b JOIN "Canvas" c ON c."ownerId" = b."ownerId" AND c."deletedAt" IS NULL
      CROSS JOIN LATERAL jsonb_array_elements(c.scene->'nodes') n
      WHERE b."assetId" = p_asset AND n->>'kind' = 'result' AND n->>'imageId' = b."imageId" AND n->>'jobId' = b."jobId")
    OR EXISTS (SELECT 1 FROM "ImageGenerationBinding" b JOIN "CanvasRun" r ON r."ownerId" = b."ownerId" AND r.state = 'COMMITTED'
      CROSS JOIN LATERAL jsonb_array_elements(r."inputSnapshot"->'input'->'references') n
      WHERE b."assetId" = p_asset AND n->>'kind' = 'result' AND n->>'imageId' = b."imageId" AND n->>'jobId' = b."jobId")
    OR EXISTS (SELECT 1 FROM "ImageUrlAlias" a JOIN "GenerationJob" j ON a.url = ANY(j."sourceImageUrls") WHERE a."assetId" = p_asset AND ((SELECT "expiresAt" IS NULL FROM "ImageAsset" WHERE id=p_asset) OR image_job_needs_inputs(j.id)))
    OR EXISTS (SELECT 1 FROM "GenerationImage" WHERE "mediaAssetId" = p_asset AND "showcaseStatus"::text IN ('FEATURED','PENDING','TAKEDOWN_PENDING'))
    OR EXISTS (SELECT 1 FROM "ImageUrlAlias" a JOIN "LoginCoverConfig" c ON c.mode = 'custom' AND c."customUrl" = a.url WHERE a."assetId" = p_asset)
$$;

CREATE OR REPLACE FUNCTION image_guard_asset() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT'); END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW."ownerId" <> OLD."ownerId" OR NEW.purpose <> OLD.purpose OR NEW."originId" IS DISTINCT FROM OLD."originId" OR NEW."publicToken" <> OLD."publicToken"
      OR NEW."byteLength" <> OLD."byteLength" OR NEW."mimeType" <> OLD."mimeType" OR NEW.sha256 <> OLD.sha256 OR NEW."createdAt" <> OLD."createdAt" THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT'); END IF;
    IF NEW.state <> OLD.state AND NOT ((OLD.state = 'PENDING' AND NEW.state IN ('AVAILABLE','QUARANTINED')) OR (OLD.state IN ('AVAILABLE','QUARANTINED') AND NEW.state = 'DELETING') OR (OLD.state = 'DELETING' AND NEW.state = 'DELETED')) THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT'); END IF;
    IF NEW.state IN ('DELETING','DELETED') AND image_has_historical_reference(OLD.id) THEN PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
    IF NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" AND NOT (
      (OLD."expiresAt" IS NOT NULL AND NEW."expiresAt" IS NOT NULL AND NEW."expiresAt"<=OLD."expiresAt")
      OR (NEW.purpose='GENERATED' AND OLD."expiresAt" IS NOT NULL AND EXISTS (SELECT 1 FROM "ImageGenerationBinding" b JOIN "GenerationJob" j ON j.id=b."jobId" WHERE b."assetId"=NEW.id AND j.status::text='SUCCEEDED' AND NEW."expiresAt"=j."completedAt"+interval '1 hour'))
      OR (NEW.purpose='GALLERY_UPLOAD' AND ((NEW."expiresAt" IS NULL AND EXISTS (SELECT 1 FROM "GalleryWork" WHERE "mediaAssetId"=NEW.id AND "userId"=NEW."ownerId" AND "showcaseStatus"::text IN ('FEATURED','TAKEDOWN_PENDING'))) OR (NEW."expiresAt"<=clock_timestamp() AND NOT EXISTS (SELECT 1 FROM "GalleryWork" WHERE "mediaAssetId"=NEW.id AND "showcaseStatus"::text IN ('FEATURED','TAKEDOWN_PENDING')))))
    ) THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT'); END IF;
    IF OLD.state = 'DELETED'  AND to_jsonb(NEW) - 'updatedAt' IS DISTINCT FROM to_jsonb(OLD) - 'updatedAt' THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT'); END IF;
  END IF;
  IF NEW.state = 'AVAILABLE' THEN
    IF NEW."activeObjectId" IS NULL OR NOT EXISTS (SELECT 1 FROM "ImageObject" o WHERE o.id = NEW."activeObjectId" AND o."assetId" = NEW.id AND o.state = 'READY' AND o."byteLength" = NEW."byteLength" AND o.sha256 = NEW.sha256 AND o."mimeType" = NEW."mimeType") THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
  END IF;
  IF NEW.state = 'DELETED' AND EXISTS (SELECT 1 FROM "ImageObject" WHERE "assetId" = NEW.id AND (accounted OR "needsReconciliation")) THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT'); END IF;
  NEW."updatedAt" := clock_timestamp(); RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION image_guard_reference() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_asset "ImageAsset";
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF TG_OP = 'UPDATE' OR OLD.permanent THEN PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
    PERFORM 1 FROM "ImageAsset" WHERE id = OLD."assetId" FOR UPDATE;
    RETURN OLD;
  END IF;
  SELECT * INTO v_asset FROM "ImageAsset" WHERE id = NEW."assetId" FOR UPDATE;
  IF v_asset.id IS NULL OR v_asset.state <> 'AVAILABLE' THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
  IF v_asset."expiresAt" IS NOT NULL THEN
    IF NEW.kind<>'JOB_INPUT' OR NEW."referenceKey" NOT LIKE 'job:%' THEN PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
    IF v_asset."expiresAt"<=clock_timestamp() AND NOT EXISTS (SELECT 1 FROM "ImageReference" WHERE "assetId"=NEW."assetId" AND kind=NEW.kind AND "referenceKey"=NEW."referenceKey" AND "ownerId"=NEW."ownerId") THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
  END IF;
  IF v_asset.purpose='GALLERY_UPLOAD' AND NOT image_gallery_readable(v_asset.id,NEW."ownerId") THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION image_cleanup_reason(p_asset UUID) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE a "ImageAsset"; c "CanvasImportAsset"; v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO a FROM "ImageAsset" WHERE id = p_asset;
  IF a.id IS NULL OR a.state NOT IN ('AVAILABLE','QUARANTINED') THEN RETURN 'UNAVAILABLE'; END IF;
  IF EXISTS (SELECT 1 FROM "ImageHistoryHold" WHERE "assetId" = a.id AND "releasedAt" IS NULL) THEN RETURN 'ADOPTION_PENDING'; END IF;
  IF a."byteLength" > 52428800 THEN RETURN 'UNSUPPORTED_SIZE'; END IF;
  IF a."expiresAt">v_now THEN RETURN 'NOT_EXPIRED'; END IF;
  IF image_has_historical_reference(a.id) THEN RETURN 'REFERENCED'; END IF;
  IF a."copyProtectedUntil" > v_now THEN RETURN 'COPYING'; END IF;
  IF NOT EXISTS (SELECT 1 FROM "ImageObject" WHERE "assetId" = a.id AND accounted) THEN RETURN 'NO_OBJECTS'; END IF;
  IF EXISTS (SELECT 1 FROM "ImageObject" WHERE "assetId" = a.id AND accounted AND "versionId" IS NOT NULL) THEN RETURN 'VERSIONED'; END IF;
  IF EXISTS (SELECT 1 FROM "ImageObject" WHERE "assetId" = a.id AND accounted AND (NOT image_object_verified("ImageObject") OR state = 'UNKNOWN')) THEN RETURN 'UNKNOWN_PUT'; END IF;
  IF EXISTS (SELECT 1 FROM "ImageObject" o LEFT JOIN "ImageWriteReservation" r ON r.id = o."reservationId" WHERE o."assetId" = a.id AND o.accounted AND (o.state <> 'READY' OR (o.provenance = 'WRITE' AND (o."writeExpiresAt" > v_now OR r.id IS NULL OR r.state <> 'CLOSED')) )) THEN RETURN 'ACTIVE_WRITE'; END IF;
  IF EXISTS (SELECT 1 FROM "ImageObject" WHERE "assetId" = a.id AND accounted AND "readProtectedUntil" > v_now) THEN RETURN 'READING'; END IF;
  IF EXISTS (SELECT 1 FROM "ImageGenerationBinding" b JOIN "GenerationJob" j ON j.id = b."jobId" WHERE b."assetId" = a.id AND image_job_needs_inputs(j.id))
    OR EXISTS (SELECT 1 FROM "ImageObject" o JOIN "ImageWriteReservation" r ON r.id = o."reservationId" JOIN "GenerationJob" j ON j.id = r."outputJobId" WHERE o."assetId" = a.id AND image_job_needs_inputs(j.id)) THEN RETURN 'ACTIVE_JOB'; END IF;
  IF a.purpose = 'CANVAS_IMPORT' THEN
    SELECT * INTO c FROM "CanvasImportAsset" WHERE "mediaAssetId" = a.id;
    IF c.id IS NULL OR c.state NOT IN ('READY','QUARANTINED') OR c."putOutcome" <> 'CONFIRMED' OR c."needsReconciliation" OR c."storageVersionId" IS NOT NULL THEN RETURN 'CANVAS_UNVERIFIED'; END IF;
    IF EXISTS (SELECT 1 FROM "CanvasSavedAssetUse" WHERE "assetId" = c.id) OR EXISTS (SELECT 1 FROM "CanvasJobAssetUse" WHERE "assetId" = c.id) THEN RETURN 'REFERENCED'; END IF;
    IF c."detachedAt" IS NULL OR a."detachedAt" IS NULL OR GREATEST(c."detachedAt",a."detachedAt") + interval '604800 seconds' > v_now
      OR c."uploadExpiresAt" > v_now OR c."preparationExpiresAt" > v_now THEN RETURN 'CANVAS_GRACE'; END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION image_begin_read(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_id UUID; a "ImageAsset"; o "ImageObject"; v_expiry TIMESTAMPTZ; v_job_read BOOLEAN;
BEGIN
  PERFORM image_lock_reference_epoch();
  IF (CASE WHEN p->>'assetId' IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN p->>'publicToken' IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN p->>'url' IS NOT NULL THEN 1 ELSE 0 END) <> 1 THEN PERFORM image_raise('IMAGE_INVALID_INPUT'); END IF;
  IF p->>'assetId' IS NOT NULL THEN v_id := image_uuid(p->>'assetId');
  ELSIF p->>'publicToken' IS NOT NULL THEN
    IF length(p->>'publicToken') <> 64 OR p->>'publicToken' !~ '^[0-9a-f]{64}$' THEN PERFORM image_raise('IMAGE_INVALID_INPUT'); END IF;
    SELECT id INTO v_id FROM "ImageAsset" WHERE "publicToken" = p->>'publicToken';
  ELSE SELECT "assetId" INTO v_id FROM "ImageUrlAlias" WHERE url = p->>'url'; END IF;
  SELECT * INTO a FROM "ImageAsset" WHERE id = v_id AND (p->>'ownerId' IS NULL OR "ownerId" = p->>'ownerId') FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF a.state <> 'AVAILABLE' OR a."activeObjectId" IS NULL THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
  v_job_read:=p->>'jobId' IS NOT NULL AND image_job_has_input(a.id,p->>'jobId');
  IF (p->>'jobId' IS NOT NULL AND NOT v_job_read) OR (a."expiresAt"<=clock_timestamp() AND NOT v_job_read) OR (a.purpose='GALLERY_UPLOAD' AND NOT v_job_read AND NOT image_gallery_readable(a.id,p->>'viewerId')) THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
  SELECT * INTO o FROM "ImageObject" WHERE id = a."activeObjectId" FOR UPDATE;
  IF o.state <> 'READY' OR NOT o.accounted OR o."needsReconciliation" THEN PERFORM image_raise('IMAGE_UNAVAILABLE'); END IF;
  v_expiry := clock_timestamp() + interval '45 seconds';
  UPDATE "ImageObject" SET "readProtectedUntil" = GREATEST("readProtectedUntil",v_expiry) WHERE id = o.id;
  RETURN jsonb_build_object('image',image_get_asset(a.id,NULL),'readExpiresAt',v_expiry);
END;
$$;

CREATE OR REPLACE FUNCTION image_snapshot_cleanup(p_job UUID) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE j "ImageMaintenanceJob"; a "ImageAsset"; v_count INTEGER := 0;
BEGIN
  SELECT * INTO j FROM "ImageMaintenanceJob" WHERE id = p_job;
  FOR a IN SELECT * FROM "ImageAsset" WHERE state IN ('AVAILABLE','QUARANTINED') AND (j.mode<>'EXPIRY' OR "expiresAt"<=clock_timestamp()) AND (j."ageCutoff" IS NULL OR "createdAt" <= j."ageCutoff") AND image_cleanup_reason(id) IS NULL ORDER BY "createdAt",id LIMIT 1001 LOOP
    v_count := v_count + 1;
    IF v_count > 1000 THEN UPDATE "ImageMaintenanceJob" SET truncated = true WHERE id = p_job; EXIT; END IF;
    INSERT INTO "ImageMaintenanceItem" ("jobId","assetId","objectId","byteLength","assetCreatedAt","expectedActiveObjectId",manifest)
      SELECT p_job,a.id,o.id,o."byteLength",a."createdAt",a."activeObjectId",image_asset_manifest(a.id) FROM "ImageObject" o WHERE o."assetId" = a.id AND o.accounted ORDER BY o.id;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION image_enqueue_due_cleanup() RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_policy "ImageStoragePolicy"; q "ImageQuota"; j "ImageMaintenanceJob"; v_key TEXT; v_due TIMESTAMPTZ; v_json JSONB;
BEGIN
  PERFORM image_lock_quota(); SELECT * INTO v_policy FROM "ImageStoragePolicy" WHERE scope = 'images' FOR UPDATE;
  UPDATE "ImageMaintenanceJob" SET state = 'EXPIRED',"completedAt" = clock_timestamp() WHERE state = 'PREVIEW' AND "previewExpiresAt" <= clock_timestamp();
  -- One batch per five minutes: reads stop at the deadline; only the file removal is batched.
  IF NOT EXISTS (SELECT 1 FROM "ImageMaintenanceJob" WHERE mode='EXPIRY' AND (state IN ('QUEUED','RUNNING','WAITING') OR "createdAt">clock_timestamp()-interval '5 minutes'))
    AND EXISTS (SELECT 1 FROM "ImageAsset" WHERE state IN ('AVAILABLE','QUARANTINED') AND "expiresAt"<=clock_timestamp() AND image_cleanup_reason(id) IS NULL) THEN
    INSERT INTO "ImageMaintenanceJob" ("requesterId","requestKey",intent,mode,state,"policyVersion","confirmedAt")
      VALUES ('system','expiry:'||gen_random_uuid()::text,'{}'::jsonb,'EXPIRY','QUEUED',v_policy.version,clock_timestamp()) RETURNING * INTO j;
    PERFORM image_snapshot_cleanup(j.id); PERFORM image_refresh_maintenance_job(j.id); RETURN image_maintenance_job_json(j.id);
  END IF;
  IF NOT v_policy.enabled THEN RETURN NULL; END IF;
  SELECT * INTO q FROM "ImageQuota" WHERE scope = 'images';
  IF v_policy."quotaCleanupEnabled" AND q."usedBytes" + q."reservedBytes" > v_policy."limitBytes"
    AND NOT EXISTS (SELECT 1 FROM "ImageMaintenanceJob" WHERE mode = 'QUOTA' AND (state IN ('QUEUED','RUNNING','WAITING') OR "createdAt" > clock_timestamp() - interval '60 seconds')) THEN
    v_json := image_request_quota_cleanup(jsonb_build_object('requestId',gen_random_uuid(),'ownerId','system','intentKey','converge:' || gen_random_uuid()::text,'neededBytes','0'));
    IF v_json IS NOT NULL THEN RETURN v_json; END IF;
  END IF;
  IF NOT v_policy."scheduleEnabled" OR v_policy."nextRunAt" IS NULL OR v_policy."nextRunAt" > clock_timestamp() THEN RETURN NULL; END IF;
  v_due := v_policy."nextRunAt"; v_key := 'schedule:' || v_policy.version::text || ':' || v_due::text;
  UPDATE "ImageStoragePolicy" SET "nextRunAt" = clock_timestamp() + make_interval(secs => "intervalSeconds"),"updatedAt" = clock_timestamp() WHERE scope = 'images';
  SELECT * INTO j FROM "ImageMaintenanceJob" WHERE "requestKey" = v_key;
  IF FOUND THEN RETURN image_maintenance_job_json(j.id); END IF;
  INSERT INTO "ImageMaintenanceJob" ("requesterId","requestKey",intent,mode,state,"policyVersion","ageCutoff","confirmedAt")
    VALUES ('system',v_key,jsonb_build_object('scheduledFor',v_due,'policyVersion',v_policy.version),'SCHEDULE','QUEUED',v_policy.version,clock_timestamp() - make_interval(days => v_policy."retentionDays"),clock_timestamp()) RETURNING * INTO j;
  PERFORM image_snapshot_cleanup(j.id); PERFORM image_refresh_maintenance_job(j.id); RETURN image_maintenance_job_json(j.id);
END;
$$;

CREATE OR REPLACE FUNCTION image_list_maintenance_locations() RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.id),'[]'::jsonb) FROM (
    SELECT x.* FROM "ImageStorageLocation" x WHERE EXISTS (
      SELECT 1 FROM "ImageObject" o JOIN "ImageMaintenanceItem" i ON i."objectId" = o.id JOIN "ImageMaintenanceJob" j ON j.id = i."jobId"
      WHERE (j.mode='EXPIRY' OR EXISTS (SELECT 1 FROM "ImageStoragePolicy" WHERE scope='images' AND enabled)) AND o."locationId" = x.id AND o.accounted AND i.state IN ('CANDIDATE','CLAIMED','RETRY') AND j.state IN ('QUEUED','RUNNING','WAITING')
        AND (j."nextAttemptAt" IS NULL OR j."nextAttemptAt" <= clock_timestamp())
    ) ORDER BY x.id LIMIT 1000
  ) l
$$;

CREATE OR REPLACE FUNCTION image_claim_maintenance(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_token UUID; v_locations TEXT[]; v_policy "ImageStoragePolicy"; j "ImageMaintenanceJob"; i "ImageMaintenanceItem"; first_item "ImageMaintenanceItem";
  a "ImageAsset"; o "ImageObject"; l "ImageStorageLocation"; v_reason TEXT; v_result JSONB := '[]'::jsonb; v_released BIGINT; v_deficit BIGINT; v_now TIMESTAMPTZ;
BEGIN
  v_token := image_uuid(p->>'executorToken');
  IF jsonb_typeof(p->'verifiedLocationIds') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'verifiedLocationIds') > 1000 THEN PERFORM image_raise('IMAGE_INVALID_INPUT'); END IF;
  SELECT COALESCE(array_agg(image_required_text(value,128)),ARRAY[]::text[]) INTO v_locations FROM jsonb_array_elements_text(p->'verifiedLocationIds');
  PERFORM image_lock_quota(); SELECT * INTO v_policy FROM "ImageStoragePolicy" WHERE scope = 'images' FOR UPDATE;
  PERFORM 1 FROM "ImageMaintenanceLease" WHERE scope = 'images' AND token = v_token AND "expiresAt" > clock_timestamp() FOR UPDATE;
  IF NOT FOUND THEN PERFORM image_raise('IMAGE_MAINTENANCE_CONFLICT'); END IF;
  FOR j IN SELECT * FROM "ImageMaintenanceJob" WHERE (v_policy.enabled OR mode='EXPIRY') AND state IN ('QUEUED','RUNNING','WAITING') AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= clock_timestamp()) ORDER BY "createdAt",id LIMIT 20 FOR UPDATE SKIP LOCKED LOOP
    IF (j.mode<>'EXPIRY' AND j."policyVersion" <> v_policy.version) OR j."cancelRequested"  OR (j.mode = 'QUOTA' AND NOT v_policy."quotaCleanupEnabled") THEN
      UPDATE "ImageMaintenanceItem" SET state = 'SKIPPED',reason = CASE WHEN j."cancelRequested" THEN 'CANCELLED' ELSE 'POLICY_CHANGED' END,"completedAt" = clock_timestamp() WHERE "jobId" = j.id AND state = 'CANDIDATE';
    END IF;
    SELECT * INTO first_item FROM "ImageMaintenanceItem" WHERE "jobId" = j.id AND state IN ('CANDIDATE','CLAIMED','RETRY')
      ORDER BY CASE WHEN state = 'CANDIDATE' THEN 1 ELSE 0 END,"assetCreatedAt","assetId",id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN PERFORM image_refresh_maintenance_job(j.id); CONTINUE; END IF;
    IF j.mode = 'QUOTA' AND first_item.state = 'CANDIDATE' THEN
      SELECT COALESCE(sum("releasedBytes"),0) INTO v_released FROM "ImageMaintenanceItem" WHERE "jobId" = j.id;
      SELECT GREATEST(0,"usedBytes" + "reservedBytes" + j."neededBytes" - v_policy."limitBytes") INTO v_deficit FROM "ImageQuota" WHERE scope = 'images';
      IF v_deficit = 0 OR v_released >= j."reclaimTargetBytes" THEN
        UPDATE "ImageMaintenanceItem" SET state = 'SKIPPED',reason = 'QUOTA_MET',"completedAt" = clock_timestamp() WHERE "jobId" = j.id AND state = 'CANDIDATE';
        PERFORM image_refresh_maintenance_job(j.id); CONTINUE;
      END IF;
    END IF;
    -- Match existing writer and Canvas order; never lock a Canvas document or
    -- owner while holding the global quota. Every I/O happens after this returns.
    PERFORM id FROM "ImageMaintenanceItem" WHERE "jobId" = j.id AND "assetId" = first_item."assetId" ORDER BY id FOR UPDATE;
    PERFORM r.id FROM "ImageWriteReservation" r WHERE EXISTS (SELECT 1 FROM "ImageObject" x WHERE x."assetId" = first_item."assetId" AND x."reservationId" = r.id) ORDER BY r.id FOR UPDATE;
    PERFORM id FROM "CanvasImportAsset" WHERE "mediaAssetId" = first_item."assetId" ORDER BY id FOR UPDATE;
    SELECT * INTO a FROM "ImageAsset" WHERE id = first_item."assetId" FOR UPDATE;
    PERFORM id FROM "ImageObject" WHERE "assetId" = a.id ORDER BY id FOR UPDATE;
    v_now := clock_timestamp(); v_reason := NULL;
    IF first_item.state = 'CANDIDATE' THEN
      v_reason := CASE WHEN j.mode = 'SOURCE_RETIREMENT' THEN image_retirement_reason(j."verificationId") ELSE image_cleanup_reason(a.id) END;
      IF v_reason IS NULL AND (a."activeObjectId" IS DISTINCT FROM first_item."expectedActiveObjectId" OR image_asset_manifest(a.id) <> first_item.manifest) THEN v_reason := 'SNAPSHOT_CHANGED'; END IF;
      IF v_reason IS NULL AND EXISTS (SELECT 1 FROM "ImageMaintenanceItem" x JOIN "ImageObject" y ON y.id = x."objectId" WHERE x."jobId" = j.id AND x."assetId" = a.id AND NOT y."locationId" = ANY(v_locations)) THEN v_reason := 'STORAGE_UNAVAILABLE'; END IF;
      IF j.mode = 'SOURCE_RETIREMENT' AND v_reason IN ('READING','COPYING') THEN
        UPDATE "ImageMaintenanceJob" SET state = 'WAITING',"nextAttemptAt" = v_now + interval '1 second' WHERE id = j.id; CONTINUE;
      END IF;
      IF v_reason IS NOT NULL THEN
        UPDATE "ImageMaintenanceItem" SET state = 'SKIPPED',reason = v_reason,"completedAt" = v_now WHERE "jobId" = j.id AND "assetId" = a.id AND state = 'CANDIDATE';
        PERFORM image_refresh_maintenance_job(j.id); CONTINUE;
      END IF;
      UPDATE "ImageMaintenanceJob" SET state = 'RUNNING',"nextAttemptAt" = NULL WHERE id = j.id;
      IF j.mode <> 'SOURCE_RETIREMENT' THEN
        UPDATE "ImageAsset" SET state = 'DELETING',"deleteJobId" = j.id WHERE id = a.id;
        UPDATE "CanvasImportAsset" SET state = 'DELETING' WHERE "mediaAssetId" = a.id;
      END IF;
    ELSE
      IF j.mode <> 'SOURCE_RETIREMENT' AND (a.state <> 'DELETING' OR a."deleteJobId" IS DISTINCT FROM j.id) THEN PERFORM image_raise('IMAGE_MAINTENANCE_CONFLICT'); END IF;
      IF j.mode = 'SOURCE_RETIREMENT' AND image_retirement_reason(j."verificationId") IS NOT NULL THEN
        UPDATE "ImageMaintenanceJob" SET state = 'WAITING',"nextAttemptAt" = v_now + interval '10 seconds' WHERE id = j.id; CONTINUE;
      END IF;
      IF EXISTS (SELECT 1 FROM "ImageMaintenanceItem" x JOIN "ImageObject" y ON y.id = x."objectId" WHERE x."jobId" = j.id AND x."assetId" = a.id AND x.state IN ('CLAIMED','RETRY')
        AND (y."deleteExpiresAt" > v_now OR y."nextDeleteAt" > v_now)) THEN
        PERFORM image_refresh_maintenance_job(j.id); CONTINUE;
      END IF;
      IF EXISTS (SELECT 1 FROM "ImageMaintenanceItem" x JOIN "ImageObject" y ON y.id = x."objectId" WHERE x."jobId" = j.id AND x."assetId" = a.id AND x.state IN ('CLAIMED','RETRY') AND NOT y."locationId" = ANY(v_locations)) THEN
        UPDATE "ImageObject" SET "nextDeleteAt" = v_now + interval '10 seconds' WHERE id IN (SELECT "objectId" FROM "ImageMaintenanceItem" WHERE "jobId" = j.id AND "assetId" = a.id AND state IN ('CLAIMED','RETRY'));
        UPDATE "ImageMaintenanceItem" SET state = 'RETRY',reason = 'STORAGE_UNAVAILABLE' WHERE "jobId" = j.id AND "assetId" = a.id AND state IN ('CLAIMED','RETRY');
        PERFORM image_refresh_maintenance_job(j.id); CONTINUE;
      END IF;
    END IF;
    FOR i IN SELECT * FROM "ImageMaintenanceItem" WHERE "jobId" = j.id AND "assetId" = a.id AND state IN ('CANDIDATE','CLAIMED','RETRY') ORDER BY id LOOP
      UPDATE "ImageMaintenanceItem" SET state = 'CLAIMED',reason = NULL WHERE id = i.id;
      UPDATE "ImageObject" SET state = 'DELETING',"deleteItemId" = i.id,"deleteToken" = gen_random_uuid(),"deleteExpiresAt" = clock_timestamp() + interval '90 seconds',
        "deleteAttempts" = "deleteAttempts" + 1,"nextDeleteAt" = NULL,"lastErrorCode" = NULL WHERE id = i."objectId" RETURNING * INTO o;
      SELECT * INTO l FROM "ImageStorageLocation" WHERE id = o."locationId";
      v_result := v_result || jsonb_build_array(jsonb_build_object('jobId',j.id,'itemId',i.id,'mode',j.mode,'object',image_object_json(o),'location',to_jsonb(l),'deleteToken',o."deleteToken",'deleteExpiresAt',o."deleteExpiresAt"));
    END LOOP;
    PERFORM image_refresh_maintenance_job(j.id); RETURN v_result;
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION image_retirement_reason(p_verification UUID) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE v "ImageReplicaVerification"; a "ImageAsset"; s "ImageObject"; t "ImageObject"; v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  SELECT * INTO v FROM "ImageReplicaVerification" WHERE id = p_verification;
  IF v.id IS NULL OR v.revoked OR v."readerProtocolRevision" <> 4 THEN RETURN 'VERIFICATION_REQUIRED'; END IF;
  SELECT * INTO a FROM "ImageAsset" WHERE id = v."assetId";
  SELECT * INTO s FROM "ImageObject" WHERE id = v."sourceObjectId";
  SELECT * INTO t FROM "ImageObject" WHERE id = v."targetObjectId";
  IF a.state <> 'AVAILABLE' OR a."activeObjectId" IS DISTINCT FROM t.id OR s.id = t.id OR s."assetId" <> a.id OR t."assetId" <> a.id OR t.state <> 'READY' OR NOT t.accounted
    OR s.state NOT IN ('READY','DELETING') OR NOT s.accounted OR s."byteLength" <> v."byteLength" OR t."byteLength" <> v."byteLength" OR s.sha256 <> v.sha256 OR t.sha256 <> v.sha256 OR s."mimeType" <> t."mimeType" THEN RETURN 'VERIFICATION_REQUIRED'; END IF;
  IF s."versionId" IS NOT NULL OR t."versionId" IS NOT NULL THEN RETURN 'VERSIONED'; END IF;
  IF NOT image_object_verified(s) OR NOT image_object_verified(t) THEN RETURN 'UNKNOWN_PUT'; END IF;
  IF EXISTS (SELECT 1 FROM "ImageHistoryHold" WHERE "assetId" = a.id AND "releasedAt" IS NULL) THEN RETURN 'ADOPTION_PENDING'; END IF;
  IF s."writeExpiresAt" > v_now OR a."copyProtectedUntil" > v_now OR EXISTS (SELECT 1 FROM "ImageObject" WHERE "assetId" = a.id AND accounted AND state IN ('WRITING','UNKNOWN')) THEN RETURN 'COPYING'; END IF;
  IF s."readProtectedUntil" > v_now THEN RETURN 'READING'; END IF;
  IF image_alias_manifest(a.id) <> v."aliasManifest" THEN RETURN 'ALIASES_CHANGED'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION image_record_replica_verification(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE a "ImageAsset"; s "ImageObject"; t "ImageObject"; v_urls TEXT[]; v_actual TEXT[]; v_id UUID;
BEGIN
  PERFORM image_lock_reference_epoch();
  IF jsonb_typeof(p->'aliasUrls') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'aliasUrls') NOT BETWEEN 0 AND 1000 OR p->>'readerProtocolRevision' IS DISTINCT FROM '4' THEN PERFORM image_raise('IMAGE_INVALID_INPUT'); END IF;
  SELECT * INTO a FROM "ImageAsset" WHERE id = image_uuid(p->>'assetId') FOR UPDATE;
  PERFORM id FROM "ImageObject" WHERE id IN (image_uuid(p->>'sourceObjectId'),image_uuid(p->>'targetObjectId')) ORDER BY id FOR UPDATE;
  SELECT * INTO s FROM "ImageObject" WHERE id = image_uuid(p->>'sourceObjectId'); SELECT * INTO t FROM "ImageObject" WHERE id = image_uuid(p->>'targetObjectId');
  IF a.id IS NULL OR s.id IS NULL OR t.id IS NULL OR a.state <> 'AVAILABLE' OR a."activeObjectId" IS DISTINCT FROM t.id OR s.id = t.id OR s."assetId" <> a.id OR t."assetId" <> a.id
    OR s.state <> 'READY' OR t.state <> 'READY' OR NOT image_object_verified(s) OR NOT image_object_verified(t)
    OR s."byteLength" <> image_bytes(p->>'byteLength') OR t."byteLength" <> s."byteLength" OR p->>'sha256' IS DISTINCT FROM a.sha256 OR s.sha256 <> a.sha256 OR t.sha256 <> a.sha256 THEN PERFORM image_raise('IMAGE_WRITE_CONFLICT'); END IF;
  SELECT COALESCE(array_agg(DISTINCT image_required_text(value,2048) ORDER BY image_required_text(value,2048)),ARRAY[]::text[]) INTO v_urls FROM jsonb_array_elements_text(p->'aliasUrls');
  SELECT COALESCE(array_agg(url ORDER BY url),ARRAY[]::text[]) INTO v_actual FROM "ImageUrlAlias" WHERE "assetId" = a.id;
  IF v_urls IS DISTINCT FROM v_actual THEN PERFORM image_raise('IMAGE_REFERENCE_CONFLICT'); END IF;
  INSERT INTO "ImageReplicaVerification" ("assetId","sourceObjectId","targetObjectId","byteLength",sha256,"aliasUrls","aliasManifest","readerProtocolRevision")
    VALUES (a.id,s.id,t.id,a."byteLength",a.sha256,v_urls,image_alias_manifest(a.id),4) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id',v_id);
END;
$$;

CREATE OR REPLACE FUNCTION image_history_hold_guard() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE i "ImageHistoryItem"; j "ImageHistoryJob"; a "ImageAsset";
BEGIN
  IF TG_OP = 'DELETE' OR NEW."itemId" <> OLD."itemId" OR NEW."canvasImportId" IS DISTINCT FROM OLD."canvasImportId" OR NEW."createdAt" <> OLD."createdAt"
    OR (OLD."assetId" IS NOT NULL AND NEW."assetId" IS DISTINCT FROM OLD."assetId") OR (OLD."releasedAt" IS NOT NULL AND NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt") THEN PERFORM image_raise('IMAGE_HISTORY_CONFLICT'); END IF;
  IF NEW."releasedAt" IS NOT NULL AND OLD."releasedAt" IS NULL THEN
    SELECT * INTO i FROM "ImageHistoryItem" WHERE id = NEW."itemId";
    SELECT * INTO j FROM "ImageHistoryJob" WHERE id = i."jobId";
    SELECT * INTO a FROM "ImageAsset" WHERE id = i."assetId";
    IF i.state NOT IN ('SOURCE_RETAINED','RETIREMENT_REQUESTED') OR i."assetId" IS DISTINCT FROM NEW."assetId"
      OR a.id IS NULL OR a.state <> 'AVAILABLE' OR i."sourceObservationId" IS NULL OR i."sourceObjectId" IS NULL
      OR (i."subjectKind" = 'GENERATED' AND i."exactUrl" IS NULL)
      OR NOT EXISTS (SELECT 1 FROM "ImageUrlAlias" WHERE url = j."publicUrlBase"||'/media/images/'||a."publicToken" AND "assetId" = a.id)
      OR (i."exactUrl" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "ImageUrlAlias" WHERE url = i."exactUrl" AND "assetId" = a.id))
      OR (i."subjectKind" = 'GENERATED' AND NOT EXISTS (SELECT 1 FROM "ImageGenerationBinding" WHERE "assetId" = a.id AND "imageId" = i."subjectId" AND "jobId" = i.snapshot->>'jobId'))
      OR (i."subjectKind" = 'CANVAS_IMPORT' AND NOT EXISTS (SELECT 1 FROM "CanvasImportAsset" WHERE id = i."subjectId" AND "mediaAssetId" = a.id))
      OR (j.mode = 'COPY' AND NOT EXISTS (SELECT 1 FROM "ImageReplicaVerification" v WHERE v.id = i."replicaVerificationId" AND v."assetId" = a.id AND v."sourceObjectId" = i."sourceObjectId" AND v."targetObjectId" = a."activeObjectId" AND v."readerProtocolRevision" = 4 AND NOT v.revoked))
      OR EXISTS (SELECT 1 FROM "ImageHistoryReference" r JOIN "ImageUrlAlias" u ON u.url = r."exactUrl" AND u."assetId" = a.id
        WHERE NOT EXISTS (SELECT 1 FROM "ImageReference" f WHERE f."assetId" = a.id AND f.kind = r.kind AND f."referenceKey" = r."referenceKey" AND f."ownerId" = r."ownerId" AND f.permanent = r.permanent))
      THEN PERFORM image_raise('IMAGE_HISTORY_CONFLICT'); END IF;
    NEW."releasedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION image_commit_migration_switch(p JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE i "ImageHistoryItem"; a "ImageAsset"; t "ImageObject"; x "ImageObjectObservation"; r "ImageWriteReservation"; v_proof JSONB; v_switched BOOLEAN;
BEGIN
  i := image_history_lock_item(p);
  IF i."replicaVerificationId" IS NOT NULL THEN
    RETURN jsonb_build_object('switched',false,'replayed',true,'replicaVerificationId',i."replicaVerificationId",'item',image_history_item_json(i.id));
  END IF;
  SELECT * INTO x FROM "ImageObjectObservation" WHERE id = image_uuid(p->>'targetReadbackObservationId') AND "itemId" = i.id;
  SELECT * INTO r FROM "ImageWriteReservation" WHERE id = i."reservationId" FOR UPDATE;
  SELECT * INTO a FROM "ImageAsset" WHERE id = i."assetId" FOR UPDATE;
  PERFORM id FROM "ImageObject" WHERE "assetId" = a.id ORDER BY id FOR UPDATE;
  SELECT * INTO t FROM "ImageObject" WHERE id = i."targetObjectId";
  IF x.id IS NULL OR x.kind NOT IN ('TARGET_READBACK','WRITE_RECONCILIATION') OR x."readResult" <> 'FULL' OR x."versionEvidence" <> 'UNVERSIONED'
    OR x."sourceSnapshotHash" <> i."snapshotHash" OR x."byteLength" IS DISTINCT FROM t."byteLength" OR x.sha256 IS DISTINCT FROM t.sha256 OR x."mimeType" IS DISTINCT FROM t."mimeType"
    OR x."locationId" IS DISTINCT FROM t."locationId" OR x.key IS DISTINCT FROM t.key OR t.state <> 'READY' OR NOT image_object_verified(t)
    OR r.state <> 'CLOSED' OR a."activeObjectId" IS DISTINCT FROM image_uuid(p->>'expectedActiveObjectId') OR a."activeObjectId" NOT IN (i."sourceObjectId",t.id)
    OR p->>'readerProtocolRevision' IS DISTINCT FROM '4' THEN PERFORM image_raise('IMAGE_OBSERVATION_REQUIRED'); END IF;
  v_switched := (image_activate_object(jsonb_build_object('assetId',a.id,'objectId',t.id,'expectedObjectId',a."activeObjectId")))::boolean;
  IF NOT v_switched THEN PERFORM image_raise('IMAGE_HISTORY_CONFLICT'); END IF;
  -- C2 verifies the target is already active. Both operations commit atomically;
  -- losing this acknowledgement can only replay this same proof, never copy.
  v_proof := image_record_replica_verification(jsonb_build_object('assetId',a.id,'sourceObjectId',i."sourceObjectId",'targetObjectId',t.id,
    'byteLength',t."byteLength"::text,'sha256',t.sha256,'aliasUrls',p->'aliasUrls','readerProtocolRevision',4));
  UPDATE "ImageHistoryItem" SET state = 'SOURCE_RETAINED',"replicaVerificationId" = (v_proof->>'id')::uuid,"errorCode" = NULL WHERE id = i.id;
  UPDATE "ImageHistoryHold" SET "releasedAt" = clock_timestamp() WHERE "itemId" = i.id;
  PERFORM image_refresh_history_job(i."jobId");
  RETURN jsonb_build_object('switched',true,'replayed',false,'replicaVerificationId',v_proof->>'id','item',image_history_item_json(i.id));
END;
$$;

CREATE OR REPLACE FUNCTION image_storage_revision() RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS $$ SELECT 4 $$;
