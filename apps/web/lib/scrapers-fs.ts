import { mkdir, readdir, stat, writeFile } from "fs/promises";
import path from "path";
import AdmZip from "adm-zip";

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
  // SCRAPERS_ROOT is an env-configured runtime path (bind mount, not part
  // of the build output) — turbopackIgnore tells Turbopack's build-time
  // tracer not to walk/bundle the whole project on account of this dynamic
  // path, which it otherwise does since it can't statically resolve it.
  const entries = await readdir(/* turbopackIgnore: true */ SCRAPERS_ROOT, { withFileTypes: true });
  const discovered: DiscoveredScraper[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(/* turbopackIgnore: true */ SCRAPERS_ROOT, entry.name);
    const files = await readdir(/* turbopackIgnore: true */ dirPath, { withFileTypes: true });
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

export class ScraperUploadError extends Error {}

// Directory/segment names come from user-controlled input (the zip's own
// entry paths, and the uploaded filename as a fallback) — strip to a safe
// character set rather than trying to individually block every dangerous
// pattern. Same character allowlist as lib/storage.ts's safeName.
function sanitizeSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "") || "scraper";
}

// Rejects the classic "zip slip" shape (entries using `../` to write
// outside the intended extraction directory) before anything touches disk.
// Checked twice in extractScraperZip below — once on the raw entry name
// from the archive, once again on the final resolved path after stripping
// a possible common wrapping folder — since either step could otherwise
// reintroduce a traversal a single check might miss.
function isSafeRelativePath(root: string, relativePath: string): boolean {
  if (path.isAbsolute(relativePath)) return false;
  const resolved = path.resolve(root, relativePath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// Extracts an uploaded scraper .zip into its own top-level directory under
// SCRAPERS_ROOT, so it shows up in discoverScrapers() the same as anything
// dropped in by hand. Handles both zip shapes people actually produce:
// a single wrapping folder (`my-scraper/README.md`, `my-scraper/scrape.py`,
// ...) or files at the zip root with no wrapper — detected by checking
// whether every entry shares the same first path segment.
export async function extractScraperZip(buffer: Buffer, suggestedName: string): Promise<{ dirName: string }> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new ScraperUploadError("Not a valid zip file.");
  }

  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length === 0) throw new ScraperUploadError("Zip file is empty.");

  for (const entry of entries) {
    if (!isSafeRelativePath("/root", entry.entryName)) {
      throw new ScraperUploadError(`Refusing to extract unsafe path in zip: ${entry.entryName}`);
    }
  }

  // "Every entry nested one level, all under the same folder name" is the
  // wrapper case. Requiring nesting (not just a shared first segment)
  // matters for a single-file zip: entryName "README.md" has no "/" at
  // all, so treating its whole name as a "wrapping folder" would strip
  // the entire relative path down to "" and silently drop the file.
  const allNested = entries.every((e) => e.entryName.includes("/"));
  const firstSegments = new Set(entries.map((e) => e.entryName.split("/")[0]));
  const hasCommonRoot = allNested && firstSegments.size === 1;
  const wrapperPrefix = hasCommonRoot ? `${[...firstSegments][0]}/` : null;

  const dirName = sanitizeSegment(wrapperPrefix ? wrapperPrefix.slice(0, -1) : suggestedName);
  const targetRoot = path.resolve(/* turbopackIgnore: true */ SCRAPERS_ROOT, dirName);

  const alreadyExists = await stat(targetRoot).then(
    () => true,
    (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  );
  if (alreadyExists) {
    throw new ScraperUploadError(`A scraper directory named "${dirName}" already exists — remove it first or rename the zip.`);
  }

  for (const entry of entries) {
    const relativePath = wrapperPrefix ? entry.entryName.slice(wrapperPrefix.length) : entry.entryName;
    if (!relativePath || !isSafeRelativePath(targetRoot, relativePath)) continue;

    const destPath = path.join(targetRoot, relativePath);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, entry.getData());
  }

  return { dirName };
}
