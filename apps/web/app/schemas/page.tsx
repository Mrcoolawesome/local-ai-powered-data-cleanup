import { redirect } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { TARGET_SCHEMA_TEMPLATES, type Column } from "@/lib/target-schema";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default async function SchemasPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const schemas = await prisma.targetSchema.findMany({
    // Per-user isolation (docs/00-overview.md) — every query in this app
    // must scope by the signed-in user's id.
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { cleaningRules: true, datasets: true } } },
  });

  async function createFromTemplate(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const templateKey = formData.get("template") as string;
    const columns: Column[] = TARGET_SCHEMA_TEMPLATES[templateKey];
    if (!columns) throw new Error(`Unknown template: ${templateKey}`);

    await prisma.targetSchema.create({
      data: {
        userId: session.user.id,
        entityType: templateKey,
        columns,
      },
    });
    revalidatePath("/schemas");
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Target Schemas</h1>
        <p className="text-muted-foreground text-sm">
          The shape raw data gets cleaned into — see docs/10-target-schema-reference.md for where these templates came from.
        </p>
      </div>

      <AppNav current="schemas" />

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle>Create from template</CardTitle>
          <CardDescription>Starts from a real column set — edit columns and add rules after creating.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createFromTemplate} className="flex items-end gap-3">
            <div className="flex flex-1 flex-col gap-2">
              <Label htmlFor="template">Template</Label>
              <Select name="template" defaultValue={Object.keys(TARGET_SCHEMA_TEMPLATES)[0]}>
                <SelectTrigger id="template" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(TARGET_SCHEMA_TEMPLATES).map((key) => (
                    <SelectItem key={key} value={key}>
                      {key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit">Create</Button>
          </form>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {schemas.length === 0 && (
          <p className="text-muted-foreground text-sm">No target schemas yet — create one above.</p>
        )}
        {schemas.map((schema) => (
          <Link key={schema.id} href={`/schemas/${schema.id}`}>
            <Card className="transition-colors hover:bg-muted/50">
              <CardHeader>
                <CardTitle>{schema.entityType}</CardTitle>
                <CardDescription>
                  {(schema.columns as unknown as Column[]).length} columns · {schema._count.cleaningRules} rules ·{" "}
                  {schema._count.datasets} datasets
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </main>
  );
}
