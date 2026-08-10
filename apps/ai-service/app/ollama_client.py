"""Thin wrapper around Ollama's native HTTP API.

Every function takes base_url explicitly rather than reading a module-level
global — the endpoint is a per-request value (the caller looks it up from
Settings.ollamaBaseUrl), never something this service should cache or
assume is fixed for its whole lifetime. See docs/05-llm-prompting.md.
"""
import httpx

DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=10.0, pool=5.0)


class OllamaError(Exception):
    """Raised when Ollama is unreachable or returns an error response."""


async def list_models(base_url: str) -> list[dict]:
    """Confirms connectivity and returns the models Ollama currently has pulled."""
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        try:
            resp = await client.get(f"{base_url}/api/tags")
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise OllamaError(f"Could not reach Ollama at {base_url}: {e}") from e
    return resp.json().get("models", [])


async def chat(base_url: str, model: str, messages: list[dict], options: dict | None = None) -> str:
    """Single non-streaming chat completion. Returns the assistant's text content."""
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        try:
            resp = await client.post(
                f"{base_url}/api/chat",
                json={
                    "model": model,
                    "messages": messages,
                    "stream": False,
                    "options": options or {},
                },
            )
            resp.raise_for_status()
        except httpx.HTTPError as e:
            raise OllamaError(f"Ollama chat request to {base_url} failed: {e}") from e
    return resp.json()["message"]["content"]
