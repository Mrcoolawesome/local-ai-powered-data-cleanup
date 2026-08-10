# Deployment: Docker Compose on the AI Server

**Decision (added after initial planning):** the whole application — Postgres, the Next.js app, the FastAPI AI orchestration service — runs as a Docker Compose stack on the same server, so it can be started/stopped as one unit (`docker compose up -d` / `docker compose down`). This does **not** include Ollama, which stays a separate, already-running process on the same physical machine (`devin-server`) — it's addressed over the network like any other configured endpoint (see [05-llm-prompting.md](./05-llm-prompting.md)), not managed by this stack.

## Services

```
docker-compose.yml
  ├─ postgres        — official postgres image, named volume for data
  ├─ migrator         — runs `prisma migrate deploy` once, exits (see below)
  ├─ web             — Next.js app (Prisma client lives here)
  ├─ ai-service       — FastAPI orchestration service
  └─ (zoom-bot        — Phase 6, not part of Phase 1's compose file yet;
       added once the presentation-route + WebSocket pieces exist to share)
```

- **`postgres`** — standard image, a named volume (`postgres-data`) for durability across `docker compose down`/`up` cycles. Not exposed outside the Compose network by default — only `web`/`migrator` need to reach it.
- **`migrator`** — built from the same Dockerfile as `web` but stopped at its `builder` stage (full `node_modules` + Prisma CLI + the `prisma/` folder), so it can run `prisma migrate deploy` before `web` starts. `web`'s own image is the trimmed Next.js `output: "standalone"` runtime and deliberately does **not** carry the Prisma CLI or migration files — keeping migrations in a separate one-shot service avoids bloating the thing that's actually running 24/7. `web` waits on `migrator` finishing successfully (`depends_on: condition: service_completed_successfully`).
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

- `.env` at the repo root (gitignored, `.env.example` committed) holds Compose-level secrets: `POSTGRES_PASSWORD`, `AUTH_SECRET`, and a *default* `DEFAULT_OLLAMA_BASE_URL` that seeds `Settings.ollamaBaseUrl` on first run — the UI-editable setting ([05-llm-prompting.md](./05-llm-prompting.md)) takes over after that, so this default only matters for a fresh install.
- Everything else (target schemas, cleaning rules, registered scrapers) is application data in Postgres, not Compose/environment configuration — it doesn't require a restart to change.
- There's no public signup flow (internal, admin-provisioned accounts). Create/update the first login after `docker compose up -d` with:
  ```bash
  docker compose run --rm -e SEED_USER_EMAIL=you@example.com -e SEED_USER_PASSWORD=... migrator pnpm exec prisma db seed
  ```
  Deliberately not run automatically on every boot — `seed.ts` upserts by email, so an unattended rerun on every restart would silently overwrite a password changed through some future in-app flow with whatever's still sitting in `.env`.

## Container user

`web` and `ai-service` run as `${APP_UID:-1000}:${APP_GID:-1000}`, not root — found necessary while testing Phase 2's file upload: a root container writing into the bind-mounted `./storage` produces root-owned files the deploying host user can't delete or modify without `sudo`, which defeats the entire point of using a bind mount ("directly inspectable/backuppable from the host," see above). Set `APP_UID`/`APP_GID` in `.env` if the deploying user's `id -u`/`id -g` isn't 1000. This is the same host/container UID-mismatch class of bug already found once in `spikes/docker-sandbox` — worth remembering as a pattern, not just a one-off fix, anywhere else a container writes into a bind mount.

## Starting and stopping

```bash
docker compose up -d      # start (or restart) the whole stack
docker compose down       # stop everything, keep data (named volumes + bind-mounted storage persist)
docker compose down -v    # stop and also wipe Postgres's named volume — deliberately destructive, not the default
```

## Phase 1 status — built and run for real, not just written

The stack above isn't a paper design — it was actually built and brought up end to end (`docker compose build && docker compose up -d`) against a fresh database, and the full login flow was exercised through real HTTP requests (CSRF token → credentials sign-in → session cookie → authenticated page load showing the correct `Settings` values). Four real issues surfaced along the way, none hypothetical:

1. **`devin-server` doesn't resolve inside a container.** It's a Tailscale MagicDNS hostname (`devin-server.tail41e05b.ts.net`), not a plain LAN name. Docker's embedded per-container DNS resolver can't reach it — confirmed both the plain default resolver and explicitly pointing the container at Tailscale's own resolver (`100.100.100.100`) fail or are flaky. What **does** work reliably (tested 3/3): the container reaching the Tailscale IP directly, since outbound traffic routes through the host, which is itself on the tailnet. Fix: `ai-service` gets a static `extra_hosts: ["devin-server:${DEVIN_SERVER_TAILSCALE_IP}"]` mapping instead of depending on DNS forwarding. If that IP ever changes, either update `.env` and restart, or just point `Settings.ollamaBaseUrl` at the new IP directly in the UI — no redeploy required either way, which is exactly the portability the UI-editable-endpoint decision was for.
2. **No migration existed yet.** `prisma generate` (build-time) and `prisma migrate deploy` (the `migrator` service) are different things — `generate` only builds the client from whatever schema is present, `migrate deploy` only *applies* migration files that already exist. The initial migration had to be created once against the real containerized Postgres (`docker compose run --rm --volume "$(pwd)/apps/web/prisma:/app/prisma" migrator pnpm exec prisma migrate dev --name init`, bind-mounting so the generated SQL lands back on the host to commit) before `migrate deploy` had anything to apply.
3. **`node:22-slim` has no OpenSSL**, which Prisma's engine wants to detect libssl against — silently degrades to a guessed version rather than failing outright, which is worse than an error. Fixed by installing `openssl` in the Dockerfile's `base` stage.
4. **Auth.js refused every request with `UntrustedHost`.** A real security check (prevents Host-header spoofing from routing to the wrong deployment), appropriate to disable here (`trustHost: true` in `lib/auth.ts`) *because* this is self-hosted behind infrastructure the deploying user fully controls — not a multi-tenant platform where that check matters.
