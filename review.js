// ========================================================================
// review.js — 生词本翻卡复习页
// ========================================================================

'use strict';

const stage = document.getElementById('stage');
const progressEl = document.getElementById('progress');
const progressBox = document.getElementById('progressBox');
const progressFill = document.getElementById('progressFill');

let deck = [];
let index = 0;
let flipped = false;
let themeMode = typeof DEFAULT_THEME_MODE !== 'undefined' ? DEFAULT_THEME_MODE : 'system';
const themeKey = typeof THEME_MODE_KEY !== 'undefined' ? THEME_MODE_KEY : 'themeMode';
const skinKey = typeof SKIN_KEY !== 'undefined' ? SKIN_KEY : 'skin';

// 当前卡片发音
let currentAudio = null;
let audioObjectUrl = null;
let audioLoading = false;
let audioError = false;
let speakBtnEl = null;
let playRequestId = 0;

function applyDocumentTheme(mode) {
  const resolve =
    typeof resolveEffectiveTheme === 'function'
      ? resolveEffectiveTheme
      : (m) => {
          if (m === 'light' || m === 'dark') return m;
          try {
            return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
          } catch (e) {
            return 'light';
          }
        };
  document.documentElement.dataset.theme = resolve(mode);
}

function setThemeMode(mode) {
  const normalize =
    typeof normalizeThemeMode === 'function'
      ? normalizeThemeMode
      : (m) => (m === 'light' || m === 'dark' || m === 'system' ? m : 'system');
  themeMode = normalize(mode);
  applyDocumentTheme(themeMode);
}

function applySkin(value) {
  const normalize =
    typeof normalizeSkin === 'function' ? normalizeSkin : (v) => (v === 'clear' ? 'clear' : 'paper');
  document.documentElement.dataset.skin = normalize(value);
}

function initTheme() {
  chrome.storage.local.get([themeKey, skinKey], (result) => {
    setThemeMode(result[themeKey]);
    applySkin(result[skinKey]);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[themeKey]) setThemeMode(changes[themeKey].newValue);
    if (changes[skinKey]) applySkin(changes[skinKey].newValue);
  });

  try {
    const mediaQuery = matchMedia('(prefers-color-scheme: dark)');
    const onSystemThemeChange = () => {
      if (themeMode === 'system') applyDocumentTheme('system');
    };
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', onSystemThemeChange);
    } else if (mediaQuery.addListener) {
      mediaQuery.addListener(onSystemThemeChange);
    }
  } catch (e) {
    // matchMedia 不可用时忽略
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  // 先从后端强制同步，再从本地镜像加载
  const ready = (typeof LCTFavorites !== 'undefined')
    ? LCTFavorites.sync({ force: true })
    : Promise.resolve();
  ready.finally(load);
});

function load() {
  chrome.storage.local.get(['favoriteLookups'], (result) => {
    const favorites = Array.isArray(result.favoriteLookups) ? result.favoriteLookups : [];
    deck = shuffle(favorites.slice());
    showCard(0, { play: deck.length > 0 });
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function langLabel(lang) {
  return lang === 'ja' ? '日本語' : 'English';
}

function lookupKey(item) {
  return [item.lang || 'en', (item.query || '').trim().toLowerCase()].join('::');
}

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (audioObjectUrl) {
    URL.revokeObjectURL(audioObjectUrl);
    audioObjectUrl = null;
  }
}

function updateSpeakButton() {
  if (!speakBtnEl) return;
  speakBtnEl.classList.toggle('is-loading', audioLoading);
  speakBtnEl.classList.toggle('is-error', audioError && !audioLoading);
  speakBtnEl.disabled = audioLoading || deck.length === 0;
  let label = '发音';
  if (audioLoading) label = '发音加载中';
  else if (audioError) label = '发音失败，点一下重试';
  speakBtnEl.setAttribute('aria-label', label);
  speakBtnEl.title = label;
}

async function playCurrentWord() {
  const item = deck[index];
  if (!item || !item.query) return;
  if (typeof LCTFavorites === 'undefined' || !LCTFavorites.fetchAudioBlob) {
    console.warn('[LCT] favorites audio API unavailable');
    return;
  }

  const requestId = ++playRequestId;
  stopAudio();
  audioLoading = true;
  audioError = false;
  updateSpeakButton();

  try {
    const blob = await LCTFavorites.fetchAudioBlob(item.lang || 'en', item.query);
    if (requestId !== playRequestId) return; // 已切卡，丢弃过期响应
    audioObjectUrl = URL.createObjectURL(blob);
    currentAudio = new Audio(audioObjectUrl);
    currentAudio.addEventListener('ended', () => {
      currentAudio = null;
    });
    await currentAudio.play();
  } catch (err) {
    if (requestId !== playRequestId) return;
    audioError = true;
    console.warn('[LCT] review audio failed:', err && err.message);
  } finally {
    if (requestId === playRequestId) {
      audioLoading = false;
      updateSpeakButton();
    }
  }
}

const SPEAKER_SVG =
  '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
  '<path d="M3.5 7.5h3L10.5 4v12l-4-3.5h-3v-5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>' +
  '<path d="M13.5 7.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path></svg>';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function render() {
  stage.innerHTML = '';
  speakBtnEl = null;

  if (deck.length === 0) {
    stopAudio();
    progressBox.hidden = true;
    const empty = el('p', 'empty');
    empty.innerHTML = '生词本还是空的。<br>在网页上划词翻译后，点击面板里的星标收藏，就会出现在这里。';
    stage.appendChild(empty);
    return;
  }

  const item = deck[index];
  progressBox.hidden = false;
  progressEl.textContent = `${index + 1} / ${deck.length}`;
  progressFill.style.width = ((index + 1) / deck.length) * 100 + '%';

  const card = el('article', 'card');
  card.addEventListener('click', flip);

  const top = el('div', 'card-top');
  top.appendChild(el('span', 'card-lang', langLabel(item.lang)));
  speakBtnEl = el('button', 'ring');
  speakBtnEl.type = 'button';
  speakBtnEl.innerHTML = SPEAKER_SVG;
  speakBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    playCurrentWord();
  });
  top.appendChild(speakBtnEl);
  card.appendChild(top);

  if (!flipped) {
    const line = el('div', 'card-wordline');
    line.appendChild(el('span', 'card-word', item.query || '--'));
    card.appendChild(line);
    card.appendChild(el('div', 'card-hint', '点击卡片或按空格查看释义'));
  } else {
    buildBack(item).forEach((node) => card.appendChild(node));
  }

  stage.appendChild(card);
  stage.appendChild(buildControls());
  stage.appendChild(buildKbdHint());
  updateSpeakButton();
}

