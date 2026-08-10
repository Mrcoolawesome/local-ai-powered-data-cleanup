import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { saveUploadedFile } from "@/lib/storage";
import { inferSchema, executeCleaning, AiServiceError } from "@/lib/ai-service";
import { renderAuditReportMarkdown } from "@/lib/audit-report";
import { findOrCreateChatSession } from "@/lib/chat";
import { ColumnSchema, type Column } from "@/lib/target-schema";
import { AppNav } from "@/components/app-nav";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function UploadPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const userId = session.user.id;

  const [schemas, files] = await Promise.all([
    prisma.targetSchema.findMany({ where: { userId }, orderBy: { entityType: "asc" } }),
    prisma.uploadedFile.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        dataset: {
          include: {
            targetSchema: true,
            cleaningRuns: { orderBy: { startedAt: "desc" }, take: 1, include: { auditReport: true } },
          },
        },
      },
    }),
  ]);

  async function uploadFile(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");
    const userId = session.user.id;

    const file = formData.get("file") as File;
    const targetSchemaId = formData.get("targetSchemaId") as string;
    const datasetName = (formData.get("datasetName") as string) || file.name;

    if (!file || file.size === 0) throw new Error("No file selected.");

    // Ownership check — a schema id alone isn't proof this user owns it.
    const schema = await prisma.targetSchema.findFirstOrThrow({
      where: { id: targetSchemaId, userId },
    });

    const { relativePath } = await saveUploadedFile(userId, file);

    const dataset = await prisma.dataset.create({
      data: { userId, name: datasetName, targetSchemaId: schema.id },
    });

    await prisma.uploadedFile.create({
      data: {
        userId,
        filePath: relativePath,
        originalFilename: file.name,
        datasetId: dataset.id,
      },
    });

    revalidatePath("/upload");
  }

  async function runCleaning(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");
    const userId = session.user.id;
    const uploadedFileId = formData.get("uploadedFileId") as string;

    // Ownership-scoped, and pulls everything ai-service needs in one query
    // — TargetSchema.columns, CleaningRules — since ai-service never
    // touches Postgres itself (docs/01-architecture.md).
    const uploadedFile = await prisma.uploadedFile.findFirstOrThrow({
      where: { id: uploadedFileId, userId },
      include: { dataset: { include: { targetSchema: { include: { cleaningRules: true } } } } },
    });
    const dataset = uploadedFile.dataset;
    if (!dataset) throw new Error("Upload has no associated dataset.");

    const targetSchemaColumns = ColumnSchema.array().parse(dataset.targetSchema.columns) as Column[];
    const targetSchemaForApi = targetSchemaColumns.map((c) => ({
      name: c.name,
      type: c.type,
      required: c.required,
      structurallyOptional: c.structurallyOptional,
      description: c.description,
    }));
    const cleaningRulesForApi = dataset.targetSchema.cleaningRules.map((r) => ({
      rule: r.rule,
      description: r.rawDescription,
    }));

    const run = await prisma.cleaningRun.create({
      data: { datasetId: dataset.id, generatedScript: "", status: "FAILED" },
    });

    try {
      const { source_schema } = await inferSchema(uploadedFile.filePath, uploadedFile.originalFilename);

      const result = await executeCleaning({
        sourceSchema: source_schema,
        targetSchema: targetSchemaForApi,
        cleaningRules: cleaningRulesForApi,
        inputRelativePath: uploadedFile.filePath,
        originalFilename: uploadedFile.originalFilename,
        outputRelativeDir: `datasets/${dataset.id}`,
      });

      const contentMarkdown = renderAuditReportMarkdown(dataset.name, {
        report: result.report,
        measured: result.measured,
      });

      const chatSession = await findOrCreateChatSession(userId, dataset.id);

      await prisma.$transaction([
        prisma.cleaningRun.update({
          where: { id: run.id },
          data: { generatedScript: result.code, status: "SUCCESS", sandboxLogs: result.sandbox_logs, finishedAt: new Date() },
        }),
        prisma.auditReport.create({
          data: {
            cleaningRunId: run.id,
            summary: { report: result.report, measured: result.measured },
            contentMarkdown,
          },
        }),
        prisma.dataset.update({
          where: { id: dataset.id },
          data: {
            filePath: result.cleaned_file_relative_path,
            rowCount: result.measured.output_row_count,
            lastCleanedAt: new Date(),
          },
        }),
        prisma.uploadedFile.update({ where: { id: uploadedFile.id }, data: { status: "CLEANED" } }),
        // Renders as the first message per docs/04-ai-cleaning-and-audit.md
        // — "replies in the chat interface with an HTML/Markdown audit
        // report" — the same session is reused on every re-clean, not a
        // fresh one each time.
        prisma.chatMessage.create({
          data: {
            chatSessionId: chatSession.id,
            role: "ASSISTANT",
            content: contentMarkdown,
            messageType: "AUDIT_REPORT",
          },
        }),
      ]);
    } catch (err) {
      const message = err instanceof AiServiceError ? JSON.stringify(err.detail) : String(err);
      await prisma.$transaction([
        prisma.cleaningRun.update({
          where: { id: run.id },
          data: { status: "FAILED", errorMessage: message, finishedAt: new Date() },
        }),
        prisma.uploadedFile.update({ where: { id: uploadedFile.id }, data: { status: "ERROR" } }),
      ]);
    }

    revalidatePath("/upload");
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Upload</h1>
        <p className="text-muted-foreground text-sm">
          Raw files land on disk under storage/uploads/. Cleaning generates a Pandas script via the local LLM and runs it
          in a sandboxed container — see docs/06-security-sandboxing.md.
        </p>
      </div>

      <AppNav current="upload" />

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle>Upload a file</CardTitle>
          {schemas.length === 0 && (
            <CardDescription>
              You need at least one target schema first — create one on the Target Schemas page.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <form action={uploadFile} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="file">File</Label>
              <Input id="file" name="file" type="file" accept=".csv,.xlsx,.xls" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="datasetName">Dataset name</Label>
              <Input id="datasetName" name="datasetName" placeholder="Contacts — Acme HVAC" />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="targetSchemaId">Target schema</Label>
              <Select name="targetSchemaId" required disabled={schemas.length === 0}>
                <SelectTrigger id="targetSchemaId" className="w-full">
                  <SelectValue placeholder="Select a target schema" />
                </SelectTrigger>
                <SelectContent>
                  {schemas.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.entityType}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={schemas.length === 0} className="self-start">
              Upload
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Uploaded files</CardTitle>
        </CardHeader>
        <CardContent>
          {files.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing uploaded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Dataset</TableHead>
                  <TableHead>Target schema</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((f) => {
                  const latestRun = f.dataset?.cleaningRuns[0];
                  return (
                    <TableRow key={f.id}>
                      <TableCell className="text-sm">{f.originalFilename}</TableCell>
                      <TableCell className="text-sm">{f.dataset?.name ?? "—"}</TableCell>
                      <TableCell className="text-sm">{f.dataset?.targetSchema.entityType ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={f.status === "ERROR" ? "destructive" : "secondary"}>
                          {f.status.toLowerCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="flex gap-2">
                        <form action={runCleaning}>
                          <input type="hidden" name="uploadedFileId" value={f.id} />
                          <Button variant="outline" size="sm" type="submit">
                            {latestRun ? "Re-clean" : "Clean"}
                          </Button>
                        </form>
                        {latestRun?.auditReport && (
                          <>
                            <a
                              href={`/datasets/${f.dataset!.id}`}
                              className={buttonVariants({ variant: "ghost", size: "sm" })}
                            >
                              View report
                            </a>
                            <a
                              href={`/datasets/${f.dataset!.id}/chat`}
                              className={buttonVariants({ variant: "ghost", size: "sm" })}
                            >
                              Chat
                            </a>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
