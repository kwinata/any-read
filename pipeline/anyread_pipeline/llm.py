"""Translation + glossing via the `claude` CLI (uses your existing login)."""

import json
import os
import subprocess

_LANG_NAME = {"ja": "Japanese", "de": "German"}
_LEVEL_SCALE = {"ja": "JLPT (Beginner = pre-N5 easiest, then N5 .. N1 hardest)",
                "de": "CEFR (A1 .. C2)"}


def _run_claude(prompt: str, model: str = "sonnet") -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE")}
    proc = subprocess.run(
        ["claude", "-p", "--output-format", "text", "--model", model],
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


def tidy(title: str, text: str) -> str:
    """Strip navigation/boilerplate that the HTML extractor let through."""
    prompt = f"""Below is text extracted from a news webpage. It is the body of the article
titled: {title}

Some lines are NOT part of the article: navigation labels, app or newsletter promotions,
related-article teasers (e.g. lines starting with 【画像】 or 【動画】), category names,
share buttons, photo credits, stray fragments, or the bare site name. Remove those lines.

Additionally, if the text contains inline learning annotations in parentheses — kana
readings or English glosses attached to words, e.g. 日本(にほん) or 秘密(secret) — remove
the parenthetical annotation and keep just the word: 日本(にほん) becomes 日本. Also remove
stray spaces WITHIN Japanese sentences that only existed to separate those annotations.

Otherwise keep every sentence of the article body VERBATIM — do not rewrite, reorder,
translate, shorten, or add anything. Keep the original paragraph breaks (paragraphs
separated by a blank line). Reply with ONLY the cleaned article text.

Text:
{text}"""
    cleaned = _run_claude(prompt, model="haiku").strip()
    # If the model went off the rails, fall back to the raw extraction.
    if len(cleaned) < 100 or len(cleaned) < 0.3 * len(text):
        return text
    return cleaned


def simplify(lang: str, level: str, title: str, text: str) -> dict:
    """Rewrite an article at a target learner level. Returns {title, text}."""
    lang_name = _LANG_NAME[lang]
    prompt = f"""Rewrite this {lang_name} news article for a language learner at {level} level
({_LEVEL_SCALE[lang]} scale). Rules:
- Keep all the important facts; it stays a faithful news article, not a summary.
- Use only vocabulary and grammar appropriate for {level}. Short, simple sentences.
- Write entirely in {lang_name}.
- Also rewrite the title at the same level.

Title: {title}

Article:
{text}

Reply with ONLY a JSON object: {{"title": "...", "text": "..."}} where "text" uses \\n\\n between paragraphs."""
    for attempt in range(2):
        raw = _run_claude(prompt)
        try:
            data = _extract_json(raw)
            if data.get("title") and data.get("text"):
                return data
            raise ValueError("missing title or text")
        except (ValueError, json.JSONDecodeError) as e:
            if attempt == 1:
                raise RuntimeError(f"LLM simplify failed: {e}") from e
            prompt += f"\n\nYour previous reply was invalid ({e}). Reply with only the JSON object."
    raise AssertionError("unreachable")


_BEGINNER_RULES = """- "Beginner" means EASIER than JLPT N5: absolute first-steps Japanese.
  Only the most common everyday vocabulary (roughly the first 150 words a learner meets),
  only です/ます sentences in present or simple past, particles limited to は・が・を・に・で・と・も・か.
  Sentences of 3-8 words each. 2-3 short paragraphs, about 8-12 sentences total is enough.
  Everyday kanji are fine (the app shows furigana), but keep the words themselves simple."""


def generate_article(lang: str, level: str, topic: str | None) -> dict:
    """Have Claude write an original graded article. Returns {title, text}."""
    lang_name = _LANG_NAME[lang]
    topic_line = (f"Topic: {topic}"
                  if topic else
                  "Pick one interesting, concrete topic yourself (culture, daily life, food, "
                  "travel, nature, science basics, history). Avoid current events.")
    prompt = f"""Write an ORIGINAL short article in {lang_name} for a language learner at {level} level
({_LEVEL_SCALE[lang]} scale). This is for a graded-reader app.

{topic_line}

Rules:
- Written entirely in {lang_name}, in the style of an easy-news / magazine article.
- Vocabulary and grammar strictly appropriate for {level}. Short, clear sentences.
- 3-5 paragraphs, about 10-16 sentences total.
- Informative and true-to-life; do NOT invent news events, statistics, or named people.
{_BEGINNER_RULES if level.lower() == "beginner" else ""}

Reply with ONLY a JSON object: {{"title": "...", "text": "..."}} where "text" uses \\n\\n between paragraphs."""
    for attempt in range(2):
        raw = _run_claude(prompt)
        try:
            data = _extract_json(raw)
            if data.get("title") and data.get("text"):
                return data
            raise ValueError("missing title or text")
        except (ValueError, json.JSONDecodeError) as e:
            if attempt == 1:
                raise RuntimeError(f"LLM generate failed: {e}") from e
            prompt += f"\n\nYour previous reply was invalid ({e}). Reply with only the JSON object."
    raise AssertionError("unreachable")


def annotate(lang: str, title: str, sentences: list[str], gloss_keys: list[str],
             extra_lang: str | None = None) -> dict:
    """Returns {titleTranslation, level, summary, translations: [str], glosses: {key: gloss}}.

    With extra_lang="id", also returns titleTranslationId, translationsId, glossesId
    (Indonesian versions of the same fields).
    """
    lang_name = _LANG_NAME[lang]
    numbered = "\n".join(f"{i}\t{s}" for i, s in enumerate(sentences))
    keys = "\n".join(gloss_keys)
    extra = ""
    if extra_lang == "id":
        extra = f"""- "titleTranslationId": natural Indonesian translation of the title
- "translationsId": array with one natural Indonesian translation per sentence, same order and same length ({len(sentences)} items)
- "glossesId": object mapping EVERY vocabulary item above to a short Indonesian gloss (e.g. "水": "air"; for function words explain the role, e.g. "は": "penanda topik")
"""
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
{extra}"""
    for attempt in range(2):
        raw = _run_claude(prompt)
        try:
            data = _extract_json(raw)
            translations = data["translations"]
            if len(translations) != len(sentences):
                raise ValueError(
                    f"Got {len(translations)} translations for {len(sentences)} sentences"
                )
            if extra_lang == "id":
                tid = data.get("translationsId")
                if not tid or len(tid) != len(sentences):
                    raise ValueError(
                        f"Got {len(tid) if tid else 0} Indonesian translations "
                        f"for {len(sentences)} sentences"
                    )
                data.setdefault("glossesId", {})
            data.setdefault("glosses", {})
            return data
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            if attempt == 1:
                raise RuntimeError(f"LLM annotation failed: {e}") from e
            prompt += f"\n\nYour previous reply was invalid ({e}). Reply with only the JSON object."
    raise AssertionError("unreachable")
