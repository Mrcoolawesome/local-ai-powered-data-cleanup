"""FastAPI AI orchestration service.

Per docs/01-architecture.md: this service owns everything Python/LangChain/
Ollama-specific. It never talks to Postgres directly (Next.js does, via
Prisma) — Next.js calls this service and persists whatever it returns.
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.config import config
from app.ollama_client import OllamaError, chat, list_models
from app.prompting import NoCodeBlockError, build_system_prompt, extract_code_block
from app.sandbox import SandboxError, run_cleaning
from app.schema_inference import SchemaInferenceError, infer_schema

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
