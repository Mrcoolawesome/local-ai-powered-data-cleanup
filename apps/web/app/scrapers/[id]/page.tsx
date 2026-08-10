import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { planScraperCommand, executeScraper, writeScraperCredentials, AiServiceError } from "@/lib/ai-service";
import { ingestScraperOutputFile } from "@/lib/scraper-ingest";
import { deleteScraperDirectory } from "@/lib/scrapers-fs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default async function ScraperDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ plan?: string; error?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { id } = await params;
  const { plan: showPlan, error } = await searchParams;

  const def = await prisma.scraperDefinition.findFirst({
    where: { id, userId: session.user.id },
    include: { runs: { orderBy: { startedAt: "desc" } } },
  });
  if (!def) notFound();

  async function markValidated() {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");
    await prisma.scraperDefinition.updateMany({
      where: { id, userId: session.user.id },
      data: { lastValidatedAt: new Date() },
    });
    revalidatePath(`/scrapers/${id}`);
  }

  // Runs a fresh planning call every time the plan section is shown rather
  // than caching it — a stale plan against a scraper whose README drifted
  // is exactly the silent-failure mode docs/03 warns about.
  let plan: Awaited<ReturnType<typeof planScraperCommand>>["plan"] | null = null;
  let planError: string | null = null;
  if (showPlan) {
    try {
      const result = await planScraperCommand(def.readmePath, def.runtime);
      plan = result.plan;
    } catch (e) {
      planError = e instanceof AiServiceError ? e.message : "Planning failed.";
    }
  }

  async function runScraper(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const definition = await prisma.scraperDefinition.findFirst({ where: { id, userId: session.user.id } });
    if (!definition) redirect("/scrapers");

    const confirmed = formData.get("confirm") === "on";
    if (!confirmed) redirect(`/scrapers/${id}?plan=1&error=${encodeURIComponent("Confirmation checkbox is required to run a real scraper.")}`);

    // When the plan offered a choice of operations (checkboxes below), the
    // actual command is whichever ones got checked, joined in sequence —
    // "everything checked" (the default) is a full export; unchecking some
    // narrows it. Falls back to the plan's own single run_command when
    // there was no such choice to make.
    const selectedOperations = formData.getAll("operations") as string[];
    const runCommand = selectedOperations.length > 0 ? selectedOperations.join(" && ") : (formData.get("runCommand") as string);
    if (!runCommand) {
      redirect(`/scrapers/${id}?plan=1&error=${encodeURIComponent("Select at least one operation to run.")}`);
    }
    const setupCommands = (formData.get("setupCommands") as string)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const watchSignals = (formData.get("watchSignals") as string)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const planJson = JSON.parse(formData.get("planJson") as string);
    const credentialsEnvFilename = formData.get("credentialsEnvFilename") as string;
    const credentialsEnvTemplate = formData.get("credentialsEnvTemplate") as string;
    const email = (formData.get("email") as string) || "";
    const password = (formData.get("password") as string) || "";

    const commandExecuted = [...setupCommands, runCommand].join(" && ");
    const run = await prisma.scraperRun.create({
      data: {
        scraperDefinitionId: definition.id,
        commandExecuted,
        planJson,
        status: "RUNNING",
      },
    });

    try {
      // Only writes the credentials file when both fields were actually
      // filled in — leaving them blank keeps whatever's already saved in
      // the scraper's directory from an earlier run/manual setup, rather
      // than clobbering it with empty values.
      if (credentialsEnvFilename && credentialsEnvTemplate && email && password) {
        await writeScraperCredentials({
          scraperDirRelativePath: definition.scriptPath,
          envFilename: credentialsEnvFilename,
          envTemplate: credentialsEnvTemplate,
          email,
          password,
        });
      }

      const result = await executeScraper({
        scraperDirRelativePath: definition.scriptPath,
        runtime: definition.runtime,
        setupCommands,
        runCommand,
        watchSignals,
      });

      let filesIngested = 0;
      for (const filePath of result.new_files) {
        const ingested = await ingestScraperOutputFile(definition.scriptPath, filePath, run.id);
        if (ingested.kind === "dataset") {
          await prisma.uploadedFile.create({
            data: {
              userId: session.user.id,
              filePath: ingested.storageRelativePath,
              originalFilename: ingested.originalFilename,
              sourceType: "SCRAPER",
              scraperRunId: run.id,
            },
          });
        } else {
          await prisma.attachment.create({
            data: {
              scraperRunId: run.id,
              filePath: ingested.scrapersRelativePath,
            },
          });
        }
        filesIngested++;
      }

      await prisma.scraperRun.update({
        where: { id: run.id },
        data: {
          status: result.timed_out ? "INTERRUPTED" : result.exit_code === 0 ? "COMPLETED" : "FAILED",
          logOutput: result.logs,
          filesIngestedCount: filesIngested,
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          logOutput: e instanceof AiServiceError ? JSON.stringify(e.detail) : String(e),
          finishedAt: new Date(),
        },
      });
    }

    revalidatePath(`/scrapers/${id}`);
    redirect(`/scrapers/${id}`);
  }

  async function deleteScraper(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const definition = await prisma.scraperDefinition.findFirst({ where: { id, userId: session.user.id } });
    if (!definition) redirect("/scrapers");

    const confirmed = formData.get("confirmDelete") === "on";
    if (!confirmed) {
      redirect(`/scrapers/${id}?error=${encodeURIComponent("Confirmation checkbox is required to delete a scraper.")}`);
    }

    // DB row first (cascades ScraperRun/Attachment, docs/02-data-model.md),
    // then the files — if the file removal throws, the registration is
    // already gone rather than left half-deleted in a confusing state.
    await prisma.scraperDefinition.delete({ where: { id: definition.id } });
    await deleteScraperDirectory(definition.scriptPath);

    redirect("/scrapers");
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/scrapers" className="text-muted-foreground text-sm hover:text-foreground">
          &larr; Scrapers
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {def.platformName}
          <Badge variant="outline">{def.runtime.toLowerCase()}</Badge>
        </h1>
        <p className="text-muted-foreground text-sm">{def.scriptPath}</p>
      </div>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle>Credential validation</CardTitle>
          <CardDescription>
            A human must confirm the saved session/credentials work (2FA, interactive login) before the agent runs
            this unattended — the agent never performs interactive login itself.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          {def.lastValidatedAt ? (
            <Badge variant="default">Validated {def.lastValidatedAt.toLocaleString()}</Badge>
          ) : (
            <Badge variant="destructive">Not yet validated</Badge>
          )}
          <form action={markValidated}>
            <Button type="submit" variant="outline">
              Mark validated now
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plan a run</CardTitle>
          <CardDescription>
            Reads the README and produces a command plan — review it before running anything against a real
            platform with live credentials.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!showPlan && (
            <Link href={`/scrapers/${id}?plan=1`}>
              <Button type="button" variant="outline">
                Get plan from README
              </Button>
            </Link>
          )}

          {error && <p className="text-destructive text-sm">{decodeURIComponent(error)}</p>}
          {planError && <p className="text-destructive text-sm">{planError}</p>}

          {plan && (
            <>
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Confidence:</span>
                  <Badge variant={plan.confidence === "high" ? "default" : plan.confidence === "medium" ? "secondary" : "destructive"}>
                    {plan.confidence}
                  </Badge>
                </div>
                {plan.concerns && <p className="text-muted-foreground">{plan.concerns}</p>}
                <div>
                  <span className="font-medium">Setup:</span>
                  <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-xs">
                    {plan.setup_commands.join("\n") || "(none)"}
                  </pre>
                </div>
                {(!plan.available_operations || plan.available_operations.length === 0) && (
                  <div>
                    <span className="font-medium">Run:</span>
                    <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-xs">{plan.run_command}</pre>
                  </div>
                )}
                <div>
                  <span className="font-medium">Watch signals:</span>
                  <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-2 text-xs">
                    {plan.watch_signals.join("\n") || "(none)"}
                  </pre>
                </div>
              </div>

              <form action={runScraper} className="flex flex-col gap-3 rounded-md border border-destructive/30 p-3">
                <input type="hidden" name="setupCommands" value={plan.setup_commands.join("\n")} />
                <input type="hidden" name="runCommand" value={plan.run_command} />
                <input type="hidden" name="watchSignals" value={plan.watch_signals.join("\n")} />
                {plan.available_operations && plan.available_operations.length > 0 && (
                  <div className="flex flex-col gap-2 text-sm">
                    <div>
                      <span className="font-medium">What to run:</span>
                      <p className="text-muted-foreground text-xs">
                        Everything is selected by default — a full export. Uncheck anything you don&apos;t want this
                        run to include.
                      </p>
                    </div>
                    <div className="flex flex-col gap-2 rounded-md bg-muted p-2">
                      {plan.available_operations.map((op, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <Checkbox id={`op-${i}`} name="operations" value={op.command} defaultChecked />
                          <Label htmlFor={`op-${i}`} className="flex flex-col gap-0.5 text-sm font-normal">
                            <span>{op.label}</span>
                            <code className="text-muted-foreground text-xs">{op.command}</code>
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <input type="hidden" name="planJson" value={JSON.stringify(plan)} />
                {plan.credentials_env_filename && plan.credentials_env_template && (
                  <>
                    <input type="hidden" name="credentialsEnvFilename" value={plan.credentials_env_filename} />
                    <input type="hidden" name="credentialsEnvTemplate" value={plan.credentials_env_template} />
                    <div className="flex flex-col gap-2 text-sm">
                      <p className="text-muted-foreground">
                        The README documents login credentials in <code>{plan.credentials_env_filename}</code>.
                        Fill these in to write/update that file before this run — leave both blank to keep
                        whatever&apos;s already saved there.
                      </p>
                      <div className="flex flex-wrap gap-3">
                        <div className="flex flex-1 flex-col gap-2">
                          <Label htmlFor="email">Email</Label>
                          <Input id="email" name="email" type="email" autoComplete="off" />
                        </div>
                        <div className="flex flex-1 flex-col gap-2">
                          <Label htmlFor="password">Password</Label>
                          <Input id="password" name="password" type="password" autoComplete="off" />
                        </div>
                      </div>
                    </div>
                  </>
                )}
                <div className="flex items-start gap-2">
                  <Checkbox id="confirm" name="confirm" required />
                  <Label htmlFor="confirm" className="text-sm font-normal">
                    I understand this will run the above commands in a sandboxed container against the real target
                    platform using this scraper&apos;s saved credentials, and I have reviewed the plan above.
                  </Label>
                </div>
                <Button type="submit" variant="destructive" className="w-fit">
                  Run scraper now
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Run history</h2>
        {def.runs.length === 0 && <p className="text-muted-foreground text-sm">No runs yet.</p>}
        {def.runs.map((run) => (
          <Card key={run.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Badge
                  variant={
                    run.status === "COMPLETED" ? "default" : run.status === "RUNNING" ? "secondary" : "destructive"
                  }
                >
                  {run.status.toLowerCase()}
                </Badge>
                <span className="text-muted-foreground text-xs font-normal">
                  {run.startedAt.toLocaleString()}
                  {run.finishedAt && ` – ${run.finishedAt.toLocaleString()}`}
                </span>
              </CardTitle>
              <CardDescription>
                {run.filesIngestedCount} file{run.filesIngestedCount === 1 ? "" : "s"} ingested
              </CardDescription>
            </CardHeader>
            {run.logOutput && (
              <CardContent>
                <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
                  {run.logOutput}
                </pre>
              </CardContent>
            )}
          </Card>
        ))}
      </div>

      <Separator />

      <Card className="border-destructive/30">
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>
            Permanently deletes this registration, its run history, and any attachments — and removes the
            scraper&apos;s files (including any saved credentials) from disk.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={deleteScraper} className="flex flex-col gap-3">
            <div className="flex items-start gap-2">
              <Checkbox id="confirmDelete" name="confirmDelete" required />
              <Label htmlFor="confirmDelete" className="text-sm font-normal">
                I understand this permanently deletes {def.platformName} ({def.scriptPath}), its run history, and
                its files.
              </Label>
            </div>
            <Button type="submit" variant="destructive" className="w-fit">
              Delete scraper
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
