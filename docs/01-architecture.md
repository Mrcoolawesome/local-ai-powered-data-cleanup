# System Architecture

## Components

```
┌─────────────────────────────────────────────────────────────────────┐
│  Next.js App (React, Tailwind, shadcn/ui)                            │
│  - NextAuth.js session/auth                                          │
│  - Upload UI, Rules/Schema config UI, Chat UI, Settings (Ollama URL) │
│  - Presentation view route (rendered inside Xvfb for Zoom share)     │
│  - WebSocket server/client for Pi control messages                   │
└───────────────┬─────────────────────────────────────┬────────────────┘
                │ HTTP (internal API routes)           │ Prisma
                ▼                                       ▼
┌───────────────────────────────┐          ┌─────────────────────────┐
│  FastAPI AI Orchestration Svc  │          │  PostgreSQL              │
│  - LangChain / PandasAI agent  │◄────────►│  users, datasets, rules, │
│  - Script generation           │  reads/  │  audit logs, chat log,  │
│  - Sandbox executor (Docker)   │  writes  │  scraper runs, settings │
│  - Scraper-trigger agent       │  via     └─────────────────────────┘
│  - Audit report generator      │  Prisma-adjacent
└───────────────┬─────────────────────────────
                │ HTTP (OpenAI-compatible / native API)
                ▼
┌───────────────────────────────┐
│  Ollama (remote: devin-server) │
│  gemma4-e4b-262k:latest        │
└───────────────────────────────┘

┌───────────────────────────────┐   ┌───────────────────────────────┐
│  Local Filesystem               │   │  Docker (sandbox executions)  │
│  raw uploads, scraper output,   │   │  - cleaning script runs       │
│  attachments, packaged zips     │   │  - scraper command runs       │
└───────────────────────────────┘   └───────────────────────────────┘

┌───────────────────────────────┐   ┌───────────────────────────────┐
│  Zoom Bot Service (Linux)       │   │  Raspberry Pi (3x4" touch)    │
│  Xvfb + Chromium + Zoom SDK     │◄──┤  Minimal React UI             │
│  shares presentation view route │WS │  sends WS trigger messages    │
└───────────────────────────────┘   └───────────────────────────────┘
```

## Why two backend services (Next.js API routes + FastAPI)

- **Next.js API routes** own everything that's naturally request/response and tightly coupled to the UI/auth session: CRUD on rules, datasets, chat messages, settings. Prisma lives here as the single ORM boundary into Postgres.
- **FastAPI service** owns everything Python-ecosystem-specific: LangChain/PandasAI agents, Ollama calls, Docker sandbox orchestration, scraper subprocess management. This is a deliberate boundary — don't try to shell out to Python from Node, and don't try to reimplement LangChain in TypeScript.
- The two talk over a small internal HTTP API (FastAPI is not exposed to the browser). Next.js API routes proxy relevant AI operations to FastAPI and persist the results via Prisma. This keeps Postgres access consolidated behind one ORM even though two services touch data indirectly (FastAPI never talks to Postgres directly — it returns structured results to Next.js, which persists them).

## Data flow: initial upload → audit

1. User uploads a raw file (or agent pulls scraper output) → Next.js writes the file to disk, creates an `UploadedFile` row via Prisma.
2. Next.js calls FastAPI `/clean/generate` with the file's inferred schema (column names + sample rows, not the full dataset), the user's `TargetSchema`, and `CleaningRule`s.
3. FastAPI prompts the LLM (see [05-llm-prompting.md](./05-llm-prompting.md)) for a Pandas script, then executes it inside a Docker sandbox against the actual file (full data never enters the LLM context — only schema/samples do).
4. FastAPI returns the transformed file path + a structured summary (rows fixed, rows flagged, unmappable columns) to Next.js.
5. Next.js persists a `CleaningRun` + `AuditReport` row, renders the HTML/Markdown report as the first chat message.
6. User continues in chat — each turn goes to FastAPI's LangChain agent, which decides "is this an edit or an audit request?" and either mutates data + replies conversationally, or regenerates a full audit report.

## Data flow: scraper trigger → ingestion

1. Agent (invoked by user "pull latest House Call Pro data" or on a schedule — v1 is user-invoked only) reads the target scraper's `README.md` from the registered scraper path.
2. Agent proposes a command plan (e.g. `python3 api_scraper.py`) — this plan is sandboxed-executed in Docker with the scraper's own directory mounted (including its saved session/`.env`, read-only where possible) and no network restrictions lifted beyond what the scraper needs.
3. Agent watches stdout/stderr against README-documented signals (e.g. HCP's `RATE-LIMITED` lines, `PROGRESS ... N errors` counters) to decide retry/backoff/stop — mirrors what a human operator would do per the README, not hardcoded per-scraper logic.
4. On completion, agent inspects the documented output structure (e.g. `output/{COMPANY_NAME}/{job_number}/{filename}`) and maps files into `Attachment`/`UploadedFile` rows tied to the right customer/job.
5. Categories that only trigger an emailed export are left alone in v1 (see [00-overview.md](./00-overview.md) non-goals) — the agent doesn't attempt to read email.

## Data flow: live presentation

1. Server renders a minimal, chrome-less Next.js route (`/present/[sessionId]`) showing whatever dataset/attachment is "active."
2. Zoom Bot Service launches Xvfb, opens that route in Chromium inside the virtual display, joins the target meeting via Zoom Linux Meeting SDK, and calls `startShareView` against the Xvfb window handle.
3. Raspberry Pi UI sends a WebSocket message (`{ action: "SHOW_VIEW", target: "contacts-sheet" }`) to the server.
4. Server broadcasts the state change to the open presentation route via WebSocket/SSE; the DOM updates in place — no page reload, so the Zoom share stays continuous.
