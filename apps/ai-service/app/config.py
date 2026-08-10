"""Process-level configuration, deliberately minimal.

Per docs/05-llm-prompting.md, the Ollama endpoint is a UI-editable setting
stored in Postgres (Settings.ollamaBaseUrl), not a static env var — callers
are expected to pass the current value from that table on each request.
DEFAULT_OLLAMA_BASE_URL here only seeds a fallback for local dev / the
health-check endpoint, matching the same default the Prisma Settings model
uses (apps/web/prisma/schema.prisma).
"""
from pydantic_settings import BaseSettings


class Config(BaseSettings):
    default_ollama_base_url: str = "http://devin-server:11434"
    default_ollama_model: str = "gemma4-e4b-262k:latest"

    class Config:
        env_prefix = "AI_SERVICE_"


config = Config()
