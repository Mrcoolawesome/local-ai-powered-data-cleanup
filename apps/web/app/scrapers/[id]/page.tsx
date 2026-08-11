import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  planScraperCommand,
  executeScraper,
  pollScraperRun,
  submitScraperInput,
  cancelScraperRun,
  writeScraperCredentials,
  AiServiceError,
} from "@/lib/ai-service";
import { ingestScraperOutputFile } from "@/lib/scraper-ingest";
import { deleteScraperDirectory } from "@/lib/scrapers-fs";
import { ScraperRunLive, type ScraperRunPollResult } from "@/components/scraper-run-live";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

// ai-service's default per-container timeout — same value the old
// synchronous run_scraper() used, now enforced across polls instead of a
// single blocking wait (docs/03-ingestion-and-scrapers.md). A container
// AWAITING_INPUT is exempt from it (scraper_sandbox.py's poll_scraper).
const SCRAPER_TIMEOUT_SECONDS = 300;

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
    let setupCommands = (formData.get("setupCommands") as string)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    // watch_signals isn't read from the form here — it's already inside
    // planJson below (the plan's own watch_signals field), which
    // pollScraperRunStatus reads back out at poll time. The "watchSignals"
    // hidden field still exists for the plan preview UI above.
    const planJson = JSON.parse(formData.get("planJson") as string);
    const credentialsEnvFilename = formData.get("credentialsEnvFilename") as string;
    const credentialsEnvTemplate = formData.get("credentialsEnvTemplate") as string;
    const email = (formData.get("email") as string) || "";
    const password = (formData.get("password") as string) || "";
    const willWriteCredentials = Boolean(credentialsEnvFilename && credentialsEnvTemplate && email && password);

    // Found for real: a scraper's own setup step commonly does
    // `cp housecallpro.env.example housecallpro.env` to seed the file with
    // placeholder values — since writeScraperCredentials below writes that
    // SAME file with the real ones first, running this setup command
    // afterward silently clobbers the real credentials right back to
    // "you@example.com"/"your-password" before the script ever runs
    // (confirmed for real: the scraper logged "Auto-login failed" because
    // the file it read back held the template's placeholders, not what
    // was just submitted). Strip any setup command that copies something
    // ONTO the credentials filename — writing the real file already
    // achieves what that step exists for.
    if (willWriteCredentials) {
      const cpToCredentialsFile = new RegExp(`\\bcp\\s+\\S+\\s+${credentialsEnvFilename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      setupCommands = setupCommands.filter((cmd) => !cpToCredentialsFile.test(cmd));
    }

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
      if (willWriteCredentials) {
        await writeScraperCredentials({
          scraperDirRelativePath: definition.scriptPath,
          envFilename: credentialsEnvFilename,
          envTemplate: credentialsEnvTemplate,
          email,
          password,
        });
      }

      // Only STARTS the container — does not wait for it to finish. The
      // run stays RUNNING; ScraperRunLive (a client component) takes over
      // from here, polling pollScraperRunStatus until the run reaches a
      // terminal status. watchSignals isn't persisted separately — it's
      // already inside planJson (formData's "planJson" field is the full
      // plan, watch_signals included), which pollScraperRunStatus reads
      // back out at poll time.
      const { container_id } = await executeScraper({
        scraperDirRelativePath: definition.scriptPath,
        runtime: definition.runtime,
        setupCommands,
        runCommand,
      });
      await prisma.scraperRun.update({ where: { id: run.id }, data: { containerId: container_id } });
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

  // Polled by ScraperRunLive (client component) every few seconds while a
  // run is RUNNING/AWAITING_INPUT. Finalizes (ingests new_files, writes
  // the terminal status) the moment ai-service reports the container has
  // exited — the same logic runScraper used to do synchronously itself
  // before a run could pause on AWAITING_INPUT.
  async function pollScraperRunStatus(runId: string): Promise<ScraperRunPollResult> {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const run = await prisma.scraperRun.findFirst({
      where: { id: runId, scraperDefinition: { userId: session.user.id } },
      include: { scraperDefinition: true },
    });
    if (!run) redirect("/scrapers");

    if (run.status !== "RUNNING" && run.status !== "AWAITING_INPUT") {
      return {
        status: run.status,
        logOutput: run.logOutput,
        filesIngestedCount: run.filesIngestedCount,
        pendingPrompt: run.pendingPrompt,
      };
    }
    if (!run.containerId) {
      // executeScraper never got far enough to record a container id —
      // runScraper's own catch block already marked this FAILED.
      return {
        status: run.status,
        logOutput: run.logOutput,
        filesIngestedCount: run.filesIngestedCount,
        pendingPrompt: run.pendingPrompt,
      };
    }

    const planJson = run.planJson as { watch_signals?: string[] } | null;
    const watchSignals = planJson?.watch_signals ?? [];

    let result;
    try {
      result = await pollScraperRun({
        containerId: run.containerId,
        scraperDirRelativePath: run.scraperDefinition.scriptPath,
        watchSignals,
        timeoutSeconds: SCRAPER_TIMEOUT_SECONDS,
        startedAt: run.startedAt.getTime() / 1000,
      });
    } catch (e) {
      const logOutput = e instanceof AiServiceError ? JSON.stringify(e.detail) : String(e);
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: { status: "FAILED", logOutput, finishedAt: new Date(), containerId: null, pendingPrompt: null },
      });
      revalidatePath(`/scrapers/${id}`);
      return { status: "FAILED", logOutput, filesIngestedCount: run.filesIngestedCount, pendingPrompt: null };
    }

    if (result.state === "running") {
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: { status: "RUNNING", pendingPrompt: null, logOutput: result.logs },
      });
      return { status: "RUNNING", logOutput: result.logs, filesIngestedCount: run.filesIngestedCount, pendingPrompt: null };
    }

    if (result.state === "awaiting_input") {
      await prisma.scraperRun.update({
        where: { id: run.id },
        data: { status: "AWAITING_INPUT", pendingPrompt: result.pending_prompt, logOutput: result.logs },
      });
      return {
        status: "AWAITING_INPUT",
        logOutput: result.logs,
        filesIngestedCount: run.filesIngestedCount,
        pendingPrompt: result.pending_prompt,
      };
    }

    // Exited — same ingestion logic runScraper used to run synchronously.
    let filesIngested = 0;
    for (const filePath of result.new_files) {
      const ingested = await ingestScraperOutputFile(run.scraperDefinition.scriptPath, filePath, run.id);
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
          data: { scraperRunId: run.id, filePath: ingested.scrapersRelativePath },
        });
      }
      filesIngested++;
    }

    const finalStatus = result.timed_out ? "INTERRUPTED" : result.exit_code === 0 ? "COMPLETED" : "FAILED";
    await prisma.scraperRun.update({
      where: { id: run.id },
      data: {
        status: finalStatus,
        logOutput: result.logs,
        filesIngestedCount: filesIngested,
        finishedAt: new Date(),
        containerId: null,
        pendingPrompt: null,
      },
    });
    revalidatePath(`/scrapers/${id}`);
    return { status: finalStatus, logOutput: result.logs, filesIngestedCount: filesIngested, pendingPrompt: null };
  }

  // Relays a human-submitted value (e.g. a 2FA code) into the still-
  // running container's stdin. Optimistically flips status back to
  // RUNNING — the next poll confirms it for real (or re-shows a prompt if
  // the scraper asks again, e.g. a wrong code).
  async function submitScraperRunInput(runId: string, text: string) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const run = await prisma.scraperRun.findFirst({
      where: { id: runId, scraperDefinition: { userId: session.user.id } },
    });
    if (!run || !run.containerId || run.status !== "AWAITING_INPUT") return;

    await submitScraperInput({ containerId: run.containerId, text });
    await prisma.scraperRun.update({ where: { id: run.id }, data: { status: "RUNNING", pendingPrompt: null } });
  }

  // Lets a human stop a RUNNING or AWAITING_INPUT run outright — the
  // concrete case that motivated this: a run paused waiting on a 2FA code
  // that's never going to arrive has no other way to end. Marked
  // INTERRUPTED, same status a timeout produces — both mean "we stopped
  // this before it finished on its own."
  async function cancelScraperRunAction(runId: string) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const run = await prisma.scraperRun.findFirst({
      where: { id: runId, scraperDefinition: { userId: session.user.id } },
      include: { scraperDefinition: true },
    });
    if (!run || (run.status !== "RUNNING" && run.status !== "AWAITING_INPUT")) return;

    let logOutput = run.logOutput;
    if (run.containerId) {
      try {
        const result = await cancelScraperRun({
          containerId: run.containerId,
          scraperDirRelativePath: run.scraperDefinition.scriptPath,
        });
        if (result.logs) logOutput = result.logs;
      } catch {
        // Best-effort — still mark it cancelled even if ai-service couldn't
        // be reached, rather than leaving the run stuck showing as live.
      }
    }

    await prisma.scraperRun.update({
      where: { id: run.id },
      data: { status: "INTERRUPTED", logOutput, finishedAt: new Date(), containerId: null, pendingPrompt: null },
    });
    revalidatePath(`/scrapers/${id}`);
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
          <ScraperRunLive
            key={run.id}
            run={{
              id: run.id,
              status: run.status,
              startedAt: run.startedAt.toISOString(),
              finishedAt: run.finishedAt?.toISOString() ?? null,
              logOutput: run.logOutput,
              filesIngestedCount: run.filesIngestedCount,
              pendingPrompt: run.pendingPrompt,
            }}
            pollAction={pollScraperRunStatus}
            submitInputAction={submitScraperRunInput}
            cancelAction={cancelScraperRunAction}
          />
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
