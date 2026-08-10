"""FastAPI AI orchestration service.

Per docs/01-architecture.md: this service owns everything Python/LangChain/
Ollama-specific. It never talks to Postgres directly (Next.js does, via
Prisma) — Next.js calls this service and persists whatever it returns.
"""
import os

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.audit import AuditRecomputeError, recompute_audit
from app.config import config
from app.ollama_client import OllamaError, chat, list_models
from app.prompting import (
    NoCodeBlockError,
    ScraperPlanParseError,
    UnrecognizedIntentError,
    build_edit_system_prompt,
    build_intent_classification_prompt,
    build_question_system_prompt,
    build_scraper_planning_prompt,
    build_system_prompt,
    extract_code_block,
    parse_intent,
    parse_scraper_plan,
)
from app.sandbox import SandboxError, run_cleaning
from app.schema_inference import SchemaInferenceError, compute_summary_stats, get_current_columns, infer_schema
from app.scraper_fs import ScraperFsError, find_credentials_example_file, read_readme, write_credentials_env
from app.scraper_sandbox import (
    ScraperSandboxError,
    list_files_modified_since,
    poll_scraper,
    send_scraper_input,
    start_scraper,
)

app = FastAPI(title="data-cleanup ai-service")


@app.get("/health")
async def health():
    return {"status": "ok"}


class InferSchemaRequest(BaseModel):
    input_relative_path: str
    original_filename: str


@app.post("/schema/infer")
async def schema_infer(req: InferSchemaRequest):
    """Reads a real uploaded file to build the source_schema /clean/generate
    and /clean/execute need. Un-sandboxed on purpose — see
    app/schema_inference.py's docstring for why that's an acceptable,
    scoped decision rather than an inconsistency with docs/06.
    """
    try:
        schema = await run_in_threadpool(infer_schema, req.input_relative_path, req.original_filename)
    except SchemaInferenceError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"source_schema": schema}


@app.get("/ollama/health")
async def ollama_health(base_url: str | None = None):
    """Confirms this service can actually reach the configured Ollama
    endpoint and lists what's pulled there — the real connectivity check,
    not just "did the process start."
    """
    url = base_url or config.default_ollama_base_url
    try:
        models = await list_models(url)
    except OllamaError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"base_url": url, "model_count": len(models), "models": [m["name"] for m in models]}


class ChatRequest(BaseModel):
    messages: list[dict]
    base_url: str | None = None
    model: str | None = None


@app.post("/ollama/chat")
async def ollama_chat(req: ChatRequest):
    url = req.base_url or config.default_ollama_base_url
    model = req.model or config.default_ollama_model
    try:
        content = await chat(url, model, req.messages)
    except OllamaError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return {"base_url": url, "model": model, "content": content}


class SourceColumn(BaseModel):
    name: str
    inferred_dtype: str = "string"
    null_pct: float = 0.0
    sample_values: list[str] = []


class TargetColumn(BaseModel):
    name: str
    type: str
    required: bool
    structurallyOptional: bool
    description: str = ""


class CleaningRuleInfo(BaseModel):
    rule: str
    description: str


class GenerateCleaningScriptRequest(BaseModel):
    # Schema + a handful of sample values only — never the full dataset.
    # docs/05-llm-prompting.md's "Core rule: schema and samples in, never
    # the full dataset" applies here just as it did in the spike.
    source_schema: list[SourceColumn]
    target_schema: list[TargetColumn]
    cleaning_rules: list[CleaningRuleInfo] = []
    base_url: str | None = None
    model: str | None = None


@app.post("/clean/generate")
async def generate_cleaning_script(req: GenerateCleaningScriptRequest):
    """Generates a clean(df) function per docs/05-llm-prompting.md. Does
    NOT execute it — that's /clean/execute, which runs the result through
    the Docker sandbox. Split so the generated code can be reviewed/logged
    before anything actually touches a file.
    """
    url = req.base_url or config.default_ollama_base_url
    model = req.model or config.default_ollama_model

    system_prompt = build_system_prompt(
        [c.model_dump() for c in req.source_schema],
        [c.model_dump() for c in req.target_schema],
        [r.model_dump() for r in req.cleaning_rules],
    )
    try:
        raw_response = await chat(
            url,
            model,
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Generate the cleaning script."},
            ],
        )
    except OllamaError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    try:
        code = extract_code_block(raw_response)
    except NoCodeBlockError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    return {"code": code, "raw_response": raw_response, "base_url": url, "model": model}


