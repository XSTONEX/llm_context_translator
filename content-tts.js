// ========================================================================
// content-tts.js — TTS preload, caching, and playback
// ========================================================================

(function () {
  'use strict';

  const LCT = globalThis.LCT;
  const state = LCT.state;

  function revokeCurrentBlob() {
    if (state.ttsBlobUrl) {
      URL.revokeObjectURL(state.ttsBlobUrl);
      state.ttsBlobUrl = null;
    }
  }

  function cleanup(options = {}) {
    if (state.ttsAbortController) {
      state.ttsAbortController.abort();
      state.ttsAbortController = null;
    }
    if (state.ttsAudio) {
      state.ttsAudio.pause();
      state.ttsAudio = null;
    }
    if (!options.keepBlob) revokeCurrentBlob();
    state.ttsReady = false;
    state.ttsLoading = false;
    state.ttsError = false;
    state.ttsText = '';
    updateSpeakerButtonState();
  }

  function pruneCache() {
    while (state.ttsCache.size > LCT.constants.TTS_CACHE_LIMIT) {
      const firstKey = state.ttsCache.keys().next().value;
      state.ttsCache.delete(firstKey);
    }
  }

  function cacheKey(text, voice) {
    return [voice || 'alloy', text].join('::');
  }

  async function fetchTTS(text, voice = 'alloy') {
    if (!text) return;

    const key = cacheKey(text, voice);
    const cached = state.ttsCache.get(key);
    cleanup();
    state.ttsText = text;

    if (cached) {
      state.ttsBlobUrl = URL.createObjectURL(cached);
      state.ttsReady = true;
      state.ttsLoading = false;
      updateSpeakerButtonState();
      return;
    }

    const apiBase = await LCT.storage.getApiBase();
    const controller = new AbortController();
    state.ttsAbortController = controller;
    state.ttsLoading = true;
    state.ttsError = false;
    updateSpeakerButtonState();

    try {
      const response = await fetch(`${apiBase}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
        signal: controller.signal
      });

      if (!response.ok) throw new Error(`TTS API error: ${response.status}`);

      const blob = await response.blob();
      if (controller.signal.aborted) return;

      state.ttsCache.set(key, blob);
      pruneCache();
      state.ttsBlobUrl = URL.createObjectURL(blob);
      state.ttsReady = true;
      state.ttsLoading = false;
      updateSpeakerButtonState();
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[LCT] TTS fetch failed:', err);
      state.ttsLoading = false;
      state.ttsError = true;
      updateSpeakerButtonState();
    }
  }

  function updateSpeakerButtonState() {
    const panel = LCT.panel && LCT.panel.getPanel();
    if (!panel) return;
    const btn = panel.querySelector('[data-action="speaker"]');
    if (!btn) return;

    btn.classList.toggle('lct-speaker-loading', state.ttsLoading);
    btn.classList.toggle('lct-speaker-ready', state.ttsReady);
    btn.classList.toggle('lct-speaker-error', state.ttsError);

    if (state.ttsLoading) btn.title = '加载中，完成后自动播放';
    else if (state.ttsReady) btn.title = '点击发音';
    else if (state.ttsError) btn.title = '发音加载失败';
    else btn.title = '发音';
  }

  function playTTS() {
    if (!state.ttsBlobUrl || !state.ttsReady) return;
    if (state.ttsAudio && !state.ttsAudio.paused && !state.ttsAudio.ended) return;

    const audio = new Audio(state.ttsBlobUrl);
    state.ttsAudio = audio;
    audio.addEventListener('ended', () => { state.ttsAudio = null; });
    audio.play().catch((err) => {
      console.error('[LCT] Audio playback failed:', err);
      state.ttsAudio = null;
      state.ttsError = true;
      updateSpeakerButtonState();
    });
  }

  function handleSpeakerClick() {
    if (state.ttsReady) {
      playTTS();
      return;
    }

    if (state.ttsError && state.ttsText) {
      fetchTTS(state.ttsText);
      return;
    }

    if (state.ttsLoading) {
      const checkInterval = setInterval(() => {
        if (state.ttsReady) {
          clearInterval(checkInterval);
          playTTS();
        } else if (!state.ttsLoading) {
          clearInterval(checkInterval);
        }
      }, 100);
      setTimeout(() => clearInterval(checkInterval), 15000);
    }
  }

  LCT.tts = {
    cleanup,
    fetchTTS,
    updateSpeakerButtonState,
    handleSpeakerClick
  };
})();
