import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AppNav } from "@/components/app-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export default async function PresentationsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const sessions = await prisma.presentationSession.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: { activeDataset: true },
  });

  async function createSession() {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const created = await prisma.presentationSession.create({
      data: { userId: session.user.id },
    });
    await prisma.auditLog.create({
      data: {
        userId: session.user.id,
        action: "presentation_session.create",
        entityType: "PresentationSession",
        entityId: created.id,
      },
    });
    revalidatePath("/presentations");
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Presentations</h1>
        <p className="text-muted-foreground text-sm">
          What&apos;s live for the Zoom bot + Pi controller — see docs/07-zoom-bot.md. The Pi controller itself is
          Phase 7; this is the minimal control surface Phase 6 needed to prove `/present/[id]` for real.
        </p>
      </div>

      <AppNav current="presentations" />

      <Separator />

      <form action={createSession}>
        <Button type="submit">New presentation session</Button>
      </form>

      <div className="flex flex-col gap-3">
        {sessions.length === 0 && <p className="text-muted-foreground text-sm">None yet.</p>}
        {sessions.map((s) => (
          <Link key={s.id} href={`/presentations/${s.id}`}>
            <Card className="transition-colors hover:bg-muted/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  {s.id}
                  <Badge variant={s.status === "SHARING" ? "default" : s.status === "ERROR" ? "destructive" : "secondary"}>
                    {s.status.toLowerCase()}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {s.activeViewKind ? `${s.activeViewKind.toLowerCase()}${s.activeDataset ? `: ${s.activeDataset.name}` : ""}` : "no active view"}
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
