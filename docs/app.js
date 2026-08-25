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
  return code === 'ja' ? '日本語' : code;
}

/* Inline SVG icons (stroke-based, inherit currentColor). Paths are separated by "|". */
const ICONS = {
  shuffle: 'M16 3h5v5|M4 20L21 3|M21 16v5h-5|M15 15l6 6|M4 4l5 5',
  book: 'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z|M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
  chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7'
      + 'a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z',
  article: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|M14 2v6h6'
         + '|M16 13H8|M16 17H8|M10 9H8',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z|M21 21l-4.35-4.35',
  volume: 'M11 5L6 9H2v6h4l5 4V5z|M15.5 8.5a5 5 0 0 1 0 7',
  menu: 'M3 6h18|M3 12h18|M3 18h18',
  list: 'M8 6h13|M8 12h13|M8 18h13|M3 6h.01|M3 12h.01|M3 18h.01',
  chevron: 'M6 9l6 6 6-6',
  radio: 'M4 10a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z|M16 4l-8 4'
       + '|M9 16a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5|M16 12h2',
};

function icon(name, size) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size || 16);
  svg.setAttribute('height', size || 16);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  for (const d of ICONS[name].split('|')) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

// Fisher-Yates over an element's children, so a section can be re-ordered in place
function shuffleChildren(container) {
  const kids = [...container.children];
  for (let i = kids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [kids[i], kids[j]] = [kids[j], kids[i]];
  }
  kids.forEach((k) => container.append(k));
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

// Top-level menu shown on the three main pages
function mkTabs(active) {
  const tabs = el('div', 'tabs');
  for (const [key, label, ico] of [['vocab', 'Vocabulary', 'book'],
                                   ['sentences', 'Sentences', 'chat'],
                                   ['articles', 'Articles', 'article']]) {
    const b = el('button', 'tab' + (active === key ? ' on' : ''));
    b.append(icon(ico, 15), el('span', null, label));
    b.addEventListener('click', () => {
      location.hash = key === 'vocab' ? '' : '#/' + key;
    });
    tabs.append(b);
  }
  return tabs;
}

/* Shared shell for the three main pages: AnyRead bar (menu + title + page tools),
   top-level tabs, section drawer/sidebar, and the content host. */
function mkShell(active) {
  $app.innerHTML = '';
  const bar = el('div', 'topbar');
  const menuBtn = el('button', 'toggle vmenu');
  menuBtn.append(icon('menu', 16));
  menuBtn.title = 'Sections';
  const tools = el('div', 'bartools');
  bar.append(menuBtn, el('h1', null, 'AnyRead'), el('div', 'spacer'), tools);

  const nav = el('nav', 'vnav');
  const scrim = el('div', 'vscrim');
  const host = el('div', 'reader');
  const sections = []; // {btn, catEl, level}

  function closeNav() {
    nav.classList.remove('open');
    scrim.classList.remove('show');
  }
  menuBtn.addEventListener('click', () => {
    nav.classList.toggle('open');
    scrim.classList.toggle('show', nav.classList.contains('open'));
  });
  scrim.addEventListener('click', closeNav);
  function setActive(i) {
    sections.forEach((s, j) => s.btn.classList.toggle('on', i === j));
  }

  // Section heading in the page + its chip in the drawer/sidebar.
  // `onShuffle` (optional) adds a shuffle button that reorders that section.
  function addSection(c, onShuffle) {
    const catEl = el('h2', 'vcat');
    const text = el('div', 'vcat-text');
    text.append(el('span', 'vcat-name', c.name));
    const subParts = [c.nameEn, c.nameId].filter(Boolean).join(' · ');
    if (subParts) text.append(el('span', 'vcat-sub', subParts));
    catEl.append(text);
    if (onShuffle) {
      const sh = el('button', 'vshuffle');
      sh.append(icon('shuffle', 15));
      sh.title = 'Shuffle this section';
      sh.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onShuffle();
      });
      catEl.append(sh);
    }
    host.append(catEl);
    const btn = el('button', 'toggle',
      (c.nameShort || c.nameEn || c.name) + (c.nameId ? '・' + c.nameId : ''));
    btn.title = subParts;
    const i = sections.length;
    btn.addEventListener('click', () => {
      setActive(i);
      closeNav();
      catEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    nav.append(btn);
    sections.push({ btn, catEl, level: c.level || 'Beginner' });
    return catEl;
  }

  // Scroll-spy: highlight the section currently below the sticky header stack.
  // The cutoff is measured, not hardcoded, so it matches where scrollIntoView
  // parks a heading (otherwise the section above stays highlighted).
  function cutoff() {
    const sticky = host.querySelector('.vsearch-wrap') || $app.querySelector('.tabs');
    return (sticky ? sticky.getBoundingClientRect().bottom : 100) + 16;
  }
  function onScroll() {
    if (!host.isConnected) {
      window.removeEventListener('scroll', onScroll);
      return;
    }
    const limit = cutoff();
    let act = 0;
    sections.forEach((s, i) => {
      if (s.catEl.getBoundingClientRect().top <= limit) act = i;
    });
    setActive(act);
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  $app.append(bar, mkTabs(active), scrim, nav);
  return { bar, tools, nav, scrim, host, sections, addSection, setActive, closeNav, onScroll };
}

async function renderLibrary() {
  stopAudio();
  const shell = mkShell('articles');
  const { host } = shell;

  let index = [];
  try {
    index = await (await fetch('articles/index.json')).json();
  } catch (e) {
    $app.append(el('div', 'empty',
      'Could not load the article list. Connect to the internet once to sync.'));
    return;
  }

  const header = el('header');
  header.append(el('h1', null, 'きじ'));
  header.append(el('p', 'sub', 'Articles · Artikel — graded news and stories'));
  host.append(header);

  const searchWrap = el('div', 'vsearch-wrap');
  const searchInput = el('input', 'vsearch');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search: title / english / indonesia…';
  const searchIco = el('span', 'vsearch-ico');
  searchIco.append(icon('search', 15));
  searchWrap.append(searchIco, searchInput);
  host.append(searchWrap);

  // Level filter chips (difficulty stays visible per article via its badge)
  let pageLevel = 'all';
  const levels = [...new Set(index.map((a) => a.level).filter(Boolean))]
    .sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
  if (levels.length > 1) {
    const lrow = el('div', 'filters');
    for (const [label, value] of [['All', 'all'], ...levels.map((l) => [l, l])]) {
      const b = el('button', 'toggle' + (pageLevel === value ? ' on' : ''), label);
      b.addEventListener('click', () => {
        pageLevel = value;
        [...lrow.children].forEach((ch) => ch.classList.remove('on'));
        b.classList.add('on');
        applyFilter();
      });
      lrow.append(b);
    }
    host.append(lrow);
  }

  // Sections = topic / theme
  const entries = []; // {el, secIdx, hay, level}
  const topics = [...new Set(index.map((a) => a.topic).filter(Boolean))];
  for (const t of topics) {
    const sample = index.find((a) => a.topic === t);
    const list = el('div', 'list');
    shell.addSection({ name: t, nameEn: sample.topicEn, nameId: sample.topicId,
                       nameShort: sample.topicEn }, () => shuffleChildren(list));
    buildList(index.filter((a) => a.topic === t), list);
  }
  const untagged = index.filter((a) => !a.topic);
  if (untagged.length) {
    const list = el('div', 'list');
    shell.addSection({ name: 'その他', nameEn: 'Other', nameShort: 'Other' },
                     () => shuffleChildren(list));
    buildList(untagged, list);
  }
  if (!index.length) {
    host.append(el('div', 'empty',
      'No articles yet. Add one with the anyread CLI and publish.'));
  }
  $app.append(host);
  shell.onScroll();

  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    const hits = new Array(shell.sections.length).fill(0);
    for (const e of entries) {
      const show = (pageLevel === 'all' || e.level === pageLevel) && (!q || e.hay.includes(q));
      e.el.style.display = show ? '' : 'none';
      if (show) hits[e.secIdx] += 1;
    }
    shell.sections.forEach((s, i) => {
      s.catEl.style.display = hits[i] ? '' : 'none';
    });
  }
  searchInput.addEventListener('input', applyFilter);

  function buildList(shown, list) {
  for (const a of shown) {
    const card = el('div', 'card');
    const head = el('div', 'cardhead');
    const titles = el('div');
    titles.append(el('h2', null, a.title));
    if (a.titleTranslation) titles.append(el('p', 'sub', a.titleTranslation));
    head.append(titles);
    if (a.level) head.append(el('span', 'lvl lvl-' + a.level.toLowerCase(), a.level));
    card.append(head);
    const meta = el('div', 'meta');
    if (a.createdAt) meta.append(el('span', null, a.createdAt.slice(0, 10)));
    if (a.hasAudio) {
      const au = el('span', 'mico');
      au.append(icon('volume', 14));
      meta.append(au);
    }
    if (a.generated) meta.append(el('span', 'badge ai', 'AI'));
    if (a.broadcast) {
      const bc = el('span', 'badge');
      bc.append(icon('radio', 12), el('span', null, 'broadcast'));
      meta.append(bc);
    }
    card.append(meta);
    card.addEventListener('click', () => {
      location.hash = '#/a/' + encodeURIComponent(a.id);
    });
    entries.push({
      el: card,
      secIdx: shell.sections.length - 1,
      level: a.level,
      hay: [a.title, a.titleTranslation, a.summary, a.level, a.topicEn, a.topicId]
        .filter(Boolean).join(' ').toLowerCase(),
    });
    list.append(card);
  }
  host.append(list);
  }
}

/* ---------------- Reader ---------------- */

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


  // Top bar with toggles
  const bar = el('div', 'topbar');
  const back = el('button', 'back', '‹');
  back.addEventListener('click', () => { location.hash = '#/articles'; });
  bar.append(back, el('h1', null, 'AnyRead'), el('div', 'spacer'));
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
  bar.append(
    mkToggle('ふ', 'furigana', () => reader.classList.toggle('no-furigana', !settings.furigana)),
    mkToggle('rо̄', 'romaji', applyRomaji)
  );
  bar.append(mkToggle('EN', 'translations', applyTranslations));
  const hasId = article.paragraphs.some((p) => p.sentences.some((s) => s.translationId));
  if (hasId) bar.append(mkToggle('ID', 'translationsId', applyTranslations));
  $app.append(bar);

  if (!settings.furigana) reader.classList.add('no-furigana');
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
      const line = el('div', 'jtext');
      s.tokens.forEach((tok, ti) => {
        const tappable = !['punct', 'symbol', 'space', 'number'].includes(tok.pos);
        // Per-token stack: furigana row / word / romaji row.
        const node = el('span', 'stk');
        node.append(
          el('span', 'fg', tok.reading || ''),
          el('span', 'base', tok.surface),
          el('span', 'rom', (tappable && tok.romaji) || '')
        );
        if (tappable) {
          node.classList.add('tok');
          node.dataset.g = g;
          node.dataset.ti = ti;
        }
        line.append(node);
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
  stopAudio();
  const shell = mkShell(mode === 'sentences' ? 'sentences' : 'vocab');
  const { host, sections, addSection } = shell;

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
  shell.tools.append(
    mkToggle('ふ', 'furigana', () => host.classList.toggle('no-furigana', !settings.furigana)),
    mkToggle('rо̄', 'romaji', () => host.classList.toggle('no-romaji', !settings.romaji))
  );
  if (!settings.furigana) host.classList.add('no-furigana');
  if (!settings.romaji) host.classList.add('no-romaji');

  let data;
  try {
    data = await (await fetch('vocab/ja-beginner.json')).json();
  } catch (e) {
    $app.append(el('div', 'empty', 'Could not load the vocabulary list.'));
    return;
  }

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
  const searchIco = el('span', 'vsearch-ico');
  searchIco.append(icon('search', 15));
  searchWrap.append(searchIco, searchInput);
  host.append(header, searchWrap);
  const searchEntries = []; // {el, secIdx, hay, hayEx}

  // Difficulty filter (second dimension next to the theme sections)
  let pageLevel = 'all';
  const sectionDefs = mode === 'sentences' ? (data.sentenceGroups || []) : data.categories;
  const pageLevels = [...new Set(sectionDefs.map((c) => c.level || 'Beginner'))]
    .sort((a, b) => LEVEL_ORDER.indexOf(a) - LEVEL_ORDER.indexOf(b));
  if (pageLevels.length > 1) {
    const lrow = el('div', 'filters');
    for (const [label, value] of [['All', 'all'], ...pageLevels.map((l) => [l, l])]) {
      const b = el('button', 'toggle' + (pageLevel === value ? ' on' : ''), label);
      b.addEventListener('click', () => {
        pageLevel = value;
        [...lrow.children].forEach((ch) => ch.classList.remove('on'));
        b.classList.add('on');
        applyFilter();
      });
      lrow.append(b);
    }
    host.append(lrow);
  }

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
    const list = el('div', 'vlist');
    addSection(c, () => shuffleChildren(list));
    host.append(list);
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
      if ((w.examples || []).length) {
        const tog = el('button', 'vtoggle');
        tog.append(icon('list', 14), icon('chevron', 12));
        tog.title = 'example / contoh';
        tog.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const open = item.classList.toggle('open');
          tog.classList.toggle('on', open);
        });
        row.append(tog);
      }
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
      list.append(item);
    }
  }

  // Themed example sentences (own page)
  for (const gDef of (mode === 'sentences' ? data.sentenceGroups || [] : [])) {
    const list = el('div', 'vlist');
    addSection(gDef, () => shuffleChildren(list));
    host.append(list);
    let pairWrap = null;
    for (const s of gDef.sentences) {
      const row = el('div', 'vsent' + (s.qa ? ' qa-' + s.qa : ''));
      if (s.qa) row.append(el('span', 'qabadge', s.qa === 'q' ? 'Q' : 'A'));
      row.append(jline(s.tokens), transBlock(s));
      row.addEventListener('click', () => playWord(s, row));
      searchEntries.push({
        el: row,
        secIdx: sections.length - 1,
        hay: [s.text, s.en, s.id,
          s.tokens.map((t) => t.romaji || '').join(' ')]
          .filter(Boolean).join(' ').toLowerCase(),
      });
      // Keep a Q&A pair together so shuffling never separates them
      if (s.qa === 'q') {
        pairWrap = el('div', 'qapair');
        pairWrap.append(row);
        list.append(pairWrap);
      } else if (s.qa === 'a' && pairWrap) {
        pairWrap.append(row);
        pairWrap = null;
      } else {
        list.append(row);
      }
    }
  }

  function applyFilter() {
    const q = searchInput.value.trim().toLowerCase();
    const hits = new Array(sections.length).fill(0);
    for (const e of searchEntries) {
      const okLevel = pageLevel === 'all' || sections[e.secIdx].level === pageLevel;
      const inEx = !!q && !!e.hayEx && e.hayEx.includes(q);
      const show = okLevel && (!q || e.hay.includes(q) || inEx);
      e.el.style.display = show ? '' : 'none';
      // A hit inside an example reveals it even in compact (no-ex) mode
      e.el.classList.toggle('show-ex', inEx);
      if (show) hits[e.secIdx] += 1;
    }
    sections.forEach((s, i) => {
      const okLevel = pageLevel === 'all' || s.level === pageLevel;
      s.catEl.style.display = okLevel && (!q || hits[i]) ? '' : 'none';
      s.btn.style.display = okLevel ? '' : 'none';
    });
  }
  searchInput.addEventListener('input', applyFilter);
  $app.append(host);
  shell.onScroll();
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
      // On the private (Netlify) deploy this sets the server-side auth cookie;
      // elsewhere the endpoint doesn't exist and the failure is ignored.
      try {
        await fetch('api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: input.value }),
        });
      } catch (e) {}
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
  if (location.hash === '#/sentences') { renderVocab('sentences'); return; }
  if (location.hash === '#/articles') { renderLibrary(); return; }
  const m = location.hash.match(/^#\/a\/(.+)$/);
  if (m) renderReader(decodeURIComponent(m[1]));
  else renderVocab('words');  // Vocabulary is the default page
}
window.addEventListener('hashchange', route);
route();
