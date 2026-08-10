-- CreateEnum
CREATE TYPE "CleaningRunStatus" AS ENUM ('SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "CleaningRun" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "generatedScript" TEXT NOT NULL,
    "status" "CleaningRunStatus" NOT NULL,
    "sandboxLogs" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "CleaningRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditReport" (
    "id" TEXT NOT NULL,
    "cleaningRunId" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "contentMarkdown" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditReport_cleaningRunId_key" ON "AuditReport"("cleaningRunId");

-- AddForeignKey
ALTER TABLE "CleaningRun" ADD CONSTRAINT "CleaningRun_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditReport" ADD CONSTRAINT "AuditReport_cleaningRunId_fkey" FOREIGN KEY ("cleaningRunId") REFERENCES "CleaningRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
