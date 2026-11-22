-- AlterTable
ALTER TABLE "User" ADD COLUMN     "generationPausedAt" TIMESTAMP(3),
ADD COLUMN     "moderationClearedAt" TIMESTAMP(3);
