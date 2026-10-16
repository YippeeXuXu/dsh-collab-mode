/**
 * 浏览器半的可执行验证。
 *
 * 这一半平时只能在真实浏览器里跑，所以它是整套改动里**唯一没有自动验证**的部分——
 * 而它恰好又踩过"fixture 写错却通过测试"的坑。这里用一个最小的 require/DOM 替身
 * 把 bundle 的 factory **真跑一遍**，从而在 Node 里固定住三件事：
 *
 *   1. factory 能执行到底（require 的 specifier 都存在、组件顶层逻辑不抛）；
 *   2. 座位行与浮层的**结构**正确（element 类型、className、层级）；
 *   3. 上一版目检发现的三处真实缺陷不会回来：描边 chip、图标与文字零间距、
 *      文案与相邻入口不同构。
 *
 * 它不验证渲染像素——那需要真实浏览器。它验证的是"代码会跑、结构如约"，
 * 这两件事此前完全没人管。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

/** 收集 jsx/jsxs 调用，得到一棵可断言的普通对象树。 */
function makeJsx(node) {
  return (type, props, key) => {
    node.count += 1;
    return { type, props: props ?? {}, key };
  };
}

/**
 * 在 Node 里加载 bundle。
 *
 * bundle 顶层就会执行 `window.__ModuleLoader__.load({...})`，所以替身必须在
 * import 之前装好，且捕获得 factory 供测试主动调用。
 */
async function loadBundle({ pendingFetch = false } = {}) {
  const node = { count: 0 };
  const jsx = makeJsx(node);
  // useState 必须**真的存状态**：否则组件永远停在初始态（loading），
  // 浮层的真实结构根本走不到，测出来的"通过"是假的。
  const slots = [];
  const effectSlots = [];
  let cursor = 0;
  const react = {
    useState: (initial) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; };
      return [slots[index], set];
    },
    /**
     * 按依赖决定是否重跑，和真实 React 一致。
     *
     * 早先这里每次渲染都无条件执行 effect，而 effect 里正是 `load()`——于是每次
     * 复渲染都把状态打回 loading，组件永远走不到 ready 态，浮层结构测不到。
     */
    useEffect: (fn, deps) => {
      const index = cursor++;
      const previous = effectSlots[index];
      const changed = previous === undefined || deps === undefined
        || deps.length !== previous.deps.length || deps.some((dep, i) => dep !== previous.deps[i]);
      if (!changed) return;
      effectSlots[index] = { deps: deps ?? [] };
      try { fn(); } catch { /* 清理函数在此无需处理 */ }
    },
    useCallback: (fn) => fn,
    createElement: jsx,
  };
  /**
   * 开始新一轮渲染：只把 hook 游标归零，**保留已存状态**。
   *
   * 早先这里把状态槽也清空了，于是每次渲染都回到初始态，组件永远停在 loading，
   * 浮层结构根本测不到——替身与真实 React 的语义差一点，测试的"通过"就是假的。
   */
  const renderPass = () => { cursor = 0; };
  const captured = { factory: null, id: null };
  const styleTags = [];
  // 面板从宿主取配置；替身给出一份最小但形状真实的响应。
  const payload = {
    ok: true,
    path: '/Users/example/.dsh/route-catalog/shared/role-route.json',
    roles: ['scout', 'reviewer'],
    routes: [
      { route_id: 'luna6_deep', provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'max' },
      { route_id: 'deepseek_official', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    ],
    config: { version: 1, roles: { reviewer: { route_id: 'luna6_deep' } } },
  };
  globalThis.fetch = pendingFetch
    ? () => new Promise(() => {})
    : async () => ({ ok: true, status: 200, json: async () => payload });

  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        captured.id = id;
        captured.factory = factory;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.document = {
    createElement: (tag) => ({ tag, dataset: {}, textContent: '', setAttribute() {} }),
    head: { __tags: styleTags, appendChild: (element) => styleTags.push(element) },
  };

  const require = (specifier) => {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: Symbol('Fragment') };
    throw new Error(`bundle required an unavailable specifier: ${specifier}`);
  };

  await import(`../host-plugins/dsh-role-route-panel/src/client.js?test=${Date.now()}`);
  assert.equal(captured.id, 'dsh-role-route-panel');
  assert.equal(typeof captured.factory, 'function');
  const exports = captured.factory(require);
  return { exports, node, styleTags, renderPass };
}

