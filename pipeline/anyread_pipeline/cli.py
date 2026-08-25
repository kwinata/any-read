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

    if args.simplify:
        print(f"Rewriting at {args.simplify} level...")
        simple = llm.simplify(lang, args.simplify, art.title, art.text)
        art.title, art.text = simple["title"], simple["text"]

    _process_article(art, lang, args, level_override=args.simplify)


def _generate(args) -> None:
    for i in range(args.count):
        if args.count > 1:
            print(f"--- generating {i + 1}/{args.count}")
        print(f"Asking Claude for an original {args.lang} article at {args.level}...")
        gen = llm.generate_article(args.lang, args.level, args.topic)
        art = fetch.FetchedArticle(title=gen["title"], text=gen["text"], generated=True)
        print(f"Title: {art.title}")
        _process_article(art, args.lang, args, level_override=args.level, extra_lang="id")


def _process_article(art, lang: str, args, level_override: str | None = None,
                     extra_lang: str | None = None) -> None:
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
    ann = llm.annotate(lang, art.title, flat_sentences, gloss_keys, extra_lang=extra_lang)
    if ann.get("titleTranslation"):
        ann["titleTranslation"] = re.sub(
            r"\s*(\([^)]*\))?\s*[-–]\s*(Yahoo! News|MATCHA.*)\s*$", "",
            ann["titleTranslation"])
    if level_override:
        ann["level"] = level_override
    glosses = ann["glosses"]
    glosses_id = ann.get("glossesId") or {}
    translations_id = ann.get("translationsId")
    i = 0
    for p in paras:
        for s in p["sentences"]:
            s["translation"] = ann["translations"][i]
            if translations_id:
                s["translationId"] = translations_id[i]
            i += 1
            for t in s["tokens"]:
                if t["pos"] in skip_gloss:
                    continue
                key = t.get("lemma") or t["surface"]
                g = glosses.get(key)
                if g:
                    t["gloss"] = g
                gi = glosses_id.get(key)
                if gi:
                    t["glossId"] = gi

    audio = None
    voice = args.voice or tts.pick_voice(lang, art.title)
    rate = args.rate
    if (level_override or "").lower() == "beginner" and rate == "-10%":
        rate = "-25%"  # beginners need slower narration than the default
    if not args.no_audio:
        print(f"Generating audio (edge-tts, {voice}, {rate})...")
        audio, timings = tts.synthesize(flat_sentences, lang, voice, rate)
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
        "titleTranslationId": ann.get("titleTranslationId"),
        "level": ann.get("level", ""),
        "summary": ann.get("summary", ""),
        "sourceUrl": art.url,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "audioFile": None if args.no_audio else "audio.mp3",
        "voice": None if args.no_audio else voice,
        "generated": art.generated,
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


def _broadcast(args) -> None:
    import os
    import tempfile

    from . import broadcast as bc

    audio_url, title_hint = bc.resolve_audio(args.source)
    print(f"Audio: {audio_url}")
    audio = bc.download_audio(audio_url)
    print(f"Downloaded {len(audio) // 1024} KB")

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tf:
        tf.write(audio)
        tmp = tf.name
    try:
        segs = bc.transcribe(tmp, args.lang, args.model)
    finally:
        os.unlink(tmp)

    title = fetch.clean_title(args.title or title_hint or segs[0]["text"][:60])
    lang = args.lang
    tokenize = ja.tokenize if lang == "ja" else de.tokenize
    skip_gloss = {"punct", "symbol", "space", "number"}

    paras = []
    flat: list[dict] = []
    for group in bc.group_paragraphs(segs):
        sents = []
        for seg in group:
            s = {"text": seg["text"], "tokens": tokenize(seg["text"]),
                 "audioStart": seg["start"], "audioEnd": seg["end"]}
            sents.append(s)
            flat.append(s)
        paras.append({"sentences": sents})
    print(f"{len(paras)} paragraphs, {len(flat)} sentences")

    # Annotate in chunks (radio bulletins can be long)
    CHUNK = 40
    first_ann = None
    glosses: dict = {}
    for i in range(0, len(flat), CHUNK):
        chunk = flat[i:i + CHUNK]
        keys, seen = [], set()
        for s in chunk:
            for t in s["tokens"]:
                if t["pos"] in skip_gloss:
                    continue
                k = t.get("lemma") or t["surface"]
                if k not in seen:
                    seen.add(k)
                    keys.append(k)
        print(f"Annotating sentences {i + 1}-{i + len(chunk)} ({len(keys)} vocab)...")
        ann = llm.annotate(lang, title, [s["text"] for s in chunk], keys)
        first_ann = first_ann or ann
        glosses.update(ann.get("glosses", {}))
        for s, tr in zip(chunk, ann["translations"]):
            s["translation"] = tr
    for s in flat:
        for t in s["tokens"]:
            if t["pos"] in skip_gloss:
                continue
            g = glosses.get(t.get("lemma") or t["surface"])
            if g:
                t["gloss"] = g

    article = {
        "schemaVersion": 1,
        "id": bundle.slugify(first_ann.get("titleTranslation") or title),
        "language": lang,
        "title": title,
        "titleTranslation": first_ann.get("titleTranslation", ""),
        "level": first_ann.get("level", ""),
        "summary": first_ann.get("summary", ""),
        "sourceUrl": args.source,
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "audioFile": "audio.mp3",
        "voice": "broadcast",
        "generated": False,
        "broadcast": True,
        "paragraphs": paras,
    }
    dest = bundle.write_article(Path(args.out), article, audio)
    print(f"Wrote {dest}  (local only — never published)")
    print("Run `anyread serve` and open the printed URL to read it.")


