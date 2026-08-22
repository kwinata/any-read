"""Translation + glossing via the `claude` CLI (uses your existing login)."""

import json
import os
import subprocess

_LANG_NAME = {"ja": "Japanese", "de": "German"}
_LEVEL_SCALE = {"ja": "JLPT (N5 easiest .. N1 hardest)", "de": "CEFR (A1 .. C2)"}


def _run_claude(prompt: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
    proc = subprocess.run(
        ["claude", "-p", "--output-format", "text", "--model", "sonnet"],
        input=prompt,
        capture_output=True,
        text=True,
        timeout=900,
        env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"claude CLI failed: {proc.stderr.strip()[:500]}")
    return proc.stdout


def _extract_json(raw: str) -> dict:
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end <= start:
        raise ValueError(f"No JSON object in claude output: {raw[:200]}")
    return json.loads(raw[start : end + 1])


def annotate(lang: str, title: str, sentences: list[str], gloss_keys: list[str]) -> dict:
    """Returns {titleTranslation, level, summary, translations: [str], glosses: {key: gloss}}."""
    lang_name = _LANG_NAME[lang]
    numbered = "\n".join(f"{i}\t{s}" for i, s in enumerate(sentences))
    keys = "\n".join(gloss_keys)
    prompt = f"""You are annotating a {lang_name} news article for a language learner's reading app.

Article title: {title}

Sentences (index TAB sentence):
{numbered}

Vocabulary items to gloss (dictionary/base forms, one per line):
{keys}

Reply with ONLY a JSON object, no markdown fences, with exactly these keys:
- "titleTranslation": natural English translation of the title
- "level": estimated difficulty on the {_LEVEL_SCALE[lang]} scale, e.g. "{ "N3" if lang == "ja" else "B1" }"
- "summary": one-sentence English summary of the article
- "translations": array with one natural English translation per sentence, same order and same length as the sentence list ({len(sentences)} items)
- "glosses": object mapping EVERY vocabulary item above (exact string as given) to a short English gloss (a few words; for function words explain the role, e.g. "は": "topic marker")
"""
    for attempt in range(2):
        raw = _run_claude(prompt)
        try:
            data = _extract_json(raw)
            translations = data["translations"]
            if len(translations) != len(sentences):
                raise ValueError(
                    f"Got {len(translations)} translations for {len(sentences)} sentences"
                )
            data.setdefault("glosses", {})
            return data
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            if attempt == 1:
                raise RuntimeError(f"LLM annotation failed: {e}") from e
            prompt += f"\n\nYour previous reply was invalid ({e}). Reply with only the JSON object."
    raise AssertionError("unreachable")