class ExecuteCleaningRequest(BaseModel):
    source_schema: list[SourceColumn]
    target_schema: list[TargetColumn]
    cleaning_rules: list[CleaningRuleInfo] = []
    # Paths relative to the shared storage root (docs/11-deployment.md) —
    # never absolute paths from the caller, so this service's notion of
    # "storage" stays the single source of truth for where things live.
    input_relative_path: str
    original_filename: str
    output_relative_dir: str
    base_url: str | None = None
    model: str | None = None


@app.post("/clean/execute")
async def execute_cleaning(req: ExecuteCleaningRequest):
    """Generate + sandbox-execute in one call — what Next.js actually calls
    for a real cleaning run. Returns everything CleaningRun/AuditReport
    need to persist (docs/02-data-model.md); this service never writes to
    Postgres itself.
    """
    url = req.base_url or config.default_ollama_base_url
    model = req.model or config.default_ollama_model
    target_schema_dicts = [c.model_dump() for c in req.target_schema]

    system_prompt = build_system_prompt(
        [c.model_dump() for c in req.source_schema],
        target_schema_dicts,
        [r.model_dump() for r in req.cleaning_rules],
    )
    try:
        raw_response = await chat(
            url,
            model,
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": "Generate the cleaning script."},
            ],
        )
    except OllamaError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    try:
        code = extract_code_block(raw_response)
    except NoCodeBlockError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    try:
        result = await run_in_threadpool(
            run_cleaning,
            code,
            req.input_relative_path,
            req.original_filename,
            target_schema_dicts,
            req.output_relative_dir,
        )
    except SandboxError as e:
        # The generated code itself is part of the error context — a bad
        # generation is a debuggable event, not just an opaque 500.
        raise HTTPException(status_code=422, detail={"error": str(e), "generated_code": code}) from e

    return {
        "code": code,
        "base_url": url,
        "model": model,
        **result,
    }


# --- Chat (Phase 4, docs/04-ai-cleaning-and-audit.md) ---------------------


class ClassifyIntentRequest(BaseModel):
    message: str
    base_url: str | None = None
    model: str | None = None


@app.post("/chat/classify-intent")
async def classify_intent(req: ClassifyIntentRequest):
    """A deliberately separate, minimal call from the main chat prompts —
    this is what keeps the system from re-auditing on every turn while
    still recognizing an explicit audit request (docs/04).
    """
    url = req.base_url or config.default_ollama_base_url
    model = req.model or config.default_ollama_model
    system_prompt = build_intent_classification_prompt()
    try:
        raw_response = await chat(
            url,
            model,
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": req.message},
            ],
            options={"temperature": 0.0},
        )
    except OllamaError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    try:
        intent = parse_intent(raw_response)
    except UnrecognizedIntentError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    return {"intent": intent, "raw_response": raw_response}


class ChatAuditRequest(BaseModel):
    dataset_file_relative_path: str
    target_schema: list[TargetColumn]


@app.post("/chat/audit")
async def chat_audit(req: ChatAuditRequest):
    """On-demand recompute against the dataset's CURRENT file — no LLM
    call, no sandbox execution, just compute_report again (docs/04's
    on-demand audit doesn't need to re-run cleaning, only re-derive the
    report from current data).
    """
    try:
        result = await run_in_threadpool(
            recompute_audit, req.dataset_file_relative_path, [c.model_dump() for c in req.target_schema]
        )
    except AuditRecomputeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return result


class ChatEditRequest(BaseModel):
    message: str
    target_schema: list[TargetColumn]
    cleaning_rules: list[CleaningRuleInfo] = []
    dataset_file_relative_path: str
    output_relative_dir: str
    base_url: str | None = None
    model: str | None = None


