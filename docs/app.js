'use strict';

const $app = document.getElementById('app');
const SETTINGS_KEY = 'anyread-settings';
const settings = Object.assign(
  { furigana: true, romaji: false, translations: false },
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

async function renderLibrary() {
  stopAudio();
  $app.innerHTML = '';
  const bar = el('div', 'topbar');
  bar.append(el('h1', null, 'AnyRead'));
  $app.append(bar);

  let index = [];
  try {
    index = await (await fetch('articles/index.json')).json();
  } catch (e) {
    $app.append(el('div', 'empty',
      'Could not load the article list. Connect to the internet once to sync.'));
    return;
  }

  const list = el('div', 'list');
  if (!index.length) {
    list.append(el('div', 'empty', 'No articles yet. Add one with the anyread CLI and publish.'));
  }
  for (const a of index) {
    const card = el('div', 'card');
    card.append(el('h2', null, a.title));
    if (a.titleTranslation) card.append(el('p', 'sub', a.titleTranslation));
    const meta = el('div', 'meta');
    meta.append(el('span', 'badge', langName(a.language)));
    if (a.level) meta.append(el('span', null, a.level));
    if (a.createdAt) meta.append(el('span', null, a.createdAt.slice(0, 10)));
    if (a.hasAudio) meta.append(el('span', null, '🔊'));
    const dl = el('button', 'dl', '⬇');
    dl.title = 'Save for offline';
    isCached(a.id).then((c) => {
      if (c) { dl.textContent = '✓'; dl.classList.add('cached'); }
    });
    dl.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      dl.textContent = '…';
      try {
        await fetch(`articles/${a.id}/article.json`);
        if (a.hasAudio) await fetch(`articles/${a.id}/audio.mp3`);
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
  $app.append(list);
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
  $app.append(bar);

  if (isJa && !settings.furigana) reader.classList.add('no-furigana');

  // Header
  const header = el('header');
  header.append(el('h1', null, article.title));
  if (article.titleTranslation) header.append(el('p', 'sub', article.titleTranslation));
  const meta = el('div', 'meta');
  meta.append(el('span', 'badge', langName(article.language)));
  if (article.level) meta.append(el('span', null, article.level));
  if (article.createdAt) meta.append(el('span', null, article.createdAt.slice(0, 10)));
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
        if (isJa && tok.reading) {
          node = el('ruby');
          node.append(document.createTextNode(tok.surface));
          node.append(el('rt', null, tok.reading));
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

      if (isJa) {
        const rom = s.tokens.map((t) => t.romaji).filter(Boolean).join(' ');
        if (rom) {
          const rEl = el('div', 'romaji', rom);
          if (!settings.romaji) rEl.classList.add('hidden');
          sEl.append(rEl);
        }
      }
      if (s.translation) {
        const tEl = el('div', 'trans', s.translation);
        if (!settings.translations) tEl.classList.add('hidden');
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
    reader.querySelectorAll('.romaji').forEach((e) => e.classList.toggle('hidden', !settings.romaji));
  }
  function applyTranslations() {
    reader.querySelectorAll('.trans').forEach((e) => e.classList.toggle('hidden', !settings.translations));
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
      if (tEl) tEl.classList.toggle('hidden');
    }
  });

  // Audio
  if (article.audioFile) {
    audio = new Audio(`articles/${id}/${article.audioFile}`);
    audio.preload = 'metadata';

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

/* ---------------- Router ---------------- */

function route() {
  const m = location.hash.match(/^#\/a\/(.+)$/);
  if (m) renderReader(decodeURIComponent(m[1]));
  else renderLibrary();
}
window.addEventListener('hashchange', route);
route();
