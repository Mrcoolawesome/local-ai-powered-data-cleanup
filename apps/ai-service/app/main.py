"""FastAPI AI orchestration service — Phase 1 skeleton.

Per docs/01-architecture.md: this service owns everything Python/LangChain/
Ollama-specific. It never talks to Postgres directly (Next.js does, via
Prisma) — Next.js calls this service and persists whatever it returns.
Phase 1 scope is just proving the service boots and can reach Ollama;
the actual cleaning/chat/scraper endpoints land in Phases 3-5.
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from app.config import config
from app.ollama_client import OllamaError, chat, list_models

app = FastAPI(title="data-cleanup ai-service")


@app.get("/health")
async def health():
    return {"status": "ok"}


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
