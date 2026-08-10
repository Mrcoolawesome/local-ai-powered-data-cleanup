import { DefaultSession } from "next-auth";

// Augments the default session/JWT shape with the Prisma user id set in
// lib/auth.ts's jwt/session callbacks — every server-side query needs this
// to scope data by user (docs/02-data-model.md's isolation model).
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
  }
}
