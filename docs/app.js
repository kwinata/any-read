'use strict';

const $app = document.getElementById('app');
const SETTINGS_KEY = 'anyread-settings';
const settings = Object.assign(
  { furigana: true, romaji: false, translations: false, translationsId: false, vocabExamples: false },
  JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
);
const RATES = [0.7, 0.85, 1.0, 1.15, 1.3];

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');

let audio = null;

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function langName(code) {
  return code === 'ja' ? '日本語' : code === 'de' ? 'Deutsch' : code;
}

function fmtTime(t) {
  const s = Math.floor(t || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function stopAudio() {
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio = null;
  }
}

async function isCached(id) {
  if (!window.caches) return false;
  return !!(await caches.match(`articles/${id}/article.json`, { ignoreSearch: true }));
}

/* ---------------- Library ---------------- */

const LEVEL_ORDER = ['Beginner', 'N5', 'N4', 'N3', 'N2', 'N1', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

async function renderLibrary() {
  stopAudio();
  $app.innerHTML = '';
  const bar = el('div', 'topbar');
  bar.append(el('h1', null, 'AnyRead'));
  const vocabBtn = el('button', 'toggle', '📖 Vocab・たんご');
  vocabBtn.title = 'Beginner vocabulary';
  vocabBtn.addEventListener('click', () => { location.hash = '#/vocab'; });
  const sentBtn = el('button', 'toggle', '💬 Sentences・れいぶん');
  sentBtn.title = 'Beginner example sentences';
  sentBtn.addEventListener('click', () => { location.hash = '#/sentences'; });
  bar.append(vocabBtn, sentBtn);
  $app.append(bar);

  let index = [];
  try {
    index = await (await fetch('articles/index.json')).json();
  } catch (e) {
    $app.append(el('div', 'empty',
      'Could not load the article list. Connect to the internet once to sync.'));
    return;
  }

  const filters = el('div', 'filters');
  const listHost = el('div');
  $app.append(filters, listHost);

  function chip(label, active, onTap) {
    const b = el('button', 'toggle' + (active ? ' on' : ''), label);
    b.addEventListener('click', onTap);
    return b;
  }

  function renderFilters() {
    filters.innerHTML = '';
    for (const [label, value] of [['All', 'all'], ['日本語', 'ja'], ['Deutsch', 'de']]) {
      filters.append(chip(label, (settings.filterLang || 'all') === value, () => {
        settings.filterLang = value;
        settings.filterLevel = 'all';
        saveSettings();
        renderFilters();
        renderList();
      }));
    }
    const lang = settings.filterLang || 'all';
    const levels = [...new Set(index
      .filter((a) => lang === 'all' || a.language === lang)
      .map((a) => a.level).filter(Boolean))]
      .sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
    if (levels.length > 1) {
      filters.append(el('span', 'fsep'));
      for (const lv of levels) {
        filters.append(chip(lv, settings.filterLevel === lv, () => {
          settings.filterLevel = settings.filterLevel === lv ? 'all' : lv;
          saveSettings();
          renderFilters();
          renderList();
        }));
      }
    }
  }

  function renderList() {
    listHost.innerHTML = '';
    const lang = settings.filterLang || 'all';
    const lvl = settings.filterLevel || 'all';
    const shown = index.filter((a) =>
      (lang === 'all' || a.language === lang) && (lvl === 'all' || a.level === lvl));
    buildList(shown);
  }

  renderFilters();
  renderList();

  function buildList(entries) {
  const list = el('div', 'list');
  if (!entries.length) {
    list.append(el('div', 'empty', index.length
      ? 'No articles match this filter.'
      : 'No articles yet. Add one with the anyread CLI and publish.'));
  }
  for (const a of entries) {
    const card = el('div', 'card');
    card.append(el('h2', null, a.title));
    if (a.titleTranslation) card.append(el('p', 'sub', a.titleTranslation));
    const meta = el('div', 'meta');
    meta.append(el('span', 'badge', langName(a.language)));
    if (a.level) meta.append(el('span', null, a.level));
    if (a.createdAt) meta.append(el('span', null, a.createdAt.slice(0, 10)));
    if (a.hasAudio) meta.append(el('span', null, '🔊'));
    if (a.generated) meta.append(el('span', 'badge ai', 'AI'));
    if (a.broadcast) meta.append(el('span', 'badge', '📻 broadcast'));
    const dl = el('button', 'dl', '⬇');
    dl.title = 'Save for offline';
    isCached(a.id).then((c) => {
      if (c) { dl.textContent = '✓'; dl.classList.add('cached'); }
    });
    dl.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      dl.textContent = '…';
      try {
        const art = await (await fetch(`articles/${a.id}/article.json`)).json();
        if (art.audioFile) await fetch(`articles/${a.id}/${art.audioFile}`);
        dl.textContent = '✓';
        dl.classList.add('cached');
      } catch (e) {
        dl.textContent = '⬇';
      }
    });
    meta.append(dl);
    card.append(meta);
    card.addEventListener('click', () => {
      location.hash = '#/a/' + encodeURIComponent(a.id);
    });
    list.append(card);
  }
  listHost.append(list);
  }
}

