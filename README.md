# local-ai-powered-data-cleanup

Internal, multi-user tool to audit, clean, and present customer spreadsheet data using a local LLM, with a live Zoom presentation bot and Raspberry Pi remote control. See [`/docs`](./docs/00-overview.md) for the full architecture and [`/docs/09-roadmap.md`](./docs/09-roadmap.md) for build status.

## Running it

The whole app is a Docker Compose stack — Postgres, the Next.js app, and the FastAPI AI service start and stop as one unit. Ollama is **not** part of this stack; it runs separately on `devin-server` and is reached over the network (see [`docs/11-deployment.md`](./docs/11-deployment.md)).

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, AUTH_SECRET (openssl rand -base64 33),
# and DEVIN_SERVER_TAILSCALE_IP (see the comment in .env.example for how to find it)

docker compose up -d
```

First run only — create your login (there's no public signup):

```bash
docker compose run --rm -e SEED_USER_EMAIL=you@example.com -e SEED_USER_PASSWORD=... migrator pnpm exec prisma db seed
```

Then open `http://localhost:3000`.

```bash
docker compose down       # stop everything, keep data
docker compose down -v    # stop and also wipe the Postgres volume (destructive)
```

## Project layout

```
apps/
  web/          Next.js app (UI, auth, Prisma/Postgres access)
  ai-service/   FastAPI service (LangChain/PandasAI, Ollama, sandboxed execution)
docs/           Architecture, data model, and phased roadmap — read this first
spikes/         Standalone proofs-of-concept for the highest-risk pieces (Zoom SDK, Docker sandboxing, LLM prompting)
example-scrapers/, example-data/   Reference material (gitignored where it holds real credentials/customer data)
```
