"""Fetch a URL and extract the main article text."""

import re
from dataclasses import dataclass

import trafilatura


@dataclass
class FetchedArticle:
    title: str
    text: str  # paragraphs separated by blank lines
    url: str | None = None


def fetch_url(url: str) -> FetchedArticle:
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        raise RuntimeError(f"Could not download {url}")
    text = trafilatura.extract(downloaded, favor_precision=True)
    if not text:
        raise RuntimeError(f"Could not extract article text from {url}")
    meta = trafilatura.extract_metadata(downloaded)
    title = (meta.title if meta and meta.title else "") or text.split("\n", 1)[0][:80]
    title = re.sub(r"\s*[|｜-]\s*(NHK.*|nachrichtenleicht\.de.*)$", "", title).strip()
    return FetchedArticle(title=title, text=text, url=url)


def from_text(text: str, title: str | None = None) -> FetchedArticle:
    text = text.strip()
    if not text:
        raise RuntimeError("Empty article text")
    if not title:
        title = text.split("\n", 1)[0][:80]
    return FetchedArticle(title=title, text=text)
