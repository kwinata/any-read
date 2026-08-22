"""Japanese tokenization: surface, kana reading, romaji, lemma, POS."""

import re

import pykakasi
from sudachipy import dictionary, tokenizer as sudachi_tokenizer

_tokenizer = None
_kks = pykakasi.kakasi()

_KANJI = re.compile(r"[一-鿿々〆ヶ]")
_JAPANESE = re.compile(r"[぀-ヿ一-鿿々〆ヶ]")

_POS_MAP = {
    "名詞": "noun",
    "代名詞": "pronoun",
    "動詞": "verb",
    "形容詞": "adjective",
    "形状詞": "adjective",
    "副詞": "adverb",
    "助詞": "particle",
    "助動詞": "auxiliary",
    "接続詞": "conjunction",
    "感動詞": "interjection",
    "連体詞": "prenominal",
    "接頭辞": "prefix",
    "接尾辞": "suffix",
    "補助記号": "punct",
    "記号": "symbol",
    "空白": "space",
}


def _get_tokenizer():
    global _tokenizer
    if _tokenizer is None:
        _tokenizer = dictionary.Dictionary().create()
    return _tokenizer


def _kata_to_hira(s: str) -> str:
    return "".join(
        chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s
    )


def _romaji(hira: str) -> str:
    return "".join(item["hepburn"] for item in _kks.convert(hira))


def tokenize(sentence: str) -> list[dict]:
    mode = sudachi_tokenizer.Tokenizer.SplitMode.C
    tokens = []
    for m in _get_tokenizer().tokenize(sentence, mode):
        surface = m.surface()
        if not surface.strip():
            continue
        pos_ja = m.part_of_speech()[0]
        pos = _POS_MAP.get(pos_ja, "other")
        tok: dict = {"surface": surface, "pos": pos}
        if pos in ("punct", "symbol", "space") or not _JAPANESE.search(surface):
            tokens.append(tok)
            continue
        reading = _kata_to_hira(m.reading_form())
        # Ruby (furigana) only makes sense when the surface contains kanji.
        if _KANJI.search(surface) and reading:
            tok["reading"] = reading
        tok["romaji"] = _romaji(reading or _kata_to_hira(surface))
        lemma = m.dictionary_form()
        if lemma and lemma != surface:
            tok["lemma"] = lemma
        tokens.append(tok)
    return tokens