/** 在树里按 className 找第一个节点。 */
function findByClass(tree, className) {
  const stack = Array.isArray(tree) ? [...tree] : [tree];
  while (stack.length > 0) {
    const current = stack.shift();
    if (!current || typeof current !== 'object') continue;
    if (current.type === 'text') continue;
    const classes = String(current.props?.className ?? '').split(/\s+/);
    if (classes.includes(className)) return current;
    const children = current.props?.children;
    if (Array.isArray(children)) stack.push(...children);
    else if (children !== undefined && children !== null) stack.push(children);
  }
  return null;
}

/** 收集树里所有渲染出的字符串文字。 */
function allText(tree) {
  const out = [];
  const stack = Array.isArray(tree) ? [...tree] : [tree];
  while (stack.length > 0) {
    const current = stack.shift();
    if (typeof current === 'string') { out.push(current); continue; }
    if (!current || typeof current !== 'object') continue;
    const children = current.props?.children;
    if (Array.isArray(children)) stack.push(...children);
    else if (children !== undefined && children !== null) stack.push(children);
  }
  return out;
}

test('factory 能在无浏览器环境执行，并导出约定入口', async () => {
  const { exports } = await loadBundle();
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots']);
  assert.equal(exports.BASE_PATH, '/api/role-route');
  assert.equal(typeof exports.Panel, 'function');
  assert.equal(typeof exports.Trigger, 'function');
});

test('座位行是原生整行形态：无边框、满高、图标与文字有间距、文案与邻居同构', async () => {
  const { exports } = await loadBundle();

  // 样式由 Panel 渲染时注入（installStyle 在 Panel 内调用），所以先渲染 Panel 再取样式。
  exports.Panel({ onClose: () => {} });
  const styleTags = globalThis.document.head.__tags ?? [];

  const trigger = exports.Trigger({});
  assert.equal(Array.isArray(trigger), true);
  assert.equal(styleTags.length, 1, '组件渲染时必须注入样式，否则会用浏览器默认样式（上一版的"风格迥异"）');
  const css = styleTags[0].textContent;
  const badge = /\.rrp_badge\{([^}]*)\}/u.exec(css);
  assert.ok(badge, 'CSS 必须定义 .rrp_badge');
  const rule = badge[1];

  // 目检指出的三处真实缺陷，逐条钉住：
  assert.match(rule, /border:none/u, '座位行不得有描边——上下邻居都是无边框列表行');
  assert.match(rule, /gap:8px/u, '图标与文字之间必须有间距（曾被目检为"贴死"）');
  // 高度必须与原生「设置」行一致（浏览器实测 34px）；49px 会让这一行显得偏高。
  assert.match(rule, /height:34px/u, '座位行高度须与原生入口一致（实测 34px）');
  // 左内边距实测基准为 6px（基准行层 x=12、图标 x=18、文字 x=42）；10px 会让整行右移 4px。
  assert.match(rule, /padding:6px 8px 6px 6px/u, '左内边距须为 6px，与相邻入口图标/文字起点对齐');

  // 边距在容器行（.rrp_layer）上，必须上下对称：只写上边距会让"与上一行"的间距
  // 大于"与下一行"——这正是实测反馈的"三个按钮之间的空隙不对称"。
  // 座位之间的空隙由容器决定，本行无法通过自身边距改变它——因此容器 gap 必须由
  // 本插件显式收窄，否则会吃侧栏默认值而显得过宽。
  const layerRule = /\.rrp_layer\{([^}]*)\}/u.exec(css);
  assert.ok(layerRule, 'CSS 必须定义 .rrp_layer');
  assert.doesNotMatch(css, /\.rrp_badge\{[^}]*background:var\(/u, '座位行不得自带底色');

  const layer = findByClass(trigger, 'rrp_layer');
  assert.ok(layer, '必须有 rrp_layer 整行容器');
  const button = findByClass(layer, 'rrp_badge');
  assert.ok(button, '必须有 rrp_badge 按钮');
  assert.equal(button.type, 'button');
  assert.ok(findByClass(button, 'rrp_badgeIcon'), '必须有图标');
  // 图标须铺满 16px 视框：图形只有 12×12 时明显小于相邻图标（目检实测）。
  const svg = (function find(node) {
    const stack = [node];
    while (stack.length) { const c = stack.pop(); if (!c || typeof c !== 'object') continue;
      if (c.type === 'svg') return c; const k = c.props?.children; if (Array.isArray(k)) stack.push(...k); else if (k) stack.push(k); }
    return null;
  })(button);
  assert.ok(svg, '座位行必须有 svg 图标');
  assert.equal(svg.props.width, 16);
  assert.ok(Number(svg.props.height) === 16, '图标视框须为 16×16，与相邻图标一致');
  // transform 绝不能加在 svg 上：那会缩放整个渲染盒（实测撑到 21×21、溢出视框），
  // 而图形本身没变大。图形应按 16×16 直接绘制。
  assert.equal(svg.props.transform, undefined, 'svg 上不得有 transform（会撑大渲染盒而非图形）');
  // 线重须与相邻实心图标的视觉笔画相当（实测 2 会渲染成 2–4px，邻居是 1–3px）。
  assert.equal(Number(svg.props.strokeWidth), 1.5, '线重须为 1.5，与相邻实心图标的笔画粗细相当');
  const texts = allText(button);
  assert.ok(texts.includes('模型路由'), `主标签须是与邻居同构的名词短语，实际: ${JSON.stringify(texts)}`);
  // 八字拼接语（"模型路由角色默认"连写）曾与邻居风格不一致，不得复现。
  assert.equal(texts.some((text) => text.includes('模型路由角色默认')), false);
});

