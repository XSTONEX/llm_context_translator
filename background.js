// ========================================================================
// background.js — Service Worker
// 职责：接收 content.js 的翻译请求，通过流式 API 转发给后端
// ========================================================================

'use strict';

const DEFAULT_API_BASE = 'http://localhost:8000';

async function getApiBase() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiBase'], (result) => {
      resolve(result.apiBase || DEFAULT_API_BASE);
    });
  });
}

// ========== 流式通信（Port 长连接） ==========

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate') return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'TRANSLATE_STREAM') return;

    try {
      const apiBase = await getApiBase();
      const response = await fetch(`${apiBase}/translate/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selected_text: msg.text,
          context_sentence: msg.context || '',
          model: msg.model || null
        })
      });

      if (!response.ok) {
        port.postMessage({
          type: 'error',
          message: `API 请求失败: ${response.status}`
        });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamEnded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 按换行符分割，处理完整的 SSE 行
        const lines = buffer.split('\n');
        // 最后一行可能不完整，保留到下次
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          try {
            const payload = JSON.parse(trimmed.slice(6));
            // 直接转发后端的结构化事件
            port.postMessage(payload);

            if (payload.type === 'done' || payload.type === 'error') {
              streamEnded = true;
            }
          } catch {
            // 忽略无法解析的行
          }
        }
      }

      // 处理缓冲区中剩余的数据
      if (!streamEnded && buffer.trim() && buffer.trim().startsWith('data: ')) {
        try {
          const payload = JSON.parse(buffer.trim().slice(6));
          port.postMessage(payload);
          if (payload.type === 'done' || payload.type === 'error') {
            streamEnded = true;
          }
        } catch {
          // 忽略
        }
      }

      // 兜底：如果后端异常中断，没发送 done 事件，确保通知前端
      if (!streamEnded) {
        port.postMessage({ type: 'done', data: null });
      }
    } catch (err) {
      try {
        port.postMessage({ type: 'error', message: err.message });
      } catch {
        // Port 可能已断开
      }
    }
  });
});

// ========== 非流式降级（sendMessage 兼容） ==========

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE') {
    fetchTranslation(message.text, message.context, message.model)
      .then((data) => {
        sendResponse({ success: true, data });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });

    return true;
  }
});

async function fetchTranslation(text, context, model) {
  const apiBase = await getApiBase();
  const response = await fetch(`${apiBase}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      selected_text: text,
      context_sentence: context || '',
      model: model || null
    })
  });

  if (!response.ok) {
    throw new Error(`API 请求失败: ${response.status}`);
  }

  return await response.json();
}
