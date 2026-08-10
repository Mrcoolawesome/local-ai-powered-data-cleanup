# The execution sandbox for LLM-generated cleaning scripts. Same image
# spikes/docker-sandbox proved (9/9 checks: file I/O, network isolation,
# timeout enforcement, read-only mounts) — built here so the real
# ai-service can produce it itself on first use (see app/sandbox.py),
# rather than requiring a separate manual build step.
FROM python:3.11-slim

RUN pip install --no-cache-dir pandas==2.2.2 openpyxl==3.1.2

RUN useradd --no-create-home --uid 10001 sandbox
USER sandbox

WORKDIR /work
