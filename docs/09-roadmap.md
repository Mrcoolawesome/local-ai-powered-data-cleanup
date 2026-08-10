# Development Roadmap

Phased so each phase produces something runnable/demoable, and so the highest-risk piece (the Zoom bot) gets de-risked early without blocking the core pipeline — which is the actual point of this tool — from progressing in parallel.

## Phase 0 — Foundations & Spikes (de-risking, no app code depends on these succeeding)

- [x] **Zoom spike, stage 1 (Xvfb + Chromium):** done and passing — see [07-zoom-bot.md](./07-zoom-bot.md) status.
- [x] **Zoom spike, stage 2 (Zoom Linux Meeting SDK join + `StartAppShare`):** fully working, visually confirmed. Bot joined a real, live meeting (`MEETING_STATUS_INMEETING`), `StartAppShare` returned `SDKERR_SUCCESS` after a Zoom sharing-permission fix, and the project owner confirmed seeing the live-updating test page shared in the meeting in real time. **Decision: proceed with the native design, no fallback needed** — see [07-zoom-bot.md](./07-zoom-bot.md) for full results.
- [x] **Docker sandbox spike:** done, 9/9 checks passing — file I/O, network isolation, timeout enforcement, and read-only mounts all verified for real, not just read from flag docs. Found and fixed a real host/container UID mismatch bug. See [06-security-sandboxing.md](./06-security-sandboxing.md) for full results.
- [x] **Ollama connectivity + model check:** done. `gemma4-e4b-262k:latest` confirmed reachable at `devin-server:11434`; a real generation run against a synthetic dirty dataset (schema/samples-only prompt, per the design) produced a cleaning script verified 6/6 rows correct by hand, then executed successfully through the Docker sandbox spike above — the full generate-then-sandbox-execute pipeline works end to end. One real gap found and fixed: the model doesn't reliably follow the strict single-return-value output contract (bundles `report` into a tuple) — the execution harness needs to tolerate that defensively rather than relying on prompt wording alone. See [05-llm-prompting.md](./05-llm-prompting.md) for full results.

**Phase 0 complete.** All four spikes done; every architectural risk flagged during planning is now resolved with real, tested evidence rather than assumption. Ready to start Phase 1.

## Phase 1 — Core Scaffolding

**Status: done, built and verified for real** — not just scaffolded, actually run: `docker compose up -d` from a clean slate, migrations applied automatically, a real user logged in through actual HTTP requests (CSRF → credentials → session cookie → authenticated page), and `ai-service` confirmed reaching the real Ollama server from inside its own container. See [11-deployment.md](./11-deployment.md)'s "Phase 1 status" for the four real issues found and fixed along the way (Tailscale DNS resolution, missing initial migration, missing OpenSSL, Auth.js host trust).

- [x] Next.js app: Tailwind + shadcn/ui installed, base layout.
- [x] NextAuth.js (Auth.js v5) authentication — Credentials provider, JWT sessions, no adapter needed.
- [x] Prisma schema v1 from [02-data-model.md](./02-data-model.md) (`User`, `Settings` — including the UI-editable Ollama endpoint), with a real initial migration committed.
- [x] FastAPI service skeleton with an Ollama client wrapper reading the configurable endpoint — `/health`, `/ollama/health`, `/ollama/chat` all exercised against the live model server.
- [x] **Docker Compose stack** (postgres + migrator + web + ai-service) per [11-deployment.md](./11-deployment.md) — this is the deployment model going forward, not just local dev convenience: the whole app starts/stops as one unit via `docker compose up`/`down`.

## Phase 2 — File Ingestion & Rules Config

**Status: done, verified against the real running stack** — not just built: a script exercising the exact Prisma calls the UI's Server Actions use (create-from-template, add/remove column, add/remove rule, upload + save-to-disk) ran against the live containerized Postgres and bind-mounted storage, and the resulting pages were fetched over real HTTP with an authenticated session cookie to confirm the data actually renders (schema list showing correct column counts, detail page showing the right columns after edits, upload page showing the uploaded file/dataset).

