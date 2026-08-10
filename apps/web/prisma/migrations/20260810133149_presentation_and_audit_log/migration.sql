-- CreateEnum
CREATE TYPE "PresentationViewKind" AS ENUM ('DATASET', 'ATTACHMENTS');

-- CreateEnum
CREATE TYPE "PresentationSessionStatus" AS ENUM ('IDLE', 'JOINING', 'SHARING', 'ERROR');

-- CreateTable
CREATE TABLE "PresentationSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "zoomMeetingId" TEXT,
    "status" "PresentationSessionStatus" NOT NULL DEFAULT 'IDLE',
    "activeViewKind" "PresentationViewKind",
    "activeDatasetId" TEXT,
    "activeScraperRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PresentationSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PresentationSession_userId_idx" ON "PresentationSession"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PresentationSession" ADD CONSTRAINT "PresentationSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresentationSession" ADD CONSTRAINT "PresentationSession_activeDatasetId_fkey" FOREIGN KEY ("activeDatasetId") REFERENCES "Dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PresentationSession" ADD CONSTRAINT "PresentationSession_activeScraperRunId_fkey" FOREIGN KEY ("activeScraperRunId") REFERENCES "ScraperRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
