# Data Model (Postgres via Prisma)

This is a conceptual entity design, not the literal `schema.prisma` (that's written during Phase 1 implementation). It exists so the ingestion, cleaning, chat, scraper, and presentation docs can all refer to the same nouns.

## Isolation model

v1 isolation is **per-user**, not per-team: every entity below that holds data is scoped by a `userId` foreign key, and every Prisma query in the app layer must filter on the authenticated session's user. A `Workspace` table is intentionally *not* introduced in v1 — the spec only calls for per-user isolation ("different users only see and interact with their own datasets"). If team sharing becomes a requirement later, `Workspace` slots in as an owning entity between `User` and everything else without reshaping the rest of the model.

## Core entities

**User**
Standard NextAuth.js user record. Owns everything else by `userId`.

**Settings**
Per-user (or, for anything that must be a single shared value like the Ollama endpoint, a singleton system-settings row — decide at implementation time based on whether users share one AI server). Holds: `ollamaBaseUrl` (default `http://devin-server:11434`), default model name (`gemma4-e4b-262k:latest`), other tunables (sandbox timeout, max concurrent scraper runs).

**TargetSchema**
A user-defined target shape for a given entity type (Contacts, Jobs, Invoices, Estimates, Pricebook - Services, Pricebook - Materials, Equipment, Memberships). Versioned (`version` int) so a change to the schema doesn't silently reinterpret old audit history. Fields: `entityType`, `columns` (JSON: name, type, `required` flag, `structurallyOptional` flag, description). See [10-target-schema-reference.md](./10-target-schema-reference.md) for the concrete column sets to seed these from — the project owner's own real migration template, covering all 8 entity types with `required` read straight from the template's own color-coding. The shape is platform-agnostic (Jobber and HouseCall Pro data both normalize to it), so one `TargetSchema` per entity type covers every scraper source, not one per platform.

**CleaningRule**
A standardized, non-negotiable rule tied to a `TargetSchema` (e.g. "Mobile and Landline columns must combine into a single Phone column"). Stored as structured data where possible (source columns, target column, merge strategy) rather than freeform text, so the prompt builder in [05-llm-prompting.md](./05-llm-prompting.md) can present rules deterministically instead of re-parsing English each time. A `rawDescription` field keeps the human-authored version for display and for rules too irregular to structure.

**UploadedFile**
A raw or scraper-produced file on disk. `filePath`, `originalFilename`, `sourceType` (`manual_upload` | `scraper`), `scraperRunId` (nullable FK), `entityTypeGuess`, `status` (`pending` | `cleaned` | `error`).

**Dataset**
A logical, cleaned table derived from one or more `UploadedFile`s against a `TargetSchema` (e.g. "Contacts — Acme HVAC, cleaned"). This is what the chat/audit UI and the presentation view actually point at. `filePath` (the cleaned output), `targetSchemaId`, `rowCount`, `lastCleanedAt`.

**CleaningRun**
One execution of the generate → sandbox-execute pipeline against a `Dataset`/`UploadedFile`. `generatedScript` (the Pandas code, kept for audit/debugging), `status`, `sandboxLogs`, `startedAt`/`finishedAt`, `triggeredBy` (`initial_upload` | `chat_request`).

**AuditReport**
The HTML/Markdown report shown in chat. Linked to a `CleaningRun` or standalone (for on-demand audits that don't re-run cleaning). `contentMarkdown`, `contentHtml`, `summary` (JSON: rows flagged, unmappable columns, missing-required-field counts), `datasetId`.

**ChatSession** / **ChatMessage**
Standard chat persistence, scoped to a `Dataset`. `ChatMessage.role` (`user` | `assistant`), `content`, `messageType` (`text` | `audit_report` | `action_confirmation`), optional `relatedAuditReportId`.

**ScraperDefinition**
A registered scraper: `platformName` (e.g. "HouseCallPro"), `scriptPath`, `readmePath`, `runtime` (`python` | `node`), `lastValidatedAt` (when a human last confirmed the README-execution mapping still works — READMEs drift, see the v1→v2 HCP rewrite in the example scrapers).

**ScraperRun**
One agent-triggered execution. `scraperDefinitionId`, `commandExecuted`, `status`, `logOutput`, `startedAt`/`finishedAt`, `filesIngestedCount`.

**Attachment**
A file (photo, document) pulled by a scraper and tied to a business entity. `filePath`, `jobId`/`customerId`/`invoiceNumber` (whichever the source scraper provides — kept loose/nullable since not every platform has the same entity graph), `scraperRunId`.

**PresentationSession**
Tracks what's currently "live" for the Zoom bot + Pi controller. `activeView` (points at a `Dataset` or `Attachment` collection), `zoomMeetingId`, `status` (`idle` | `joining` | `sharing` | `error`).

**AuditLog**
Append-only. `userId`, `action`, `entityType`, `entityId`, `metadata` (JSON), `createdAt`. Every mutating action from every subsystem (cleaning run, chat edit, scraper trigger, rule change) writes here — this is the compliance/traceability backbone the spec's "audit logs" requirement points at.

## Relationships (high level)

```
User 1──* TargetSchema 1──* CleaningRule
User 1──* UploadedFile ──* Dataset ──* CleaningRun ──1 AuditReport
Dataset 1──* ChatSession 1──* ChatMessage
User 1──* ScraperDefinition 1──* ScraperRun ──* Attachment
User 1──* PresentationSession
User 1──* AuditLog (polymorphic entityType/entityId)
```