def _bundle(args) -> None:
    """Merge docs/ + local/articles into dist/ for a private (Netlify) deploy."""
    import shutil

    root = Path(__file__).resolve().parents[2]
    dist = root / "dist"
    if dist.exists():
        shutil.rmtree(dist)
    shutil.copytree(root / "docs", dist)
    local_articles = root / "local" / "articles"
    if local_articles.is_dir():
        for d in sorted(local_articles.iterdir()):
            if (d / "article.json").is_file():
                shutil.copytree(d, dist / "articles" / d.name, dirs_exist_ok=True)
    bundle.rebuild_index(dist / "articles")
    n = len(list((dist / "articles").glob("*/article.json")))
    print(f"Bundled {n} articles into {dist}")


def _serve(args) -> None:
    import http.server
    import json as _json
    import socket

    root = Path(__file__).resolve().parents[2]
    docs = root / "docs"
    local_articles = root / "local" / "articles"
    public_articles = docs / "articles"

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(docs), **kw)

        def log_message(self, *a):
            pass

        def _send_bytes(self, data: bytes, ctype: str):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = self.path.split("?")[0]
            if path == "/articles/index.json":
                entries = []
                for p in (public_articles / "index.json", local_articles / "index.json"):
                    if p.exists():
                        entries += _json.loads(p.read_text(encoding="utf-8"))
                entries.sort(key=lambda e: e.get("createdAt") or "", reverse=True)
                self._send_bytes(_json.dumps(entries, ensure_ascii=False).encode(),
                                 "application/json")
                return
            if path.startswith("/articles/"):
                rel = path[len("/articles/"):]
                f = local_articles / rel
                if f.is_file():
                    ctype = "audio/mpeg" if f.suffix == ".mp3" else "application/json"
                    self._send_bytes(f.read_bytes(), ctype)
                    return
            super().do_GET()

    server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    try:
        lan_ip = socket.gethostbyname(socket.gethostname())
    except OSError:
        lan_ip = "<your-lan-ip>"
    print(f"AnyRead (public + local broadcast articles):")
    print(f"  this Mac:  http://localhost:{args.port}")
    print(f"  phone on same wifi:  http://{lan_ip}:{args.port}")
    print("Ctrl-C to stop.")
    server.serve_forever()


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
    add.add_argument("--simplify", metavar="LEVEL",
                     help="Rewrite the article at a target level, e.g. N5 or A1")
    add.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "docs" / "articles"),
                     help="Output directory (default: <repo>/docs/articles)")
    gen = sub.add_parser("generate", help="Have Claude write an original graded article")
    gen.add_argument("--lang", choices=["ja", "de"], required=True)
    gen.add_argument("--level", required=True, help="Target level, e.g. N5 or A1")
    gen.add_argument("--topic", help="Topic (default: Claude picks one)")
    gen.add_argument("--count", type=int, default=1, help="How many articles to generate")
    gen.add_argument("--voice", help="edge-tts voice (default: per-article rotation)")
    gen.add_argument("--rate", default="-10%", help="Speech rate (default -10%%)")
    gen.add_argument("--no-audio", action="store_true", help="Skip TTS")
    gen.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "docs" / "articles"))
    bc = sub.add_parser("broadcast",
                        help="LOCAL-ONLY: real news audio (podcast/mp3/page) + Whisper transcript")
    bc.add_argument("source", help="Direct mp3 URL, podcast RSS feed (takes latest), or article page with audio")
    bc.add_argument("--lang", choices=["ja", "de"], required=True)
    bc.add_argument("--title", help="Override title")
    bc.add_argument("--model", default="medium", help="Whisper model size (default medium)")
    bc.add_argument("--out", default=str(Path(__file__).resolve().parents[2] / "local" / "articles"))
    sub.add_parser("bundle", help="Build dist/ (docs + local articles) for the private deploy")
    srv = sub.add_parser("serve", help="Serve the app locally incl. local-only broadcast articles")
    srv.add_argument("--port", type=int, default=8642)
    news = sub.add_parser("news", help="List recent headlines (Yahoo/Matcha / nachrichtenleicht)")
    news.add_argument("--lang", choices=["ja", "de"])
    news.add_argument("--limit", type=int, default=10)
    pub = sub.add_parser("publish", help="Commit and push new articles to the site")
    pub.add_argument("-m", "--message", default="Add articles")
    args = parser.parse_args()
    if args.cmd == "bundle":
        _bundle(args)
    elif args.cmd == "add":
        _build_article(args)
    elif args.cmd == "generate":
        _generate(args)
    elif args.cmd == "broadcast":
        _broadcast(args)
    elif args.cmd == "serve":
        _serve(args)
    elif args.cmd == "news":
        _list_news(args)
    elif args.cmd == "publish":
        _publish(args)


if __name__ == "__main__":
    main()
