"""Pre-baked TTS via edge-tts: one MP3 per article, with per-sentence timings."""

import asyncio
import io

import edge_tts
from mutagen.mp3 import MP3

DEFAULT_VOICES = {"ja": "ja-JP-NanamiNeural", "de": "de-DE-KatjaNeural"}


async def _synthesize_one(text: str, voice: str, rate: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    audio = b""
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio += chunk["data"]
    if not audio:
        raise RuntimeError(f"edge-tts produced no audio for: {text[:60]}")
    return audio


def synthesize(sentences: list[str], lang: str, voice: str | None, rate: str) -> tuple[bytes, list[tuple[float, float]]]:
    """Returns (mp3_bytes, [(start_sec, end_sec) per sentence])."""
    voice = voice or DEFAULT_VOICES[lang]

    async def run():
        out = b""
        timings = []
        cursor = 0.0
        for i, sent in enumerate(sentences):
            audio = await _synthesize_one(sent, voice, rate)
            duration = MP3(io.BytesIO(audio)).info.length
            timings.append((round(cursor, 3), round(cursor + duration, 3)))
            cursor += duration
            out += audio
            print(f"  tts {i + 1}/{len(sentences)}", end="\r", flush=True)
        print()
        return out, timings

    return asyncio.run(run())
