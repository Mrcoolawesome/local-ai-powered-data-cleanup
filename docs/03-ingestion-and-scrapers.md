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

1. **Install + Registration (one-time, human-assisted):** a scraper's files reach the scrapers root one of two ways — dropped in by hand (how the two `/example-scrapers` examples got there), or uploaded as a `.zip` through `/scrapers` (`lib/scrapers-fs.ts`'s `extractScraperZip`), which handles both a single wrapping folder and files at the zip root, and refuses zip-slip path-traversal entries before anything touches disk. Either way, an admin/user then registers a `ScraperDefinition` — points at the script + README paths. A human confirms the saved session/credentials are valid (2FA, interactive login) *before* the agent is allowed to trigger it unattended. The agent never performs interactive login itself.
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

## Phase 5 build status

**Plan step — built and tested against the real HCP READMEs.** `POST /scraper/plan` reads a README verbatim (`app/scraper_fs.py`), sends it through a dedicated planning prompt ([05-llm-prompting.md](./05-llm-prompting.md)), and returns `setup_commands`/`run_command`/`watch_signals`/`confidence`/`concerns`. Verified against both real example scrapers (Python/Playwright HCP v2, Node HCP exporter) — the plan correctly picked up each one's distinct invocation style (flags vs. no flags, `pip3 install` vs `npm install`) straight from README prose, with no per-platform special-casing in the prompt.

**Sandbox-execute step — built and tested end-to-end against a safe synthetic fixture**, not a real platform (deliberate: this phase proves the *mechanics* — container launch, timeout, log capture, signal matching, new-file detection — without touching live scraper credentials). `POST /scraper/execute` (`app/scraper_sandbox.py`) ran a fake scraper that installs `requests`, makes one real HTTP call to `https://api.github.com`, writes a file under a nested output path, and prints a watched-for completion string. Result matched every expectation: `exit_code: 0`, `matched_signals` included the completion string, `new_files` correctly listed only the genuinely-new file (not the scraper's own `.py`/`README.md`/`.env`, which `list_files_modified_since`'s exclusion list correctly filtered out). See [06-security-sandboxing.md](./06-security-sandboxing.md) for the one real permission issue found while testing this (a test-harness mistake, not a code bug) and the fix.

**v1 simplification, stated up front rather than discovered as a gap:** monitoring is a post-hoc scan of the fully-captured log against `watch_signals` after the container exits (or times out), not real-time streaming with an early-abort on a rate-limit signal mid-run. Real-time streaming is a reasonable future improvement (`container.logs(stream=True)`), not implemented in v1 — a run that hits a rate limit still runs to its own timeout rather than being cut short the moment the signal appears in its output.

