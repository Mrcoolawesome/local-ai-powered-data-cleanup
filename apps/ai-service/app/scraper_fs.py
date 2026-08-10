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
