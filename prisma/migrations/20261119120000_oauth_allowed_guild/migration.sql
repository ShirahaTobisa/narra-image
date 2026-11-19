-- Discord login can be limited to members of one server. NULL keeps the
-- original behaviour (new users still need an invite code).
ALTER TABLE "OAuthProvider" ADD COLUMN "allowedGuildId" TEXT;
