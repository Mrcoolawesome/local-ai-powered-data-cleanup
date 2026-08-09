# Deployment: Docker Compose on the AI Server

**Decision (added after initial planning):** the whole application — Postgres, the Next.js app, the FastAPI AI orchestration service — runs as a Docker Compose stack on the same server, so it can be started/stopped as one unit (`docker compose up -d` / `docker compose down`). This does **not** include Ollama, which stays a separate, already-running process on the same physical machine (`devin-server`) — it's addressed over the network like any other configured endpoint (see [05-llm-prompting.md](./05-llm-prompting.md)), not managed by this stack.

## Services

```
docker-compose.yml
  ├─ postgres        — official postgres image, named volume for data
  ├─ web             — Next.js app (Prisma client lives here)
  ├─ ai-service       — FastAPI orchestration service
  └─ (zoom-bot        — Phase 6, not part of Phase 1's compose file yet;
       added once the presentation-route + WebSocket pieces exist to share)
```

- **`postgres`** — standard image, a named volume (`postgres-data`) for durability across `docker compose down`/`up` cycles. Not exposed outside the Compose network by default — only `web` needs to reach it.
- **`web`** — the Next.js app. Owns the Prisma client and all Postgres access (per [01-architecture.md](./01-architecture.md)'s "one ORM boundary" decision). Exposed on a host port for browser access.
- **`ai-service`** — the FastAPI service. Talks to `devin-server:11434` (configurable, see below) for Ollama, and to `web`'s internal API for anything it needs from Postgres (it never queries Postgres directly). Not exposed to the host — only `web` calls it, over the Compose-internal network.

## Local file storage

Uploads, scraper output, and attachments live on a bind-mounted host directory (not a named volume) — e.g. `./storage` on the host, mounted into both `web` (for serving/managing files) and `ai-service` (for reading files it cleans and writing sandbox output). A bind mount, not a named volume, because this data needs to survive even a full `docker compose down -v` and be directly inspectable/backuppable from the host without going through Docker.

## The sandbox-orchestration problem: `ai-service` needs to launch sibling containers

This is the one real architectural tension containerizing `ai-service` introduces. [06-security-sandboxing.md](./06-security-sandboxing.md)'s design has `ai-service` launch a fresh Docker container per LLM-directed execution (cleaning script, scraper command) — proven out for real in the [Docker sandbox spike](../spikes/docker-sandbox/README.md). If `ai-service` itself now runs *inside* a container, it needs a way to launch those sibling sandbox containers.

**Chosen approach: Docker-outside-of-Docker (DooD)** — mount the host's Docker socket into `ai-service`:

```yaml
ai-service:
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock
```

`ai-service` then calls the host's own Docker daemon to launch sandbox containers as *siblings* of itself, not nested inside it. This is simpler and lighter than true Docker-in-Docker (which needs a nested daemon and loses the host's layer cache).

**The real tradeoff, stated plainly:** mounting the Docker socket gives `ai-service` the ability to launch arbitrary containers with arbitrary mounts and privileges — which is effectively root-equivalent access to the host. The sandboxing model in `06-security-sandboxing.md` exists specifically to contain a compromised or buggy *generated script*; it does not, by itself, protect against `ai-service` *itself* being compromised (e.g., via a dependency vulnerability in the FastAPI service or its Python packages), since a compromised `ai-service` already has the socket. Mitigations:

- Keep `ai-service`'s own dependency surface small and audited — it's the one component whose compromise bypasses the sandbox model entirely.
- `ai-service` never runs arbitrary Docker CLI commands built from LLM output — it always launches the sandbox with a fixed, code-reviewed command template (the flags proven in the spike: `--network none`, resource limits, `--user`, `--cap-drop=ALL`, mounts scoped to exactly the input/output paths for that one execution). The LLM never gets to influence the container invocation itself, only what runs *inside* it.
- This is a known, standard pattern (widely used by CI systems, PaaS build services, etc.) — not a novel risk, but worth stating explicitly rather than mounting the socket silently.

## Configuration

- `.env` at the repo root (gitignored, `.env.example` committed) holds Compose-level secrets: `POSTGRES_PASSWORD`, `NEXTAUTH_SECRET`, and a *default* `OLLAMA_BASE_URL` that seeds `Settings.ollamaBaseUrl` on first run — the UI-editable setting ([05-llm-prompting.md](./05-llm-prompting.md)) takes over after that, so this default only matters for a fresh install.
- Everything else (target schemas, cleaning rules, registered scrapers) is application data in Postgres, not Compose/environment configuration — it doesn't require a restart to change.

## Starting and stopping

```bash
docker compose up -d      # start (or restart) the whole stack
docker compose down       # stop everything, keep data (named volumes + bind-mounted storage persist)
docker compose down -v    # stop and also wipe Postgres's named volume — deliberately destructive, not the default
```
