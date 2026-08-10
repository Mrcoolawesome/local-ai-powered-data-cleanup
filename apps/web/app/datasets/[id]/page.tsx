import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export default async function DatasetPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { id } = await params;
  const dataset = await prisma.dataset.findFirst({
    where: { id, userId: session.user.id },
    include: {
      targetSchema: true,
      cleaningRuns: { orderBy: { startedAt: "desc" }, include: { auditReport: true } },
    },
  });
  if (!dataset) notFound();

  const latestRun = dataset.cleaningRuns[0];

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/upload" className="text-muted-foreground text-sm hover:text-foreground">
          &larr; Upload
        </Link>
        <h1 className="text-2xl font-semibold">{dataset.name}</h1>
        <p className="text-muted-foreground text-sm">
          Target schema: {dataset.targetSchema.entityType} · {dataset.rowCount ?? "—"} rows
        </p>
      </div>

      <Separator />

      {!latestRun ? (
        <p className="text-muted-foreground text-sm">No cleaning run yet.</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Badge variant={latestRun.status === "SUCCESS" ? "default" : "destructive"}>
              {latestRun.status.toLowerCase()}
            </Badge>
            <span className="text-muted-foreground text-xs">
              {latestRun.startedAt.toLocaleString()}
            </span>
          </div>

          {latestRun.status === "FAILED" && (
            <Card>
              <CardHeader>
                <CardTitle>Run failed</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-destructive">
                  {latestRun.errorMessage}
                </pre>
              </CardContent>
            </Card>
          )}

          {latestRun.auditReport && (
            <Card>
              <CardHeader>
                <CardTitle>Audit report</CardTitle>
                <CardDescription>
                  Templated from the sandbox&apos;s measured output, not a second LLM call — see docs/04-ai-cleaning-and-audit.md.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="overflow-x-auto whitespace-pre-wrap text-sm">{latestRun.auditReport.contentMarkdown}</pre>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Generated script</CardTitle>
              <CardDescription>What actually ran, for review — not executed anywhere except the sandbox.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                {latestRun.generatedScript || "(none — generation failed before producing code)"}
              </pre>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
