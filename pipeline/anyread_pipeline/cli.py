"""anyread — turn a news article into an annotated, narrated AnyRead bundle.

Usage:
  anyread add https://www3.nhk.or.jp/news/easy/...      # fetch, annotate, narrate
  anyread add --text-file article.txt --title "Titel"   # from a local file
  cat article.txt | anyread add --stdin
"""

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import bundle, de, fetch, ja, llm, segment, tts


def _build_article(args) -> None:
    if args.source and args.source.startswith("http"):
        art = fetch.fetch_url(args.source)
    elif args.text_file:
        art = fetch.from_text(Path(args.text_file).read_text(encoding="utf-8"), args.title)
    elif args.stdin:
        art = fetch.from_text(sys.stdin.read(), args.title)
    else:
        raise SystemExit("Give a URL, --text-file, or --stdin (see anyread add -h)")
    if args.title:
        art.title = args.title

    lang = args.lang or segment.detect_lang(art.text)
    print(f"Language: {lang}  Title: {art.title}")

    if art.url and not args.no_tidy:
        print("Tidying extracted text (removing page boilerplate)...")
        art.text = llm.tidy(art.title, art.text)

    tokenize = ja.tokenize if lang == "ja" else de.tokenize
    paras = []
    flat_sentences: list[str] = []
    for p in segment.paragraphs(art.text):
        sents = []
        for s in segment.sentences(p, lang):
            sents.append({"text": s, "tokens": tokenize(s)})
            flat_sentences.append(s)
        if sents:
            paras.append({"sentences": sents})
    if not flat_sentences:
        raise SystemExit("No sentences found in article")
    print(f"{len(paras)} paragraphs, {len(flat_sentences)} sentences")

    skip_gloss = {"punct", "symbol", "space", "number"}
    gloss_keys: list[str] = []
    seen = set()
    for p in paras:
        for s in p["sentences"]:
            for t in s["tokens"]:
                if t["pos"] in skip_gloss:
                    continue
                key = t.get("lemma") or t["surface"]
                if key not in seen:
                    seen.add(key)
                    gloss_keys.append(key)

    print(f"Annotating with Claude ({len(gloss_keys)} vocab items)...")
    ann = llm.annotate(lang, art.title, flat_sentences, gloss_keys)
    glosses = ann["glosses"]
    i = 0
    for p in paras:
        for s in p["sentences"]:
            s["translation"] = ann["translations"][i]
            i += 1
            for t in s["tokens"]:
                if t["pos"] in skip_gloss:
                    continue
                g = glosses.get(t.get("lemma") or t["surface"])
                if g:
                    t["gloss"] = g

    audio = None
    if not args.no_audio:
        print("Generating audio (edge-tts)...")
        audio, timings = tts.synthesize(flat_sentences, lang, args.voice, args.rate)
        i = 0
        for p in paras:
            for s in p["sentences"]:
                s["audioStart"], s["audioEnd"] = timings[i]
                i += 1

    article = {
        "schemaVersion": 1,
        "id": bundle.slugify(ann.get("titleTranslation") or art.title),
        "language": lang,
        "title": art.title,
        "titleTranslation": ann.get("titleTranslation", ""),
        "level": ann.get("level", ""),
        "summary": ann.get("summary", ""),
        "sourceUrl": art.url,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "audioFile": None if args.no_audio else "audio.mp3",
        "paragraphs": paras,
    }

    out_dir = Path(args.out)
    dest = bundle.write_article(out_dir, article, audio)
    print(f"Wrote {dest}")
    print("Run `anyread publish` to push it to the site.")


def _http_get(url: str) -> str:
    import ssl
    import urllib.request

    import certifi

    ctx = ssl.create_default_context(cafile=certifi.where())
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=30, context=ctx).read().decode("utf-8", "replace")


_NL_NOT_ARTICLES = re.compile(
    r"/(benutzung|erklaerung|regionale-angebote|das-grundgesetz"
    r"|nachrichten|sport|kultur-und-wissen|vermischtes"
    r"|nachrichtenleicht-link-auf-instagram|podcast-[a-z0-9-]+|[a-z0-9-]*woerterbuch[a-z0-9-]*)-100\.html$"
)


