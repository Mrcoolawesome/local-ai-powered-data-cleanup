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

    # /app/storage inside this container — used for ai-service's own file
    # reads/writes.
    storage_root: str = "/app/storage"
    # The SAME directory's absolute path on the Docker host — required to
    # launch sandbox containers as siblings of this one (Docker-outside-of-
    # Docker; see docker-compose.yml's ai-service.environment comment and
    # docs/11-deployment.md). Not set in local non-Docker dev, where the
    # sandbox executor isn't exercised anyway.
    host_storage_path: str | None = None

    # Real scraper installs (docs/03-ingestion-and-scrapers.md) — same
    # container-path / host-path split as storage_root/host_storage_path
    # above, same Docker-outside-of-Docker reason.
    scrapers_root: str = "/app/scrapers"
    host_scrapers_path: str | None = None

    # Optional: name/id of an already-running VPN container (e.g. a
    # Gluetun sidecar) whose network namespace scraper containers should
    # join instead of the default bridge network — moves a scraper's
    # traffic onto that container's IP without this app touching or
    # depending on how that VPN container itself is configured. None
    # (the default) leaves scrapers on the plain default network, exactly
    # as before this setting existed.
    scraper_vpn_container: str | None = None

    class Config:
        env_prefix = "AI_SERVICE_"


config = Config()
