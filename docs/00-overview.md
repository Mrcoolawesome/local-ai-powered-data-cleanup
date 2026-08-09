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
| Zoom bot | De-risked with a standalone spike before it's on the critical path | Native Zoom Linux SDK + Xvfb + `startShareView` is the least-proven integration in this spec. It must not block the data pipeline / auditing core, which is the primary value of the app. |
| Target schemas | Derive directly from the real example export in `/example-data` (gitignored — contains live customer PII), not from the "Lighthouse" `crunchwrap_supreme` codebase referenced in the HCP README | The `crunchwrap_supreme` repo isn't accessible to the user. The example export (`MLD Services_tempest_export.xlsx`, a Jobber-platform export, not HouseCall Pro) confirms the target shape is platform-agnostic: its Contacts/Jobs/Invoices/Estimates columns (`external_id`, `job_number`, `line_items_json`, `subtotal_cents`/`total_cents`, `customer_uid`, …) line up closely with the "Lighthouse" field names the HCP README described. So the concrete example file supersedes needing the other codebase — see [02-data-model.md](./02-data-model.md) for the derived column definitions and observed dirty-data patterns. |
| Scraper email-exports | Out of scope for auto-ingestion in v1 | Some scraper categories (e.g. HCP Contacts, Job History, Services) deliver output via an emailed export, not a local file. The agent has nothing on disk to map. Users download and upload those manually through the normal ingestion flow. |

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
- [10-target-schema-reference.md](./10-target-schema-reference.md) — concrete target-schema columns & dirty-data patterns derived from `/example-data`