/* ---------------- Reader ---------------- */

const DE_NO_SPACE_BEFORE = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '»', '“', '%', '…']);
const DE_NO_SPACE_AFTER = new Set(['(', '[', '«', '„']);

async function renderReader(id) {
  stopAudio();
  $app.innerHTML = '';

  let article;
  try {
    article = await (await fetch(`articles/${id}/article.json`)).json();
  } catch (e) {
    const bar = el('div', 'topbar');
    const back = el('button', 'back', '‹ Back');
    back.addEventListener('click', () => { location.hash = ''; });
    bar.append(back, el('div', 'spacer'));
    $app.append(bar, el('div', 'empty',
      'This article is not saved offline. Open it once while online, or tap ⬇ in the library.'));
    return;
  }

  const isJa = article.language === 'ja';

  // Top bar with toggles
  const bar = el('div', 'topbar');
  const back = el('button', 'back', '‹');
  back.addEventListener('click', () => { location.hash = ''; });
  bar.append(back, el('div', 'spacer'));
  const reader = el('div', 'reader');

  function mkToggle(label, key, apply) {
    const b = el('button', 'toggle' + (settings[key] ? ' on' : ''), label);
    b.addEventListener('click', () => {
      settings[key] = !settings[key];
      saveSettings();
      b.classList.toggle('on', settings[key]);
      apply();
    });
    return b;
  }
  if (isJa) {
    bar.append(
      mkToggle('ふ', 'furigana', () => reader.classList.toggle('no-furigana', !settings.furigana)),
      mkToggle('rо̄', 'romaji', applyRomaji)
    );
  }
  bar.append(mkToggle('EN', 'translations', applyTranslations));
  const hasId = article.paragraphs.some((p) => p.sentences.some((s) => s.translationId));
  if (hasId) bar.append(mkToggle('ID', 'translationsId', applyTranslations));
  $app.append(bar);

  if (isJa && !settings.furigana) reader.classList.add('no-furigana');
  if (!settings.romaji) reader.classList.add('no-romaji');
  applyTranslations();

  // Header
  const header = el('header');
  header.append(el('h1', null, article.title));
  if (article.titleTranslation) header.append(el('p', 'sub', article.titleTranslation));
  if (article.titleTranslationId) header.append(el('p', 'sub trans-id', article.titleTranslationId));
  const meta = el('div', 'meta');
  meta.append(el('span', 'badge', langName(article.language)));
  if (article.level) meta.append(el('span', null, article.level));
  if (article.createdAt) meta.append(el('span', null, article.createdAt.slice(0, 10)));
  if (article.generated) meta.append(el('span', 'badge ai', 'AI-written'));
  header.append(meta);
  reader.append(header);

  // Sentences
  const flat = []; // {el, start, end, tokens}
  let g = 0;
  for (const para of article.paragraphs) {
    const pEl = el('div', 'para');
    for (const s of para.sentences) {
      const sEl = el('div', 'sentence');
      sEl.dataset.g = g;
      const line = el('div', isJa ? 'jtext' : 'dtext');
      s.tokens.forEach((tok, ti) => {
        const tappable = !['punct', 'symbol', 'space', 'number'].includes(tok.pos);
        let node;
        if (isJa) {
          // Per-token stack: furigana row / word / romaji row.
          node = el('span', 'stk');
          node.append(
            el('span', 'fg', tok.reading || ''),
            el('span', 'base', tok.surface),
            el('span', 'rom', (tappable && tok.romaji) || '')
          );
        } else {
          node = el('span', null, tok.surface);
        }
        if (tappable) {
          node.classList.add('tok');
          node.dataset.g = g;
          node.dataset.ti = ti;
        }
        line.append(node);
        if (!isJa) {
          const next = s.tokens[ti + 1];
          if (next && !DE_NO_SPACE_BEFORE.has(next.surface) && !DE_NO_SPACE_AFTER.has(tok.surface)) {
            line.append(document.createTextNode(' '));
          }
        }
      });
      sEl.append(line);

      if (s.translation || s.translationId) {
        const tEl = el('div', 'trans');
        if (s.translation) tEl.append(el('div', 'trans-en', s.translation));
        if (s.translationId) tEl.append(el('div', 'trans-id', s.translationId));
        if (article.audioFile && s.audioStart != null) {
          const chip = el('span', 'playhere', '▶ play from here');
          chip.dataset.start = s.audioStart;
          tEl.append(chip);
        }
        sEl.append(tEl);
      }
      flat.push({ el: sEl, start: s.audioStart, end: s.audioEnd, tokens: s.tokens });
      pEl.append(sEl);
      g += 1;
    }
    reader.append(pEl);
  }

  if (article.sourceUrl) {
    const src = el('p', 'source');
    const a = el('a', null, 'Source article');
    a.href = article.sourceUrl;
    a.target = '_blank';
    src.append(a);
    reader.append(src);
  }
  $app.append(reader);

  function applyRomaji() {
    reader.classList.toggle('no-romaji', !settings.romaji);
  }
  function applyTranslations() {
    reader.classList.toggle('show-en', !!settings.translations);
    reader.classList.toggle('show-id', !!settings.translationsId);
  }

  // Bottom overlay: gloss card + audio bar
  const bottom = el('div', 'bottom');
  const glossHost = el('div');
  bottom.append(glossHost);
  $app.append(bottom);

  let selectedTok = null;
  function showGloss(tok, node) {
    if (selectedTok) selectedTok.classList.remove('sel');
    selectedTok = node;
    node.classList.add('sel');
    glossHost.innerHTML = '';
    const card = el('div', 'gloss');
    const head = el('div');
    head.append(el('span', 'word', tok.surface));
    if (tok.reading) head.append(el('span', 'read', tok.reading));
    if (tok.romaji) head.append(el('span', 'rom', tok.romaji));
    card.append(head);
    if (tok.lemma && tok.lemma !== tok.surface) {
      card.append(el('div', 'pos', 'base form: ' + tok.lemma));
    }
    card.append(el('div', 'g', tok.gloss || 'no gloss'));
    if (tok.glossId) card.append(el('div', 'g gid', tok.glossId));
    card.append(el('div', 'pos', tok.pos));
    const close = el('button', 'close', '✕');
    close.addEventListener('click', hideGloss);
    card.append(close);
    glossHost.append(card);
  }
  function hideGloss() {
    glossHost.innerHTML = '';
    if (selectedTok) selectedTok.classList.remove('sel');
    selectedTok = null;
  }

  reader.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.playhere');
    if (chip && audio) {
      audio.currentTime = Number(chip.dataset.start);
      audio.play();
      return;
    }
    const tokNode = ev.target.closest('.tok');
    if (tokNode) {
      const t = flat[Number(tokNode.dataset.g)].tokens[Number(tokNode.dataset.ti)];
      showGloss(t, tokNode);
      return;
    }
    const sent = ev.target.closest('.sentence');
    if (sent) {
      const tEl = sent.querySelector('.trans');
      if (tEl) tEl.classList.toggle('reveal');
    }
  });

  // Audio
  if (article.audioFile) {
    audio = new Audio(`articles/${id}/${article.audioFile}`);
    audio.preload = 'auto';

    const abar = el('div', 'audiobar');
    const slider = el('input');
    slider.type = 'range';
    slider.min = 0;
    slider.max = 100;
    slider.value = 0;
    slider.step = 0.1;
    const controls = el('div', 'controls');
    const rateBtn = el('button', 'rate', '1×');
    const backBtn = el('button', null, '↺5');
    const playBtn = el('button', 'play', '▶');
    const fwdBtn = el('button', null, '↻5');
    const timeEl = el('span', 'time', '0:00');
    controls.append(rateBtn, backBtn, playBtn, fwdBtn, timeEl);
    abar.append(slider, controls);
    bottom.append(abar);

    let rateIdx = 2;
    rateBtn.addEventListener('click', () => {
      rateIdx = (rateIdx + 1) % RATES.length;
      audio.playbackRate = RATES[rateIdx];
      rateBtn.textContent = RATES[rateIdx] + '×';
    });
    playBtn.addEventListener('click', () => {
      if (audio.paused) audio.play(); else audio.pause();
    });
    backBtn.addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 5); });
    fwdBtn.addEventListener('click', () => {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
    });
    slider.addEventListener('input', () => {
      if (audio.duration) audio.currentTime = (slider.value / 100) * audio.duration;
    });
    audio.addEventListener('play', () => { playBtn.textContent = '⏸'; });
    audio.addEventListener('pause', () => { playBtn.textContent = '▶'; });

    let currentG = -1;
    audio.addEventListener('timeupdate', () => {
      const t = audio.currentTime;
      timeEl.textContent = fmtTime(t);
      if (audio.duration) slider.value = (t / audio.duration) * 100;
      if (audio.paused) return;
      const idx = flat.findIndex((s) => s.start != null && t >= s.start && t < s.end);
      if (idx !== currentG) {
        if (currentG >= 0) flat[currentG].el.classList.remove('current');
        currentG = idx;
        if (idx >= 0) {
          flat[idx].el.classList.add('current');
          flat[idx].el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    });
    audio.addEventListener('ended', () => {
      if (currentG >= 0) flat[currentG].el.classList.remove('current');
      currentG = -1;
    });

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: article.title,
        artist: 'AnyRead',
      });
      navigator.mediaSession.setActionHandler('play', () => audio.play());
      navigator.mediaSession.setActionHandler('pause', () => audio.pause());
      navigator.mediaSession.setActionHandler('seekbackward', () => {
        audio.currentTime = Math.max(0, audio.currentTime - 5);
      });
      navigator.mediaSession.setActionHandler('seekforward', () => {
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
      });
    }
  }
}

