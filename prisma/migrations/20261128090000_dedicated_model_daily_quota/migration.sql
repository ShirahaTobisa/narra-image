CREATE TABLE "ModelDailyUsage" (
    "model" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelDailyUsage_pkey" PRIMARY KEY ("model", "dateKey", "userId"),
    CONSTRAINT "ModelDailyUsage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "GenerationJob"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ModelDailyUsage_jobId_key" ON "ModelDailyUsage"("jobId");

-- All admission paths (web, Canvas, API and Go gateway) reserve in the job transaction.
CREATE FUNCTION narra_enforce_model_daily_quota() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    quota_day TEXT;
BEGIN
    IF NEW."providerMode" <> 'BUILT_IN' OR NEW.model NOT IN ('seedream-5-5', 'h3') THEN
        RETURN NEW;
    END IF;
    quota_day := to_char(clock_timestamp() AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD');
    PERFORM pg_advisory_xact_lock(hashtextextended('narra:model-day:' || NEW.model || ':' || quota_day, 0));
    IF EXISTS (SELECT 1 FROM "ModelDailyUsage" WHERE model = NEW.model AND "dateKey" = quota_day AND "userId" = NEW."userId") THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MODEL_DAILY_QUOTA_USED';
    END IF;
    IF (SELECT count(*) FROM "ModelDailyUsage" WHERE model = NEW.model AND "dateKey" = quota_day) >= 10 THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MODEL_DAILY_QUOTA_EXHAUSTED';
    END IF;
    INSERT INTO "ModelDailyUsage" (model, "dateKey", "userId", "jobId") VALUES (NEW.model, quota_day, NEW."userId", NEW.id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER "GenerationJob_model_daily_quota" AFTER INSERT ON "GenerationJob"
FOR EACH ROW EXECUTE FUNCTION narra_enforce_model_daily_quota();

-- Definitively failed/refunded tasks release both limits. Unknown or partially delivered work retains its claim.
CREATE FUNCTION narra_release_model_daily_quota() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'FAILED' AND NEW."creditsSpent" = 0
       AND (NEW."handoffState" IS NULL OR NEW."handoffState" IN ('NOT_STARTED', 'RESOLVED'))
       AND COALESCE(NEW."errorCode", '') NOT IN ('HANDOFF_UNKNOWN', 'RESULT_PERSIST_FAILED')
       AND NOT EXISTS (SELECT 1 FROM "GenerationImage" WHERE "jobId" = NEW.id)
       AND NOT EXISTS (SELECT 1 FROM "GeneratedVideo" WHERE "jobId" = NEW.id) THEN
        DELETE FROM "ModelDailyUsage" WHERE "jobId" = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "GenerationJob_release_model_daily_quota"
AFTER UPDATE OF status, "creditsSpent", "handoffState", "errorCode" ON "GenerationJob"
FOR EACH ROW EXECUTE FUNCTION narra_release_model_daily_quota();
