-- AlterTable
ALTER TABLE "ScraperDefinition" ADD COLUMN     "cachedPlan" JSONB,
ADD COLUMN     "planCachedAt" TIMESTAMP(3);
