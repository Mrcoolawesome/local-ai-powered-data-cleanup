import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ColumnSchema, type Column } from "@/lib/target-schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function SchemaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { id } = await params;
  const schema = await prisma.targetSchema.findFirst({
    // scope by userId, not just id — a user must never be able to view
    // another user's schema just by guessing/incrementing the id.
    where: { id, userId: session.user.id },
    include: { cleaningRules: { orderBy: { createdAt: "asc" } } },
  });
  if (!schema) notFound();

  const columns = ColumnSchema.array().parse(schema.columns);

  async function addColumn(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    const newColumn = ColumnSchema.parse({
      name: formData.get("name"),
      type: formData.get("type") || "string",
      required: formData.get("required") === "on",
      structurallyOptional: formData.get("structurallyOptional") === "on",
      description: formData.get("description") || "",
    });

    const current = await prisma.targetSchema.findFirstOrThrow({
      where: { id, userId: session.user.id },
    });
    const currentColumns = ColumnSchema.array().parse(current.columns);
    if (currentColumns.some((c) => c.name === newColumn.name)) {
      throw new Error(`Column "${newColumn.name}" already exists.`);
    }

    await prisma.targetSchema.update({
      where: { id },
      data: { columns: [...currentColumns, newColumn] },
    });
    revalidatePath(`/schemas/${id}`);
  }

  async function removeColumn(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");
    const columnName = formData.get("columnName") as string;

    const current = await prisma.targetSchema.findFirstOrThrow({
      where: { id, userId: session.user.id },
    });
    const currentColumns = ColumnSchema.array().parse(current.columns);

    await prisma.targetSchema.update({
      where: { id },
      data: { columns: currentColumns.filter((c) => c.name !== columnName) },
    });
    revalidatePath(`/schemas/${id}`);
  }

  async function addRule(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");

    // Re-check ownership before writing a child row — a schema id alone
    // isn't proof of ownership.
    await prisma.targetSchema.findFirstOrThrow({ where: { id, userId: session.user.id } });

    await prisma.cleaningRule.create({
      data: {
        targetSchemaId: id,
        rule: formData.get("rule") as string,
        rawDescription: formData.get("rawDescription") as string,
      },
    });
    revalidatePath(`/schemas/${id}`);
  }

  async function removeRule(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user) redirect("/login");
    const ruleId = formData.get("ruleId") as string;

    await prisma.cleaningRule.deleteMany({
      where: { id: ruleId, targetSchema: { userId: session.user.id } },
    });
    revalidatePath(`/schemas/${id}`);
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <Link href="/schemas" className="text-muted-foreground text-sm hover:text-foreground">
          &larr; Target Schemas
        </Link>
        <h1 className="text-2xl font-semibold">{schema.entityType}</h1>
        <p className="text-muted-foreground text-sm">Version {schema.version}</p>
      </div>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle>Columns</CardTitle>
          <CardDescription>
            Required columns block a row from being considered clean if missing. Structurally-optional columns are
            expected to be empty on many rows and won&apos;t be flagged for that alone — see docs/10-target-schema-reference.md.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Flags</TableHead>
                <TableHead>Description</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {columns.map((column: Column) => (
                <TableRow key={column.name}>
                  <TableCell className="font-mono text-xs">{column.name}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{column.type}</TableCell>
                  <TableCell className="flex gap-1">
                    {column.required && <Badge variant="default">required</Badge>}
                    {column.structurallyOptional && <Badge variant="secondary">structurally optional</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{column.description}</TableCell>
                  <TableCell>
                    <form action={removeColumn}>
                      <input type="hidden" name="columnName" value={column.name} />
                      <Button variant="ghost" size="sm" type="submit">
                        Remove
                      </Button>
                    </form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <form action={addColumn} className="flex flex-col gap-3 rounded-lg border p-4">
            <p className="text-sm font-medium">Add column</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" name="name" required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="type">Type</Label>
                <Input id="type" name="type" defaultValue="string" required />
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="description">Description</Label>
              <Input id="description" name="description" />
            </div>
            <div className="flex gap-6">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="required" />
                Required
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox name="structurallyOptional" />
                Structurally optional
              </label>
            </div>
            <Button type="submit" className="self-start">
              Add column
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cleaning rules</CardTitle>
          <CardDescription>
            Non-negotiable rules the cleaning script must follow exactly — see docs/03-ingestion-and-scrapers.md.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {schema.cleaningRules.length === 0 && (
            <p className="text-muted-foreground text-sm">No rules yet.</p>
          )}
          {schema.cleaningRules.map((rule) => (
            <div key={rule.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div>
                <p className="font-mono text-xs text-muted-foreground">{rule.rule}</p>
                <p className="text-sm">{rule.rawDescription}</p>
              </div>
              <form action={removeRule}>
                <input type="hidden" name="ruleId" value={rule.id} />
                <Button variant="ghost" size="sm" type="submit">
                  Remove
                </Button>
              </form>
            </div>
          ))}

          <form action={addRule} className="flex flex-col gap-3 rounded-lg border p-4">
            <p className="text-sm font-medium">Add rule</p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rule">Rule slug</Label>
              <Input id="rule" name="rule" placeholder="combine_phone" required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="rawDescription">Description</Label>
              <Input
                id="rawDescription"
                name="rawDescription"
                placeholder="Mobile and Landline columns must combine into a single 'Phone' column."
                required
              />
            </div>
            <Button type="submit" className="self-start">
              Add rule
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
