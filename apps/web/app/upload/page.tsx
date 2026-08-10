import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { saveUploadedFile } from "@/lib/storage";
import { AppNav } from "@/components/app-nav";
import { Button } from "@/components/ui/button";
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
      include: { dataset: { include: { targetSchema: true } } },
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

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Upload</h1>
        <p className="text-muted-foreground text-sm">
          Raw files land on disk under storage/uploads/ and become an UploadedFile + Dataset — cleaning happens in a later phase.
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="text-sm">{f.originalFilename}</TableCell>
                    <TableCell className="text-sm">{f.dataset?.name ?? "—"}</TableCell>
                    <TableCell className="text-sm">{f.dataset?.targetSchema.entityType ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{f.status.toLowerCase()}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
