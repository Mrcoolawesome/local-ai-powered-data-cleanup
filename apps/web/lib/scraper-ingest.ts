import { copyFile, mkdir } from "fs/promises";
import path from "path";

// Same two roots as lib/scrapers-fs.ts and lib/storage.ts — kept as two
// separate consts (not reused directly) so this file's intent (moving
// content FROM one root INTO the other) stays obvious at the call site.
const SCRAPERS_ROOT = process.env.SCRAPERS_ROOT || path.join(process.cwd(), "..", "..", "example-scrapers");
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), "storage");

const SPREADSHEET_EXTENSIONS = new Set([".csv", ".xlsx", ".xls"]);

export type IngestedFile =
  | { kind: "dataset"; storageRelativePath: string; originalFilename: string }
  | { kind: "attachment"; scrapersRelativePath: string; originalFilename: string };

// A new file a scraper run produced (per ai-service's list_files_modified_since)
// goes one of two places, decided by extension alone rather than a
// per-platform layout parser (docs/03-ingestion-and-scrapers.md's "no
// hardcoded per-platform switch statement" constraint):
//
// - Spreadsheet exports (.csv/.xlsx/.xls) are copied into STORAGE_ROOT so
//   the existing cleaning pipeline (which only ever resolves paths against
//   STORAGE_ROOT, both here and in ai-service) can pick them up exactly
//   like a manual upload — becomes an UploadedFile row.
// - Everything else (photos, PDFs, etc.) is left where the scraper wrote
//   it, under SCRAPERS_ROOT — becomes an Attachment row referencing that
//   path directly. No copy: `web` only mounts example-scrapers read-only,
//   and duplicating potentially large binary media into storage/ for no
//   reason beyond "one root to rule them all" isn't worth the disk cost.
//
// v1 gap, stated rather than silently absent: Attachment.jobId/customerId
// are left null here — parsing them out of the file's path (e.g. HCP v2's
// output/{COMPANY}/{job}/{file} layout) would need either a hardcoded
// per-platform parser (the thing this design avoids) or a second LLM call
// this phase doesn't build. Fine for now since those fields are documented
// as loose/nullable on purpose.
export async function ingestScraperOutputFile(
  scraperDirRelativePath: string,
  fileRelativePath: string,
  scraperRunId: string
): Promise<IngestedFile> {
  const originalFilename = path.basename(fileRelativePath);
  const ext = path.extname(fileRelativePath).toLowerCase();

  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    // turbopackIgnore: both roots are env-configured runtime bind-mount
    // paths, same reason as lib/scrapers-fs.ts's discoverScrapers().
    const destDir = path.join(/* turbopackIgnore: true */ STORAGE_ROOT, "scraper-runs", scraperRunId);
    await mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, originalFilename);
    const srcPath = path.join(/* turbopackIgnore: true */ SCRAPERS_ROOT, scraperDirRelativePath, fileRelativePath);
    await copyFile(srcPath, destPath);
    return {
      kind: "dataset",
      storageRelativePath: path.join("scraper-runs", scraperRunId, originalFilename),
      originalFilename,
    };
  }

  return {
    kind: "attachment",
    scrapersRelativePath: path.join(scraperDirRelativePath, fileRelativePath),
    originalFilename,
  };
}
