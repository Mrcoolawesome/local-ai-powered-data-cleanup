# House Call Pro — Job Attachments Scraper (v2, API-driven)

Logs into House Call Pro and pulls every job's attachments as full-size originals
using HCP's internal JSON APIs (no DOM clicking). Then packages them into ~25 GB
zip parts, verifying each part before deleting the originals to save disk space.

**v2 rewrite (2026-07-21):** the old DOM scraper broke when HCP changed job URLs
from `/pro/jobs/...` to `/app/jobs/...`. This version instead uses:

- `GET /alpha/jobs?page_size=200&page=N` — job list (id, invoice number, customer id)
- `GET /api/customers/{cus}/attachments?attachable_uuid={job}&attachable_type=Job`
  — per-job attachments, each with a presigned S3 `download_url` for the original

It is dramatically faster and immune to UI changes, but **respect the rate limit**:
more than ~6 concurrent API calls triggers a sustained 403 wall. The script uses
4 concurrent fetches with retry/backoff and a 120s cool-down if a batch mass-fails.

## Setup (one time)

```bash
pip3 install playwright python-dotenv requests
python3 -m playwright install chromium
```

## Configure

Create a `.env` file **in the same folder as the scripts** with:

```ini
COMPANY_NAME=Acme HVAC      # required — names the output folder & zips
HCP_EMAIL=user@company.com
HCP_PASSWORD=••••••
```

## Run

```bash
python3 api_scraper.py
```

- A Chrome window opens; complete 2FA if prompted (waits up to 3 min).
  The session is saved to `session.json` and reused on later runs.
- Progress is checkpointed (`progress.json`, `jobs_api_cache.json`) — safe to
  Ctrl-C and rerun; it resumes where it left off and retries failed jobs.
- Watch the `PROGRESS ... N errors` counter: errors are per-job API failures
  that will be retried on the next run. `RATE-LIMITED` lines mean back off.

## Package (zip + reclaim disk)

```bash
python3 chunk_zip.py
```

Zips completed job folders into `~/Downloads/{COMPANY_NAME} - HCP Job Attachments partN.zip`
(~25 GB each), CRC-verifies every file against the source, and only then deletes
the originals. Skips folders modified in the last 15 min, so it's safe to run
while the scraper is still going. Rerun after the scraper finishes to sweep up
the remainder (set `MIN_AGE = 0` for the final pass).

## Output

- Files while scraping: `output/{COMPANY_NAME}/{job_number}/{original_filename}`
- Final: `~/Downloads/{COMPANY_NAME} - HCP Job Attachments part1..N.zip`

## Notes

- Jobs whose customer was deleted return HTTP 422 "Customer is not present";
  spot-check those in the UI — in practice they have no attachments.
- Attachments cluster on recent jobs; old jobs are usually empty, so the scan
  speeds up dramatically once past the photo-heavy era.
- Never commit or share a `.env` — it holds live customer credentials.
