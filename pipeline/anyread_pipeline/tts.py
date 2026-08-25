"""Pre-baked TTS via edge-tts: one MP3 per article, with per-sentence timings."""

import asyncio
import io

import edge_tts
from mutagen.mp3 import MP3

VOICE_POOLS = {
    # ja-JP has only two native neural voices; the multilingual voices speak
    # natural Japanese too, giving listening variety.
    "ja": ["ja-JP-NanamiNeural", "ja-JP-KeitaNeural",
           "en-US-AvaMultilingualNeural", "en-US-AndrewMultilingualNeural",
           "en-US-EmmaMultilingualNeural", "en-US-BrianMultilingualNeural",
           "de-DE-SeraphinaMultilingualNeural", "fr-FR-VivienneMultilingualNeural"],
    "de": ["de-DE-KatjaNeural", "de-DE-ConradNeural", "de-DE-AmalaNeural",
           "de-DE-KillianNeural", "de-DE-SeraphinaMultilingualNeural",
           "de-DE-FlorianMultilingualNeural"],
}
DEFAULT_VOICES = {"ja": VOICE_POOLS["ja"][0], "de": VOICE_POOLS["de"][0]}


def pick_voice(lang: str, key: str) -> str:
    """Stable per-article voice choice, varied across articles."""
    import hashlib

    pool = VOICE_POOLS[lang]
    return pool[int(hashlib.sha1(key.encode()).hexdigest(), 16) % len(pool)]


async def _synthesize_one(text: str, voice: str, rate: str) -> bytes:
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    audio = b""
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio += chunk["data"]
    if not audio:
        raise RuntimeError(f"edge-tts produced no audio for: {text[:60]}")
    return audio


def synthesize(sentences: list[str], lang: str, voice: str | None, rate: str,
               voices: list[str] | None = None) -> tuple[bytes, list[tuple[float, float]]]:
    """Returns (mp3_bytes, [(start_sec, end_sec) per sentence]).

    `voices` optionally overrides the voice per sentence (same length as sentences).
    """
    voice = voice or DEFAULT_VOICES[lang]

    async def run():
        out = b""
        timings = []
        cursor = 0.0
        for i, sent in enumerate(sentences):
            audio = await _synthesize_one(sent, (voices[i] if voices else voice), rate)
            duration = MP3(io.BytesIO(audio)).info.length
            timings.append((round(cursor, 3), round(cursor + duration, 3)))
            cursor += duration
            out += audio
            print(f"  tts {i + 1}/{len(sentences)}", end="\r", flush=True)
        print()
        return out, timings

    return asyncio.run(run())
