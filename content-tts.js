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

  async function getAuthHeaders() {
    const token = await getAccessToken();
    return token ? { 'X-LCT-Token': token } : {};
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

    // 同步置「加载中」，让随后调用的 autoPlay 能立刻 arm whenReady。
    // getApiBase 是异步的，若等到 await 之后再置位，autoPlay 会先看到「未加载」而提前放弃。
    state.ttsLoading = true;
    state.ttsError = false;
    updateSpeakerButtonState();

    const apiBase = await LCT.storage.getApiBase();
    const controller = new AbortController();
    state.ttsAbortController = controller;

    try {
      const response = await fetch(`${apiBase}/api/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(await getAuthHeaders())
        },
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

  // 音频就绪后执行回调：已就绪立即执行；加载中则每 100ms 轮询等待（最多 15s）；出错或失败则放弃
  function whenReady(callback) {
    if (state.ttsReady) {
      callback();
      return;
    }
    if (!state.ttsLoading) return;

    const checkInterval = setInterval(() => {
      if (state.ttsReady) {
        clearInterval(checkInterval);
        callback();
      } else if (!state.ttsLoading) {
        clearInterval(checkInterval);
      }
    }, 100);
    setTimeout(() => clearInterval(checkInterval), 15000);
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

    if (state.ttsLoading) whenReady(playTTS);
  }

  // 连续播放音频 N 遍：靠 ended 事件链式重播，播满后停止
  function playTimes(times) {
    if (times <= 0 || !state.ttsBlobUrl || !state.ttsReady) return;

    // 先停掉正在播放的音频，避免快速连续划词时声音叠加
    if (state.ttsAudio) {
      state.ttsAudio.pause();
      state.ttsAudio = null;
    }

    let remaining = times;
    const playOnce = () => {
      const audio = new Audio(state.ttsBlobUrl);
      state.ttsAudio = audio;
      audio.addEventListener('ended', () => {
        state.ttsAudio = null;
        remaining -= 1;
        if (remaining > 0) playOnce();
      });
      audio.play().catch((err) => {
        console.error('[LCT] Audio playback failed:', err);
        state.ttsAudio = null;
        state.ttsError = true;
        updateSpeakerButtonState();
      });
    };
    playOnce();
  }

  // TTS 触发后立即调用：音频一就绪就按用户设置自动播放（off 不播 / once 一遍 / thrice 三遍），
  // 不再等整段翻译流式输出结束
  async function autoPlay() {
    const result = await LCT.storage.get(['ttsPlayMode']);
    const mode = result.ttsPlayMode || 'off';
    const times = mode === 'thrice' ? 3 : mode === 'once' ? 1 : 0;
    if (times === 0) return;
    whenReady(() => playTimes(times));
  }

  LCT.tts = {
    cleanup,
    fetchTTS,
    updateSpeakerButtonState,
    handleSpeakerClick,
    autoPlay
  };
})();
