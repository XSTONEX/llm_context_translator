// ========================================================================
// review.js — 生词本翻卡复习页
// ========================================================================

'use strict';

const stage = document.getElementById('stage');
const progressEl = document.getElementById('progress');

let deck = [];
let index = 0;
let flipped = false;
let themeMode = typeof DEFAULT_THEME_MODE !== 'undefined' ? DEFAULT_THEME_MODE : 'system';
const themeKey = typeof THEME_MODE_KEY !== 'undefined' ? THEME_MODE_KEY : 'themeMode';

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

function initTheme() {
  chrome.storage.local.get([themeKey], (result) => {
    setThemeMode(result[themeKey]);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[themeKey]) return;
    setThemeMode(changes[themeKey].newValue);
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
  if (audioLoading) speakBtnEl.textContent = '加载中';
  else if (audioError) speakBtnEl.textContent = '重试发音';
  else speakBtnEl.textContent = '发音';
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

function render() {
  stage.innerHTML = '';
  speakBtnEl = null;

  if (deck.length === 0) {
    stopAudio();
    progressEl.textContent = '';
    const empty = document.createElement('div');
    empty.classList.add('empty');
    empty.innerHTML = '生词本还是空的。<br>在网页上划词翻译后，点击面板里的 ★ 收藏，就会出现在这里。';
    stage.appendChild(empty);
    return;
  }

  const item = deck[index];
  progressEl.textContent = `${index + 1} / ${deck.length}`;

  const card = document.createElement('div');
  card.classList.add('card');
  card.addEventListener('click', flip);

  const langTag = document.createElement('div');
  langTag.classList.add('card-lang');
  langTag.textContent = langLabel(item.lang);
  card.appendChild(langTag);

  if (!flipped) {
    const row = document.createElement('div');
    row.classList.add('card-front-row');

    const word = document.createElement('div');
    word.classList.add('card-front-word');
    word.textContent = item.query || '--';
    row.appendChild(word);
    card.appendChild(row);

    const hint = document.createElement('div');
    hint.classList.add('card-hint');
    hint.textContent = '点击卡片或按空格查看释义';
    card.appendChild(hint);
  } else {
    card.appendChild(buildBack(item));
  }

  stage.appendChild(card);
  stage.appendChild(buildControls());
  stage.appendChild(buildKbdHint());
  updateSpeakButton();
}

function buildBack(item) {
  const back = document.createElement('div');
  back.classList.add('card-back');

  const word = document.createElement('div');
  word.classList.add('card-front-word');
  word.textContent = item.query || '--';
  back.appendChild(word);

  if (item.phonetic) {
    const reading = document.createElement('div');
    reading.classList.add('back-reading');
    reading.textContent = item.phonetic;
    back.appendChild(reading);
  }

  const core = item.coreTranslation || item.translation || '';
  if (core) {
    const coreEl = document.createElement('div');
    coreEl.classList.add('back-core');
    coreEl.textContent = core;
    back.appendChild(coreEl);
  }

  if (Array.isArray(item.definitions) && item.definitions.length > 0) {
    const defs = document.createElement('div');
    defs.classList.add('back-defs');
    item.definitions.forEach((d) => {
      const row = document.createElement('div');
      row.classList.add('back-def');
      if (d.partOfSpeech) {
        const pos = document.createElement('span');
        pos.classList.add('pos');
        pos.textContent = d.partOfSpeech;
        row.appendChild(pos);
      }
      row.appendChild(document.createTextNode(d.meaning || ''));
      defs.appendChild(row);
    });
    back.appendChild(defs);
  }

  return back;
}

function buildControls() {
  const controls = document.createElement('div');
  controls.classList.add('controls');

  const prevBtn = makeBtn('上一张', prev, 'btn');
  prevBtn.disabled = index === 0;
  controls.appendChild(prevBtn);

  controls.appendChild(makeBtn(flipped ? '看正面' : '翻面', flip, 'btn btn-primary'));

  const nextBtn = makeBtn('下一张', next, 'btn');
  nextBtn.disabled = index >= deck.length - 1;
  controls.appendChild(nextBtn);

  speakBtnEl = makeBtn('发音', () => {
    playCurrentWord();
  }, 'btn btn-speak');
  speakBtnEl.addEventListener('click', (e) => e.stopPropagation());
  controls.appendChild(speakBtnEl);

  controls.appendChild(makeBtn('随机重排', reshuffle, 'btn'));
  controls.appendChild(makeBtn('移出生词本', removeCurrent, 'btn btn-danger'));

  return controls;
}

function makeBtn(label, handler, cls) {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.textContent = label;
  btn.addEventListener('click', handler);
  return btn;
}

function buildKbdHint() {
  const hint = document.createElement('div');
  hint.classList.add('kbd-hint');
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
