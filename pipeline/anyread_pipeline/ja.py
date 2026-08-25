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
# Particles pronounced differently from their kana (Hepburn: wa, e, o)
_PARTICLE_ROMAJI = {"は": "wa", "へ": "e", "を": "o"}

_DIGITS = re.compile(r"^[0-9０-９]+$")
_SMALL_NUM = {1: "いち", 2: "に", 3: "さん", 4: "よん", 5: "ご",
              6: "ろく", 7: "なな", 8: "はち", 9: "きゅう"}
_HUNDREDS = {1: "ひゃく", 2: "にひゃく", 3: "さんびゃく", 4: "よんひゃく", 5: "ごひゃく",
             6: "ろっぴゃく", 7: "ななひゃく", 8: "はっぴゃく", 9: "きゅうひゃく"}
_THOUSANDS = {1: "せん", 2: "にせん", 3: "さんぜん", 4: "よんせん", 5: "ごせん",
              6: "ろくせん", 7: "ななせん", 8: "はっせん", 9: "きゅうせん"}


def _std_kana(n: int) -> str:
    """Standard kana reading for a number (0..99,999,999)."""
    if n == 0:
        return "ゼロ"
    parts = []
    man, rem = divmod(n, 10000)
    if man:
        parts.append(("" if man == 1 else _std_kana(man)) + ("いち" if man == 1 else "") + "まん")
    th, rem = divmod(rem, 1000)
    if th:
        parts.append(_THOUSANDS[th])
    hu, rem = divmod(rem, 100)
    if hu:
        parts.append(_HUNDREDS[hu])
    te, unit = divmod(rem, 10)
    if te:
        parts.append(("" if te == 1 else _SMALL_NUM[te]) + "じゅう")
    if unit:
        parts.append(_SMALL_NUM[unit])
    return "".join(parts)


# Date readings for <digits>日 (the rest read <number>にち)
_DAY_KANA = {2: "ふつ", 3: "みっ", 4: "よっ", 5: "いつ", 6: "むい", 7: "なの",
             8: "よう", 9: "ここの", 10: "とお", 14: "じゅうよっ", 20: "はつ",
             24: "にじゅうよっ"}
# Counters that trigger sound changes. Value: {unit-digit: (tail swap, counter reading)}
# 0 means the number ends in 10 (じゅう→じゅっ).
_P = {"ふん": "ぷん", "ほん": "ぽん", "はい": "ぱい", "ひき": "ぴき"}
_B = {"ほん": "ぼん", "はい": "ばい", "ひき": "びき"}


def _counter_number(n: int, counter: str) -> tuple[str, str | None]:
    """(number kana, counter reading override) for <digits><counter>."""
    k = _std_kana(n)
    unit = n % 10
    tail10 = k.endswith("じゅう")

    def swap(old: str, new: str) -> str:
        return k[: len(k) - len(old)] + new if k.endswith(old) else k

    if counter == "がつ" and n in (4, 7, 9):
        return {4: "し", 7: "しち", 9: "く"}[n], None
    if counter == "じ":
        return swap("よん", "よ") if unit == 4 else \
            swap("なな", "しち") if unit == 7 else \
            swap("きゅう", "く") if unit == 9 else k, None
    if counter == "ねん" and unit == 4:
        return swap("よん", "よ"), None
    if counter == "にん":
        return (swap("よん", "よ") if unit == 4 else k), None
    if counter in _P:  # ふん・ほん・はい・ひき — always return the counter reading
        pr = _P[counter]
        if unit == 1:
            return swap("いち", "いっ"), pr
        if unit == 3:
            return k, (pr if counter == "ふん" else _B[counter])
        if unit == 4 and counter == "ふん":
            return k, pr
        if unit == 6:
            return swap("ろく", "ろっ"), pr
        if unit == 8:
            return swap("はち", "はっ"), pr
        if unit == 0 and tail10:
            return swap("じゅう", "じゅっ"), pr
        return k, counter
    if counter in ("こ", "かい"):
        if unit == 1:
            return swap("いち", "いっ"), None
        if unit == 6:
            return swap("ろく", "ろっ"), None
        if unit == 8:
            return swap("はち", "はっ"), None
        if unit == 0 and tail10:
            return swap("じゅう", "じゅっ"), None
        return k, None
    if counter in ("さい", "さつ"):
        if unit == 1:
            return swap("いち", "いっ"), None
        if unit == 8:
            return swap("はち", "はっ"), None
        if unit == 0 and tail10:
            return swap("じゅう", "じゅっ"), None
        return k, None
    return k, None


