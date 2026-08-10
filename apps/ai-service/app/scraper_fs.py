"""Reads scraper README content from the shared scrapers mount
(docs/03-ingestion-and-scrapers.md). Un-sandboxed — reading a text file is
a narrower operation than executing anything, same reasoning as
schema_inference.py.
"""
import os

from app.config import config


class ScraperFsError(Exception):
    pass


def read_readme(readme_relative_path: str) -> str:
    path = os.path.join(config.scrapers_root, readme_relative_path)
    if not os.path.exists(path):
        raise ScraperFsError(f"No README at {readme_relative_path}")
    with open(path, encoding="utf-8") as f:
        return f.read()


# A "cp X.env.example X.env, fill in your email/password" setup step is a
# common real-world pattern (found for real: HouseCallPro-Exporter's README
# says exactly this) — the actual KEY=value variable names then live in
# that example file, not spelled out in the README's own prose. Without
# this, the planning LLM (which only ever saw the README text) has no way
# to know the real variable names and correctly declines to guess
# (docs/05-llm-prompting.md's "do not invent"), which is the right call
# given only the README — but means credentials_env_filename/template come
# back null even though the scraper clearly does take a login. Reading
# this file too, when present, closes that gap.
_CREDENTIALS_EXAMPLE_SUFFIXES = (".env.example", ".env.sample", ".env.template", ".env.dist")


def find_credentials_example_file(scraper_dir_relative_path: str) -> tuple[str, str] | None:
    scraper_dir = os.path.join(config.scrapers_root, scraper_dir_relative_path)
    if not os.path.isdir(scraper_dir):
        return None
    for name in sorted(os.listdir(scraper_dir)):
        full_path = os.path.join(scraper_dir, name)
        if not os.path.isfile(full_path):
            continue
        if name.lower().endswith(_CREDENTIALS_EXAMPLE_SUFFIXES):
            with open(full_path, encoding="utf-8") as f:
                return name, f.read()
    return None


# Writes a scraper's login credentials into its own directory, in whatever
# filename/format that specific scraper's README documents — extracted by
# the planning LLM as credentials_env_filename/credentials_env_template
# (app/prompting.py), never hardcoded, since different scrapers use
# different filenames and variable names for the same email/password pair
# (docs/03-ingestion-and-scrapers.md's "no per-platform special-casing").
# Un-sandboxed like read_readme above — this only ever touches one file
# inside one scraper's own directory, not arbitrary execution.
def write_credentials_env(scraper_dir_relative_path: str, env_filename: str, env_template: str, email: str, password: str) -> None:
    if os.path.basename(env_filename) != env_filename or env_filename in ("", ".", ".."):
        raise ScraperFsError(f"Invalid credentials filename from plan: {env_filename!r}")

    scraper_dir = os.path.join(config.scrapers_root, scraper_dir_relative_path)
    resolved_dir = os.path.realpath(scraper_dir)
    scrapers_root = os.path.realpath(config.scrapers_root)
    if not resolved_dir.startswith(scrapers_root + os.sep):
        raise ScraperFsError(f"Refusing to write outside the scrapers root: {scraper_dir_relative_path}")
    if not os.path.isdir(scraper_dir):
        raise ScraperFsError(f"No scraper directory at {scraper_dir_relative_path}")

    content = env_template.replace("{{EMAIL}}", email).replace("{{PASSWORD}}", password)
    dest_path = os.path.join(scraper_dir, env_filename)
    with open(dest_path, "w", encoding="utf-8") as f:
        f.write(content)
