-- Human-friendly user number (shown as #12 in admin and settings).
-- Existing users are numbered in sign-up order; new users take the next value.
ALTER TABLE "User" ADD COLUMN "uid" INTEGER;

UPDATE "User" AS u
SET "uid" = ordered.rn
FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt", id) AS rn FROM "User") AS ordered
WHERE u.id = ordered.id;

CREATE SEQUENCE "User_uid_seq" AS INTEGER OWNED BY "User"."uid";
SELECT setval('"User_uid_seq"', COALESCE((SELECT MAX("uid") FROM "User"), 0) + 1, false);

ALTER TABLE "User"
  ALTER COLUMN "uid" SET DEFAULT nextval('"User_uid_seq"'),
  ALTER COLUMN "uid" SET NOT NULL;

CREATE UNIQUE INDEX "User_uid_key" ON "User"("uid");
