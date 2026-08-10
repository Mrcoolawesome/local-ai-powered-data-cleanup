import Link from "next/link";

export function AppNav({ current }: { current: "home" | "schemas" | "upload" }) {
  const linkClass = (key: string) =>
    key === current
      ? "text-foreground font-medium"
      : "text-muted-foreground hover:text-foreground";

  return (
    <nav className="flex items-center gap-4 text-sm">
      <Link href="/" className={linkClass("home")}>
        Home
      </Link>
      <Link href="/schemas" className={linkClass("schemas")}>
        Target Schemas
      </Link>
      <Link href="/upload" className={linkClass("upload")}>
        Upload
      </Link>
    </nav>
  );
}
