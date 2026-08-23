"""Local-only broadcast articles: real published news audio + Whisper transcript.

Sources must be officially published audio (podcast RSS feeds, direct MP3s, or
article pages that embed their own MP3) — not ripped video platforms.
"""

import re
import ssl
import urllib.request

import certifi

AUDIO_EXT = (".mp3", ".m4a", ".aac", ".ogg")


def _http_get(url: str, binary: bool = False):
    ctx = ssl.create_default_context(cafile=certifi.where())
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    data = urllib.request.urlopen(req, timeout=60, context=ctx).read()
    return data if binary else data.decode("utf-8", "replace")


def resolve_audio(url: str) -> tuple[str, str | None]:
    """Return (audio_url, title_hint) for a direct file, RSS feed, or article page."""
    base = url.split("?")[0].lower()
    if base.endswith(AUDIO_EXT):
        return url, None
    body = _http_get(url)
    if "<rss" in body[:2000] or "<feed" in body[:2000]:
        # Latest enclosure in the feed
        item = re.search(r"<(item|entry)>.*?</\1>", body, re.S)
        if not item:
            raise RuntimeError("RSS feed has no items")
        chunk = item.group(0)
        enc = re.search(r'enclosure[^>]+url="([^"]+)"', chunk)
        title = re.search(r"<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</title>", chunk, re.S)
        if not enc:
            raise RuntimeError("Feed item has no audio enclosure")
        return enc.group(1), (title.group(1).strip() if title else None)
    # Article page: find an embedded audio file
    m = re.search(r'https?://[^"\'\s]+?\.(?:mp3|m4a|aac)(?:\?[^"\'\s]*)?', body)
    if not m:
        raise RuntimeError(f"No audio file found on {url}")
    title = re.search(r"<title>(.*?)</title>", body, re.S)
    return m.group(0), (title.group(1).strip() if title else None)


def download_audio(audio_url: str) -> bytes:
    data = _http_get(audio_url, binary=True)
    if len(data) < 10_000:
        raise RuntimeError(f"Suspiciously small audio ({len(data)} bytes)")
    return data


def transcribe(audio_path: str, lang: str, model_size: str = "medium") -> list[dict]:
    """Whisper transcription. Returns [{text, start, end}] per segment."""
    from faster_whisper import WhisperModel

    print(f"Loading Whisper {model_size} (first run downloads the model)...")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio_path, language=lang, vad_filter=True)
    out = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            out.append({"text": text, "start": round(seg.start, 3), "end": round(seg.end, 3)})
            print(f"  {seg.start:7.1f}s  {text[:60]}", flush=True)
    if not out:
        raise RuntimeError("Whisper produced no segments")
    return out


def group_paragraphs(segments: list[dict], gap: float = 1.5) -> list[list[dict]]:
    """Split segments into paragraphs at silence gaps."""
    paras: list[list[dict]] = [[segments[0]]]
    for prev, cur in zip(segments, segments[1:]):
        if cur["start"] - prev["end"] >= gap:
            paras.append([])
        paras[-1].append(cur)
    return paras
