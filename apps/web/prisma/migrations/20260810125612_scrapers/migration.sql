-- CreateEnum
CREATE TYPE "ScraperRuntime" AS ENUM ('PYTHON', 'NODE');

-- CreateEnum
CREATE TYPE "ScraperRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'INTERRUPTED', 'FAILED');

-- AlterTable
ALTER TABLE "UploadedFile" ADD COLUMN     "scraperRunId" TEXT;

-- CreateTable
CREATE TABLE "ScraperDefinition" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platformName" TEXT NOT NULL,
    "scriptPath" TEXT NOT NULL,
    "readmePath" TEXT NOT NULL,
    "runtime" "ScraperRuntime" NOT NULL,
    "lastValidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScraperDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScraperRun" (
    "id" TEXT NOT NULL,
    "scraperDefinitionId" TEXT NOT NULL,
    "commandExecuted" TEXT NOT NULL,
    "planJson" JSONB NOT NULL,
    "status" "ScraperRunStatus" NOT NULL DEFAULT 'RUNNING',
    "logOutput" TEXT,
    "filesIngestedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ScraperRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "scraperRunId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "jobId" TEXT,
    "customerId" TEXT,
    "invoiceNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_scraperRunId_fkey" FOREIGN KEY ("scraperRunId") REFERENCES "ScraperRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScraperDefinition" ADD CONSTRAINT "ScraperDefinition_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScraperRun" ADD CONSTRAINT "ScraperRun_scraperDefinitionId_fkey" FOREIGN KEY ("scraperDefinitionId") REFERENCES "ScraperDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_scraperRunId_fkey" FOREIGN KEY ("scraperRunId") REFERENCES "ScraperRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
