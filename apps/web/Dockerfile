FROM node:22-slim AS base
# node:22-slim has no openssl — Prisma's engine can't detect libssl/openssl
# without it and falls back to a guessed version (a real warning hit while
# testing this Dockerfile against a live Postgres, not a hypothetical).
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL isn't needed for `next build` itself (no page in this app
# queries the DB at build time — see docs/09-roadmap.md Phase 1 note on
# auth() making / and /login dynamic), but `prisma generate` still wants
# something parseable in the env, and prisma.config.ts loads dotenv.
RUN echo "DATABASE_URL=postgresql://placeholder:placeholder@placeholder:5432/placeholder" > .env
RUN pnpm exec prisma generate
RUN pnpm build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
