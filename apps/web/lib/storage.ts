import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

// /app/storage inside the Docker Compose stack (bind-mounted, shared with
// ai-service — docs/11-deployment.md). Falls back to a relative path for
// running `pnpm dev` outside Docker.
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), "storage");

// Saves an uploaded file under storage/uploads/{userId}/ with a
// collision-proof name, and returns the path relative to STORAGE_ROOT —
// that relative path is what gets stored in UploadedFile.filePath, so it
// stays valid regardless of which container (web or ai-service) resolves
// it, since both mount the same root at the same place.
export async function saveUploadedFile(userId: string, file: File): Promise<{ relativePath: string }> {
  const userDir = path.join(STORAGE_ROOT, "uploads", userId);
  await mkdir(userDir, { recursive: true });

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
  const absolutePath = path.join(userDir, filename);

  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(absolutePath, buffer);

  return { relativePath: path.join("uploads", userId, filename) };
}