@app.post("/chat/edit")
async def chat_edit(req: ChatEditRequest):
    """A user-requested incremental change to already-cleaned data. Routed
    through the identical sandbox as the initial clean — docs/04: no
    trusted tier just because a chat turn produced the code instead of
    the initial upload.
    """
    url = req.base_url or config.default_ollama_base_url
    model = req.model or config.default_ollama_model
    target_schema_dicts = [c.model_dump() for c in req.target_schema]
    cleaning_rule_dicts = [r.model_dump() for r in req.cleaning_rules]

    try:
        current_columns = await run_in_threadpool(get_current_columns, req.dataset_file_relative_path)
    except SchemaInferenceError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    system_prompt = build_edit_system_prompt(target_schema_dicts, cleaning_rule_dicts, current_columns)
    try:
        raw_response = await chat(
            url,
            model,
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": req.message},
            ],
        )
    except OllamaError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    try:
        code = extract_code_block(raw_response)
    except NoCodeBlockError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    try:
        result = await run_in_threadpool(
            run_cleaning,
            code,
            req.dataset_file_relative_path,
            "dataset.csv",  # already-cleaned data is always CSV — see sandbox.py's _read_call_for
            target_schema_dicts,
            req.output_relative_dir,
        )
    except SandboxError as e:
        raise HTTPException(status_code=422, detail={"error": str(e), "generated_code": code}) from e

    return {"code": code, "base_url": url, "model": model, **result}


class ChatQuestionRequest(BaseModel):
    message: str
    target_schema: list[TargetColumn]
    dataset_file_relative_path: str
    base_url: str | None = None
    model: str | None = None


@app.post("/chat/question")
async def chat_question(req: ChatQuestionRequest):
    """Conversational answer using aggregate stats only — never raw rows
    (docs/05-llm-prompting.md). No sandbox execution; this path never
    mutates the dataset.
    """
    url = req.base_url or config.default_ollama_base_url
    model = req.model or config.default_ollama_model
    target_schema_dicts = [c.model_dump() for c in req.target_schema]

    try:
        summary_stats = await run_in_threadpool(compute_summary_stats, req.dataset_file_relative_path)
    except SchemaInferenceError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    system_prompt = build_question_system_prompt(target_schema_dicts, summary_stats)
    try:
        reply = await chat(
            url,
            model,
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": req.message},
            ],
        )
    except OllamaError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    return {"reply": reply, "base_url": url, "model": model, "summary_stats": summary_stats}


# --- Scraper agent (Phase 5, docs/03-ingestion-and-scrapers.md) -----------


class ScraperPlanRequest(BaseModel):
    readme_relative_path: str
    runtime: str
    base_url: str | None = None
    model: str | None = None


@app.post("/scraper/plan")
async def scraper_plan(req: ScraperPlanRequest):
    """Reads a real scraper README and asks the LLM for a structured
    command plan. Read-only — does not execute anything. The README is
    untrusted input the agent reads, not instructions it follows directly
    (docs/06-security-sandboxing.md's prompt-injection awareness) — the
    resulting plan is still subject to the same sandbox as everything else
    when it's actually run (docs/11-deployment.md).
    """
    url = req.base_url or config.default_ollama_base_url
    model = req.model or config.default_ollama_model

    try:
        readme_content = await run_in_threadpool(read_readme, req.readme_relative_path)
    except ScraperFsError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    # A "cp X.env.example X.env" setup step (found for real: HouseCallPro-Exporter)
    # means the actual credential variable names live in that example file,
    # not the README's own prose — include it as extra context when present
    # so the plan can extract the real names instead of correctly declining
    # to guess. scraper_dir is readme_relative_path's own directory, so this
    # needs no new request field.
    scraper_dir = os.path.dirname(req.readme_relative_path)
    example_file = await run_in_threadpool(find_credentials_example_file, scraper_dir)
    # Found for real running an actual scraper: a README's "Scripts" list
    # often gives bare filenames (e.g. "housecallpro-exporter.mjs --only
    # invoices") with no interpreter — a human reader infers "run this with
    # node" from context the model doesn't reliably have. Stating the
    # scraper's own already-registered runtime explicitly (not left for the
    # model to guess from the README's prose alone) is what
    # build_scraper_planning_prompt's instruction below relies on.
    user_content = f"THIS SCRAPER'S REGISTERED RUNTIME: {req.runtime}\n\n{readme_content}"
    if example_file:
        example_name, example_content = example_file
        user_content += (
            f"\n\n---\nADDITIONAL FILE FOUND IN THIS SCRAPER'S DIRECTORY: {example_name}\n"
            f"(likely the credentials file template referenced in the README's setup step)\n{example_content}"
        )

    system_prompt = build_scraper_planning_prompt()
    try:
        raw_response = await chat(
            url,
            model,
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            options={"temperature": 0.1},
        )
    except OllamaError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    try:
        plan = parse_scraper_plan(raw_response)
    except ScraperPlanParseError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    return {"plan": plan, "raw_response": raw_response, "base_url": url, "model": model}


