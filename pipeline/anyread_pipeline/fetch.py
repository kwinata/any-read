"""Fetch a URL and extract the main article text."""

import re
from dataclasses import dataclass

import trafilatura


@dataclass
class FetchedArticle:
    title: str
    text: str  # paragraphs separated by blank lines
    url: str | None = None
    generated: bool = False


def fetch_url(url: str) -> FetchedArticle:
    # Yahoo "pickup" pages are teasers; resolve to the full hosted article.
    if "news.yahoo.co.jp/pickup/" in url:
        page = trafilatura.fetch_url(url)
        m = re.search(r"https://news\.yahoo\.co\.jp/articles/[0-9a-f]+", page or "")
        if m:
            url = m.group(0)
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        raise RuntimeError(f"Could not download {url}")
    text = trafilatura.extract(downloaded, favor_precision=True)
    if not text:
        raise RuntimeError(f"Could not extract article text from {url}")
    meta = trafilatura.extract_metadata(downloaded)
    title = (meta.title if meta and meta.title else "") or text.split("\n", 1)[0][:80]
    title = clean_title(title)
    return FetchedArticle(title=title, text=text, url=url)


def clean_title(title: str) -> str:
    # Site-name suffixes ("... - NHK", "...（毎日新聞） - Yahoo!ニュース", "... | ...MATCHA...")
    title = re.sub(r"\s*[|｜-]\s*(NHK.*|nachrichtenleicht\.de.*|日本の観光メディア.*|.*MATCHA.*|Yahoo!ニュース.*)$", "", title)
    # Trailing publisher credit, possibly nested: 「...（FNN（フジテレビ系））」
    title = title.rstrip()
    while title.endswith("）"):
        depth, i = 0, len(title) - 1
        while i >= 0:
            if title[i] == "）":
                depth += 1
            elif title[i] == "（":
                depth -= 1
                if depth == 0:
                    break
            i -= 1
        if i < 0:
            break
        title = title[:i].rstrip()
    # Inline annotations: kana readings 訪(おとず)れる and English glosses ルート(route)
    title = re.sub(r"[(（][ぁ-ゖー]+[)）]", "", title)
    title = re.sub(r"[(（][A-Za-z0-9 ,''&-]+[)）]", "", title)
    # Collapse spaces; drop the word-spacing between Japanese characters
    title = re.sub(r"[ 　]+", " ", title)
    jc = "ぁ-ゖァ-ヺ一-龯ー々、。・「」！？"
    title = re.sub(rf"(?<=[{jc}]) (?=[{jc}])", "", title)
    title = re.sub(r"[(（] | [)）]", lambda m: m.group(0).strip(), title)
    return title.strip()


def from_text(text: str, title: str | None = None) -> FetchedArticle:
    text = text.strip()
    if not text:
        raise RuntimeError("Empty article text")
    if not title:
        title = text.split("\n", 1)[0][:80]
    return FetchedArticle(title=title, text=text)
