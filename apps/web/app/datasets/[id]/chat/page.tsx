import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrCreateChatSession } from "@/lib/chat";
import { renderAuditReportMarkdown } from "@/lib/audit-report";
import { ColumnSchema, type Column } from "@/lib/target-schema";
import {
  classifyIntent,
  chatAudit,
  chatEdit,
  chatQuestion,
  AiServiceError,
  INTENT_EDIT,
  INTENT_AUDIT,
} from "@/lib/ai-service";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const userId = session.user.id;

  const { id } = await params;
  const dataset = await prisma.dataset.findFirst({
    where: { id, userId },
    include: { targetSchema: { include: { cleaningRules: true } } },
  });
  if (!dataset) notFound();

  const chatSession = await findOrCreateChatSession(userId, dataset.id);
  const messages = await prisma.chatMessage.findMany({
    where: { chatSessionId: chatSession.id },
    orderBy: { createdAt: "asc" },
  });

  async function sendMessage(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");
    const userId = session.user.id;
    const message = (formData.get("message") as string)?.trim();
    if (!message) return;

    const dataset = await prisma.dataset.findFirstOrThrow({
      where: { id, userId },
      include: { targetSchema: { include: { cleaningRules: true } } },
    });
    if (!dataset.filePath) throw new Error("Dataset has no cleaned file yet — run Clean first.");

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

    const chatSession = await findOrCreateChatSession(userId, dataset.id);
    await prisma.chatMessage.create({
      data: { chatSessionId: chatSession.id, role: "USER", content: message },
    });

    // Cheap, separate classification call before anything else happens —
    // this is the mechanism that keeps the system from re-auditing on
    // every turn while still recognizing an explicit audit request
    // (docs/04-ai-cleaning-and-audit.md).
    let intent: string;
    try {
      const result = await classifyIntent(message);
      intent = result.intent;
    } catch (err) {
      await prisma.chatMessage.create({
        data: {
          chatSessionId: chatSession.id,
          role: "ASSISTANT",
          content: `I couldn't process that: ${err instanceof AiServiceError ? err.message : String(err)}`,
        },
      });
      revalidatePath(`/datasets/${id}/chat`);
      return;
    }

    if (intent === INTENT_EDIT) {
      try {
        const result = await chatEdit({
          message,
          targetSchema: targetSchemaForApi,
          cleaningRules: cleaningRulesForApi,
          datasetFileRelativePath: dataset.filePath,
          outputRelativeDir: `datasets/${dataset.id}`,
        });

        const contentMarkdown = renderAuditReportMarkdown(dataset.name, {
          report: result.report,
          measured: result.measured,
        });

        const run = await prisma.cleaningRun.create({
          data: {
            datasetId: dataset.id,
            generatedScript: result.code,
            status: "SUCCESS",
            sandboxLogs: result.sandbox_logs,
            finishedAt: new Date(),
          },
        });

        await prisma.$transaction([
          prisma.auditReport.create({
            data: { cleaningRunId: run.id, summary: { report: result.report, measured: result.measured }, contentMarkdown },
          }),
          prisma.dataset.update({
            where: { id: dataset.id },
            data: {
              filePath: result.cleaned_file_relative_path,
              rowCount: result.measured.output_row_count,
              lastCleanedAt: new Date(),
            },
          }),
          prisma.chatMessage.create({
            data: {
              chatSessionId: chatSession.id,
              role: "ASSISTANT",
              content: "Done — applied that change.",
              messageType: "ACTION_CONFIRMATION",
            },
          }),
          prisma.chatMessage.create({
            data: { chatSessionId: chatSession.id, role: "ASSISTANT", content: contentMarkdown, messageType: "AUDIT_REPORT" },
          }),
        ]);
      } catch (err) {
        const detail = err instanceof AiServiceError ? JSON.stringify(err.detail) : String(err);
        await prisma.chatMessage.create({
          data: {
            chatSessionId: chatSession.id,
            role: "ASSISTANT",
            content: `I couldn't apply that change: ${detail}`,
          },
        });
      }
    } else if (intent === INTENT_AUDIT) {
      try {
        const result = await chatAudit({
          datasetFileRelativePath: dataset.filePath,
          targetSchema: targetSchemaForApi,
        });
        const contentMarkdown = renderAuditReportMarkdown(dataset.name, result);
        await prisma.chatMessage.create({
          data: { chatSessionId: chatSession.id, role: "ASSISTANT", content: contentMarkdown, messageType: "AUDIT_REPORT" },
        });
      } catch (err) {
        const detail = err instanceof AiServiceError ? JSON.stringify(err.detail) : String(err);
        await prisma.chatMessage.create({
          data: { chatSessionId: chatSession.id, role: "ASSISTANT", content: `I couldn't run that audit: ${detail}` },
        });
      }
    } else {
      try {
        const result = await chatQuestion({
          message,
          targetSchema: targetSchemaForApi,
          datasetFileRelativePath: dataset.filePath,
        });
        await prisma.chatMessage.create({
          data: { chatSessionId: chatSession.id, role: "ASSISTANT", content: result.reply },
        });
      } catch (err) {
        const detail = err instanceof AiServiceError ? JSON.stringify(err.detail) : String(err);
        await prisma.chatMessage.create({
          data: { chatSessionId: chatSession.id, role: "ASSISTANT", content: `I couldn't answer that: ${detail}` },
        });
      }
    }

    revalidatePath(`/datasets/${id}/chat`);
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 p-6">
      <div>
        <Link href={`/datasets/${dataset.id}`} className="text-muted-foreground text-sm hover:text-foreground">
          &larr; {dataset.name}
        </Link>
        <h1 className="text-2xl font-semibold">Chat</h1>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {messages.length === 0 && (
          <p className="text-muted-foreground text-sm">No messages yet — clean the dataset first to get an audit report here.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "USER" ? "self-end" : "self-start"}>
            {m.messageType === "AUDIT_REPORT" || m.messageType === "ACTION_CONFIRMATION" ? (
              <Card className="max-w-lg">
                <CardContent className="pt-4">
                  {m.messageType === "ACTION_CONFIRMATION" && (
                    <Badge variant="default" className="mb-2">
                      Applied
                    </Badge>
                  )}
                  <pre className="overflow-x-auto whitespace-pre-wrap text-sm">{m.content}</pre>
                </CardContent>
              </Card>
            ) : (
              <div
                className={`max-w-lg rounded-lg px-3 py-2 text-sm ${
                  m.role === "USER" ? "bg-primary text-primary-foreground" : "bg-muted"
                }`}
              >
                {m.content}
              </div>
            )}
          </div>
        ))}
      </div>

      <form action={sendMessage} className="flex gap-2 border-t pt-4">
        <Input name="message" placeholder="Ask a question, request an edit, or say 'audit this'..." required />
        <Button type="submit">Send</Button>
      </form>
    </main>
  );
}
