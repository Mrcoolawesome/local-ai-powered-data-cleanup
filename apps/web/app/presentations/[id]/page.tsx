import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default async function PresentationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { id } = await params;
  const presentationSession = await prisma.presentationSession.findFirst({
    where: { id, userId: session.user.id },
    include: { activeDataset: true, activeScraperRun: { include: { scraperDefinition: true } } },
  });
  if (!presentationSession) notFound();

  const [datasets, scraperRuns] = await Promise.all([
    prisma.dataset.findMany({ where: { userId: session.user.id }, orderBy: { createdAt: "desc" } }),
    prisma.scraperRun.findMany({
      where: { scraperDefinition: { userId: session.user.id } },
      orderBy: { startedAt: "desc" },
      include: { scraperDefinition: true },
    }),
  ]);

  async function showDataset(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");
    const datasetId = formData.get("datasetId") as string;

    await prisma.presentationSession.update({
      where: { id },
      data: { activeViewKind: "DATASET", activeDatasetId: datasetId, activeScraperRunId: null },
    });
    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: "presentation_session.show_view",
        entityType: "PresentationSession",
        entityId: id,
        metadata: { kind: "DATASET", datasetId },
      },
    });
    revalidatePath(`/presentations/${id}`);
  }

  async function showAttachments(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");
    const scraperRunId = formData.get("scraperRunId") as string;

    await prisma.presentationSession.update({
      where: { id },
      data: { activeViewKind: "ATTACHMENTS", activeScraperRunId: scraperRunId, activeDatasetId: null },
    });
    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: "presentation_session.show_view",
        entityType: "PresentationSession",
        entityId: id,
        metadata: { kind: "ATTACHMENTS", scraperRunId },
      },
    });
    revalidatePath(`/presentations/${id}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/presentations" className="text-muted-foreground text-sm hover:text-foreground">
          &larr; Presentations
        </Link>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          {presentationSession.id}
          <Badge variant={presentationSession.status === "SHARING" ? "default" : "secondary"}>
            {presentationSession.status.toLowerCase()}
          </Badge>
        </h1>
        <p className="text-muted-foreground text-sm">
          <Link href={`/present/${presentationSession.id}`} target="_blank" className="underline">
            Open the presentation route
          </Link>{" "}
          (what the Zoom bot loads — reload to see a new view, until Phase 7&apos;s WebSocket layer lands)
        </p>
      </div>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle>Show a dataset</CardTitle>
          <CardDescription>Points the presentation route at a cleaned Dataset table.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={showDataset} className="flex items-end gap-3">
            <Select name="datasetId" defaultValue={datasets[0]?.id}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a dataset" />
              </SelectTrigger>
              <SelectContent>
                {datasets.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={datasets.length === 0}>
              Show
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Show attachments</CardTitle>
          <CardDescription>Points the presentation route at one scraper run&apos;s attachments.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={showAttachments} className="flex items-end gap-3">
            <Select name="scraperRunId" defaultValue={scraperRuns[0]?.id}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a run" />
              </SelectTrigger>
              <SelectContent>
                {scraperRuns.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.scraperDefinition.platformName} · {r.startedAt.toLocaleString()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" disabled={scraperRuns.length === 0}>
              Show
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
