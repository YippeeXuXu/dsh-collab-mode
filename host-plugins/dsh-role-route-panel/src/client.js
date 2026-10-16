/**
 * 角色默认路由面板 —— 浏览器半。
 *
 * 手写的 `__ModuleLoader__` bundle，与 tokenledger 同款：宿主把 `exports["./client"]`
 * 指向的那一个文件原样发给浏览器并同步 `require` 出去，所以这里没有构建步骤，
 * 也没有 JSX——`jsx`/`jsxs` 直接调用。
 *
 * ## 这个面板做什么
 *
 * 7 个角色各一条「模型 + 思考强度」下拉。候选**不是**手写的型号清单，而是宿主
 * `/api/role-route` 从共享 route catalog 里读出来的已注册路线：每条路线自带
 * 强度，所以“模型 + 强度”就是选一条路线，选不出一条不存在的组合。
 *
 * ## 它为什么不能更简单
 *
 * 浏览器半与宿主半是**两套挂载机制**：这一半由客户端模块扫描器按包名发现，
 * 那一半由 profile 的 host Loader 挂起。控制台一切正常并不证明宿主半存在——
 * 这个坑真实发生过。因此这里每一条失败路径都写清楚“哪一半缺了”，而不是让
 * 面板安静地不出现。
 *
 * @module dsh-role-route-panel/client
 */

console.info('[role-route-panel] bundle script executing (client half present)');