class WriteScraperCredentialsRequest(BaseModel):
    scraper_dir_relative_path: str
    env_filename: str
    env_template: str
    email: str
    password: str


@app.post("/scraper/credentials")
async def write_scraper_credentials(req: WriteScraperCredentialsRequest):
    """Writes a scraper's login email/password into its own directory in
    the filename/format its own README documents (credentials_env_filename/
    credentials_env_template from /scraper/plan) — called right before
    /scraper/execute so a saved session/.env is in place before the run,
    same "orchestrator mounts the credential file, the model never sees
    plaintext values" principle as every other scraper credential handling
    in this app (docs/06-security-sandboxing.md). Nothing here is logged.
    """
    try:
        await run_in_threadpool(
            write_credentials_env,
            req.scraper_dir_relative_path,
            req.env_filename,
            req.env_template,
            req.email,
            req.password,
        )
    except ScraperFsError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"status": "ok"}


class ExecuteScraperRequest(BaseModel):
    scraper_dir_relative_path: str
    runtime: str
    setup_commands: list[str] = []
    run_command: str


@app.post("/scraper/execute")
async def execute_scraper(req: ExecuteScraperRequest):
    """Starts a scraper — network-enabled, the scraper's own directory
    (including its saved session/.env) mounted read-write — and returns
    immediately with a container id, WITHOUT waiting for it to finish.
    This is the consequential endpoint in this whole subsystem: it makes
    real requests against whatever platform the scraper targets, using
    whatever credentials are sitting in that directory. Next.js is
    expected to have gotten explicit user confirmation before calling
    this — see docs/03-ingestion-and-scrapers.md.

    Deliberately fire-and-forget rather than blocking for the whole run
    (like the rest of this service's endpoints do): a run can legitimately
    pause for a long, unbounded stretch waiting on a human to answer a
    prompt (AWAITING_INPUT — see scraper_sandbox.py's module docstring),
    which a single HTTP request can't sensibly block for. Callers poll
    /scraper/status instead.
    """
    try:
        result = await run_in_threadpool(
            start_scraper,
            req.scraper_dir_relative_path,
            req.runtime,
            req.setup_commands,
            req.run_command,
        )
    except ScraperSandboxError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return result


class ScraperStatusRequest(BaseModel):
    container_id: str
    scraper_dir_relative_path: str
    watch_signals: list[str] = []
    timeout_seconds: int = 300
    # Epoch seconds — the caller's own record of when this run started
    # (Next.js already has this as ScraperRun.startedAt), not something
    # this stateless service tracks itself.
    started_at: float


@app.post("/scraper/status")
async def scraper_status(req: ScraperStatusRequest):
    """Polled repeatedly by Next.js while a run is RUNNING or
    AWAITING_INPUT. Only computes new_files (a real directory walk) once
    the container has actually exited — pointless work on every poll
    otherwise.
    """
    try:
        result = await run_in_threadpool(
            poll_scraper,
            req.container_id,
            req.watch_signals,
            req.timeout_seconds,
            req.started_at,
        )
    except ScraperSandboxError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    if result["state"] == "exited":
        new_files = await run_in_threadpool(
            list_files_modified_since, req.scraper_dir_relative_path, req.started_at
        )
        result = {**result, "new_files": new_files}
    return result


class ScraperInputRequest(BaseModel):
    container_id: str
    text: str


@app.post("/scraper/input")
async def scraper_input(req: ScraperInputRequest):
    """Relays a human-submitted value (e.g. a 2FA code) into a still-
    running container's stdin — the other half of the AWAITING_INPUT
    marker convention (scraper_sandbox.py). Nothing here is logged; the
    text a user types here can be as sensitive as the prompt that asked
    for it.
    """
    try:
        await run_in_threadpool(send_scraper_input, req.container_id, req.text)
    except ScraperSandboxError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return {"status": "ok"}