test('角色行：一行一个角色，选项含“跟随预设默认”，无强度声明写“未声明”', async () => {
  const { exports } = await loadBundle();
  const routes = [
    { route_id: 'luna6_deep', provider: 'openai-codex', model: 'gpt-6-luna', reasoningEffort: 'max' },
    { route_id: 'deepseek_official', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  ];

  // 已配置的角色：显示所选路线，强度列显示该路线的档位。
  const configured = exports.RoleRow({ role: 'reviewer', selected: 'luna6_deep', routes, onSelect: () => {} });
  const label = findByClass(configured, 'rrp_label');
  assert.ok(label, '每行必须有角色标签');
  assert.ok(findByClass(configured, 'rrp_sel'), '每行必须有下拉');
  const texts = allText(configured);
  assert.ok(texts.some((t) => t.includes('（跟随预设默认）')), '下拉必须能回到“跟随预设默认”');
  assert.ok(texts.some((t) => t.includes('max')), '强度列须显示所选路线的档位');

  // 选了一条**没有声明强度**的路线：强度列必须写“未声明”，而不是留空或写成坏的。
  const undeclared = exports.RoleRow({ role: 'reviewer', selected: 'deepseek_official', routes, onSelect: () => {} });
  const eff = findByClass(undeclared, 'rrp_eff');
  assert.equal(eff.props['data-none'], 'true');
  assert.deepEqual(eff.props.children, '未声明');

  // 未配置的角色：强度列用破折号，不假装有值。
  const unset = exports.RoleRow({ role: 'scout', selected: '', routes, onSelect: () => {} });
  assert.deepEqual(findByClass(unset, 'rrp_eff').props.children, '—');
});

test('浮层首帧：未取到配置时显示读取中，不渲染空壳', async () => {
  // 让加载永不结算，从而稳定地停在首帧（不依赖微任务时序）。
  const { exports } = await loadBundle({ pendingFetch: true });
  const first = exports.Panel({ onClose: () => {} });
  assert.ok(findByClass(first, 'rrp_panel'), '首帧必须已是面板容器，而不是空白');
  assert.match(JSON.stringify(allText(first)), /读取配置/u);
  // 首帧不应渲染角色行——没有数据就假装有数据是更糟的失败。
  assert.equal(findByClass(first, 'rrp_row'), null, '首帧不得渲染角色行');
});

test('draftOf 只记录当前路线：未配置角色为空串（面板显示“跟随预设默认”）', async () => {
  const { exports } = await loadBundle();
  const draft = exports.draftOf({ roles: ['scout', 'reviewer'], config: { roles: { reviewer: { route_id: 'kimi_k3_256k' } } } });
  assert.deepEqual(draft, { scout: '', reviewer: 'kimi_k3_256k' });
});
