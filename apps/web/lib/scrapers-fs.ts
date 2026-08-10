import { readdir } from "fs/promises";
import path from "path";

// /app/scrapers inside the Docker Compose stack (read-only bind mount of
// ./example-scrapers — docs/11-deployment.md, docker-compose.yml), mirrors
// STORAGE_ROOT's pattern. Falls back to a relative path for `pnpm dev`
// outside Docker.
const SCRAPERS_ROOT = process.env.SCRAPERS_ROOT || path.join(process.cwd(), "..", "..", "example-scrapers");

export type DiscoveredScraper = {
  dirRelativePath: string;
  readmeRelativePath: string;
  readmeFilename: string;
};

// One level deep only — each scraper lives in its own top-level directory
// under SCRAPERS_ROOT (matches how /example-scrapers is actually laid out:
// housecallpro-job-attachments-scraper-v2/, HouseCallPro/, ...).
export async function discoverScrapers(): Promise<DiscoveredScraper[]> {
  const entries = await readdir(SCRAPERS_ROOT, { withFileTypes: true });
  const discovered: DiscoveredScraper[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(SCRAPERS_ROOT, entry.name);
    const files = await readdir(dirPath, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && file.name.toLowerCase().endsWith(".md")) {
        discovered.push({
          dirRelativePath: entry.name,
          readmeRelativePath: path.join(entry.name, file.name),
          readmeFilename: file.name,
        });
      }
    }
  }

  return discovered;
}