window.__ModuleLoader__.load({
  id: 'dsh-role-route-panel',
  factory: (require) => {
    console.info('[role-route-panel] factory materializing');
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let react;
    let jsx;
    let jsxs;
    try {
      react = require('react');
      ({ jsx, jsxs } = require('react/jsx-runtime'));
    } catch (error) {
      // 工厂里抛出的 require 会连带整个 bundle 一起消失，且不留别的线索。
      // 把 specifier 写进日志，才能把“面板不见了”变成“这个依赖不在图里”。
      console.error('[role-route-panel] a require failed; the panel cannot mount:', error);
      throw error;
    }

    const BASE_PATH = '/api/role-route';
    const { useCallback, useEffect, useState } = react;

    /** 角色标签：面板是给人看的，角色名是给插件看的，两者必须分开。 */
    const ROLE_LABELS = {
      scout: 'Scout（侦察）',
      scout_flash: 'Scout Flash',
      executor: 'Executor（执行）',
      executor_flash: 'Executor Flash',
      reviewer: 'Reviewer（结果审查）',
      reviewer_qwen: 'Reviewer Qwen',
      reviewer_vl: 'Reviewer VL（视觉）',
    };

    const CSS = [
      // ── 侧栏底部那一行 ─────────────────────────────────────────────────────
      //
      // 这些取值不是自创的，是逐项照抄 dsh-tokenledger 在同一座位上的写法：
      // 全宽 49px 行、`--dsw-alias-*` 令牌、hover/active 态、折叠时收成 36px 圆钮。
      // 自创按钮样式会在这个位置显得格格不入——那一排控件是既有设计系统，不是空白。
      // 座位容器的间隙由**容器**决定，行自身怎么调都改不了它（实测反馈"太宽"，改
      // 本行边距无效即是此因）。所以直接给容器定 gap，并保持不换行：本行是整行，
      // 与上下两个入口同列。
      // 容器实测是 flex row、gap 2px；本行是整行（flex:0 0 100%）会自然换行占满一行。
      // 座位容器实测是 flex row + gap 0，三行间距由各自外边距决定；相邻行已自带 4px
      // 下边距，所以本行**不能**再加同向边距，否则间距会被叠加成 8px（实测发生过）。
      "div:has(> [data-slot='sidebar.footer.action']){flex-wrap:wrap}",
      // 不设外边距：侧栏原生行之间靠容器的 gap（实测 6/8px）排布，行自身没有 margin。
      // 同时吃 gap 又加 margin 会让这一行与邻居的间距偏宽（实测反馈"空隙太宽"）；
      // 只写上边距则会让上下不对称。交给容器 gap，间距天然对称且与邻居一致。
      // 高度 34px 与原生「设置」行一致（浏览器实测：设置行 34px + margin 4px 0；
      // 而 tokenledger 的 49px 是它自己的选择，照抄会让这一行明显偏高、上下间距不等）。
      '.rrp_layer{flex:0 0 100%;min-width:0;align-items:center;height:34px;margin:0 0 4px;display:flex;position:relative}',
      // 与相邻入口同范式：无边框、无底色、49px 满高；左侧内边距与邻居逐字对齐，
      // 否则整列左边界会凸出一截（实测凸出约 13px，是上一版的真实缺陷）。
      // 内边距与左边界逐项对齐原生「设置」行（实测 padding:6px 2px 6px 10px、height:34px、
      // border-radius:12px、gap:8px），否则三行的文字起点会差 2–4px。
      '.rrp_badge{width:100%;min-width:0;height:34px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;padding:6px 8px 6px 6px;font-family:inherit;font-size:14px;font-weight:inherit;display:inline-flex;overflow:hidden;text-align:left}',
      '.rrp_badge:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.rrp_badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rrp_badgeIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}',
      '.rrp_badgeLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.rrp_badgeValue{color:var(--dsw-alias-label-tertiary);flex:none;margin-left:auto;padding-left:12px;font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}',
      // 折叠态：外壳收成 56px 轨道，每个控件变 36px 圆钮；不处理会溢出轨道。
      '@media (max-width:640px){.rrp_layer{flex:none;width:36px;height:36px;margin:0}}',

      // ── 浮层 ───────────────────────────────────────────────────────────────
      //
      // 浮动元素先取 `--dsw-alias-bg-overlay`：`--dsw-alias-bg-base` 是**页面**的底，
      // 有的皮肤把它设成透明（页面正确、浮层致命，字会直接映在壁纸上）。没有该令牌
      // 的主题回落到旧值，默认观感不变。
      '.rrp_panel{position:fixed;left:12px;bottom:64px;z-index:30;width:560px;max-width:calc(100vw - 24px);max-height:76vh;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));box-shadow:var(--dsw-shadow-lv2)}',
      '.rrp_head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.rrp_title{font-size:13px;font-weight:600;flex:1;color:var(--dsw-alias-label-primary)}',
      '.rrp_hint{font-size:11px;color:var(--dsw-alias-label-caption);line-height:16px;padding:8px 12px 0}',
      '.rrp_body{padding:6px 12px 12px;overflow:auto}',
      '.rrp_headRow{display:grid;grid-template-columns:132px 1fr 64px;gap:8px;align-items:center;padding:2px 0 4px;font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.rrp_row{display:grid;grid-template-columns:132px 1fr 64px;gap:8px;align-items:center;padding:3px 0}',
      '.rrp_label{font-size:12px;color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.rrp_sel{width:100%;box-sizing:border-box;height:26px;padding:0 6px;font-family:inherit;font-size:12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.rrp_sel:hover{border-color:var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}',
      '.rrp_eff{font-size:11px;line-height:16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.rrp_eff[data-none]{color:var(--dsw-alias-label-caption)}',
      '.rrp_foot{display:flex;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.rrp_btn{font-family:inherit;font-size:12px;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.rrp_btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover-solid)}',
      '.rrp_btn[disabled]{opacity:.5;cursor:default}',
      '.rrp_primary{border-color:transparent;background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));color:var(--dsw-alias-label-inverse,var(--dsw-alias-bg-base))}',
      '.rrp_msg{font-size:11px;line-height:16px;flex:1;color:var(--dsw-alias-label-caption)}',
      '.rrp_err{color:var(--dsw-alias-label-error,var(--dsw-alias-label-primary))}',
      '.rrp_banner{font-size:11px;line-height:16px;padding:6px 8px;margin:0 0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
    ].join('');

    let styleInstalled = false;
    function installStyle() {
      if (styleInstalled) return;
      styleInstalled = true;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'role-route-panel';
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function useRegistry() {
      const [state, setState] = useState({ status: 'loading' });
      const load = useCallback(async () => {
        try {
          const response = await fetch(BASE_PATH, { headers: { accept: 'application/json' } });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body?.ok === false) {
            // 404 在这里不是“路由坏了”，而是宿主半没挂上——两种情况要分开说。
            setState(response.status === 404
              ? { status: 'error', message: '宿主半没有提供 /api/role-route（面板已加载，host 半缺失）' }
              : { status: 'error', message: `${body?.error ?? response.status}${body?.detail ? `：${body.detail}` : ''}` });
            return;
          }
          setState({ status: 'ready', data: body, draft: draftOf(body) });
        } catch (error) {
          setState({ status: 'error', message: `无法读取配置：${String(error?.message ?? error)}` });
        }
      }, []);
      useEffect(() => { void load(); }, [load]);
      return [state, setState, load];
    }

    /** 草稿是「角色 → route_id」，只记录与服务器不同的选择。 */
    function draftOf(data) {
      const draft = {};
      for (const role of data.roles ?? []) {
        const routeId = data.config?.roles?.[role]?.route_id;
        draft[role] = typeof routeId === 'string' ? routeId : '';
      }
      return draft;
    }

    function routeLabel(route) {
      const effort = route.reasoningEffort === undefined ? '（无强度）' : route.reasoningEffort;
      return `${route.provider} / ${route.model} · ${effort}`;
    }

    /**
    * 一个角色对应的一行。
    *
    * 抽成纯函数是为了能被直接测：内联在组件里时，要走到它必须先骗过
    * useState/useEffect/fetch 三件事，测试容易在环境上翻车而不是在逻辑上。
    */
    function RoleRow({ role, selected, routes, onSelect }) {
      const route = routes.find((item) => item.route_id === selected);
      return jsx('div', {
        className: 'rrp_row',
        children: [
          jsx('div', { className: 'rrp_label', children: ROLE_LABELS[role] ?? role }),
          jsx('select', {
            className: 'rrp_sel',
            value: selected,
            onChange: (event) => onSelect(role, event.target.value),
            children: [
              jsx('option', { value: '', children: '（跟随预设默认）' }),
              ...routes.map((item) => jsx('option', { value: item.route_id, key: item.route_id, children: routeLabel(item) })),
            ],
          }),
          jsx('div', {
            className: 'rrp_eff',
            ...(route?.reasoningEffort === undefined ? { 'data-none': 'true' } : {}),
            children: route === undefined ? '—' : (route.reasoningEffort ?? '未声明'),
          }),
        ],
      });
    }

    function Panel({ onClose }) {
      installStyle();
      const [state, setState, load] = useRegistry();
      const [saving, setSaving] = useState(false);
      const [notice, setNotice] = useState(null);

      const save = useCallback(async () => {
        if (state.status !== 'ready') return;
        setSaving(true);
        setNotice(null);
        try {
          const roles = {};
          for (const [role, routeId] of Object.entries(state.draft ?? {})) {
            roles[role] = routeId === '' ? null : { route_id: routeId };
          }
          const response = await fetch(BASE_PATH, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ roles }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body?.ok === false) {
            setNotice({ kind: 'error', text: `${body?.error ?? response.status}${body?.detail ? `：${body.detail}` : ''}` });
            return;
          }
          setState({ status: 'ready', data: body, draft: draftOf(body) });
          setNotice({ kind: 'ok', text: '已保存。新派发（含当前会话内下一次派发）即按此解析；已运行的子 Agent 不受影响。' });
        } catch (error) {
          setNotice({ kind: 'error', text: `保存失败：${String(error?.message ?? error)}` });
        } finally {
          setSaving(false);
        }
      }, [state, setState]);

      const dirty = state.status === 'ready'
        && JSON.stringify(state.draft) !== JSON.stringify(draftOf(state.data));

      if (state.status === 'loading') {
        return jsx('div', { className: 'rrp_panel', children: jsx('div', { className: 'rrp_body', children: '读取配置…' }) });
      }
      if (state.status === 'error') {
        return jsx('div', {
          className: 'rrp_panel',
          children: [
            jsx('div', { className: 'rrp_head', children: [jsx('div', { className: 'rrp_title', children: '角色默认模型路由' }), jsx('button', { className: 'rrp_btn', onClick: onClose, children: '关闭' })] }),
            jsx('div', { className: 'rrp_body', children: jsx('div', { className: 'rrp_msg rrp_err', children: state.message }) }),
          ],
        });
      }

      const routes = state.data.routes ?? [];
      const roles = state.data.roles ?? [];
      const rows = roles.map((role) => jsx(RoleRow, {
        key: role,
        role,
        selected: state.draft[role] ?? '',
        routes,
        onSelect: (target, value) => setState((previous) => ({ ...previous, draft: { ...previous.draft, [target]: value } })),
      }));

      return jsx('div', {
        className: 'rrp_panel',
        children: [
          jsx('div', { className: 'rrp_head', children: [
            jsx('div', { className: 'rrp_title', children: '角色默认模型路由' }),
            jsx('button', { className: 'rrp_btn', onClick: () => void load(), disabled: saving, children: '重新读取' }),
            jsx('button', { className: 'rrp_btn', onClick: onClose, children: '关闭' }),
          ] }),
          jsx('div', { className: 'rrp_hint', children: '选定即成为该角色的默认：新派发（含当前会话内下一次）按此解析，已运行的子会话不受影响。' }),
          jsx('div', { className: 'rrp_body', children: [
            jsx('div', { className: 'rrp_headRow', children: [
              jsx('div', { key: 'h1', children: '角色' }),
              jsx('div', { key: 'h2', children: '路线（模型 · 强度）' }),
              jsx('div', { key: 'h3', style: { textAlign: 'center' }, children: '强度' }),
            ] }),
            ...rows,
          ] }),
          jsx('div', { className: 'rrp_foot', children: [
            jsx('div', { className: `rrp_msg${notice?.kind === 'error' ? ' rrp_err' : ''}`, children: notice?.text ?? `配置：${state.data.path}` }),
            jsx('button', { className: 'rrp_btn rrp_primary', onClick: () => void save(), disabled: saving || !dirty, children: saving ? '保存中…' : '保存' }),
          ] }),
        ],
      });
    }

    /** 侧栏底部座位上的一整行：图标 + 标签 + 右侧当前摘要。 */
    function Trigger() {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [open]);
      return [
        jsx('div', {
          key: 'seat',
          className: 'rrp_layer',
          children: jsx('button', {
            type: 'button',
            className: 'rrp_badge',
            title: '角色默认模型路由',
            'aria-expanded': open,
            ...(open ? { 'data-active': 'true' } : {}),
            onClick: () => setOpen((value) => !value),
            children: [
              // 与其他座位行同宽同色的线性图标，避免文字行看起来像临时贴上去的。
              // 视框与相邻图标一致（16×16），且**不在 svg 上放 transform**——那会缩放
              // 整个渲染盒（实测撑到 21×21 并溢出视框），图形本身并没变大。图形直接按
              // 16×16 绘制并铺满，线重取 2（邻居实心图形换算过来约 1.5–2px）。
              // 造型：一条主干在左侧，向右分出两条支路，右下端点画实心圆。
              jsx('span', { key: 'icon', className: 'rrp_badgeIcon', children: jsx('svg', {
                width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
                // 线重 1.5：相邻两个图标是**实心路径**（fill=currentColor），换算到
                // 16px 视框里笔画约 1–3px；此前用 2 实测渲染出 2–4px，明显偏粗。
                stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
                children: [
                  jsx('path', { key: 'trunk', d: 'M4 3.5V12.5' }),
                  jsx('path', { key: 'upper', d: 'M4 6.5h5.5a2 2 0 0 1 2 2' }),
                  jsx('path', { key: 'lower', d: 'M4 10.5h3.5a2 2 0 0 0 2-2' }),
                  jsx('circle', { key: 'dot', cx: 12, cy: 12, r: 1.75, fill: 'currentColor', stroke: 'none' }),
                ],
              }) }),
              jsx('span', { key: 'label', className: 'rrp_badgeLabel', children: '模型路由' }),
              // 右侧摘要与相邻入口的“数值位”同列，但用更淡的层级，不抢主标签。
              jsx('span', { key: 'value', className: 'rrp_badgeValue', children: '角色默认' }),
            ],
          }),
        }),
        open ? jsx(Panel, { key: 'panel', onClose: () => setOpen(false) }) : null,
      ];
    }

    const inject = ['slots'];

    function apply(ctx) {
      console.info('[role-route-panel] apply() called; taking the sidebar footer seat');
      // 在这里注入，而不是等 Panel 首次渲染：否则座位行在第一帧是无样式的裸按钮。
      installStyle();
      try {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'role-route-panel', order: 30 },
          Trigger,
        ));
      } catch (error) {
        console.error('[role-route-panel] could not take the footer seat:', error);
        throw error;
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.Panel = Panel;
    exports.Trigger = Trigger;
    exports.BASE_PATH = BASE_PATH;
    exports.ROLE_LABELS = ROLE_LABELS;
    exports.draftOf = draftOf;
    exports.RoleRow = RoleRow;
    exports.routeLabel = routeLabel;
    console.info('[role-route-panel] factory ready; exports:', Object.keys(module.exports).join(', '));
    return module.exports;
  },
});
