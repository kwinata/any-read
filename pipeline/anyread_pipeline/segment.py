"""Split article text into paragraphs and sentences."""

import re

# Japanese sentence enders, keeping trailing closing quotes/brackets with the sentence.
_JA_SENT = re.compile(r"[^。！？!?…]*[。！？!?…]+[」』）\)]*|[^。！？!?…]+$")
# Latin-script: split after ./!/? followed by whitespace and an upper-case or quote start.
_DE_SENT = re.compile(r"(?<=[.!?])[\"»«”]?\s+(?=[\"„«»A-ZÄÖÜ0-9])")


def paragraphs(text: str) -> list[str]:
    paras = [p.strip() for p in re.split(r"\n\s*\n|\n", text)]
    return [p for p in paras if p]


def sentences(paragraph: str, lang: str) -> list[str]:
    if lang == "ja":
        found = [m.group(0).strip() for m in _JA_SENT.finditer(paragraph)]
        return [s for s in found if s]
    parts = _DE_SENT.split(paragraph)
    return [p.strip() for p in parts if p.strip()]


def detect_lang(text: str) -> str:
    """Distinguish ja from de by script; good enough for this pipeline."""
    ja_chars = len(re.findall(r"[぀-ヿ一-鿿]", text))
    return "ja"
