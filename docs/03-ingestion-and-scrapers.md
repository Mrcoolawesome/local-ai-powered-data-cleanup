# Ingestion & Scraper Agent

## Manual upload path

1. User uploads a raw CSV/Excel file via the Next.js UI.
2. File is streamed to disk under a per-user storage root; a `UploadedFile` row is created (`sourceType: manual_upload`).
3. User selects (or the system infers from filename/columns) which `TargetSchema` this file should be cleaned against.
4. Proceeds into the cleaning pipeline ([04-ai-cleaning-and-audit.md](./04-ai-cleaning-and-audit.md)).

This is also the path for scraper output that only arrives as an emailed export (see [00-overview.md](./00-overview.md)) — the user downloads the email attachment and uploads it exactly like any other raw file. No special-casing needed in v1.

## Scraper agent path

Grounded in the two real examples in `/example-scrapers` (House Call Pro), which already show the range of variation the agent has to handle:

| | `housecallpro-job-attachments-scraper-v2` | `HouseCallPro` (exporter) |
|---|---|---|
| Runtime | Python (`pip3 install` + Playwright) | Node.js (`npm install`, requires a specific Chrome path) |
| Config | `.env` (email/password) | `housecallpro.env` (email/password/flags) |
| Invocation | Single script, no flags | `--only contacts,jobs,invoices` category selection |
| Output | Files on disk (`output/{COMPANY}/{job}/{file}`), then a separate zip/package step | Local `.xlsx` for invoices/estimates; **email** for everything else |
| Operational quirks | Rate-limit backoff, resumable via checkpoint files, session reuse | Headless flag for first-run 2FA, session dir reuse |

The agent cannot hardcode per-platform logic for 7 different scrapers — it has to actually read and reason over each README at run time. That's the core design constraint for this module.

### Workflow

1. **Registration (one-time, human-assisted):** an admin/user registers a `ScraperDefinition` — points at the script + README paths. A human confirms the saved session/credentials are valid (2FA, interactive login) *before* the agent is allowed to trigger it unattended. The agent never performs interactive login itself.
2. **Trigger:** user (or future scheduler) asks the agent to run a specific scraper, e.g. "pull the latest House Call Pro job attachments."
3. **Plan:** the agent reads the `README.md`, extracts the run command(s) and any required flags (e.g. `--only invoices`), and produces a command plan. This is a distinct LLM call from the cleaning-script generator — see [05-llm-prompting.md](./05-llm-prompting.md) for why the two need different system prompts.
4. **Sandbox-execute:** the planned command runs inside a Docker container (see [06-security-sandboxing.md](./06-security-sandboxing.md)) with the scraper's own directory mounted — including its saved session file / `.env` — so it can authenticate without the agent ever seeing the plaintext credentials in its own context.
5. **Monitor:** the agent tails stdout/stderr and pattern-matches against README-documented signals it was told to watch for (e.g. HCP v2's `RATE-LIMITED` lines, `PROGRESS ... N errors` counter) to decide whether to let it keep running, or that it's stalled/failing and needs to stop and report to the user. This is intentionally generic — the "signals to watch for" come from what the agent parsed out of the README, not a hardcoded per-scraper switch statement.
6. **Ingest:** once the run completes (or a checkpointed partial run is stopped), the agent inspects the documented output structure and walks the resulting files, creating `UploadedFile`/`Attachment` rows mapped to the right customer/job/invoice per the README's stated layout.
7. **Log:** every step (plan, command executed, files ingested) is written to `ScraperRun` + `AuditLog`.

### Known hazards this design has to account for

- **README drift breaks the agent silently.** The HCP scraper's own history (v1 DOM scraper → v2 API scraper, because HCP changed URL structure) shows platform changes can invalidate a working scraper without warning. `ScraperDefinition.lastValidatedAt` plus surfacing scraper run failures prominently (not just logging them) is the mitigation — there's no way to fully automate around an upstream platform changing shape.
- **Rate limits are real and platform-specific.** Don't let the agent retry-loop into a 403 wall; respect documented cool-downs literally.
- **Checkpointed/resumable scrapers mean "run" isn't atomic.** A `ScraperRun` can represent a resumed continuation of a prior interrupted run — model status as `running | completed | interrupted | failed`, not just success/fail.
