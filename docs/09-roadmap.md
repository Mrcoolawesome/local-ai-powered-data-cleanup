# Development Roadmap

Phased so each phase produces something runnable/demoable, and so the highest-risk piece (the Zoom bot) gets de-risked early without blocking the core pipeline — which is the actual point of this tool — from progressing in parallel.

## Phase 0 — Foundations & Spikes (de-risking, no app code depends on these succeeding)

- [x] **Zoom spike, stage 1 (Xvfb + Chromium):** done and passing — see [07-zoom-bot.md](./07-zoom-bot.md) status.
- [x] **Zoom spike, stage 2 (Zoom Linux Meeting SDK join + `StartAppShare`):** fully working, visually confirmed. Bot joined a real, live meeting (`MEETING_STATUS_INMEETING`), `StartAppShare` returned `SDKERR_SUCCESS` after a Zoom sharing-permission fix, and the project owner confirmed seeing the live-updating test page shared in the meeting in real time. **Decision: proceed with the native design, no fallback needed** — see [07-zoom-bot.md](./07-zoom-bot.md) for full results.
- [x] **Docker sandbox spike:** done, 9/9 checks passing — file I/O, network isolation, timeout enforcement, and read-only mounts all verified for real, not just read from flag docs. Found and fixed a real host/container UID mismatch bug. See [06-security-sandboxing.md](./06-security-sandboxing.md) for full results.
- [x] **Ollama connectivity + model check:** done. `gemma4-e4b-262k:latest` confirmed reachable at `devin-server:11434`; a real generation run against a synthetic dirty dataset (schema/samples-only prompt, per the design) produced a cleaning script verified 6/6 rows correct by hand, then executed successfully through the Docker sandbox spike above — the full generate-then-sandbox-execute pipeline works end to end. One real gap found and fixed: the model doesn't reliably follow the strict single-return-value output contract (bundles `report` into a tuple) — the execution harness needs to tolerate that defensively rather than relying on prompt wording alone. See [05-llm-prompting.md](./05-llm-prompting.md) for full results.

**Phase 0 complete.** All four spikes done; every architectural risk flagged during planning is now resolved with real, tested evidence rather than assumption. Ready to start Phase 1.

## Phase 1 — Core Scaffolding

- Next.js app: Tailwind + shadcn/ui installed, base layout.
- NextAuth.js authentication.
- Prisma schema v1 from [02-data-model.md](./02-data-model.md) (start with `User`, `Settings` — including the UI-editable Ollama endpoint).
- FastAPI service skeleton with an Ollama client wrapper reading the configurable endpoint.
- Local dev environment wiring (Postgres, the two services) so a fresh clone can get running quickly.

## Phase 2 — File Ingestion & Rules Config

- Manual file upload UI + disk storage pattern + `UploadedFile` records.
- `TargetSchema` + `CleaningRule` UI (create/edit), seeded from the concrete column sets in [10-target-schema-reference.md](./10-target-schema-reference.md).
- Required-vs-structurally-expected-empty distinction on `TargetSchema.columns` (see that doc's Design implication) so the Phase 3 audit report doesn't drown real gaps in expected sparsity.
- Prisma models for `TargetSchema`, `CleaningRule`, `Dataset`.

## Phase 3 — AI Cleaning Engine

- FastAPI `/clean/generate` endpoint implementing the script-generation prompt from [05-llm-prompting.md](./05-llm-prompting.md).
- Docker sandbox executor (productionizing the Phase 0 spike) wired to actually run generated scripts against uploaded files.
- Audit report generation (templated from sandbox execution stats, not a second free-form LLM call) per [04-ai-cleaning-and-audit.md](./04-ai-cleaning-and-audit.md).
- `CleaningRun` + `AuditReport` persistence.

## Phase 4 — Human-in-the-Loop Chat

- Chat UI (`ChatSession`/`ChatMessage`), rendering the initial audit report as the first message.
- Intent-classification step (edit vs. audit vs. question) per [04-ai-cleaning-and-audit.md](./04-ai-cleaning-and-audit.md).
- LangChain/PandasAI agent wired for iterative edits, routed through the same sandbox as Phase 3 — no separate "trusted" code path.
- On-demand full-audit trigger.

## Phase 5 — Scraper Agent

- `ScraperDefinition` registration (starting with the two House Call Pro examples already on hand).
- README-reading command-planning agent per [05-llm-prompting.md](./05-llm-prompting.md)'s scraper-planning prompt.
- Sandbox-execute scraper runs (credentials mounted, not exposed to the model).
- Output-structure-aware ingestion into `UploadedFile`/`Attachment`.
- Extend to the remaining ~5 scraper platforms once the pattern is proven on House Call Pro.

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
