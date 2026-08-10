import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export const { handlers, auth, signIn, signOut } = NextAuth({
  // JWT sessions, not database sessions — there's no PrismaAdapter here.
  // Adapters exist for OAuth account linking and DB-backed sessions;
  // neither applies to a Credentials-only internal tool, and NextAuth's
  // Credentials provider doesn't support adapter-backed sign-in anyway.
  session: { strategy: "jwt" },
  // Auth.js refuses requests whose Host header it doesn't recognize
  // (UntrustedHost) unless told to trust it — a real check hit while
  // testing this behind Docker Compose's plain port mapping, not a
  // hypothetical. Appropriate here: this is entirely self-hosted behind
  // infrastructure the deploying user controls (docs/11-deployment.md),
  // not a multi-tenant platform where a spoofed Host header could route
  // to someone else's deployment.
  trustHost: true,
  pages: {
    signIn: "/login",
  },
  providers: [
    Credentials({
      credentials: {
        email: {},
        password: {},
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return null;

        const passwordMatches = await bcrypt.compare(password, user.passwordHash);
        if (!passwordMatches) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    // Carry the Prisma user id onto the JWT/session so server code can
    // scope every query by it (docs/02-data-model.md's per-user isolation
    // model) without a second DB lookup on every request.
    async jwt({ token, user }) {
      if (user) token.id = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = token.id as string;
      return session;
    },
  },
});
