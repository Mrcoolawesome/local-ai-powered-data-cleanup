-- CreateEnum
CREATE TYPE "FileSourceType" AS ENUM ('MANUAL_UPLOAD', 'SCRAPER');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('PENDING', 'CLEANED', 'ERROR');

-- CreateTable
CREATE TABLE "TargetSchema" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "columns" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetSchema_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CleaningRule" (
    "id" TEXT NOT NULL,
    "targetSchemaId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "rawDescription" TEXT NOT NULL,
    "structured" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CleaningRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "sourceType" "FileSourceType" NOT NULL DEFAULT 'MANUAL_UPLOAD',
    "status" "FileStatus" NOT NULL DEFAULT 'PENDING',
    "datasetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dataset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "targetSchemaId" TEXT NOT NULL,
    "filePath" TEXT,
    "rowCount" INTEGER,
    "lastCleanedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dataset_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "TargetSchema" ADD CONSTRAINT "TargetSchema_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CleaningRule" ADD CONSTRAINT "CleaningRule_targetSchemaId_fkey" FOREIGN KEY ("targetSchemaId") REFERENCES "TargetSchema"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dataset" ADD CONSTRAINT "Dataset_targetSchemaId_fkey" FOREIGN KEY ("targetSchemaId") REFERENCES "TargetSchema"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
