const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createListenerTarget() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
      listeners.push({ type, fn, capture });
    },
    removeEventListener(type, fn, options) {
      const capture = typeof options === 'boolean' ? options : Boolean(options && options.capture);
      const idx = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (idx >= 0) listeners.splice(idx, 1);
    },
    dispatch(type, event = {}) {
      listeners.filter((l) => l.type === type).forEach((l) => l.fn(event));
    }
  };
}

function createElement(tagName) {
  const classes = new Set();
  const element = {
    ...createListenerTarget(),
    tagName: tagName.toUpperCase(),
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    innerHTML: '',
    attributes: {},
    classList: {
      add(...names) {
        names.forEach((name) => classes.add(name));
      },
      contains(name) {
        return classes.has(name);
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }
  };
  return element;
}

function loadTrigger() {
  const document = { ...createListenerTarget(), createElement };
  const shadowRoot = createElement('shadow-root');
  const context = {
    console,
    document,
    window: { innerWidth: 1000, innerHeight: 800 },
    chrome: { storage: { local: { get() {}, set() {} } } },
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context);
  const root = path.join(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content-core.js'), 'utf8'), context);
  context.LCT.panel = {
    getShadowRoot() {
      return shadowRoot;
    },
    initShadowDOM() {}
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'content-trigger.js'), 'utf8'), context);
  return { LCT: context.LCT, document, shadowRoot };
}

function insideHitZone(point, pos, hitSize) {
  return (
    point.x >= pos.left && point.x <= pos.left + hitSize &&
    point.y >= pos.top && point.y <= pos.top + hitSize
  );
}

function icons(shadowRoot) {
  return shadowRoot.children.filter((c) => c.classList.contains('lct-trigger'));
}

