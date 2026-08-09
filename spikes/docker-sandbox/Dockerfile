# The execution sandbox for LLM-generated scripts, per docs/06-security-sandboxing.md.
# Deliberately minimal: only what a Pandas cleaning script needs, nothing a
# malicious/buggy script could use to do more than it should.
FROM python:3.11-slim

RUN pip install --no-cache-dir pandas==2.2.2 openpyxl==3.1.2

# Non-root, unprivileged user — a script escaping its intended logic still
# can't touch anything owned by root or outside its mounted work directories.
RUN useradd --no-create-home --uid 10001 sandbox
USER sandbox

WORKDIR /work
