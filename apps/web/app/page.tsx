import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Singleton row per docs/02-data-model.md — the Ollama endpoint is one
  // shared physical server, not a per-user preference.
  const settings = await prisma.settings.upsert({
    where: { id: "singleton" },
    create: {},
    update: {},
  });

  async function updateSettings(formData: FormData) {
    "use server";
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        ollamaBaseUrl: formData.get("ollamaBaseUrl") as string,
        ollamaModel: formData.get("ollamaModel") as string,
      },
    });
    revalidatePath("/");
  }

  async function logout() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Data Cleanup</h1>
          <p className="text-muted-foreground text-sm">Signed in as {session.user.email}</p>
        </div>
        <form action={logout}>
          <Button variant="outline" type="submit">
            Sign out
          </Button>
        </form>
      </div>

      <Separator />

      <Card>
        <CardHeader>
          <CardTitle>Ollama settings</CardTitle>
          <CardDescription>
            Shared across all users — this points at the physical LLM server, not a personal preference.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={updateSettings} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ollamaBaseUrl">Ollama base URL</Label>
              <Input
                id="ollamaBaseUrl"
                name="ollamaBaseUrl"
                defaultValue={settings.ollamaBaseUrl}
                placeholder="http://devin-server:11434"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ollamaModel">Model</Label>
              <Input
                id="ollamaModel"
                name="ollamaModel"
                defaultValue={settings.ollamaModel}
                placeholder="gemma4-e4b-262k:latest"
                required
              />
            </div>
            <Button type="submit" className="self-start">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