/* ---------------- Vocabulary ---------------- */

async function renderVocab(mode) {  // 'words' | 'sentences'
  $app.innerHTML = '';
  const bar = el('div', 'topbar');
  const back = el('button', 'back', '‹');
  back.addEventListener('click', () => { location.hash = ''; });
  const menuBtn = el('button', 'toggle vmenu', '☰');
  bar.append(back, menuBtn, el('div', 'spacer'));
  const host = el('div', 'reader');

  function mkToggle(label, key, apply) {
    const b = el('button', 'toggle' + (settings[key] ? ' on' : ''), label);
    b.addEventListener('click', () => {
      settings[key] = !settings[key];
      saveSettings();
      b.classList.toggle('on', settings[key]);
      apply();
    });
    return b;
  }
  bar.append(
    mkToggle('ふ', 'furigana', () => host.classList.toggle('no-furigana', !settings.furigana)),
    mkToggle('rо̄', 'romaji', () => host.classList.toggle('no-romaji', !settings.romaji))
  );
  if (mode !== 'sentences') {
    bar.append(mkToggle('例', 'vocabExamples',
      () => host.classList.toggle('no-ex', !settings.vocabExamples)));
  }
  $app.append(bar);
  if (!settings.furigana) host.classList.add('no-furigana');
  if (!settings.romaji) host.classList.add('no-romaji');
  if (mode !== 'sentences' && !settings.vocabExamples) host.classList.add('no-ex');

  let data;
  try {
    data = await (await fetch('vocab/ja-beginner.json')).json();
  } catch (e) {
    $app.append(el('div', 'empty', 'Could not load the vocabulary list.'));
    return;
  }

  // Section nav: hamburger drawer on phones, fixed sidebar on wide screens
  const nav = el('nav', 'vnav');
  const scrim = el('div', 'vscrim');
  const sections = []; // {btn, catEl}
  function closeNav() {
    nav.classList.remove('open');
    scrim.classList.remove('show');
  }
  menuBtn.addEventListener('click', () => {
    nav.classList.toggle('open');
    scrim.classList.toggle('show', nav.classList.contains('open'));
  });
  scrim.addEventListener('click', closeNav);
  $app.append(scrim, nav);

  const header = el('header');
  if (mode === 'sentences') {
    header.append(el('h1', null, 'れいぶん'));
    header.append(el('p', 'sub', 'Example sentences · Contoh kalimat — tap a sentence to hear it'));
  } else {
    header.append(el('h1', null, 'たんごちょう'));
    header.append(el('p', 'sub', 'Useful beginner vocabulary — tap a word to hear it'));
  }
  const searchWrap = el('div', 'vsearch-wrap');
  const searchInput = el('input', 'vsearch');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search: english / indonesia / romaji…';
  searchWrap.append(el('span', 'vsearch-ico', '🔍'), searchInput);
  header.append(searchWrap);
  host.append(header);
  const searchEntries = []; // {el, secIdx, hay}

  const audio = data.audioFile ? new Audio('vocab/' + data.audioFile) : null;
  let stopAt = null;
  let currentRow = null;
  if (audio) {
    audio.preload = 'auto';
    audio.addEventListener('timeupdate', () => {
      if (stopAt != null && audio.currentTime >= stopAt) {
        audio.pause();
        stopAt = null;
        if (currentRow) currentRow.classList.remove('current');
      }
    });
  }
  function playWord(w, row) {
    if (!audio || w.start == null) return;
    if (currentRow) currentRow.classList.remove('current');
    currentRow = row;
    row.classList.add('current');
    audio.currentTime = w.start;
    stopAt = w.end - 0.05;
    audio.play();
  }

  function setActive(i) {
    sections.forEach((s, j) => s.btn.classList.toggle('on', i === j));
  }
  // Trilingual section header (ja / en · id) plus its nav chip
  function addSection(c) {
    const catEl = el('h2', 'vcat', c.name);
    const subParts = [c.nameEn, c.nameId].filter(Boolean).join(' · ');
    if (subParts) catEl.append(el('span', 'vcat-sub', subParts));
    host.append(catEl);
    const btn = el('button', 'toggle', (c.nameShort ? c.nameShort + '・' : '') + c.name);
    btn.title = subParts;
    const i = sections.length;
    btn.addEventListener('click', () => {
      setActive(i);
      closeNav();
      catEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    nav.append(btn);
    sections.push({ btn, catEl });
  }
  // A sentence's tokens as furigana/word/romaji stacks (like the reader)
  function jline(tokens) {
    const line = el('div', 'jtext');
    for (const tok of tokens) {
      const tappable = !['punct', 'symbol', 'space', 'number'].includes(tok.pos);
      const stk = el('span', 'stk');
      stk.append(
        el('span', 'fg', tok.reading || ''),
        el('span', 'base', tok.surface),
        el('span', 'rom', (tappable && tok.romaji) || '')
      );
      line.append(stk);
    }
    return line;
  }
  function transBlock(s) {
    const gl = el('div', 'vtrans');
    gl.append(el('div', null, s.en));
    if (s.id) gl.append(el('div', 'idn', s.id));
    return gl;
  }

  for (const c of (mode === 'sentences' ? [] : data.categories)) {
    addSection(c);
    for (const w of c.words) {
      const item = el('div', 'vitem');
      const row = el('div', 'vrow');
      const jt = el('span', 'jtext');
      const stk = el('span', 'stk');
      // Furigana only when the word actually contains kanji
      const needsFg = /[一-鿿々]/.test(w.w);
      stk.append(
        el('span', 'fg', needsFg ? (w.reading || '') : ''),
        el('span', 'base', w.w),
        el('span', 'rom', w.romaji || '')
      );
      jt.append(stk);
      row.append(jt);
      const gl = el('div', 'vgloss');
      gl.append(el('div', null, w.en));
      if (w.id) gl.append(el('div', 'idn', w.id));
      row.append(gl);
      row.addEventListener('click', () => playWord(w, row));
      item.append(row);
      for (const ex of w.examples || []) {
        const exEl = el('div', 'vex');
        exEl.append(jline(ex.tokens), transBlock(ex));
        exEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          playWord(ex, exEl);
        });
        item.append(exEl);
      }
      searchEntries.push({
        el: item,
        secIdx: sections.length - 1,
        hay: [w.w, w.reading, w.romaji, w.en, w.id]
          .filter(Boolean).join(' ').toLowerCase(),
        hayEx: (w.examples || []).map((e2) =>
          [e2.text, e2.en, e2.id, e2.tokens.map((t) => t.romaji || '').join(' ')]
            .filter(Boolean).join(' ')).join(' ').toLowerCase(),
      });
      host.append(item);
    }
  }

  // Themed example sentences (own page)
  for (const gDef of (mode === 'sentences' ? data.sentenceGroups || [] : [])) {
    addSection(gDef);
    for (const s of gDef.sentences) {
      const row = el('div', 'vsent');
      row.append(jline(s.tokens), transBlock(s));
      row.addEventListener('click', () => playWord(s, row));
      searchEntries.push({
        el: row,
        secIdx: sections.length - 1,
        hay: [s.text, s.en, s.id,
          s.tokens.map((t) => t.romaji || '').join(' ')]
          .filter(Boolean).join(' ').toLowerCase(),
      });
      host.append(row);
    }
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const hits = new Array(sections.length).fill(0);
    for (const e of searchEntries) {
      const inEx = !!q && !!e.hayEx && e.hayEx.includes(q);
      const show = !q || e.hay.includes(q) || inEx;
      e.el.style.display = show ? '' : 'none';
      // A hit inside an example reveals it even in compact (no-ex) mode
      e.el.classList.toggle('show-ex', inEx);
      if (show) hits[e.secIdx] += 1;
    }
    sections.forEach((s, i) => {
      s.catEl.style.display = !q || hits[i] ? '' : 'none';
    });
  });
  $app.append(host);

  // Scroll-spy: highlight the section currently at the top of the view
  function onScroll() {
    if (!host.isConnected) {
      window.removeEventListener('scroll', onScroll);
      return;
    }
    let active = 0;
    sections.forEach((s, i) => {
      if (s.catEl.getBoundingClientRect().top <= 130) active = i;
    });
    setActive(active);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ---------------- Password gate ---------------- */

// To change the password: printf 'newpass' | shasum -a 256  → paste the hex here.
const PASS_HASH = '8c28ed22b31b278b871e4d8cd9f466e3bf53071db1cfde72c37c91cb7f1f70ed';
const AUTH_KEY = 'anyread-auth';

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function isAuthed() {
  try { return localStorage.getItem(AUTH_KEY) === PASS_HASH; } catch (e) { return false; }
}

function renderLock() {
  $app.innerHTML = '';
  const box = el('div', 'lock');
  box.append(el('h1', null, 'AnyRead'));
  box.append(el('p', 'sub', 'Enter the password to open the library.'));
  const input = el('input', 'pw');
  input.type = 'password';
  input.autocapitalize = 'none';
  const btn = el('button', 'unlock', 'Open');
  const err = el('p', 'pwerr', '');
  async function attempt() {
    if ((await sha256Hex(input.value)) === PASS_HASH) {
      try { localStorage.setItem(AUTH_KEY, PASS_HASH); } catch (e) {}
      route();
    } else {
      err.textContent = 'Wrong password.';
      input.value = '';
    }
  }
  btn.addEventListener('click', attempt);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') attempt(); });
  box.append(input, btn, err);
  $app.append(box);
  input.focus();
}

/* ---------------- Router ---------------- */

function route() {
  if (!isAuthed()) { renderLock(); return; }
  if (location.hash === '#/vocab') { renderVocab('words'); return; }
  if (location.hash === '#/sentences') { renderVocab('sentences'); return; }
  const m = location.hash.match(/^#\/a\/(.+)$/);
  if (m) renderReader(decodeURIComponent(m[1]));
  else renderLibrary();
}
window.addEventListener('hashchange', route);
route();
