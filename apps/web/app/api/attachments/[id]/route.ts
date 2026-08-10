import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Same env-configured runtime path as lib/scrapers-fs.ts.
const SCRAPERS_ROOT = process.env.SCRAPERS_ROOT || path.join(process.cwd(), "..", "..", "example-scrapers");

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

// Deliberately unauthenticated, same reasoning as
// app/present/[sessionId]/page.tsx: the Zoom bot's Chromium has no
// interactive login session, so this route treats the attachment's own
// unguessable cuid id as its authorization — see that page's comment for
// the full reasoning. Read-only, no mutation path, so the blast radius of
// that tradeoff is "an attacker who already has a valid id can view one
// file," not broader account access.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const attachment = await prisma.attachment.findUnique({ where: { id } });
  if (!attachment) return new NextResponse("Not found", { status: 404 });

  const ext = path.extname(attachment.filePath).toLowerCase();
  const absolutePath = path.join(/* turbopackIgnore: true */ SCRAPERS_ROOT, attachment.filePath);

  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch {
    return new NextResponse("File not found on disk", { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: { "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream" },
  });
}