**Next.js side — built and tested end-to-end through the real running app**, not just unit-level. `/scrapers` (`app/scrapers/page.tsx`) discovers scrapers on disk (`lib/scrapers-fs.ts`) and registers a `ScraperDefinition`; `/scrapers/[id]` (`app/scrapers/[id]/page.tsx`) fetches a fresh plan on demand, requires an explicit confirmation checkbox before the "Run scraper now" Server Action fires, and shows run history. Ingestion (`lib/scraper-ingest.ts`) routes each new file by extension: spreadsheet exports (`.csv`/`.xlsx`/`.xls`) get copied into `STORAGE_ROOT` and become an `UploadedFile` (`sourceType: SCRAPER`) so the existing cleaning pipeline picks them up unmodified; everything else is left where the scraper wrote it, under the scrapers root, and becomes an `Attachment` referencing that path directly — no unnecessary copy of binary media. v1 gap: `Attachment.jobId`/`customerId` are left null (parsing them out of a path like HCP v2's `output/{COMPANY}/{job}/{file}` would need either a hardcoded per-platform parser or a second LLM call, neither built this phase).

Verified via a real browser session (Playwright driving system Chrome, headless) against the live Docker Compose stack — logged in as the seeded user, registered the same safe fake-scraper fixture through the actual `/scrapers` UI, requested a plan (confidence: high, matched the README correctly), confirmed and ran it, and confirmed in Postgres: `ScraperRun.status = COMPLETED`, `filesIngestedCount = 1`, and the produced file correctly became an `Attachment` (not spreadsheet-shaped) with the right path — the on-disk file was independently confirmed to exist too. This is a real proof of the full chain: browser → Server Action → ai-service → Docker sandbox → filesystem → Postgres, not a mocked or partial test. All test rows/files were removed afterward.

**Not yet run:** any real platform scraper (House Call Pro or otherwise) against live credentials — that step requires explicit user go-ahead first, independent of whether the mechanics are proven.

## Zip upload — built and tested for real

Dropping a scraper's files into the scrapers root by hand doesn't scale to "add a scraper through the app" — `extractScraperZip` (`lib/scrapers-fs.ts`) is the actual upload path behind `/scrapers`' "Upload a scraper" form. It handles both zip shapes people actually produce (a single wrapping folder, or files at the zip root with no wrapper) by checking whether every entry shares one common first path segment; whichever shape it is, the result lands as one top-level directory under the scrapers root, indistinguishable from a hand-copied one to `discoverScrapers()`.

Since this accepts arbitrary user-uploaded archive content, it's checked for the classic **zip slip** vulnerability (an entry path like `../../etc/whatever` writing outside the intended directory) — every entry's raw path is validated before anything is written, and the final resolved path is checked again after stripping a possible wrapping folder, since either step alone could otherwise let a traversal through. A duplicate directory name is rejected outright rather than silently overwritten — re-uploading (or a name collision with an existing registered scraper) fails with a clear error instead of clobbering session/credential files that might already be sitting in that directory.

**Verified for real**, not just by code review: uploaded a wrapped zip and a no-wrapper zip through the real running app (via a direct POST to the Server Action, replicating exactly what the browser's `<form>` submits) — both extracted correctly and showed up in "Discovered, not yet registered" exactly like a hand-copied scraper. Re-uploading the same zip was correctly rejected as a duplicate. A crafted zip with a `../../../../tmp/...` entry was correctly rejected before extraction, and independently confirmed the target file was never written anywhere on disk. All test scrapers removed after.

This did require loosening `web`'s scrapers mount from read-only to read-write (`docker-compose.yml`) — `web` still never *executes* a scraper or reads its credentials, that stays `ai-service`'s job in the sandbox executor (`docs/06-security-sandboxing.md`); it can now write new scraper directories, which is a narrower privilege than "run arbitrary code," but is a real change from the read-only guarantee stated through Phase 5, worth being explicit about.

## Credentials entry through the plan flow — built and tested for real

Every scraper example on hand takes an email/password in some `.env`-shaped file, but each one names the file and its variables differently (docs/05-llm-prompting.md's earlier table: HCP v2's `.env` vs. the exporter's `housecallpro.env`). Rather than hardcode either shape, the planning LLM call (`build_scraper_planning_prompt`, `apps/ai-service/app/prompting.py`) now also extracts `credentials_env_filename`/`credentials_env_template` straight from the README — the exact filename and `KEY=value` layout it documents, with `{{EMAIL}}`/`{{PASSWORD}}` placeholders standing in for the real values, using the README's own variable names rather than assuming `EMAIL`/`PASSWORD`. Both are `null` if a scraper documents no such file.

When a plan includes them, `/scrapers/[id]` shows Email/Password fields alongside the existing plan preview; leaving both blank on a run keeps whatever's already saved (an earlier manual setup, or a previous run's credentials) rather than clobbering it. Filling them in calls a new `POST /scraper/credentials` (ai-service) right before execution, which substitutes the placeholders and writes the file into the scraper's own directory (`write_credentials_env`, `apps/ai-service/app/scraper_fs.py`) — the model itself never sees or produces the actual email/password values, only the shape of the file they go in, same "orchestrator mounts the credential file" principle as every other scraper credential path in this app.

**Verified for real**, not just by code review: extended the safe fake-scraper fixture to document a `login.env` file with non-generic variable names (`SCRAPER_EMAIL`/`SCRAPER_PASSWORD`, not `EMAIL`/`PASSWORD`) and to actually read and use it (refusing to run without it). Ran the full flow through the real app — the plan correctly extracted `login.env` with those exact variable names (not a hardcoded guess), the form correctly showed the fields, and after submitting real values the scraper's own log confirmed it read them correctly (`Logged in as tester@example.com (password length 20, never printed)`) and completed successfully. Independently confirmed the written `login.env` on disk matched exactly. All test data removed after.

## Deleting scrapers — built and tested for real

Two delete paths, matching the two states a scraper can be in:

- **Discovered, not yet registered** (`/scrapers`'s "Delete" button next to Register): removes just the on-disk directory via `deleteScraperDirectory` (`lib/scrapers-fs.ts`) — nothing in the DB yet to clean up. Re-derives "not registered" server-side rather than trusting the client only rendered the button for an unregistered entry, and redirects with an error instead if it turns out to already be registered (delete it from its own page instead, since that path also has run history to cascade).
- **Registered** (`/scrapers/[id]`'s "Danger zone", confirmation-checkbox-gated like the run form): deletes the `ScraperDefinition` row first — cascading to its `ScraperRun`s and their `Attachment`s at the database level (`ON DELETE CASCADE`, confirmed in the actual migration SQL, not just assumed from Prisma's schema-level defaults), with any `PresentationSession` pointing at one of those runs correctly falling back via `ON DELETE SET NULL` rather than erroring — then removes the scraper's files (including any saved credentials) from disk. DB row first, then files, so a file-removal failure doesn't leave a half-deleted registration still pointing at a (potentially already-gone) directory.

**Verified for real**: deleted an unregistered scraper through `/scrapers` and confirmed its directory was actually gone from disk (not just absent from the page — checked independently, since a stale/cached page render could otherwise look like a false confirmation). Registered a scraper, deleted it through its own "Danger zone," and confirmed both the `ScraperDefinition` row and its on-disk directory were gone afterward, with a correct redirect back to `/scrapers`.
