// ========================================================================
// content-trigger.js — 图标触发：选中后在松手点旁显示小图标，鼠标碰到才翻译
// ========================================================================

(function () {
  'use strict';

  const LCT = globalThis.LCT;
  const constants = LCT.constants;
  const ICONS = LCT.ICONS;

  const FIRE_ANIMATION_MS = 160;
  const LEAVE_ANIMATION_MS = 150;
  // 只按修饰键不算「在打字」，图标保留；⌘C 这类组合键的主键会让图标消失
  const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

  let iconElement = null;
  let onTriggerCallback = null;
  let center = null;
  let timeoutTimer = null;
  let dwellTimer = null;

  // 以松手点为锚：默认放右下；贴右边/底边放不下时翻到左侧/上方。
  // 返回热区左上角（视口坐标）与方位，保证松手点本身不在热区内，必须「滑过去」才触发
  function computePosition(pointer, viewport) {
    const size = constants.TRIGGER_ICON_SIZE;
    const pad = (constants.TRIGGER_HIT_SIZE - size) / 2;
    const gap = constants.TRIGGER_EDGE_GAP;

    let h = 'right';
    let chipLeft = pointer.x + constants.TRIGGER_OFFSET_X;
    if (chipLeft + size > viewport.width - gap) {
      h = 'left';
      chipLeft = pointer.x - constants.TRIGGER_OFFSET_X - size;
    }

    let v = 'down';
    let chipTop = pointer.y + constants.TRIGGER_OFFSET_Y;
    if (chipTop + size > viewport.height - gap) {
      v = 'up';
      chipTop = pointer.y - constants.TRIGGER_OFFSET_Y - size;
    }

    chipLeft = Math.max(gap, chipLeft);
    chipTop = Math.max(gap, chipTop);
    return { left: chipLeft - pad, top: chipTop - pad, h, v };
  }

  function getRoot() {
    if (!LCT.panel.getShadowRoot()) LCT.panel.initShadowDOM();
    return LCT.panel.getShadowRoot();
  }

  function clearTimers() {
    clearTimeout(timeoutTimer);
    clearTimeout(dwellTimer);
    timeoutTimer = null;
    dwellTimer = null;
  }

  function onDocumentMouseDown(event) {
    if (!containsEvent(event)) hide();
  }

  function onDocumentKeyDown(event) {
    if (MODIFIER_KEYS.has(event.key)) return;
    hide();
  }

  function onDocumentScroll() {
    hide();
  }

  function onDocumentMouseMove(event) {
    if (!center) return;
    const distance = Math.hypot(event.clientX - center.x, event.clientY - center.y);
    if (distance > constants.TRIGGER_DISMISS_DISTANCE) hide();
  }

  function bindGlobalListeners() {
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    document.addEventListener('scroll', onDocumentScroll, { capture: true, passive: true });
    document.addEventListener('mousemove', onDocumentMouseMove, { passive: true });
  }

  function unbindGlobalListeners() {
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
    document.removeEventListener('keydown', onDocumentKeyDown, true);
    document.removeEventListener('scroll', onDocumentScroll, { capture: true, passive: true });
    document.removeEventListener('mousemove', onDocumentMouseMove, { passive: true });
  }

  // 收起当前图标并返回它（调用方决定是播触发动画还是离场动画）
  function detach() {
    clearTimers();
    unbindGlobalListeners();
    const el = iconElement;
    iconElement = null;
    onTriggerCallback = null;
    center = null;
    return el;
  }

  function fire(el) {
    if (!el || el !== iconElement) return;
    const callback = onTriggerCallback;
    detach();
    el.classList.add('lct-trigger-fired');
    setTimeout(() => el.remove(), FIRE_ANIMATION_MS);
    if (callback) callback();
  }

  function createIcon(position) {
    const el = document.createElement('div');
    el.classList.add('lct-trigger');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', '翻译选中内容');
    el.dataset.h = position.h;
    el.dataset.v = position.v;
    el.style.left = position.left + 'px';
    el.style.top = position.top + 'px';

    const chip = document.createElement('span');
    chip.classList.add('lct-trigger-chip');
    chip.innerHTML = ICONS.trigger;
    el.appendChild(chip);

    el.addEventListener('pointerenter', () => {
      if (el !== iconElement) return;
      if (constants.TRIGGER_DWELL > 0) {
        clearTimeout(dwellTimer);
        dwellTimer = setTimeout(() => fire(el), constants.TRIGGER_DWELL);
      } else {
        fire(el);
      }
    });
    el.addEventListener('pointerleave', () => {
      clearTimeout(dwellTimer);
      dwellTimer = null;
    });
    // 阻止默认行为：点图标时不清掉页面上的选区高亮
    el.addEventListener('mousedown', (event) => event.preventDefault());
    el.addEventListener('click', () => fire(el));
    return el;
  }

  function show(pointer, onTrigger) {
    hide({ immediate: true });
    const root = getRoot();
    if (!root) return;

    const position = computePosition(pointer, {
      width: window.innerWidth,
      height: window.innerHeight
    });
    const el = createIcon(position);
    root.appendChild(el);

    iconElement = el;
    onTriggerCallback = onTrigger;
    const half = constants.TRIGGER_HIT_SIZE / 2;
    center = { x: position.left + half, y: position.top + half };
    bindGlobalListeners();
    timeoutTimer = setTimeout(() => hide(), constants.TRIGGER_TIMEOUT);
  }

  function hide(options = {}) {
    const el = detach();
    if (!el) return;
    if (options.immediate) {
      el.remove();
      return;
    }
    el.classList.add('lct-trigger-leaving');
    setTimeout(() => el.remove(), LEAVE_ANIMATION_MS);
  }

  function isVisible() {
    return Boolean(iconElement);
  }

  function containsEvent(event) {
    if (!iconElement || !event || typeof event.composedPath !== 'function') return false;
    return event.composedPath().includes(iconElement);
  }

  LCT.trigger = {
    computePosition,
    show,
    hide,
    isVisible,
    containsEvent
  };
})();
