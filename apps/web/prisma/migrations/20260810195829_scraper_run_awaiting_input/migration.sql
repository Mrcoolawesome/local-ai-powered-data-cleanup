-- AlterEnum
ALTER TYPE "ScraperRunStatus" ADD VALUE 'AWAITING_INPUT';

-- AlterTable
ALTER TABLE "ScraperRun" ADD COLUMN     "containerId" TEXT,
ADD COLUMN     "pendingPrompt" TEXT;