- [x] Manual file upload UI + disk storage pattern + `UploadedFile` records — `lib/storage.ts` writes into the bind-mounted `./storage`, relative paths stored in the DB so both `web` and the future `ai-service` sandbox execution resolve them identically.
- [x] `TargetSchema` + `CleaningRule` UI (create/edit), seeded from the concrete column sets in [10-target-schema-reference.md](./10-target-schema-reference.md) — Contacts/Jobs/Invoices templates to start (Memberships/Pricebook/Estimates deferred until there's a real use case exercising them, not built speculatively).
- [x] Required-vs-structurally-expected-empty distinction on `TargetSchema.columns` (see that doc's Design implication) — two independent boolean flags (`required`, `structurallyOptional`), not one tri-state, so the Phase 3 audit report doesn't drown real gaps (e.g. `customer_phone`) in expected sparsity (e.g. `unit`).
- [x] Prisma models for `TargetSchema`, `CleaningRule`, `UploadedFile`, `Dataset`, all per-user scoped per [02-data-model.md](./02-data-model.md)'s isolation model — every query checks `userId`, including a re-check before any child-row write (a schema/dataset id alone is never treated as proof of ownership).
- **Found and fixed:** the same host/container UID-mismatch class of bug as `spikes/docker-sandbox` — `web`/`ai-service` now run as `${APP_UID:-1000}:${APP_GID:-1000}` instead of root, so uploaded files land owned by the deploying user, not root. See [11-deployment.md](./11-deployment.md)'s "Container user" section.

## Phase 3 — AI Cleaning Engine

**Status: done, run for real against the live compose stack** — a verification script mirroring the exact Server Action logic ran the full chain (Next.js → ai-service `/schema/infer` → `/clean/execute` → real Ollama → real Docker sandbox → Prisma persistence) against a real file, and the resulting `CleaningRun`/`AuditReport`/`Dataset` rows and cleaned CSV on disk were all verified correct.

- [x] FastAPI `/clean/generate` + `/clean/execute` endpoints implementing the script-generation prompt from [05-llm-prompting.md](./05-llm-prompting.md). **Real finding that changed the design:** two independent live generations broke trying to satisfy the original contract's `report` output (a tuple return, then an actual Python `SyntaxError` from misusing `global`) — dropped the `report` requirement from the model entirely; the harness now computes it from `TargetSchema`'s `required`/`structurallyOptional` flags instead. See [05-llm-prompting.md](./05-llm-prompting.md)'s "Verification, not blind trust."
- [x] Docker sandbox executor (productionizing the Phase 0 spike) — `ai-service` launches sandbox containers as siblings of itself via the mounted host Docker socket (Docker-outside-of-Docker). **Three more real bugs found and fixed:**
  - Embedding `TargetSchema` into the harness via `json.dumps()` produced JSON literals (`true`/`false`) inside what needs to be **Python** source — `repr()` instead.
  - The Phase 0 spike's shell-script timeout (`timeout --signal=KILL` wrapping `docker run`) killed the CLI *client* but left the container itself running — found two containers still alive 12 hours after their spike test run. The SDK-based executor here calls `container.kill()` directly via the Docker API, confirmed (by deliberately forcing a timeout) to leave no orphaned container.
  - `ai-service` running as non-root (Phase 2's UID fix) couldn't reach the Docker socket (`root:docker`, mode 660) — added it to the host's `docker` group via Compose's `group_add`, configurable as `DOCKER_GID` since that GID varies by machine.
- [x] Audit report generation (templated from sandbox execution stats, not a second free-form LLM call) per [04-ai-cleaning-and-audit.md](./04-ai-cleaning-and-audit.md). **One more real bug, found via end-to-end testing with the full Contacts template against a narrower source file:** a required target column the model didn't produce *at all* was recorded in `unmapped_fields` but skipped by a `continue` before the required-field check ran — the report claimed "no required fields missing" while one was, in fact, entirely missing. Fixed to treat "absent" the same as "present but 100% null" for severity scoring.
- [x] `CleaningRun` + `AuditReport` persistence, plus a real observed model failure (forgot `import re` despite using `re.sub`) that validated the error path: the sandbox error and full generated code both correctly surfaced to the UI for review rather than a silent/opaque failure.

## Phase 4 — Human-in-the-Loop Chat

**Status: done, verified live** — a script exercising the exact `sendMessage` Server Action logic ran three real chat turns (question, edit, audit) against the live stack, each correctly classified and routed, with the edit verified by reading the actual output file (`ALICE NGUYEN` really was uppercased) and the audit correctly re-flagging gaps against a deliberately mismatched schema.

- [x] Chat UI (`ChatSession`/`ChatMessage`), rendering the initial audit report as the first message — one session per `Dataset` (find-or-create), so re-cleans and on-demand audits append to the same conversation rather than starting fresh each time.
- [x] Intent-classification step (edit vs. audit vs. question) per [04-ai-cleaning-and-audit.md](./04-ai-cleaning-and-audit.md) — a small, separate, temperature-0 call. Correctly classified all three real test messages on the first try, including the spec's own example phrasing ("Audit the Contacts sheet").
- [x] Edit path wired for iterative edits, routed through the identical sandbox as Phase 3's initial clean — no separate "trusted" code path, per docs/04. Verified with a real request ("Make every full_name value uppercase") that changed only what was asked and nothing else.
- [x] On-demand full-audit trigger — recomputes the report directly from `TargetSchema` against the dataset's current file, no LLM call and no sandbox execution needed, since the report is a deterministic function of (current data, schema). **Real design decision:** the report-scoring logic (`compute_report`) now lives in exactly one place (`apps/ai-service/app/report.py`) and is embedded into the sandbox harness via `inspect.getsource()` rather than duplicated — the subtle required-field-scoring bug found in Phase 3 lived in this exact logic once already, so keeping two copies in sync by hand was a real, known risk, not a hypothetical one.
- [x] Question-answering path, answering only from aggregate stats (row/null counts, low-cardinality value counts) — never raw rows, per [05-llm-prompting.md](./05-llm-prompting.md). Verified: asked "how many rows are missing an email" against a 3-row test set, got the correct answer (1) derived purely from aggregates.

## Phase 5 — Scraper Agent — DONE (mechanics proven; real platforms not yet run)

- `ScraperDefinition` registration — done, `/scrapers` UI, tested against the real House Call Pro examples' READMEs for discovery/registration and end-to-end (browser → DB) against a safe synthetic fixture for the full plan-and-run flow.
- README-reading command-planning agent per [05-llm-prompting.md](./05-llm-prompting.md)'s scraper-planning prompt — done, verified against both real HCP READMEs (Python/Playwright and Node variants, each correctly picked up).
- Sandbox-execute scraper runs (credentials mounted, not exposed to the model) — done, `docker-py`-based executor, real permission bug found and root-caused during testing (`docs/06-security-sandboxing.md`).
- Output-structure-aware ingestion into `UploadedFile`/`Attachment` — done, extension-based routing (spreadsheet → `UploadedFile`, media → `Attachment`); job/customer id extraction from Attachment paths deliberately left as a v1 gap (`docs/03-ingestion-and-scrapers.md`).
- Extend to the remaining ~5 scraper platforms once the pattern is proven on House Call Pro — not started; deliberately not running any real scraper against live credentials without explicit user go-ahead first, independent of the mechanics being proven end-to-end.

## Phase 6 — Zoom Presentation Bot

- Only starts once Phase 0's Zoom spike has a validated approach (native or fallback).
- `/present/[sessionId]` route.
- Zoom Bot Service productionized from the spike.

## Phase 7 — Raspberry Pi Controller

- WebSocket server for `PresentationSession` control ([08-raspberry-pi-controller.md](./08-raspberry-pi-controller.md)).
- Minimal Pi-side React kiosk UI.
- End-to-end test: Pi button press → visible change in an actual Zoom share.

## Phase 8 — Hardening & Polish

- Multi-tenancy audit: verify every query path is scoped by `userId`.
- Security pass on sandbox configuration and credential handling against [06-security-sandboxing.md](./06-security-sandboxing.md)'s threat model.
- `AuditLog` completeness check — confirm every mutating action across every subsystem actually writes a log entry.
- UI polish.

## What's explicitly deferred past v1

- Team/shared workspaces (see [02-data-model.md](./02-data-model.md) isolation model).
- Auto-ingestion for scraper categories that only deliver via emailed export.
- Scheduled/unattended scraper triggering (v1 is user-invoked only).
