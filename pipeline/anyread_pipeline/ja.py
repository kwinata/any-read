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


# Sudachi gives split-off numerals their standalone reading, but before a
# counter the reading often differs (七時 = しちじ not ななじ, 四月 = しがつ,
# 七日 = なのか).
_NUM_TIME = {"四": "よ", "七": "しち", "九": "く"}
_NUM_MONTH = {"四": "し", "七": "しち", "九": "く"}
_NUM_DAY = {"二": "ふつ", "三": "みっ", "四": "よっ", "五": "いつ",
            "六": "むい", "七": "なの", "八": "よう", "九": "ここの", "十": "とお"}


def _fix_counter_readings(tokens: list[dict]) -> list[dict]:
    for cur, nxt in zip(tokens, tokens[1:]):
        ns, nr = nxt["surface"], nxt.get("reading") or ""
        fix = None
        if ns.startswith("時") and nr.startswith("じ"):
            fix = _NUM_TIME.get(cur["surface"])
        elif ns.startswith("月") and nr.startswith("がつ"):
            fix = _NUM_MONTH.get(cur["surface"])
        elif ns == "日" and nr in ("にち", "か") and cur["surface"] in _NUM_DAY:
            # Sokuon readings (みっ) don't romanize alone; show the combined
            # romaji (mikka) under the number and none under 日.
            fix = _NUM_DAY[cur["surface"]]
            nxt["reading"] = "か"
            nxt["romaji"] = ""
            if cur.get("reading"):
                cur["reading"] = fix
            cur["romaji"] = _romaji(fix + "か")
            continue
        if fix and cur.get("reading") and cur["reading"] != fix:
            cur["reading"] = fix
            cur["romaji"] = _romaji(fix)
    return tokens


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
    return _fix_counter_readings(tokens)