function buildBack(item) {
  const nodes = [];
  const line = el('div', 'card-wordline');
  line.appendChild(el('span', 'card-word', item.query || '--'));
  if (item.phonetic) line.appendChild(el('span', 'card-reading', item.phonetic));
  nodes.push(line);

  const core = item.coreTranslation || item.translation || '';
  if (core) nodes.push(el('div', 'card-core', core));

  if (Array.isArray(item.definitions) && item.definitions.length > 0) {
    const defs = el('div', 'card-defs');
    item.definitions.forEach((d) => {
      const row = el('div', 'card-def');
      if (d.partOfSpeech) {
        row.appendChild(el('span', 'pos', d.partOfSpeech));
        row.appendChild(el('span', 'leader'));
      }
      row.appendChild(el('span', 'def-meaning', d.meaning || ''));
      defs.appendChild(row);
    });
    nodes.push(defs);
  }

  return nodes;
}

function buildControls() {
  const controls = el('div', 'controls');

  const prevBtn = makeBtn('上一张', prev, 'btn');
  prevBtn.disabled = index === 0;
  controls.appendChild(prevBtn);

  controls.appendChild(makeBtn(flipped ? '看正面' : '翻面', flip, 'btn btn-primary'));

  const nextBtn = makeBtn('下一张', next, 'btn');
  nextBtn.disabled = index >= deck.length - 1;
  controls.appendChild(nextBtn);

  controls.appendChild(el('span', 'spacer'));
  controls.appendChild(makeBtn('随机重排', reshuffle, 'btn btn-quiet'));
  controls.appendChild(makeBtn('移出生词本', removeCurrent, 'btn btn-quiet btn-danger'));

  return controls;
}

function makeBtn(label, handler, cls) {
  const btn = el('button', cls, label);
  btn.type = 'button';
  btn.addEventListener('click', handler);
  return btn;
}

function buildKbdHint() {
  const hint = el('p', 'kbd-hint');
  hint.innerHTML =
    '<span class="kbd">空格</span> 翻面 · <span class="kbd">←</span> 上一张 · <span class="kbd">→</span> 下一张 · <span class="kbd">S</span> 发音';
  return hint;
}

function flip() {
  flipped = !flipped;
  render();
}

function showCard(nextIndex, { play = true } = {}) {
  stopAudio();
  index = nextIndex;
  flipped = false;
  audioError = false;
  render();
  if (play && deck.length > 0) playCurrentWord();
}

function prev() {
  if (index === 0) return;
  showCard(index - 1);
}

function next() {
  if (index >= deck.length - 1) return;
  showCard(index + 1);
}

function reshuffle() {
  deck = shuffle(deck);
  showCard(0);
}

function removeCurrent() {
  const item = deck[index];
  if (!item) return;
  const target = lookupKey(item);
  chrome.storage.local.get(['favoriteLookups'], (result) => {
    const favorites = Array.isArray(result.favoriteLookups) ? result.favoriteLookups : [];
    const nextFavorites = favorites.filter((entry) => lookupKey(entry) !== target);
    chrome.storage.local.set({ favoriteLookups: nextFavorites }, () => {
      // 同步删除后端（失败不阻塞本地操作）
      if (typeof LCTFavorites !== 'undefined') {
        LCTFavorites.remove(item.lang, item.query).catch(() => {});
      }
      stopAudio();
      deck.splice(index, 1);
      const nextIndex = Math.min(index, Math.max(0, deck.length - 1));
      showCard(nextIndex, { play: deck.length > 0 });
    });
  });
}

document.addEventListener('keydown', (e) => {
  if (deck.length === 0) return;
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    flip();
  } else if (e.key === 'ArrowLeft') {
    prev();
  } else if (e.key === 'ArrowRight') {
    next();
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    playCurrentWord();
  }
});
