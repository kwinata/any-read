# AnyRead

A personal graded-reader web app (The Chairman's Bao style) for Japanese and
German: real news articles annotated with furigana, romaji, per-word glosses,
sentence translations, and pre-generated narration audio. Installable on iPhone
as a home-screen PWA; opened articles work fully offline.

## Layout

- `pipeline/` — Python CLI that turns an article URL (or pasted text) into annotated data.
- `docs/` — the PWA (vanilla JS, no build step) plus article data in
  `docs/articles/<slug>/` and the `docs/articles/index.json` manifest.
  Served by GitHub Pages.

## Adding an article

```sh
cd pipeline
.venv/bin/anyread news                   # recent headlines (ja: Yahoo News + Matcha easy; de: nachrichtenleicht)
.venv/bin/anyread add "<url>"            # fetch, tidy, annotate, narrate
.venv/bin/anyread publish                # git commit + push -> site updates
```

Options for `add`: `--lang ja|de` (default auto-detect), `--title`, `--voice
<edge-tts voice>`, `--rate -20%` (default -10%), `--no-audio`, `--no-tidy`,
`--text-file file.txt` / `--stdin` for pasted text.

The pipeline uses SudachiPy (Japanese tokenization + readings), pykakasi
(romaji), the `claude` CLI (boilerplate cleanup, translations, glosses,
JLPT/CEFR level — uses your existing login), and edge-tts (free neural voices,
per-sentence timings).

Japanese sources: Yahoo News briefs (news.yahoo.co.jp) and Matcha's
やさしい日本語 articles (matcha-jp.com/easy — easier level). NHK stopped serving
full article bodies to scrapers in 2026 (NHK ONE migration), so it's out.

## Phone setup (once)

Open the GitHub Pages URL in Safari → Share → **Add to Home Screen**.
Tap ⬇ on an article to save it offline (or just open it once). New articles
appear whenever the app is opened with connectivity.

## Reader features

Tap a word for its gloss; tap anywhere else in a sentence to reveal its
translation; toggles in the top bar for furigana (ふ), romaji (rō), and all
translations (EN); audio bar with speed control, ±5 s, seek; the playing
sentence is highlighted and auto-scrolled, with "▶ play from here" in each
revealed translation.

## Local development

```sh
cd docs && python3 -m http.server 8642   # http://localhost:8642
```
