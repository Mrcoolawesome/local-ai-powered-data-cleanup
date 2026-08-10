# Project Overview

## What this is

An internal, multi-user system that:

1. Ingests raw spreadsheet exports (invoices, estimates, contacts, jobs, attachments) produced by ~7 different web scrapers or uploaded manually.
2. Uses a local LLM (via Ollama) to generate and run Python/Pandas cleaning scripts that transform raw data into a user-defined target schema.
3. Surfaces a chat-based, human-in-the-loop audit interface for reviewing and iteratively fixing data.
4. Presents the cleaned data / attachments live in a Zoom meeting via a native SDK bot, remotely controlled from a Raspberry Pi touchscreen.

Everything runs on infrastructure the user controls: local Postgres, local filesystem, local LLM. No data leaves the network by default.

## Non-goals (v1)

- No cloud LLM fallback. Local-only.
- No fully unattended scraper login flows — 2FA/interactive login remains a one-time human-attended setup step per platform; the agent only *triggers* scrapers that already have a valid saved session/credentials.
- No auto-ingestion for scraper outputs that arrive via emailed export rather than local disk (see [03-ingestion-and-scrapers.md](./03-ingestion-and-scrapers.md)) — those stay a manual upload for now.
- No team/shared workspaces — v1 isolation is per-user, not per-team. (Modeled so it could grow into that later, see [02-data-model.md](./02-data-model.md).)

## Key architectural decisions (locked in during planning)

| Decision | Choice | Why |
|---|---|---|
| Code-execution sandbox | Docker container per execution, no network, restricted mount | Both the cleaning-script generator and the scraper-trigger agent run LLM-directed code/commands against a machine holding customer data and live platform credentials. Containerizing every execution is the only option that isn't "trust the LLM completely." |
| LLM | `gemma4-e4b-262k:latest` (custom 262k-context variant of `gemma4:e4b-it-qat`) via Ollama | Already validated by the user for this hardware; large context window matters because schema + rules + sample rows for a cleaning task can be long. |
| Ollama endpoint | Configurable in the UI, defaults to `devin-server:11434` | The LLM runs on a separate physical machine (`devin-server`) from wherever the app is deployed/dev'd. Hardcoding the endpoint would break portability. |
| Zoom bot | Proceed with the native Zoom Linux SDK + Xvfb + `StartAppShare` design (no fallback needed) | Fully validated against a real, live Zoom meeting: the bot authenticated, joined, reached `MEETING_STATUS_INMEETING`, and successfully shared — the project owner, present in the meeting, visually confirmed seeing the live-updating test page. This was the highest-risk item in the spec and it's closed. See [07-zoom-bot.md](./07-zoom-bot.md) for full spike results. |
| Target schemas | Seed directly from the project owner's own real migration template (all 8 sheets), not from the "Lighthouse" `crunchwrap_supreme` codebase referenced in the HCP README | The `crunchwrap_supreme` repo isn't accessible to the user. An earlier pass used a real Jobber-platform export (`/example-data`, gitignored) and confirmed the target shape is platform-agnostic across scraper sources — since superseded by the project owner providing their own authoritative migration template covering every entity type Podium needs (Contacts, Jobs, Invoices, Estimates, Pricebook - Services, Pricebook - Materials, Equipment, Memberships), with required columns explicitly color-coded in the file itself rather than inferred. See [10-target-schema-reference.md](./10-target-schema-reference.md) for exactly how that maps to `TARGET_SCHEMA_TEMPLATES`. |
| Scraper email-exports | Out of scope for auto-ingestion in v1 | Some scraper categories (e.g. HCP Contacts, Job History, Services) deliver output via an emailed export, not a local file. The agent has nothing on disk to map. Users download and upload those manually through the normal ingestion flow. |
| Deployment | Docker Compose (postgres + web + ai-service) on the AI server, started/stopped as one unit | User wants to "spin it up or down with Docker." Ollama stays outside the stack (already running separately on the same machine). The `ai-service` container gets the host Docker socket mounted in to launch sandbox containers as siblings (Docker-outside-of-Docker) — a real, stated tradeoff, see [11-deployment.md](./11-deployment.md). |

## Document map

- [01-architecture.md](./01-architecture.md) — system components & data flow
- [02-data-model.md](./02-data-model.md) — Postgres/Prisma entity design
- [03-ingestion-and-scrapers.md](./03-ingestion-and-scrapers.md) — file upload + scraper agent workflow
- [04-ai-cleaning-and-audit.md](./04-ai-cleaning-and-audit.md) — cleaning engine, chat, audit reports
- [05-llm-prompting.md](./05-llm-prompting.md) — Gemma system prompt design
- [06-security-sandboxing.md](./06-security-sandboxing.md) — Docker execution sandbox & credential handling
- [07-zoom-bot.md](./07-zoom-bot.md) — Zoom SDK + Xvfb presentation bot
- [08-raspberry-pi-controller.md](./08-raspberry-pi-controller.md) — Pi touchscreen + WebSocket control
- [09-roadmap.md](./09-roadmap.md) — phased build order
- [10-target-schema-reference.md](./10-target-schema-reference.md) — concrete target-schema columns for all 8 entity types, seeded from the project owner's own migration template
- [11-deployment.md](./11-deployment.md) — Docker Compose deployment, sandbox-orchestration-from-a-container tradeoff
