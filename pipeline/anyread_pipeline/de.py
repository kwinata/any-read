"""German tokenization: words stay tappable, punctuation stays inline."""

import re

_TOKEN = re.compile(r"[A-Za-zÄÖÜäöüß]+(?:[-'][A-Za-zÄÖÜäöüß]+)*|\d+(?:[.,]\d+)*|\S", re.UNICODE)
_WORD = re.compile(r"[A-Za-zÄÖÜäöüß]")


def tokenize(sentence: str) -> list[dict]:
    tokens = []
    for m in _TOKEN.finditer(sentence):
        surface = m.group(0)
        if _WORD.search(surface):
            tokens.append({"surface": surface, "pos": "word"})
        elif surface.isdigit() or re.match(r"\d", surface):
            tokens.append({"surface": surface, "pos": "number"})
        else:
            tokens.append({"surface": surface, "pos": "punct"})
    return tokens