def list_ja_news(limit: int = 10) -> list[tuple[str, str]]:
    """(title, url): Yahoo News briefs plus Matcha easy-Japanese articles.

    (NHK moved article bodies behind the authenticated NHK ONE app in 2026,
    so its pages only serve teasers now.)
    """
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    n_easy = max(1, limit // 3)  # a third from Matcha (easier level)
    try:
        html = _http_get("https://matcha-jp.com/easy")
        for url in dict.fromkeys(re.findall(r'https://matcha-jp\.com/easy/\d+', html)):
            out.append(("(easy) " + url.rsplit("/", 1)[-1], url))
            if len(out) >= n_easy:
                break
    except Exception:
        pass
    for feed in ("top-picks", "domestic", "science", "world", "business", "it"):
        if len(out) >= limit:
            break
        try:
            xml = _http_get(f"https://news.yahoo.co.jp/rss/topics/{feed}.xml")
        except Exception:
            continue
        for item in re.findall(r"<item>.*?</item>", xml, re.S):
            title = re.search(r"<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", item, re.S)
            link = re.search(r"<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</link>", item, re.S)
            if not (title and link):
                continue
            url = link.group(1).strip().split("?")[0]
            if "/pickup/" not in url or url in seen:
                continue
            seen.add(url)
            out.append((title.group(1).strip(), url))
            if len(out) >= limit:
                break
    return out


def list_de_news(limit: int = 10) -> list[tuple[str, str]]:
    """(title, url) from nachrichtenleicht: homepage plus category pages."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    pages = ["", "nachrichten-100.html", "kultur-und-wissen-100.html",
             "sport-100.html", "vermischtes-100.html"]
    for page in pages:
        if len(out) >= limit:
            break
        try:
            html = _http_get("https://www.nachrichtenleicht.de/" + page)
        except Exception:
            continue
        for url in re.findall(r'https://www\.nachrichtenleicht\.de/[a-z0-9-]+-100\.html', html):
            if url in seen or _NL_NOT_ARTICLES.search(url):
                continue
            seen.add(url)
            title = url.rsplit("/", 1)[-1].removesuffix("-100.html").replace("-", " ")
            out.append((title, url))
            if len(out) >= limit:
                break
    return out


def _list_news(args) -> None:
    langs = [args.lang] if args.lang else ["ja", "de"]
    if "ja" in langs:
        print("--- ja (NHK) ---")
        for title, url in list_ja_news(args.limit):
            print(f"{title}\n  {url}")
    if "de" in langs:
        print("--- de (nachrichtenleicht) ---")
        for title, url in list_de_news(args.limit):
            print(f"{title}\n  {url}")


def _publish(args) -> None:
    import subprocess

    root = Path(__file__).resolve().parents[2]

    def git(*cmd, check=True):
        return subprocess.run(["git", "-C", str(root), *cmd], check=check,
                              capture_output=True, text=True)

    git("add", "-A")
    commit = git("commit", "-m", args.message, check=False)
    if commit.returncode != 0:
        if "nothing to commit" in commit.stdout + commit.stderr:
            print("Nothing new to publish.")
            return
        raise SystemExit(commit.stderr.strip() or commit.stdout.strip())
    git("push")
    print("Published. The site updates in a minute or two.")


def main() -> None:
    parser = argparse.ArgumentParser(prog="anyread", description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)
    add = sub.add_parser("add", help="Create a bundle from a URL or text")
    add.add_argument("source", nargs="?", help="Article URL")
    add.add_argument("--text-file", help="Read article text from a file instead")
    add.add_argument("--stdin", action="store_true", help="Read article text from stdin")
    add.add_argument("--title", help="Override the article title")
    add.add_argument("--lang", choices=["ja", "de"], help="Force language (default: auto-detect)")
    add.add_argument("--voice", help="edge-tts voice (default per language)")
    add.add_argument("--rate", default="-10%", help="Speech rate, e.g. '-20%%' (default -10%%)")
    add.add_argument("--no-audio", action="store_true", help="Skip TTS")
    add.add_argument("--no-tidy", action="store_true", help="Skip LLM cleanup of extracted text")
    add.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "docs" / "articles"),
                     help="Output directory (default: <repo>/docs/articles)")
    news = sub.add_parser("news", help="List recent headlines (NHK / nachrichtenleicht)")
    news.add_argument("--lang", choices=["ja", "de"])
    news.add_argument("--limit", type=int, default=10)
    pub = sub.add_parser("publish", help="Commit and push new articles to the site")
    pub.add_argument("-m", "--message", default="Add articles")
    args = parser.parse_args()
    if args.cmd == "add":
        _build_article(args)
    elif args.cmd == "news":
        _list_news(args)
    elif args.cmd == "publish":
        _publish(args)


if __name__ == "__main__":
    main()