_TSU_KANA = {1: "ひと", 2: "ふた", 3: "みっ", 4: "よっ", 5: "いつ",
             6: "むっ", 7: "なな", 8: "やっ", 9: "ここの"}

# Counter identified by its SURFACE (Sudachi's per-context counter reading can be
# wrong, e.g. 3本 → ぽん); the reading just confirms it is that counter.
_SURFACE_COUNTER = {"分": "ふん", "本": "ほん", "杯": "はい", "匹": "ひき",
                    "時": "じ", "月": "がつ", "年": "ねん", "人": "にん",
                    "個": "こ", "回": "かい", "歳": "さい", "才": "さい", "冊": "さつ"}
_COUNTER_OK = {"ふん": ("ふん", "ぷん"), "ほん": ("ほん", "ぼん", "ぽん"),
               "はい": ("はい", "ばい", "ぱい"), "ひき": ("ひき", "びき", "ぴき"),
               "じ": ("じ",), "がつ": ("がつ",), "ねん": ("ねん",), "にん": ("にん",)}


def _fix_number_readings(tokens: list[dict]) -> None:
    for i, cur in enumerate(tokens):
        if not _DIGITS.match(cur["surface"]):
            continue
        try:
            n = int(cur["surface"].translate(str.maketrans("０１２３４５６７８９", "0123456789")))
        except ValueError:
            continue
        if n >= 100_000_000:
            continue
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        nr = (nxt or {}).get("reading") or ""
        kana, override = None, None
        if nxt and nxt["surface"] == "つ" and 1 <= n <= 9:
            kana = _TSU_KANA[n]
        elif nxt and nxt["surface"] == "日" and nr in ("か", "にち"):
            if n in _DAY_KANA:  # date: combined romaji under the number (futsuka)
                cur["reading"] = _DAY_KANA[n]
                cur["romaji"] = _romaji(_DAY_KANA[n] + "か")
                nxt["reading"], nxt["romaji"] = "か", ""
                continue
            kana, override = _std_kana(n), "にち"
        elif nxt and nxt["surface"] in _SURFACE_COUNTER:
            canon = _SURFACE_COUNTER[nxt["surface"]]
            if canon in _COUNTER_OK and nr not in _COUNTER_OK[canon]:
                kana = _std_kana(n)  # e.g. 分=ぶん (fraction), 月=つき: not a counter
            else:
                kana, override = _counter_number(n, canon)
        else:
            kana = _std_kana(n)
        cur["reading"] = kana
        cur["romaji"] = _romaji(kana)
        if override and nxt:
            nxt["reading"] = override
            nxt["romaji"] = _romaji(override)

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
    _fix_number_readings(tokens)
    return _fix_sokuon_romaji(tokens)


def _fix_sokuon_romaji(tokens: list[dict]) -> list[dict]:
    """A token ending in っ romanizes as 'tsu'; double the next consonant instead
    (行っ+て = 'it te', not 'itsu te')."""
    for cur, nxt in zip(tokens, tokens[1:]):
        rom, kana = cur.get("romaji") or "", cur.get("reading") or ""
        nrom = nxt.get("romaji") or ""
        if (rom.endswith("tsu") and kana.endswith("っ")
                and nrom[:1] in set("bcdfghjkmnprstwyz")):
            cur["romaji"] = rom[:-3] + nrom[0]
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
        if pos == "particle" and surface in _PARTICLE_ROMAJI:
            tok["romaji"] = _PARTICLE_ROMAJI[surface]
        lemma = m.dictionary_form()
        if lemma and lemma != surface:
            tok["lemma"] = lemma
        tokens.append(tok)
    return _fix_counter_readings(tokens)
