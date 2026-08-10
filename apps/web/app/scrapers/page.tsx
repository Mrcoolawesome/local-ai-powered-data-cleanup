import { redirect } from "next/navigation";
import Link from "next/link";
import path from "path";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { discoverScrapers, extractScraperZip, deleteScraperDirectory, ScraperUploadError } from "@/lib/scrapers-fs";
import { AppNav } from "@/components/app-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default async function ScrapersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const { error } = await searchParams;

  const [registered, discovered] = await Promise.all([
    prisma.scraperDefinition.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
      include: { runs: { orderBy: { startedAt: "desc" }, take: 1 } },
    }),
    discoverScrapers(),
  ]);

  const registeredDirs = new Set(registered.map((r) => r.scriptPath.split("/")[0]));
  const unregistered = discovered.filter((d) => !registeredDirs.has(d.dirRelativePath));

  async function register(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const dirRelativePath = formData.get("dirRelativePath") as string;
    const readmeRelativePath = formData.get("readmeRelativePath") as string;
    const platformName = formData.get("platformName") as string;
    const runtime = formData.get("runtime") as string;
    if (runtime !== "PYTHON" && runtime !== "NODE") throw new Error(`Unknown runtime: ${runtime}`);

    await prisma.scraperDefinition.create({
      data: {
        userId: session.user.id,
        platformName,
        scriptPath: dirRelativePath,
        readmePath: readmeRelativePath,
        runtime,
      },
    });
    revalidatePath("/scrapers");
  }

  async function uploadZip(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const file = formData.get("file") as File;
    if (!file || file.size === 0) redirect(`/scrapers?error=${encodeURIComponent("No file selected.")}`);
    if (!file.name.toLowerCase().endsWith(".zip")) {
      redirect(`/scrapers?error=${encodeURIComponent("Only .zip files are accepted.")}`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const suggestedName = path.basename(file.name, path.extname(file.name));

    try {
      await extractScraperZip(buffer, suggestedName);
    } catch (e) {
      const message = e instanceof ScraperUploadError ? e.message : "Failed to extract zip.";
      redirect(`/scrapers?error=${encodeURIComponent(message)}`);
    }

    revalidatePath("/scrapers");
  }

  async function deleteDiscovered(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const dirRelativePath = formData.get("dirRelativePath") as string;
    // Re-derive "not registered" server-side rather than trusting the
    // client only rendered this button for an unregistered entry — a
    // registered ScraperDefinition still needs its DB row (and any run
    // history/attachments) removed first, via /scrapers/[id]'s own delete.
    const isRegistered = await prisma.scraperDefinition.findFirst({
      where: { userId: session.user.id, scriptPath: dirRelativePath },
    });
    if (isRegistered) {
      redirect(`/scrapers?error=${encodeURIComponent("That scraper is registered — delete it from its own page instead.")}`);
    }

    await deleteScraperDirectory(dirRelativePath);
    revalidatePath("/scrapers");
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Scrapers</h1>
        <p className="text-muted-foreground text-sm">
          Registered scrapers the agent can plan and run — see docs/03-ingestion-and-scrapers.md.
        </p>
      </div>

      <AppNav current="scrapers" />

      <Separator />

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Registered</h2>
        {registered.length === 0 && (
          <p className="text-muted-foreground text-sm">None registered yet — discover one below.</p>
        )}
        {registered.map((def) => {
          const latestRun = def.runs[0];
          return (
            <Link key={def.id} href={`/scrapers/${def.id}`}>
              <Card className="transition-colors hover:bg-muted/50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    {def.platformName}
                    <Badge variant="outline">{def.runtime.toLowerCase()}</Badge>
                    {def.lastValidatedAt ? (
                      <Badge variant="default">credentials validated</Badge>
                    ) : (
                      <Badge variant="destructive">not validated</Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {def.scriptPath}
                    {latestRun && (
                      <>
                        {" · last run "}
                        {latestRun.status.toLowerCase()} {latestRun.startedAt.toLocaleString()}
                      </>
                    )}
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          );
        })}
      </div>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle>Upload a scraper</CardTitle>
          <CardDescription>
            A .zip of the scraper&apos;s script + README (a saved session/.env can be included too) — extracted onto
            the scrapers root and shown below to register, same as one dropped in by hand.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error && <p className="text-destructive text-sm">{decodeURIComponent(error)}</p>}
          <form action={uploadZip} className="flex items-end gap-3">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="scraper-zip">Zip file</Label>
              <Input id="scraper-zip" name="file" type="file" accept=".zip" required />
            </div>
            <Button type="submit">Upload</Button>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Discovered, not yet registered</h2>
        <p className="text-muted-foreground text-sm">
          Found under the scrapers root by scanning for a README — registering just records the paths; a human
          still has to confirm saved credentials/session work before the agent can trigger it unattended.
        </p>
        {unregistered.length === 0 && (
          <p className="text-muted-foreground text-sm">Nothing new — every discovered scraper is registered.</p>
        )}
        {unregistered.map((d) => (
          <Card key={d.dirRelativePath}>
            <CardHeader>
              <CardTitle>{d.dirRelativePath}</CardTitle>
              <CardDescription>{d.readmeRelativePath}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <form action={register} className="flex flex-wrap items-end gap-3">
                <input type="hidden" name="dirRelativePath" value={d.dirRelativePath} />
                <input type="hidden" name="readmeRelativePath" value={d.readmeRelativePath} />
                <input type="hidden" name="platformName" value={d.dirRelativePath} />
                <div className="flex flex-col gap-2">
                  <label htmlFor={`runtime-${d.dirRelativePath}`} className="text-sm font-medium">
                    Runtime
                  </label>
                  <select
                    id={`runtime-${d.dirRelativePath}`}
                    name="runtime"
                    className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
                    defaultValue="PYTHON"
                  >
                    <option value="PYTHON">Python</option>
                    <option value="NODE">Node</option>
                  </select>
                </div>
                <Button type="submit">Register</Button>
              </form>
              <form action={deleteDiscovered}>
                <input type="hidden" name="dirRelativePath" value={d.dirRelativePath} />
                <Button type="submit" variant="destructive">
                  Delete
                </Button>
              </form>
            </CardContent>
          </Card>
        ))}
      </div>
    </main>
  );
}
