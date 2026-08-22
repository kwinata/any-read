"""Write article data into the PWA site directory and refresh the article index."""

import hashlib
import json
import re
from pathlib import Path


def slugify(title: str) -> str:
    ascii_part = re.sub(r"[^a-z0-9]+", "-", title.lower().encode("ascii", "ignore").decode()).strip("-")
    if len(ascii_part) >= 5:
        return ascii_part[:60]
    return "article-" + hashlib.sha1(title.encode()).hexdigest()[:10]


def write_article(articles_dir: Path, article: dict, audio: bytes | None) -> Path:
    d = articles_dir / article["id"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "article.json").write_text(
        json.dumps(article, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    if audio is not None:
        (d / "audio.mp3").write_bytes(audio)
    rebuild_index(articles_dir)
    return d


def rebuild_index(articles_dir: Path) -> None:
    entries = []
    for p in sorted(articles_dir.glob("*/article.json")):
        a = json.loads(p.read_text(encoding="utf-8"))
        entry = {k: a.get(k) for k in
                 ("id", "language", "title", "titleTranslation", "level", "summary", "createdAt")}
        entry["hasAudio"] = bool(a.get("audioFile"))
        entries.append(entry)
    entries.sort(key=lambda e: e.get("createdAt") or "", reverse=True)
    (articles_dir / "index.json").write_text(
        json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8"
    )