async function run() {
  // 位置：默认右下；贴右边翻到左侧，贴底边翻到上方；松手点永远不在热区内
  {
    const { LCT } = loadTrigger();
    const hit = LCT.constants.TRIGGER_HIT_SIZE;
    const vp = { width: 1000, height: 800 };

    const normal = LCT.trigger.computePosition({ x: 100, y: 100 }, vp);
    assert.deepEqual({ ...normal }, { left: 103, top: 107, h: 'right', v: 'down' });

    const rightEdge = LCT.trigger.computePosition({ x: 990, y: 100 }, vp);
    assert.equal(rightEdge.h, 'left');
    assert.equal(rightEdge.left, 955);

    const bottomEdge = LCT.trigger.computePosition({ x: 100, y: 790 }, vp);
    assert.equal(bottomEdge.v, 'up');
    assert.equal(bottomEdge.top, 751);

    for (const [pointer, pos] of [
      [{ x: 100, y: 100 }, normal],
      [{ x: 990, y: 100 }, rightEdge],
      [{ x: 100, y: 790 }, bottomEdge]
    ]) {
      assert.equal(insideHitZone(pointer, pos, hit), false);
    }
  }

  // 碰到即触发，只触发一次，播完触发动画后移除
  {
    const { LCT, document, shadowRoot } = loadTrigger();
    let fired = 0;
    LCT.trigger.show({ x: 100, y: 100 }, () => { fired += 1; });
    const [el] = icons(shadowRoot);
    assert.ok(el);
    assert.equal(el.style.left, '103px');
    assert.equal(el.style.top, '107px');
    assert.equal(el.dataset.h, 'right');
    assert.equal(LCT.trigger.isVisible(), true);
    assert.ok(document.listeners.length > 0);

    el.dispatch('pointerenter');
    assert.equal(fired, 1);
    assert.equal(LCT.trigger.isVisible(), false);
    assert.equal(el.classList.contains('lct-trigger-fired'), true);
    assert.equal(document.listeners.length, 0);

    el.dispatch('click');
    assert.equal(fired, 1);
    await sleep(200);
    assert.equal(icons(shadowRoot).length, 0);
  }

  // 点击也能触发（触控板/触屏兜底）；点图标不清掉页面选区
  {
    const { LCT, shadowRoot } = loadTrigger();
    let fired = 0;
    LCT.trigger.show({ x: 100, y: 100 }, () => { fired += 1; });
    const [el] = icons(shadowRoot);
    let prevented = false;
    el.dispatch('mousedown', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    el.dispatch('click');
    assert.equal(fired, 1);
  }

  // 重新选词：旧图标立即移除，只保留一个；旧图标上的事件不再触发新回调
  {
    const { LCT, shadowRoot } = loadTrigger();
    let first = 0;
    let second = 0;
    LCT.trigger.show({ x: 100, y: 100 }, () => { first += 1; });
    const [oldEl] = icons(shadowRoot);
    LCT.trigger.show({ x: 300, y: 300 }, () => { second += 1; });
    assert.equal(icons(shadowRoot).length, 1);
    oldEl.dispatch('pointerenter');
    assert.equal(first + second, 0);
    icons(shadowRoot)[0].dispatch('pointerenter');
    assert.equal(second, 1);
  }

  // 消失条件：点别处 / 键盘输入 / 滚动 / 鼠标走远 / 超时，都不触发翻译
  const dismissals = [
    ['点击别处', ({ document }) => document.dispatch('mousedown', { composedPath: () => [] })],
    ['按下普通键', ({ document }) => document.dispatch('keydown', { key: 'c' })],
    ['滚动', ({ document }) => document.dispatch('scroll', {})],
    ['鼠标走远', ({ document }) => document.dispatch('mousemove', { clientX: 119 + 200, clientY: 123 })]
  ];
  for (const [label, act] of dismissals) {
    const harness = loadTrigger();
    let fired = 0;
    harness.LCT.trigger.show({ x: 100, y: 100 }, () => { fired += 1; });
    const [el] = icons(harness.shadowRoot);
    act(harness);
    assert.equal(harness.LCT.trigger.isVisible(), false, label);
    assert.equal(el.classList.contains('lct-trigger-leaving'), true, label);
    assert.equal(harness.document.listeners.length, 0, label);
    el.dispatch('pointerenter');
    assert.equal(fired, 0, label);
    await sleep(200);
    assert.equal(icons(harness.shadowRoot).length, 0, label);
  }

  // 不该消失的：在图标上按下、只按修饰键、鼠标还在附近
  {
    const { LCT, document, shadowRoot } = loadTrigger();
    LCT.trigger.show({ x: 100, y: 100 }, () => {});
    const [el] = icons(shadowRoot);
    document.dispatch('mousedown', { composedPath: () => [el] });
    document.dispatch('keydown', { key: 'Meta' });
    document.dispatch('keydown', { key: 'Shift' });
    document.dispatch('mousemove', { clientX: 119 + 100, clientY: 123 });
    assert.equal(LCT.trigger.isVisible(), true);
    assert.equal(LCT.trigger.containsEvent({ composedPath: () => [el] }), true);
    assert.equal(LCT.trigger.containsEvent({ composedPath: () => [] }), false);
  }

  // 超时自动消失
  {
    const { LCT } = loadTrigger();
    LCT.constants.TRIGGER_TIMEOUT = 30;
    LCT.trigger.show({ x: 100, y: 100 }, () => {});
    await sleep(60);
    assert.equal(LCT.trigger.isVisible(), false);
  }

  // 停留时间 > 0：需停留够才触发，中途离开则取消
  {
    const { LCT, shadowRoot } = loadTrigger();
    LCT.constants.TRIGGER_DWELL = 40;
    let fired = 0;
    LCT.trigger.show({ x: 100, y: 100 }, () => { fired += 1; });
    const [el] = icons(shadowRoot);
    el.dispatch('pointerenter');
    el.dispatch('pointerleave');
    await sleep(70);
    assert.equal(fired, 0);
    el.dispatch('pointerenter');
    assert.equal(fired, 0);
    await sleep(70);
    assert.equal(fired, 1);
  }

  console.log('trigger-icon.test.js: all passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
