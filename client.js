// Browser half of the GitLab project workbench.
// 左侧栏沿用禅道插件的同一套视觉与结构：项目 → 分支/Tag，右侧看引用详情与提交。
// Plain JavaScript (no JSX): React comes from the module table.

window.__ModuleLoader__.load({
  id: '@local/dsh-gitlab',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    const VERSION = 'v0.4.2';
    const HEADERS = { 'x-gitlab-client': '1' };
    const JSON_HEADERS = { 'x-gitlab-client': '1', 'content-type': 'application/json' };
    const LAYOUT_KEY = 'dsh-gitlab-layout-v1';
    const VIEW_KEY = 'dsh-gitlab-view-v1';

    const isMac = (() => {
      try {
        return /Mac/i.test(navigator.platform || navigator.userAgent || '');
      } catch (error) {
        return false;
      }
    })();

    const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));

    async function api(path, options) {
      const res = await fetch(path, Object.assign({ headers: HEADERS }, options));
      let data;
      try {
        data = await res.json();
      } catch (error) {
        throw new Error('接口返回异常（HTTP ' + res.status + '）');
      }
      if (!data.ok) {
        const failure = new Error(data.error || '请求失败');
        failure.code = data.code || '';
        failure.status = res.status;
        throw failure;
      }
      return data;
    }

    const notifyStore = {
      enabled: true,
      configured: true,
      unread: 0,
      items: [],
      loaded: false,
      listeners: new Set(),
    };
    let notifyTimer = null;

    function applyNotifySnapshot(data) {
      if (!data) return;
      notifyStore.enabled = data.enabled !== false;
      notifyStore.configured = data.configured !== false;
      notifyStore.unread = Number(data.unread) || 0;
      notifyStore.items = Array.isArray(data.items) ? data.items : [];
      notifyStore.loaded = true;
      for (const listener of notifyStore.listeners) listener();
    }

    function subscribeNotify(listener) {
      notifyStore.listeners.add(listener);
      listener();
      return () => notifyStore.listeners.delete(listener);
    }

    async function refreshNotify(force) {
      try {
        const data = await api('/gitlab/api/activity' + (force ? '?force=1' : ''));
        applyNotifySnapshot(data);
      } catch (error) {
        /* Host or GitLab unreachable: keep the previous list */
      }
    }

    function startNotifyPolling() {
      if (notifyTimer) return;
      refreshNotify(false);
      notifyTimer = setInterval(() => {
        if (notifyStore.enabled) refreshNotify(false);
      }, 30000);
    }

    function describeNotification(item) {
      const action = ACTION_LABELS[item.actionName] || item.actionName || '更新了';
      let subject = '';
      if (item.ref) subject = (item.refType === 'tag' ? 'Tag ' : '分支 ') + item.ref;
      else if (item.targetType === 'MergeRequest') subject = '!' + item.targetIid;
      else if (item.targetType === 'Issue') subject = '#' + item.targetIid;
      let link = item.projectWebUrl || '';
      if (item.commitId && item.projectWebUrl) link = item.projectWebUrl + '/-/commit/' + item.commitId;
      else if (item.targetType === 'MergeRequest' && item.projectWebUrl) {
        link = item.projectWebUrl + '/-/merge_requests/' + item.targetIid;
      }
      return { action, subject, link, title: item.commitTitle || item.targetTitle || '' };
    }

    function formatTime(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const diff = Date.now() - date.getTime();
      const minutes = Math.round(diff / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return minutes + ' 分钟前';
      const hours = Math.round(minutes / 60);
      if (hours < 24) return hours + ' 小时前';
      const days = Math.round(hours / 24);
      if (days < 30) return days + ' 天前';
      const pad = (n) => String(n).padStart(2, '0');
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    }

    function avatarColor(seed) {
      const palette = ['#3f7ff0', '#22b07d', '#f5a524', '#e8544f', '#8f6bff', '#19b5c9', '#e879b9', '#7a869a'];
      const text = String(seed || '?');
      let hash = 0;
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
      return palette[hash % palette.length];
    }

    const EVENT_FILTERS = [
      { key: 'all', label: '全部' },
      { key: 'push', label: '推送事件' },
      { key: 'merge', label: '合并事件' },
    ];

    const ACTION_LABELS = {
      'pushed to': '推送到',
      'pushed new': '新建了',
      'pushed to deleted': '删除了',
      opened: '创建了',
      closed: '关闭了',
      merged: '合并了',
      approved: '批准了',
      created: '创建了',
      updated: '更新了',
      deleted: '删除了',
      commented: '评论了',
      joined: '加入了',
      left: '离开了',
      expired: '过期了',
    };

    /** Turn one GitLab event into the row the panel renders. */
    function describeEvent(item, projectWebUrl) {
      const base = String(projectWebUrl || '');
      if (item.push) {
        const isTag = item.push.refType === 'tag';
        const commitLink = item.push.commitId ? base + '/-/commit/' + item.push.commitId : '';
        const detail = [item.push.commitShortId, item.push.commitTitle].filter(Boolean).join(' · ');
        const more = item.push.commitCount > 1 ? '（共 ' + item.push.commitCount + ' 个提交）' : '';
        return {
          icon: isTag ? 'tag' : 'branch',
          action: ACTION_LABELS[item.actionName] || '推送到',
          subject: (isTag ? 'Tag ' : '分支 ') + item.push.ref,
          detail: detail + more,
          url: commitLink,
        };
      }
      const iid = item.targetIid || item.targetId;
      if (item.targetType === 'MergeRequest') {
        return {
          icon: 'commit',
          action: ACTION_LABELS[item.actionName] || item.actionName || '更新了',
          subject: '!' + iid,
          detail: item.targetTitle,
          url: iid ? base + '/-/merge_requests/' + iid : '',
        };
      }
      if (item.targetType === 'Issue') {
        return {
          icon: 'commit',
          action: ACTION_LABELS[item.actionName] || item.actionName || '更新了',
          subject: '#' + iid,
          detail: item.targetTitle,
          url: iid ? base + '/-/issues/' + iid : '',
        };
      }
      return {
        icon: 'commit',
        action: ACTION_LABELS[item.actionName] || item.actionName || '活动',
        subject: item.targetTitle,
        detail: '',
        url: '',
      };
    }

    function onRowKey(activate) {
      return (event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          activate();
        }
      };
    }

    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    function localDayKey(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return 'unknown';
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function formatDayHeader(iso) {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '未知日期';
      const day = localDayKey(iso);
      const today = localDayKey(new Date().toISOString());
      const yesterday = localDayKey(new Date(Date.now() - 86400000).toISOString());
      const label = date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
      if (day === today) return '今天 · ' + label;
      if (day === yesterday) return '昨天 · ' + label;
      return label;
    }

    function groupByDay(items, pickDate) {
      const groups = [];
      let current = null;
      for (const item of items) {
        const iso = pickDate(item);
        const key = localDayKey(iso);
        if (!current || current.key !== key) {
          current = { key, label: formatDayHeader(iso), items: [] };
          groups.push(current);
        }
        current.items.push(item);
      }
      return groups;
    }

    function encodeRefPath(name) {
      return String(name || '')
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/');
    }

    // ── icons ─────────────────────────────────────────────────────────────
    const ICONS = {
      'chevron-right': { paths: ['M6 3.5 10.5 8 6 12.5'] },
      'chevron-down': { paths: ['M3.5 6 8 10.5 12.5 6'] },
      'chevron-left': { paths: ['M10.5 3.5 6 8 10.5 12.5'] },
      'expand-all': { paths: ['M3.8 6.2 8 2.6 12.2 6.2', 'M3.8 9.8 8 13.4 12.2 9.8'] },
      'arrow-up': { paths: ['M8 12.6V3.6', 'M4.4 7.2 8 3.6 11.6 7.2'] },
      'arrow-down': { paths: ['M8 3.4v9', 'M4.4 8.8 8 12.4 11.6 8.8'] },
      'collapse-all': { paths: ['M3.8 2.6 8 6.2 12.2 2.6', 'M3.8 13.4 8 9.8 12.2 13.4'] },
      refresh: { paths: ['M13.2 8a5.2 5.2 0 1 1-1.6-3.75', 'M13.2 2.6v3.2H10'] },
      search: {
        paths: ['M7 12.4a5.4 5.4 0 1 0 0-10.8 5.4 5.4 0 0 0 0 10.8Z', 'M10.9 10.9 14 14'],
      },
      link: {
        paths: [
          'M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-1 1',
          'M9.4 6.6a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l1-1',
        ],
      },
      folder: { paths: ['M2 5.2A1.6 1.6 0 0 1 3.6 3.6h2.6l1.5 1.7h4.7A1.6 1.6 0 0 1 14 6.9v5.5a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.4Z'] },
      'folder-open': {
        paths: [
          'M2 11.6V5.2A1.6 1.6 0 0 1 3.6 3.6h2.6l1.5 1.7h4.7A1.6 1.6 0 0 1 14 6.9v1.2',
          'M2 11.6 3.7 8h11l-1.7 3.6a1.6 1.6 0 0 1-1.4.9H3.6A1.6 1.6 0 0 1 2 11.6Z',
        ],
      },
      branch: { paths: ['M5 5.2v5.6', 'M5 8.4c0-2 1.6-3.4 3.6-3.4h1.6'], dots: [[5, 3.6, 1.6], [5, 12.4, 1.6], [11.4, 5, 1.6]] },
      tag: { paths: ['M2.6 7.4V3.2a.6.6 0 0 1 .6-.6h4.2l6 6-4.8 4.8-6-6Z'], dots: [[5.4, 5.4, 1.3]] },
      commit: { paths: ['M2 8h3.2', 'M10.8 8H14'], dots: [[8, 8, 2.6]] },
      external: {
        paths: ['M9.6 2.6h3.8v3.8', 'M13.4 2.6 8.2 7.8', 'M12.2 9.8v2.6a1.6 1.6 0 0 1-1.6 1.6H3.6A1.6 1.6 0 0 1 2 12.4V5.4a1.6 1.6 0 0 1 1.6-1.6h2.6'],
      },
      pulse: { paths: ['M2 8h2.6L6.4 4l3 8 2-5.4 1 1.4H14'] },
      edit: {
        paths: [
          'M10.6 3.1a1.6 1.6 0 0 1 2.3 2.3L5.2 13.1l-2.8.6.6-2.8z',
          'M9.4 4.3 11.7 6.6',
        ],
      },
      bell: { paths: ['M8 2.4a4 4 0 0 0-4 4v2.2L2.8 11h10.4L12 8.6V6.4a4 4 0 0 0-4-4Z', 'M6.3 13a1.8 1.8 0 0 0 3.4 0'] },
      close: { paths: ['M4 4 12 12', 'M12 4 4 12'] },
      alert: { paths: ['M8 2.4 14 12.4H2Z', 'M8 6.4v2.8'], dots: [[8, 11, 0.9]] },
    };

    function GlyphIcon(props) {
      const icon = ICONS[props.name] || ICONS.commit;
      const size = props.size || 16;
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        (icon.paths || []).map((d, index) => h('path', { key: 'p' + index, d })),
        (icon.dots || []).map((dot, index) =>
          h('circle', { key: 'c' + index, cx: dot[0], cy: dot[1], r: dot[2], fill: 'currentColor', stroke: 'none' }),
        ),
      );
    }

    // ── styles ────────────────────────────────────────────────────────────
    // Same token layer as the ZenTao panel so both sidebars look identical.
    const CSS = `/* ── TDesign token layer (scoped to the panel) ─────────────────────────────── */
.gl-root{
--td-brand-color:#0052d9;--td-brand-color-hover:#366ef4;--td-brand-color-focus:#d9e1ff;--td-brand-color-active:#003cab;--td-brand-color-disabled:#b5c7ff;--td-brand-color-light:#f2f3ff;--td-brand-color-light-hover:#d9e1ff;
--td-success-color:#2ba471;--td-success-color-hover:#56c08d;--td-success-color-focus:#c6f3d7;--td-success-color-disabled:#92dab2;--td-success-color-light:#e3f9e9;
--td-warning-color:#e37318;--td-warning-color-hover:#fa9550;--td-warning-color-focus:#ffd9c2;--td-warning-color-disabled:#ffb98c;--td-warning-color-light:#fff1e9;
--td-error-color:#d54941;--td-error-color-hover:#f6685d;--td-error-color-focus:#ffd8d2;--td-error-color-disabled:#ffb9b0;--td-error-color-light:#fff0ed;
--td-text-color-primary:rgba(0,0,0,.9);--td-text-color-secondary:rgba(0,0,0,.6);--td-text-color-placeholder:rgba(0,0,0,.4);--td-text-color-disabled:rgba(0,0,0,.26);--td-text-color-anti:#fff;--td-text-color-brand:#0052d9;
--td-bg-color-page:#eee;--td-bg-color-container:#fff;--td-bg-color-container-hover:#f3f3f3;--td-bg-color-container-active:#e8e8e8;
--td-bg-color-secondarycontainer:#f3f3f3;--td-bg-color-secondarycontainer-hover:#eee;
--td-bg-color-component:#e8e8e8;--td-bg-color-component-hover:#ddd;--td-bg-color-component-disabled:#eee;--td-bg-color-specialcomponent:#fff;
--td-border-level-1-color:#e8e8e8;--td-border-level-2-color:#ddd;--td-component-stroke:#e8e8e8;--td-component-border:#ddd;
--td-radius-small:2px;--td-radius-default:3px;--td-radius-medium:6px;--td-radius-large:9px;
--td-shadow-2:0 3px 14px 2px rgba(0,0,0,.05),0 8px 10px 1px rgba(0,0,0,.06),0 5px 5px -3px rgba(0,0,0,.1);
--td-font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
--td-font-family-code:ui-monospace,SFMono-Regular,Menlo,monospace;
--td-font-body-small:12px/20px var(--td-font-family);--td-font-body-medium:14px/22px var(--td-font-family);
--td-font-title-small:600 14px/22px var(--td-font-family);--td-font-title-medium:600 16px/24px var(--td-font-family);
--td-scrollbar-color:rgba(0,0,0,.1);--td-scrollbar-hover-color:rgba(0,0,0,.3);
}
body[data-ds-dark-theme] .gl-root{
--td-brand-color:#4582e6;--td-brand-color-hover:#2667d4;--td-brand-color-focus:#173463;--td-brand-color-active:#699ef5;--td-brand-color-disabled:#143975;--td-brand-color-light:#1b2f51;--td-brand-color-light-hover:#173463;
--td-success-color:#059465;--td-success-color-light:#193a2a;
--td-warning-color:#cf6e2d;--td-warning-color-light:#4f2a1d;
--td-error-color:#c64751;--td-error-color-light:#472324;
--td-text-color-primary:rgba(255,255,255,.9);--td-text-color-secondary:rgba(255,255,255,.55);--td-text-color-placeholder:rgba(255,255,255,.35);--td-text-color-disabled:rgba(255,255,255,.22);--td-text-color-anti:#fff;--td-text-color-brand:#4582e6;
--td-bg-color-page:#181818;--td-bg-color-container:#242424;--td-bg-color-container-hover:#2c2c2c;--td-bg-color-container-active:#5e5e5e;
--td-bg-color-secondarycontainer:#2c2c2c;--td-bg-color-secondarycontainer-hover:#393939;
--td-bg-color-component:#393939;--td-bg-color-component-hover:#4b4b4b;--td-bg-color-component-disabled:#2c2c2c;--td-bg-color-specialcomponent:transparent;
--td-border-level-1-color:#393939;--td-border-level-2-color:#5e5e5e;--td-component-stroke:#393939;--td-component-border:#5e5e5e;
--td-scrollbar-color:hsla(0,0%,100%,.1);--td-scrollbar-hover-color:hsla(0,0%,100%,.3);
}

/* ── shell ───────────────────────────────────────────────────────────────── */
.gl-root{position:relative;display:flex;flex-wrap:nowrap;width:100%;max-width:100%;height:100%;min-height:0;background:var(--td-bg-color-container);color:var(--td-text-color-primary);font:var(--td-font-body-medium);overflow:hidden;--gl-radius:5px;--gl-icon:var(--dsw-alias-menu-icon,var(--dsw-alias-label-secondary,#666));--gl-icon-muted:var(--dsw-alias-label-tertiary,#999);--gl-icon-brand:var(--dsw-alias-link,var(--dsw-static-deepseek-500,#4176e6))}
.gl-root *,.gl-root *:before,.gl-root *:after{box-sizing:border-box}
.gl-pane{display:flex;flex:0 0 auto;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--td-bg-color-container)}
.gl-left{position:relative;background:var(--dsw-specific-sidebar-fill,var(--td-bg-color-secondarycontainer))}
.gl-main{flex:1 1 0;display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;background:var(--td-bg-color-container);container-type:inline-size}
.gl-split{flex:0 0 8px;width:8px;cursor:col-resize;background:transparent;position:relative;z-index:2}
.gl-split:after{content:'';position:absolute;left:50%;top:0;bottom:0;width:1px;margin-left:-.5px;background:var(--td-component-stroke)}
.gl-split:hover:after,.gl-split:active:after{background:var(--td-brand-color);width:2px;margin-left:-1px}
.gl-rail{flex:0 0 40px;width:40px;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:8px 4px 0;background:var(--td-bg-color-container);user-select:none}
.gl-rail-left{border-right:1px solid var(--td-component-stroke)}
.gl-mac .gl-rail{padding-top:38px}
.gl-under-lights .gl-left .gl-pane-head{padding-left:var(--gl-pane-head-pad,16px)}
.gl-under-lights.gl-left-closed .gl-main-head{padding-left:var(--gl-main-head-pad,16px)}

/* ── left pane chrome ────────────────────────────────────────────────────── */
.gl-pane-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 8px 0 16px;border-bottom:1px solid var(--td-component-stroke);height:48px;min-height:48px;min-width:0;-webkit-app-region:drag}
.gl-pane-title{font:var(--td-font-title-small);color:var(--td-text-color-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;transition:max-width .22s cubic-bezier(.4,0,.2,1),opacity .12s linear}
.gl-head-actions{display:flex;align-items:center;gap:4px;margin-left:auto;-webkit-app-region:no-drag}
.gl-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:0 0 auto;border:0;background:transparent;color:var(--gl-icon);cursor:pointer;padding:0;border-radius:var(--gl-radius);transition:background-color .2s linear,color .2s linear}
.gl-icon-btn:hover:not(:disabled){background:var(--td-bg-color-container-hover);color:var(--td-text-color-primary)}
.gl-icon-btn:active:not(:disabled){background:var(--td-bg-color-container-active)}
.gl-icon-btn:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:0}
.gl-icon-btn:disabled{color:var(--td-text-color-disabled);cursor:not-allowed}
.gl-icon-btn.gl-spinning svg{animation:gl-spin .9s linear infinite}
@keyframes gl-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.gl-icon-btn.gl-spinning svg{animation:none}}

/* ── search row ──────────────────────────────────────────────────────────── */
.gl-filter-row{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--td-component-stroke);flex:0 0 auto}
.gl-search{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;-webkit-app-region:no-drag}
.gl-search-icon{display:flex;flex:0 0 auto;color:var(--gl-icon)}
.gl-search-input{flex:1 1 auto;min-width:0;height:24px;border:0;background:transparent;color:var(--td-text-color-primary);font:var(--td-font-body-medium);outline:none;padding:0}
.gl-search-input::placeholder{color:var(--td-text-color-placeholder)}
.gl-search-input::-webkit-search-cancel-button,.gl-search-input::-webkit-search-decoration{-webkit-appearance:none;appearance:none}

/* ── tree ────────────────────────────────────────────────────────────────── */
.gl-tree{overflow:auto;flex:1 1 auto;min-height:0;padding:6px 8px 10px;scrollbar-width:thin}
.gl-tree-head{display:flex;align-items:center;gap:8px;flex:0 0 auto;height:28px;padding:0 16px;color:var(--td-text-color-placeholder);font-size:12px;line-height:20px}
.gl-tree-head-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gl-tree-head-btn{display:inline-flex;align-items:center;gap:4px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
.gl-tree-head-btn:hover{color:var(--td-text-color-primary)}
.gl-tree-head-btn:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:2px}
.gl-tree-head-active{color:var(--td-text-color-secondary)}
.gl-tree-head-arrow{display:inline-flex;color:var(--gl-icon-brand)}
.gl-tree-head-spacer{flex:1 1 auto}
.gl-icon-btn-sm{width:20px;height:20px;border-radius:4px;color:var(--td-text-color-placeholder)}
.gl-icon-btn-sm:hover:not(:disabled){color:var(--td-text-color-primary)}
.gl-tree-head-count{white-space:nowrap}
.gl-tree::-webkit-scrollbar,.gl-commits::-webkit-scrollbar{width:6px;height:6px}
.gl-tree::-webkit-scrollbar-thumb,.gl-commits::-webkit-scrollbar-thumb{background:var(--td-scrollbar-color);border-radius:11px}
.gl-tree::-webkit-scrollbar-thumb:hover,.gl-commits::-webkit-scrollbar-thumb:hover{background:var(--td-scrollbar-hover-color)}
.gl-tree::-webkit-scrollbar-track,.gl-commits::-webkit-scrollbar-track{background:transparent}
.gl-row{display:flex;align-items:center;gap:8px;height:34px;padding:0 8px;border-radius:6px;cursor:pointer;user-select:none;min-width:0;overflow:hidden;transition:background-color .12s linear}
.gl-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.gl-row:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:-2px}
.gl-search:focus-within .gl-search-icon{color:var(--gl-icon-brand)}
.gl-project{font-weight:500}
.gl-project-active{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.1))}
.gl-project-active .gl-icon{color:var(--gl-icon-brand)}
.gl-note{color:var(--td-text-color-placeholder);font-weight:400}
.gl-overview{padding:6px 8px 0;flex:0 0 auto}
.gl-overview-hint{flex:0 0 auto;font-size:11px;line-height:16px;color:var(--td-text-color-placeholder)}
.gl-event-note{flex:0 0 auto;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px;padding:0 8px;border-radius:10px;background:var(--td-brand-color-light);color:var(--td-brand-color);font-size:11px;line-height:18px}
.gl-event-project{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 6px;border-radius:3px;background:var(--td-bg-color-secondarycontainer);color:var(--td-text-color-secondary);font-size:11px;line-height:16px;font-family:var(--td-font-family-code)}
.gl-note-input{flex:1 1 auto;min-width:0;height:24px;padding:0 6px;border:1px solid var(--td-brand-color);border-radius:4px;background:var(--td-bg-color-container);color:var(--td-text-color-primary);font:var(--td-font-body-medium);outline:none}
.gl-edit-btn{opacity:0;pointer-events:none;transition:opacity .12s linear}
.gl-project:hover .gl-edit-btn,.gl-project:focus-within .gl-edit-btn,.gl-edit-btn:focus-visible{opacity:1;pointer-events:auto}
@media (prefers-reduced-motion:reduce){.gl-edit-btn{transition:none}}
.gl-group-mark{display:inline-flex;align-items:center;justify-content:center}
.gl-group-caret{display:none;align-items:center;justify-content:center}
.gl-group-row:hover .gl-group-mark{display:none}
.gl-group-row:hover .gl-group-caret{display:inline-flex}
.gl-project .gl-name{color:var(--td-text-color-primary)}
.gl-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 18px;width:18px;height:18px;color:var(--gl-icon)}
.gl-icon-open{color:var(--gl-icon-brand)}
.gl-icon-folder{display:inline-flex;align-items:center;justify-content:center}
.gl-icon-caret{display:none;align-items:center;justify-content:center;color:var(--gl-icon)}
.gl-project:hover .gl-icon-folder{display:none}
.gl-project:hover .gl-icon-caret{display:inline-flex}
.gl-name{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--td-font-body-medium)}
.gl-meta{flex:0 0 auto;min-width:36px;text-align:center;font-size:12px;line-height:20px;color:var(--td-text-color-placeholder);white-space:nowrap}
.gl-count{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;min-width:36px;height:20px;padding:0 6px;border-radius:var(--gl-radius);background:var(--td-bg-color-secondarycontainer);color:var(--td-text-color-secondary);font-size:12px;line-height:18px;text-align:center}
.gl-children-wrap{display:grid;grid-template-rows:0fr;transition:grid-template-rows .22s cubic-bezier(.4,0,.2,1)}
.gl-children-wrap.gl-children-open{grid-template-rows:1fr}
.gl-children{display:flex;flex-direction:column;gap:1px;margin:0;padding-left:26px;overflow:hidden;min-height:0;opacity:0;transition:opacity .18s ease}
.gl-children-wrap.gl-children-open .gl-children{opacity:1}
@media (prefers-reduced-motion:reduce){.gl-children-wrap,.gl-children{transition:none}}
.gl-subgroup{display:flex;flex-direction:column;gap:1px;min-width:0}
.gl-group-row{height:30px;font-weight:400}
.gl-group-label{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--td-font-body-medium);font-weight:500;color:var(--td-text-color-secondary)}
.gl-group-open .gl-group-label{color:var(--td-text-color-primary)}
.gl-icon-sm{flex:0 0 16px;width:16px;height:16px}
.gl-children-sub{padding-left:16px}
.gl-ref{height:32px;font-weight:400}
.gl-ref .gl-name{font:var(--td-font-body-medium);color:var(--td-text-color-secondary)}
.gl-ref:hover .gl-name{color:var(--td-text-color-primary)}
.gl-ref.gl-active{background:var(--dsw-alias-interactive-bg-active,rgba(0,0,0,.1))}
.gl-ref.gl-active .gl-name{color:var(--td-text-color-primary);font-weight:500}
.gl-ref.gl-active .gl-icon{color:var(--gl-icon-brand)}
.gl-flag{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;min-width:36px;padding:0 4px;border-radius:3px;background:var(--td-brand-color-light);color:var(--td-brand-color);font-size:11px;line-height:16px;text-align:center}
.gl-muted .gl-name{color:var(--td-text-color-placeholder)}
.gl-empty{padding:16px;color:var(--td-text-color-placeholder);text-align:center;font:var(--td-font-body-medium)}
.gl-empty-sm{padding:4px 8px;text-align:left;font:var(--td-font-body-small)}
.gl-error-text{color:var(--td-error-color)}
.gl-error-actions{display:flex;align-items:center;gap:12px;margin-top:6px}
.gl-children .gl-empty{padding:4px 4px 4px 8px;text-align:left}
.gl-link{border:0;background:transparent;padding:0;color:var(--td-brand-color);font:inherit;cursor:pointer;text-decoration:none}
.gl-link:hover{text-decoration:underline}
.gl-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto;padding:4px 8px 6px 16px;border-top:1px solid var(--td-component-stroke)}
.gl-plugin-version{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--td-text-color-placeholder);user-select:none}
.gl-update-btn{flex:0 0 auto;padding:0 4px;border:0;border-radius:3px;background:transparent;color:var(--td-text-color-placeholder);font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap}
.gl-update-btn:hover:not(:disabled){color:var(--td-text-color-primary)}
.gl-update-btn:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:0}
.gl-update-btn:disabled{cursor:default}
.gl-update-stale{color:var(--td-warning-color);font-weight:500}
.gl-update-stale:hover:not(:disabled){color:var(--td-warning-color)}

/* ── activity notifications ──────────────────────────────────────────────── */
.gl-bell-btn{position:relative}
.gl-bell-open{color:var(--gl-icon-brand)}
.gl-bell-badge{position:absolute;top:2px;right:1px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-state-error-primary,#d54941);color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:500;pointer-events:none}
.gl-panel-badge{position:absolute;top:-4px;right:-5px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--dsw-alias-state-error-primary,#d54941);color:#fff;font-size:9px;line-height:14px;text-align:center;font-weight:500;z-index:2}
.gl-notify-mask{position:absolute;inset:0;z-index:69}
.gl-notify{position:absolute;top:52px;right:16px;z-index:70;width:min(360px,calc(100% - 32px));max-height:min(480px,72vh);display:flex;flex-direction:column;background:var(--td-bg-color-container);border:1px solid var(--td-component-stroke);border-radius:10px;box-shadow:var(--td-shadow-2);overflow:hidden}
.gl-notify-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto;padding:10px 12px;border-bottom:1px solid var(--td-component-stroke)}
.gl-notify-title{font:var(--td-font-title-small);color:var(--td-text-color-primary)}
.gl-switch{position:relative;flex:0 0 auto;width:34px;height:18px;padding:0;border:0;border-radius:9px;background:var(--td-bg-color-component);cursor:pointer;transition:background-color .15s linear}
.gl-switch:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:1px}
.gl-switch-on{background:var(--td-brand-color)}
.gl-switch-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s linear}
.gl-switch-on .gl-switch-knob{transform:translateX(16px)}
@media (prefers-reduced-motion:reduce){.gl-switch,.gl-switch-knob{transition:none}}
.gl-notify-body{flex:1 1 auto;min-height:0;overflow:auto;padding:6px}
.gl-notify-empty{padding:20px 8px;text-align:center;color:var(--td-text-color-placeholder);font:var(--td-font-body-small)}
.gl-bubble{display:block;padding:8px 10px;border-radius:8px;text-decoration:none;color:inherit}
.gl-bubble:hover{background:var(--td-bg-color-container-hover)}
.gl-bubble:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:-2px}
.gl-bubble-read{opacity:.6}
.gl-bubble-top{display:flex;align-items:center;gap:6px;min-width:0}
.gl-bubble-dot{flex:0 0 auto;width:6px;height:6px;border-radius:50%;background:var(--td-error-color)}
.gl-bubble-read .gl-bubble-dot{background:transparent}
.gl-bubble-project{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--td-font-body-small);color:var(--td-text-color-secondary)}
.gl-bubble-time{flex:0 0 auto;font-size:11px;line-height:16px;color:var(--td-text-color-placeholder)}
.gl-bubble-text{margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--td-font-body-medium);color:var(--td-text-color-primary)}
.gl-bubble-commit{margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--td-text-color-placeholder);font-family:var(--td-font-family-code)}
.gl-notify-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:0 0 auto;padding:8px 12px;border-top:1px solid var(--td-component-stroke);font:var(--td-font-body-small);color:var(--td-text-color-placeholder)}
.gl-notify-count{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gl-notify-foot .gl-link{font-size:12px;line-height:20px}
.gl-notify-foot .gl-link:disabled{color:var(--td-text-color-disabled);cursor:default;text-decoration:none}

/* ── main pane ───────────────────────────────────────────────────────────── */
.gl-main-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 16px;border-bottom:1px solid var(--td-component-stroke);height:48px;min-height:48px;min-width:0;overflow:hidden;-webkit-app-region:drag}
.gl-crumbs{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;font:var(--td-font-body-small);color:var(--td-text-color-secondary);-webkit-app-region:no-drag}
.gl-crumb{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
.gl-crumb-strong{color:var(--td-text-color-primary);font:var(--td-font-title-small);font-family:var(--td-font-family-code)}
.gl-crumb-sep{flex:0 0 auto;color:var(--td-text-color-placeholder)}
.gl-main-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;-webkit-app-region:no-drag}
.gl-link-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:var(--gl-radius);color:var(--td-text-color-secondary);font:var(--td-font-body-small);text-decoration:none;white-space:nowrap}
.gl-link-btn:hover{background:var(--td-bg-color-container-hover);color:var(--td-text-color-primary)}
.gl-body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden}

/* ── detail ──────────────────────────────────────────────────────────────── */
.gl-detail{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden}
.gl-detail-head{flex:0 0 auto;padding:16px 16px 12px;border-bottom:1px solid var(--td-component-stroke)}
.gl-detail-title{display:flex;align-items:center;gap:8px;min-width:0}
.gl-detail-icon{display:inline-flex;flex:0 0 auto;color:var(--gl-icon-brand)}
.gl-detail-name{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--td-font-title-medium);color:var(--td-text-color-primary);font-family:var(--td-font-family-code)}
.gl-badge{flex:0 0 auto;padding:0 6px;border-radius:3px;font-size:11px;line-height:18px;background:var(--td-bg-color-secondarycontainer);color:var(--td-text-color-secondary)}
.gl-badge-brand{background:var(--td-brand-color-light);color:var(--td-brand-color)}
.gl-badge-warn{background:var(--td-warning-color-light);color:var(--td-warning-color)}
.gl-detail-meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:8px;font:var(--td-font-body-small);color:var(--td-text-color-placeholder)}
.gl-detail-meta b{font-weight:500;color:var(--td-text-color-secondary)}
.gl-commits{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;overflow:auto}
.gl-activity{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;overflow:hidden}
.gl-subtabs{display:flex;align-items:center;gap:2px;flex:0 0 auto;padding:0 16px;border-bottom:1px solid var(--td-component-stroke);overflow-x:auto;scrollbar-width:none}
.gl-subtabs::-webkit-scrollbar{display:none}
.gl-subtab{position:relative;display:inline-flex;align-items:center;height:38px;padding:0 10px;border:0;background:transparent;color:var(--td-text-color-secondary);font:var(--td-font-body-medium);cursor:pointer;white-space:nowrap}
.gl-subtab:hover{color:var(--td-text-color-primary)}
.gl-subtab:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:-2px}
.gl-subtab-active{color:var(--td-brand-color);font-weight:500}
.gl-subtab-active:after{content:'';position:absolute;left:8px;right:8px;bottom:0;height:2px;border-radius:2px 2px 0 0;background:var(--td-brand-color)}
.gl-events{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;overflow:auto}
.gl-event{position:relative;display:flex;align-items:flex-start;gap:10px;padding:10px 30px 12px 44px;border-bottom:0;min-width:0}
.gl-event:after{content:'';position:absolute;left:44px;right:16px;bottom:0;height:1px;background:var(--td-component-stroke);opacity:.55}
.gl-event:hover{background:var(--td-bg-color-container-hover)}
.gl-avatar{display:inline-flex;align-items:center;justify-content:center;flex:0 0 22px;width:22px;height:22px;margin-top:1px;border-radius:50%;color:#fff;font-size:11px;line-height:1;font-weight:600;user-select:none}
.gl-more{display:flex;justify-content:center;padding:12px 16px;flex:0 0 auto}
.gl-event-main{flex:1 1 auto;min-width:0}
.gl-event-title{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px;min-width:0;font:var(--td-font-body-medium);color:var(--td-text-color-primary)}
.gl-event-author{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.gl-event-action{color:var(--td-text-color-secondary)}
.gl-event-subject{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--td-font-family-code);color:var(--td-text-color-brand)}
.gl-event-meta{display:flex;align-items:baseline;gap:0;margin-top:2px;min-width:0;font:var(--td-font-body-small);color:var(--td-text-color-placeholder)}
.gl-event-detail{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--td-font-family-code);font-size:12px;color:var(--td-text-color-secondary);text-decoration:none}
a.gl-event-detail:hover{color:var(--td-brand-color);text-decoration:underline}
.gl-event-time{flex:0 0 auto;white-space:nowrap}
.gl-timeline{position:relative;flex:0 0 auto}
.gl-timeline:before{content:'';position:absolute;left:24px;top:12px;bottom:0;width:1px;background:var(--td-component-stroke)}
.gl-day{position:relative;display:flex;flex-direction:column;min-width:0}
.gl-day-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:8px;height:36px;padding:0 16px 0 44px;background:var(--td-bg-color-container);font:var(--td-font-body-small);font-weight:600;color:var(--td-text-color-secondary)}
.gl-day-head:before{content:'';position:absolute;left:24px;top:0;bottom:0;width:1px;background:var(--td-component-stroke)}
.gl-day-node{position:absolute;left:15px;top:50%;transform:translateY(-50%);z-index:1;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;background:var(--td-bg-color-container);color:var(--gl-icon)}
.gl-day-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gl-commit{position:relative;display:flex;align-items:flex-start;gap:10px;padding:10px 30px 12px 44px;border-bottom:0;min-width:0}
.gl-commit:after{content:'';position:absolute;left:44px;right:16px;bottom:0;height:1px;background:var(--td-component-stroke);opacity:.55}
.gl-commit-tags{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;margin-top:1px;max-width:200px;overflow:hidden}
.gl-tag-pill{display:inline-flex;align-items:center;gap:3px;max-width:120px;height:20px;padding:0 7px;border-radius:10px;background:var(--td-bg-color-secondarycontainer);color:var(--td-text-color-secondary);font-size:11px;line-height:18px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gl-tag-pill:hover{background:var(--td-brand-color-light);color:var(--td-brand-color)}
.gl-commit:hover{background:var(--td-bg-color-container-hover)}
.gl-commit-sha{flex:0 0 auto;margin-top:1px;padding:0 5px;border-radius:3px;background:var(--td-bg-color-secondarycontainer);color:var(--td-text-color-secondary);font:var(--td-font-body-small);font-family:var(--td-font-family-code);text-decoration:none;line-height:18px}
a.gl-commit-sha:hover{background:var(--td-brand-color-light);color:var(--td-brand-color)}
.gl-commit-main{flex:1 1 auto;min-width:0}
.gl-commit-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--td-font-body-medium);color:var(--td-text-color-primary)}
.gl-commit-meta{margin-top:2px;font:var(--td-font-body-small);color:var(--td-text-color-placeholder)}
.gl-empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;margin:auto;padding:24px;text-align:center;font:var(--td-font-body-medium);min-height:0;overflow:auto}
.gl-empty-icon{display:flex;align-items:center;justify-content:center;color:var(--gl-icon-muted)}
.gl-empty-title{margin-top:10px;font:var(--td-font-body-medium);color:var(--td-text-color-secondary)}
.gl-empty-desc{margin-top:4px;max-width:360px;font:var(--td-font-body-small);color:var(--td-text-color-placeholder)}
.gl-empty-state .gl-btn{margin-top:14px}

/* ── connection form ─────────────────────────────────────────────────────── */
.gl-form-card{display:flex;flex-direction:column;gap:12px;width:min(420px,100%);padding:18px;border:1px solid var(--td-component-stroke);border-radius:10px;background:var(--td-bg-color-container);text-align:left}
.gl-form{display:flex;flex-direction:column;gap:12px}
.gl-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.gl-label{font:var(--td-font-body-small);color:var(--td-text-color-secondary)}
.gl-input{width:100%;height:32px;padding:0 10px;border:1px solid var(--td-component-border);border-radius:var(--td-radius-medium);background:var(--td-bg-color-container);color:var(--td-text-color-primary);font:var(--td-font-body-medium);outline:none}
.gl-input:focus{border-color:var(--td-brand-color);box-shadow:0 0 0 2px var(--td-brand-color-focus)}
.gl-input::placeholder{color:var(--td-text-color-placeholder)}
.gl-help{margin:0;font:var(--td-font-body-small);color:var(--td-text-color-placeholder);line-height:18px}
.gl-warn-note{margin:0;font:var(--td-font-body-small);color:var(--td-warning-color);line-height:18px}
.gl-form-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gl-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 14px;border:1px solid var(--td-component-border);border-radius:var(--td-radius-medium);background:var(--td-bg-color-container);color:var(--td-text-color-primary);font:var(--td-font-body-medium);cursor:pointer}
.gl-btn:hover:not(:disabled){background:var(--td-bg-color-container-hover)}
.gl-btn:focus-visible{outline:2px solid var(--td-brand-color-focus);outline-offset:0}
.gl-btn:disabled{opacity:.55;cursor:default}
.gl-btn-primary{border-color:var(--td-brand-color);background:var(--td-brand-color);color:#fff}
.gl-btn-primary:hover:not(:disabled){border-color:var(--td-brand-color-hover);background:var(--td-brand-color-hover)}
.gl-btn-text{border-color:transparent;background:transparent;color:var(--td-text-color-secondary)}
.gl-error-banner{display:flex;align-items:flex-start;gap:6px;padding:8px 10px;border-radius:var(--td-radius-medium);background:var(--td-error-color-light);color:var(--td-error-color);font:var(--td-font-body-small)}
.gl-error-banner svg{flex:0 0 auto;margin-top:2px}

/* ── modal ───────────────────────────────────────────────────────────────── */
.gl-modal-mask{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.35)}
.gl-modal{display:flex;flex-direction:column;width:min(440px,100%);max-height:100%;border-radius:10px;background:var(--td-bg-color-container);box-shadow:var(--td-shadow-2);overflow:hidden}
.gl-modal-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 8px 8px 16px;border-bottom:1px solid var(--td-component-stroke)}
.gl-modal-title{font:var(--td-font-title-small);color:var(--td-text-color-primary)}
.gl-modal-body{padding:16px;overflow:auto}
`;

    const NOTES_KEY = 'dsh-gitlab-notes-v1';

    function loadNotes() {
      try {
        const raw = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value === 'string' && value.trim()) out[key] = value;
        }
        return out;
      } catch (error) {
        return {};
      }
    }

    function loadView() {
      const fallback = { viewMode: 'activity', activeProjectId: 0, eventFilter: 'all', openProjects: {}, sortDir: 0 };
      try {
        const saved = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null');
        if (!saved || typeof saved !== 'object') return fallback;
        return {
          viewMode:
            saved.viewMode === 'ref' ? 'ref' : saved.viewMode === 'overview' ? 'overview' : 'activity',
          activeProjectId: Number(saved.activeProjectId) || 0,
          eventFilter: saved.eventFilter === 'push' ? 'push' : 'all',
          openProjects:
            saved.openProjects && typeof saved.openProjects === 'object' ? saved.openProjects : {},
          sortDir: Number(saved.sortDir) === 1 || Number(saved.sortDir) === -1 ? Number(saved.sortDir) : 0,
        };
      } catch (error) {
        return fallback;
      }
    }

    function loadLayout() {
      const fallback = { leftOpen: true, leftW: 300 };
      try {
        const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
        if (!saved) return fallback;
        return {
          leftOpen: saved.leftOpen !== false,
          leftW: clamp(saved.leftW || 300, 200, 560),
        };
      } catch (error) {
        return fallback;
      }
    }

    function ConnectionForm(props) {
      const [baseUrl, setBaseUrl] = useState(props.initialBaseUrl || '');
      const [token, setToken] = useState('');
      const tokenRef = useRef(null);

      useEffect(() => {
        if (props.autoFocus && tokenRef.current) tokenRef.current.focus();
      }, [props.autoFocus]);

      const submit = (event) => {
        event.preventDefault();
        props.onSubmit({ baseUrl, token });
      };

      return h(
        'form',
        { className: 'gl-form', onSubmit: submit },
        h(
          'label',
          { className: 'gl-field' },
          h('span', { className: 'gl-label' }, 'GitLab 地址'),
          h('input', {
            className: 'gl-input',
            value: baseUrl,
            spellCheck: false,
            placeholder: 'http://gitlab.example.com',
            onChange: (event) => setBaseUrl(event.target.value),
          }),
        ),
        h(
          'label',
          { className: 'gl-field' },
          h('span', { className: 'gl-label' }, 'Personal Access Token'),
          h('input', {
            className: 'gl-input',
            ref: tokenRef,
            type: 'password',
            value: token,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: props.hasToken ? '已保存，留空则不修改' : 'glpat-xxxxxxxx（只需 read_api）',
            onChange: (event) => setToken(event.target.value),
          }),
        ),
        /^http:\/\//i.test(baseUrl.trim())
          ? h('p', { className: 'gl-warn-note' }, '这是明文 HTTP 连接，令牌会以明文经过网络；实例支持 HTTPS 时请换成 HTTPS 地址。')
          : null,
        h(
          'p',
          { className: 'gl-help' },
          '令牌只发给本机 Host，保存在 DSH 凭据库里，不会写进页面，也不会写进插件配置文件。',
        ),
        props.error ? h('div', { className: 'gl-error-banner', role: 'alert' }, h(GlyphIcon, { name: 'alert', size: 14 }), h('span', null, props.error)) : null,
        h(
          'div',
          { className: 'gl-form-foot' },
          h('button', { className: 'gl-btn gl-btn-primary', type: 'submit', disabled: !!props.busy }, props.busy ? '连接中…' : '保存并连接'),
          props.hasToken && props.onClear
            ? h('button', { className: 'gl-btn gl-btn-text', type: 'button', disabled: !!props.busy, onClick: props.onClear }, '清除令牌')
            : null,
        ),
      );
    }

    function Modal(props) {
      const closeRef = useRef(props.onClose);
      const boxRef = useRef(null);
      closeRef.current = props.onClose;
      useEffect(() => {
        const previous = document.activeElement;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            closeRef.current();
            return;
          }
          if (event.key !== 'Tab' || !boxRef.current) return;
          const items = boxRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
          const list = Array.prototype.filter.call(items, (el) => !el.disabled && el.offsetParent !== null);
          if (!list.length) return;
          const first = list[0];
          const last = list[list.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        };
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('keydown', onKey);
          if (previous && typeof previous.focus === 'function') previous.focus();
        };
      }, []);
      return h(
        'div',
        {
          className: 'gl-modal-mask',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeRef.current();
          },
        },
        h(
          'div',
          { className: 'gl-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title, tabIndex: -1, ref: boxRef },
          h(
            'div',
            { className: 'gl-modal-head' },
            h('span', { className: 'gl-modal-title' }, props.title),
            h(
              'button',
              { className: 'gl-icon-btn', 'aria-label': '关闭', onClick: () => closeRef.current() },
              h(GlyphIcon, { name: 'close', size: 16 }),
            ),
          ),
          h('div', { className: 'gl-modal-body' }, props.children),
        ),
      );
    }

    function IconAction(props) {
      return h(
        'button',
        {
          className: 'gl-icon-btn' + (props.busy ? ' gl-spinning' : ''),
          title: props.title,
          'aria-label': props.title,
          disabled: !!props.disabled || !!props.busy,
          onClick: props.onClick,
        },
        h(GlyphIcon, { name: props.icon, size: 16 }),
      );
    }

    function Workbench(props) {
      const [savedView] = useState(loadView);
      const [layout, setLayout] = useState(loadLayout);
      const [lightsPad, setLightsPad] = useState(0);
      const [phase, setPhase] = useState('loading'); // loading | needs-config | ready | error
      const [bootError, setBootError] = useState('');
      const [connection, setConnection] = useState({ baseUrl: '', configured: false, hasToken: false, tokenSource: 'none', user: null });
      const [projects, setProjects] = useState([]);
      const [projectsBusy, setProjectsBusy] = useState(false);
      const [projectsError, setProjectsError] = useState('');
      const [projectsErrorCode, setProjectsErrorCode] = useState('');
      const [projectsTruncated, setProjectsTruncated] = useState(false);
      const [query, setQuery] = useState('');
      const [openProjects, setOpenProjects] = useState(savedView.openProjects);
      const [sortDir, setSortDir] = useState(savedView.sortDir);
      // Project notes stay in this browser only; nothing is written to GitLab.
      const [notes, setNotes] = useState(loadNotes);
      const [noteEdit, setNoteEdit] = useState(null);
      const [refs, setRefs] = useState({});
      const [openGroups, setOpenGroups] = useState({});
      const [selection, setSelection] = useState(null);
      const [commits, setCommits] = useState({ key: '', status: 'idle', items: [], hasMore: false, page: 1, error: '' });
      const [viewMode, setViewMode] = useState(savedView.viewMode); // activity | ref
      const [activeProjectId, setActiveProjectId] = useState(savedView.activeProjectId);
      const [eventFilter, setEventFilter] = useState(savedView.eventFilter);
      const [events, setEvents] = useState({ key: '', status: 'idle', items: [], hasMore: false, page: 1, error: '' });
      const [overview, setOverview] = useState({ key: '', status: 'idle', items: [], hasMore: false, page: 1, error: '' });
      const [dialog, setDialog] = useState(null);
      // Shared by the inline first-run form and the settings modal, so a failed
      // attempt reports itself in either place.
      const [connect, setConnect] = useState({ busy: false, error: '' });
      const [updateCheck, setUpdateCheck] = useState({ status: 'idle', text: '', detail: '' });
      const [notify, setNotify] = useState({
        enabled: notifyStore.enabled,
        unread: notifyStore.unread,
        items: notifyStore.items,
      });
      const [notifyOpen, setNotifyOpen] = useState(false);

      const refsRef = useRef({});
      const refsSeq = useRef({});
      const eventsCache = useRef({});
      const noteCancel = useRef(false);
      const rootRef = useRef(null);
      const aliveRef = useRef(true);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      useEffect(() => {
        try {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
        } catch (error) {
          /* storage may be unavailable */
        }
      }, [layout]);

      useEffect(() => {
        try {
          localStorage.setItem(
            VIEW_KEY,
            JSON.stringify({ viewMode, activeProjectId, eventFilter, openProjects, sortDir }),
          );
        } catch (error) {
          /* storage may be unavailable */
        }
      }, [viewMode, activeProjectId, eventFilter, openProjects, sortDir]);

      // Keep the left column inside the panel; never squeeze the detail off screen.
      useEffect(() => {
        const fit = () => {
          const el = rootRef.current;
          const width = (el && el.clientWidth) || window.innerWidth || 1200;
          const limit = Math.max(200, Math.min(560, width - 360));
          setLayout((prev) => {
            const leftW = clamp(prev.leftW, 200, limit);
            return leftW === prev.leftW ? prev : Object.assign({}, prev, { leftW });
          });
        };
        fit();
        window.addEventListener('resize', fit);
        return () => window.removeEventListener('resize', fit);
      }, []);

      // When the DSH sidebar is collapsed the panel starts under the macOS
      // traffic lights; reserve that space in whichever header lands on the left.
      useEffect(() => {
        const el = rootRef.current;
        if (!el || !isMac) return undefined;
        const update = () => {
          const rect = el.getBoundingClientRect();
          setLightsPad(Math.max(0, 76 - rect.left));
        };
        update();
        let observer = null;
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(update);
          observer.observe(el);
        }
        window.addEventListener('resize', update);
        return () => {
          if (observer) observer.disconnect();
          window.removeEventListener('resize', update);
        };
      }, []);

      const loadProjects = React.useCallback(async (fresh) => {
        setProjectsBusy(true);
        setProjectsError('');
        try {
          const data = await api('/gitlab/api/projects' + (fresh ? '?fresh=1' : ''));
          if (!aliveRef.current) return;
          if (data.configured === false) {
            setPhase('needs-config');
            setProjects([]);
            return;
          }
          const list = data.projects || [];
          setProjects(list);
          setProjectsTruncated(!!data.truncated);
          setActiveProjectId((prev) =>
            prev && list.some((project) => project.id === prev) ? prev : list[0] ? list[0].id : 0,
          );
          setPhase('ready');
          // The row counter is "branches + tags", which needs the refs fetched.
          // Pull the first screenful in the background (four at a time) so every
          // visible project shows its number without waiting for a click.
          ensureManyRefs(list.slice(0, 12).map((project) => project.id));
        } catch (error) {
          if (!aliveRef.current) return;
          setProjectsError(error?.message || String(error));
          setProjectsErrorCode(error?.code || '');
        } finally {
          if (aliveRef.current) setProjectsBusy(false);
        }
      }, []);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const data = await api('/gitlab/api/config');
            if (!alive) return;
            setConnection({
              baseUrl: data.baseUrl || '',
              configured: !!data.configured,
              hasToken: !!data.hasToken,
              tokenSource: data.tokenSource || 'none',
              user: data.user || null,
            });
            if (data.configured) {
              setPhase('ready');
              loadProjects(false);
            } else {
              setPhase('needs-config');
            }
          } catch (error) {
            if (!alive) return;
            setBootError(error?.message || String(error));
            setPhase('error');
          }
        })();
        return () => {
          alive = false;
        };
      }, [loadProjects]);

      // The Host only keeps the verified identity in memory, so after a restart
      // the panel asks once more in order to label the connection.
      useEffect(() => {
        if (!connection.configured || connection.user) return undefined;
        let alive = true;
        api('/gitlab/api/me')
          .then((data) => {
            if (!alive || !data.user) return;
            setConnection((prev) => (prev.user ? prev : Object.assign({}, prev, { user: data.user })));
          })
          .catch(() => {
            /* an expired token already shows up on the project list */
          });
        return () => {
          alive = false;
        };
      }, [connection.configured, connection.user]);

      function toggleProject(project) {
        const open = !!openProjects[project.id];
        const alreadyViewing = viewMode === 'activity' && activeProjectId === project.id;
        if (alreadyViewing) {
          // The second click on a project whose activity is already on screen
          // folds the branch, instead of being swallowed by a view switch.
          setOpenProjects((prev) => Object.assign({}, prev, { [project.id]: !open }));
          if (!open) ensureRefs(project.id, false);
          return;
        }
        setActiveProjectId(project.id);
        setViewMode('activity');
        if (!open) {
          setOpenProjects((prev) => Object.assign({}, prev, { [project.id]: true }));
          ensureRefs(project.id, false);
        }
      }

      function commitNote() {
        if (noteCancel.current) {
          noteCancel.current = false;
          setNoteEdit(null);
          return;
        }
        if (!noteEdit) return;
        const key = noteEdit.key;
        const value = String(noteEdit.value || '').trim();
        const next = Object.assign({}, notes);
        if (value) next[key] = value;
        else delete next[key];
        setNotes(next);
        setNoteEdit(null);
        try {
          localStorage.setItem(NOTES_KEY, JSON.stringify(next));
        } catch (error) {
          /* storage may be unavailable */
        }
      }

      function cycleSort() {
        setSortDir((prev) => (prev === 0 ? 1 : prev === 1 ? -1 : 0));
      }

      function toggleAll() {
        if (!filtered.length) return;
        if (allExpanded) {
          setOpenProjects({});
          setOpenGroups({});
          return;
        }
        const nextOpenProjects = {};
        const nextOpenGroups = {};
        for (const project of filtered) {
          nextOpenProjects[project.id] = true;
          nextOpenGroups[project.id] = { branch: true, tag: true };
        }
        setOpenProjects(nextOpenProjects);
        setOpenGroups(nextOpenGroups);
        ensureManyRefs(filtered.map((project) => project.id));
      }

      function toggleGroup(projectId, kind) {
        setOpenGroups((prev) => {
          const current = prev[projectId] || { branch: true, tag: true };
          return Object.assign({}, prev, {
            [projectId]: Object.assign({}, current, { [kind]: !current[kind] }),
          });
        });
      }

      function setRefsFor(projectId, value) {
        refsRef.current = Object.assign({}, refsRef.current, { [projectId]: value });
        setRefs(refsRef.current);
      }

      async function ensureRefs(projectId, fresh) {
        const current = refsRef.current[projectId];
        if (!fresh && current && (current.status === 'loading' || current.status === 'ready')) return;
        // A late answer from an older request must not overwrite a newer one.
        const seq = (refsSeq.current[projectId] || 0) + 1;
        refsSeq.current[projectId] = seq;
        setRefsFor(
          projectId,
          Object.assign(
            { status: 'loading', branches: [], tags: [], truncated: false, error: '' },
            current ? { branches: current.branches || [], tags: current.tags || [] } : {},
          ),
        );
        try {
          const data = await api('/gitlab/api/refs?projectId=' + projectId + (fresh ? '&fresh=1' : ''));
          if (!aliveRef.current || refsSeq.current[projectId] !== seq) return;
          setRefsFor(projectId, {
            status: 'ready',
            branches: data.branches || [],
            tags: data.tags || [],
            truncated: !!data.truncated,
            error: '',
          });
        } catch (error) {
          if (!aliveRef.current || refsSeq.current[projectId] !== seq) return;
          const previous = refsRef.current[projectId] || {};
          // Keep whatever the user was already looking at; only add the error.
          setRefsFor(projectId, {
            status: 'error',
            branches: previous.branches || [],
            tags: previous.tags || [],
            truncated: !!previous.truncated,
            error: error?.message || String(error),
          });
        }
      }

      // Expanding everything loads refs four projects at a time, so a long
      // project list cannot fire hundreds of requests at once.
      async function ensureManyRefs(projectIds) {
        const queue = projectIds.slice();
        const worker = async () => {
          while (queue.length) {
            const id = queue.shift();
            await ensureRefs(id, false);
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
      }

      async function loadEvents(projectId, filter, fresh, page) {
        const target = page || 1;
        const key = projectId + ':' + filter;
        const hit = eventsCache.current[key];
        if (target === 1 && !fresh && hit) {
          setEvents(hit);
          return;
        }
        if (target === 1) {
          setEvents({ key, status: 'loading', items: [], hasMore: false, page: 1, error: '' });
        } else {
          setEvents((prev) => (prev.key === key ? Object.assign({}, prev, { status: 'more' }) : prev));
        }
        try {
          const data = await api(
            '/gitlab/api/events?projectId=' +
              projectId +
              '&filter=' +
              filter +
              '&page=' +
              target +
              (fresh ? '&fresh=1' : ''),
          );
          const base = target > 1 && events.key === key ? events.items : [];
          const merged = {
            key,
            status: 'ready',
            items: base.concat(data.events || []),
            hasMore: !!data.hasMore,
            page: target,
            error: '',
          };
          eventsCache.current[key] = merged;
          setEvents(merged);
        } catch (error) {
          if (target > 1) {
            setEvents((prev) => (prev.key === key ? Object.assign({}, prev, { status: 'ready' }) : prev));
            return;
          }
          const failed = { key, status: 'error', items: [], hasMore: false, page: 1, error: error?.message || String(error) };
          setEvents((prev) => (prev.key === key ? failed : prev));
        }
      }

      async function loadOverview(filter, fresh, page) {
        const target = page || 1;
        const key = 'overview:' + filter;
        if (target === 1) {
          setOverview({ key, status: 'loading', items: [], hasMore: false, page: 1, error: '' });
        } else {
          setOverview((prev) => (prev.key === key ? Object.assign({}, prev, { status: 'more' }) : prev));
        }
        try {
          const data = await api(
            '/gitlab/api/overview?filter=' + filter + '&page=' + target + (fresh ? '&fresh=1' : ''),
          );
          const base = target > 1 && overview.key === key ? overview.items : [];
          setOverview({
            key,
            status: 'ready',
            items: base.concat(data.events || []),
            hasMore: !!data.hasMore,
            page: target,
            error: '',
          });
        } catch (error) {
          if (target > 1) {
            setOverview((prev) => (prev.key === key ? Object.assign({}, prev, { status: 'ready' }) : prev));
            return;
          }
          setOverview((prev) =>
            prev.key === key
              ? { key, status: 'error', items: [], hasMore: false, page: 1, error: error?.message || String(error) }
              : prev,
          );
        }
      }

      async function loadCommits(projectId, kind, ref, fresh, page) {
        const target = page || 1;
        const key = projectId + ':' + kind + ':' + ref;
        if (target === 1) {
          setCommits({ key, status: 'loading', items: [], hasMore: false, page: 1, error: '' });
        } else {
          setCommits((prev) => (prev.key === key ? Object.assign({}, prev, { status: 'more' }) : prev));
        }
        try {
          const data = await api(
            '/gitlab/api/commits?projectId=' +
              projectId +
              '&kind=' +
              kind +
              '&ref=' +
              encodeURIComponent(ref) +
              '&page=' +
              target +
              (fresh ? '&fresh=1' : ''),
          );
          const base = target > 1 && commits.key === key ? commits.items : [];
          const merged = {
            key,
            status: 'ready',
            items: base.concat(data.commits || []),
            hasMore: !!data.hasMore,
            page: target,
            error: '',
          };
          setCommits(merged);
        } catch (error) {
          if (target > 1) {
            setCommits((prev) => (prev.key === key ? Object.assign({}, prev, { status: 'ready' }) : prev));
            return;
          }
          setCommits((prev) =>
            prev.key === key
              ? { key, status: 'error', items: [], hasMore: false, page: 1, error: error?.message || String(error) }
              : prev,
          );
        }
      }

      function selectRef(projectId, kind, name) {
        setSelection({ projectId, kind, name });
        setActiveProjectId(projectId);
        setViewMode('ref');
        loadCommits(projectId, kind, name);
      }

      function refreshAll() {
        // Clearing the cache also has to reload every project the user already
        // opened, otherwise an expanded project collapses to an empty subtree.
        refsRef.current = {};
        setRefs({});
        for (const key of Object.keys(openProjects)) {
          if (openProjects[key]) ensureRefs(Number(key), true);
        }
        loadProjects(true);
        if (viewMode === 'overview') loadOverview(eventFilter, true, 1);
        if (viewMode === 'activity' && activeProjectId) loadEvents(activeProjectId, eventFilter, true);
        if (selection) loadCommits(selection.projectId, selection.kind, selection.name, true);
      }

      function startDrag(event) {
        event.preventDefault();
        const startX = event.clientX;
        const startW = layout.leftW;
        const el = rootRef.current;
        const width = (el && el.clientWidth) || window.innerWidth || 1200;
        const move = (ev) => {
          const next = startW + (ev.clientX - startX);
          setLayout((prev) => Object.assign({}, prev, { leftW: clamp(next, 200, Math.max(200, Math.min(560, width - 360))) }));
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }

      async function saveConnection(form) {
        const baseUrl = String(form.baseUrl || '').trim();
        const trimmedToken = String(form.token || '').trim();
        const sameBase =
          baseUrl.replace(/\/+$/, '') === String(connection.baseUrl || '').replace(/\/+$/, '');
        if (!baseUrl) {
          setConnect({ busy: false, error: '请填写 GitLab 地址' });
          return;
        }
        if (!trimmedToken && !connection.hasToken && !form.clearToken) {
          setConnect({ busy: false, error: '请填写访问令牌（需要 read_api 权限）' });
          return;
        }
        if (!trimmedToken && !form.clearToken && !sameBase) {
          setConnect({ busy: false, error: '更换 GitLab 地址需要重新输入访问令牌' });
          return;
        }
        setConnect({ busy: true, error: '' });
        try {
          const payload = { baseUrl };
          if (form.clearToken) payload.clearToken = true;
          else if (form.token) payload.token = form.token;
          const data = await api('/gitlab/api/settings', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(payload),
          });
          setConnection({
            baseUrl: data.baseUrl || '',
            configured: !!data.configured,
            hasToken: !!data.hasToken,
            tokenSource: data.tokenSource || 'none',
            user: data.user || null,
          });
          setConnect({ busy: false, error: '' });
          setDialog(null);
          // A different instance has different projects; drop everything that
          // belonged to the previous connection so nothing dangles open.
          refsRef.current = {};
          refsSeq.current = {};
          setRefs({});
          setSelection(null);
          setCommits({ key: '', status: 'idle', items: [], error: '' });
          setOpenProjects({});
          setOpenGroups({});
          setQuery('');
          setProjects([]);
          eventsCache.current = {};
          setEvents({ key: '', status: 'idle', items: [], error: '' });
          setEventFilter('all');
          setActiveProjectId(0);
          setViewMode('activity');
          if (data.configured) {
            setPhase('ready');
            loadProjects(true);
          } else {
            setPhase('needs-config');
          }
        } catch (error) {
          setConnect({ busy: false, error: error?.message || String(error) });
          // The failed save may still have stored a token; resync so the field
          // hint and the clear button reflect what the Host actually holds.
          try {
            const data = await api('/gitlab/api/config');
            setConnection({
              baseUrl: data.baseUrl || '',
              configured: !!data.configured,
              hasToken: !!data.hasToken,
              tokenSource: data.tokenSource || 'none',
              user: data.user || null,
            });
          } catch (refreshError) {
            /* keep the previous view when the resync also fails */
          }
        }
      }

      useEffect(() => {
        startNotifyPolling();
        return subscribeNotify(() =>
          setNotify({
            enabled: notifyStore.enabled,
            unread: notifyStore.unread,
            items: notifyStore.items,
          }),
        );
      }, []);

      useEffect(() => {
        if (!notifyOpen) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') setNotifyOpen(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [notifyOpen]);

      async function toggleNotify() {
        try {
          const data = await api('/gitlab/api/activity/enabled', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ enabled: !notify.enabled }),
          });
          applyNotifySnapshot(data);
        } catch (error) {
          /* the switch snaps back on the next poll */
        }
      }

      async function markNotificationsRead(keys) {
        try {
          const data = await api('/gitlab/api/activity/read', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(Array.isArray(keys) && keys.length ? { keys } : {}),
          });
          applyNotifySnapshot(data);
        } catch (error) {
          /* ignore */
        }
      }

      const renderBubble = (item) => {
        const view = describeNotification(item);
        return h(
          'a',
          {
            key: item.key,
            className: 'gl-bubble' + (item.read ? ' gl-bubble-read' : ''),
            href: view.link || undefined,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: view.title || item.projectName,
            onClick: (event) => {
              if (!view.link) event.preventDefault();
              // Opening a bubble counts as reading it.
              if (!item.read) markNotificationsRead([item.key]);
            },
          },
          h(
            'div',
            { className: 'gl-bubble-top' },
            h('span', { className: 'gl-bubble-dot' }),
            h('span', { className: 'gl-bubble-project' }, item.projectName),
            h('span', { className: 'gl-bubble-time' }, formatTime(item.createdAt)),
          ),
          h(
            'div',
            { className: 'gl-bubble-text' },
            (item.authorName || '某人') + ' ' + view.action + (view.subject ? ' ' + view.subject : ''),
          ),
          view.title ? h('div', { className: 'gl-bubble-commit' }, view.title) : null,
        );
      };

      async function checkUpdate() {
        setUpdateCheck({ status: 'busy', text: '检查中…', detail: '' });
        try {
          const data = await api('/gitlab/api/update');
          if (data.updateAvailable && data.upstream) {
            setUpdateCheck({
              status: 'stale',
              text: '新版本 ' + data.upstream.version,
              detail:
                '当前 v' + data.version + ' → 最新 ' + data.upstream.version +
                '。到插件目录执行 git pull 后重启 DSH。下载：' + data.upstream.url,
            });
            return;
          }
          if (data.changed && data.changed.length) {
            setUpdateCheck({
              status: 'stale',
              text: '有更新',
              detail:
                (data.needsRestart
                  ? '插件代码已更新，重启 DSH 后生效。'
                  : '页面代码已更新，刷新页面后生效。若界面没变就重启 DSH。') +
                '变更文件：' + data.changed.join('、'),
            });
            return;
          }
          if (data.upstreamError) {
            setUpdateCheck({
              status: 'error',
              text: '检查失败',
              detail: '本地 v' + data.version + ' 未改动，但连接 GitHub 失败：' + data.upstreamError,
            });
            return;
          }
          setUpdateCheck({
            status: 'latest',
            text: '已是最新',
            detail:
              '运行中 v' + data.version +
              (data.upstream ? '，GitHub 上最新也是 ' + data.upstream.version : '') + '。',
          });
        } catch (error) {
          setUpdateCheck({ status: 'error', text: '检查失败', detail: error?.message || String(error) });
        }
      }

      function openDialog() {
        setConnect({ busy: false, error: '' });
        setDialog({ baseUrl: connection.baseUrl });
      }

      useEffect(() => {
        if (viewMode === 'overview') {
          loadOverview(eventFilter, false, 1);
          return;
        }
        if (viewMode !== 'activity' || !activeProjectId) return;
        loadEvents(activeProjectId, eventFilter, false);
      }, [viewMode, activeProjectId, eventFilter]);

      // Projects restored as expanded need their refs fetched once the list is in.
      const restoredRef = useRef(false);
      useEffect(() => {
        if (restoredRef.current || !projects.length) return;
        restoredRef.current = true;
        const ids = Object.keys(openProjects)
          .filter((id) => openProjects[id])
          .map(Number)
          .filter((id) => projects.some((project) => project.id === id));
        if (ids.length) ensureManyRefs(ids);
      }, [projects]);

      const filtered = (() => {
        const keyword = query.trim().toLowerCase();
        if (!keyword) return projects;
        return projects.filter((project) => {
          const haystack = (project.nameWithNamespace + ' ' + project.description).toLowerCase();
          return haystack.indexOf(keyword) >= 0;
        });
      })();

      // 0 = newest activity (server order), 1 = name A→Z, -1 = name Z→A.
      const sortedProjects = (() => {
        if (!sortDir) return filtered;
        const list = filtered.slice().sort((a, b) =>
          String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }),
        );
        return sortDir > 0 ? list : list.reverse();
      })();

      const duplicateNames = (() => {
        const counts = new Map();
        for (const project of filtered) counts.set(project.name, (counts.get(project.name) || 0) + 1);
        return counts;
      })();

      const allExpanded =
        filtered.length > 0 &&
        filtered.every((project) => {
          if (!openProjects[project.id]) return false;
          const groups = openGroups[project.id];
          return !groups || (groups.branch && groups.tag);
        });

      const projectById = (id) => projects.find((project) => project.id === id);
      const selectedProject = selection ? projectById(selection.projectId) : null;
      const selectedRefItem = (() => {
        if (!selection) return null;
        const bucket = refs[selection.projectId];
        if (!bucket || bucket.status !== 'ready') return null;
        const list = selection.kind === 'branch' ? bucket.branches : bucket.tags;
        return list.find((item) => item.name === selection.name) || null;
      })();

      const tagNote = (() => {
        if (!selectedRefItem || !selectedRefItem.message) return '';
        const text = String(selectedRefItem.message).replace(/\s+/g, ' ').trim();
        return text.length > 80 ? text.slice(0, 80) + '…' : text;
      })();

      const activityProject = activeProjectId ? projectById(activeProjectId) : null;

      const webLink = (() => {
        if (viewMode === 'overview') return '';
        if (viewMode === 'activity') return activityProject ? activityProject.webUrl + '/-/activity' : '';
        if (!selection || !selectedProject || !selectedProject.webUrl) return '';
        const base = selectedProject.webUrl;
        if (selection.kind === 'branch') return base + '/-/tree/' + encodeRefPath(selection.name);
        return base + '/-/tags/' + encodeRefPath(selection.name);
      })();

      const renderLeft = () => {
        if (phase === 'loading') return h('div', { className: 'gl-empty' }, '连接中…');
        if (phase === 'error') {
          return h(
            'div',
            { className: 'gl-empty' },
            '宿主接口没响应：' + bootError,
            h('div', { style: { marginTop: '8px' } }, h('button', { className: 'gl-link', onClick: () => window.location.reload() }, '重新加载')),
          );
        }
        if (phase === 'needs-config') {
          return h(
            'div',
            { className: 'gl-empty gl-empty-sm' },
            '还没连接 GitLab。填好地址和令牌后，这里会列出你的项目。',
            h('div', { style: { marginTop: '6px' } }, h('button', { className: 'gl-link', onClick: openDialog }, '打开连接设置')),
          );
        }
        if (projectsError) {
          return h(
            'div',
            { className: 'gl-empty gl-empty-sm gl-error-text' },
            projectsErrorCode === 'unauthorized' ? '令牌可能已失效：' : '',
            projectsError,
            h(
              'div',
              { className: 'gl-error-actions' },
              h('button', { className: 'gl-link', onClick: () => loadProjects(true) }, '重试'),
              h('button', { className: 'gl-link', onClick: openDialog }, '打开连接设置'),
            ),
          );
        }
        if (!filtered.length) {
          return h(
            'div',
            { className: 'gl-empty gl-empty-sm' },
            query ? '没有匹配的项目' : projectsBusy ? '加载项目…' : '你在 GitLab 上还没有可读项目',
          );
        }
        return sortedProjects.map((project) => renderProject(project));
      };

      const renderProject = (project) => {
        const open = !!openProjects[project.id];
        const bucket = refs[project.id] || { status: 'idle', branches: [], tags: [] };
        const groups = openGroups[project.id] || { branch: true, tag: true };
        const refCount = bucket.status === 'ready' ? bucket.branches.length + bucket.tags.length : null;
        // Two groups can hold projects with the same name; show the full path then.
        const label = duplicateNames.get(project.name) > 1 ? project.pathWithNamespace : project.name;
        const noteKey = project.pathWithNamespace || String(project.id);
        const note = notes[noteKey] || '';
        const editing = !!noteEdit && noteEdit.key === noteKey;
        return h(
          'div',
          { key: 'p' + project.id, className: 'gl-group' },
          h(
            'div',
            {
              className:
                'gl-row gl-project' +
                (project.archived ? ' gl-muted' : '') +
                // While the overview is on screen no single project is the current one.
                (viewMode !== 'overview' && activeProjectId === project.id ? ' gl-project-active' : ''),
              title: project.pathWithNamespace,
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              'aria-label': project.pathWithNamespace,
              onClick: () => toggleProject(project),
              onKeyDown: onRowKey(() => toggleProject(project)),
            },
            h(
              'span',
              { className: 'gl-icon' + (open ? ' gl-icon-open' : '') },
              h('span', { className: 'gl-icon-folder' }, h(GlyphIcon, { name: open ? 'folder-open' : 'folder', size: 16 })),
              h('span', { className: 'gl-icon-caret' }, h(GlyphIcon, { name: open ? 'chevron-down' : 'chevron-right', size: 16 })),
            ),
            editing
              ? h('input', {
                  className: 'gl-note-input',
                  value: noteEdit.value,
                  autoFocus: true,
                  placeholder: '写个备注，回车保存',
                  'aria-label': '项目备注',
                  onClick: (event) => event.stopPropagation(),
                  onChange: (event) => setNoteEdit({ key: noteKey, value: event.target.value }),
                  onBlur: commitNote,
                  onKeyDown: (event) => {
                    event.stopPropagation();
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitNote();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      noteCancel.current = true;
                      setNoteEdit(null);
                    }
                  },
                })
              : h(
                  'span',
                  { className: 'gl-name', title: label + (note ? '（' + note + '）' : '') },
                  label,
                  note ? h('span', { className: 'gl-note' }, '（' + note + '）') : null,
                ),
            h(
              'button',
              {
                type: 'button',
                className: 'gl-icon-btn gl-icon-btn-sm gl-edit-btn',
                title: '备注',
                'aria-label': note ? '修改备注' : '添加备注',
                onClick: (event) => {
                  event.stopPropagation();
                  setNoteEdit({ key: noteKey, value: note });
                },
                onKeyDown: (event) => event.stopPropagation(),
              },
              h(GlyphIcon, { name: 'edit', size: 13 }),
            ),
            refCount === null ? null : h('span', { className: 'gl-meta' }, String(refCount)),
          ),
          h(
            'div',
            { className: 'gl-children-wrap' + (open ? ' gl-children-open' : '') },
            h(
              'div',
              { className: 'gl-children' },
              bucket.status === 'loading' && !bucket.branches.length
                ? h('div', { className: 'gl-empty gl-empty-sm' }, '加载分支和 Tag…')
                : null,
              bucket.status === 'error'
                ? h(
                    'div',
                    { className: 'gl-empty gl-empty-sm gl-error-text' },
                    bucket.error,
                    h('div', { style: { marginTop: '4px' } }, h('button', { className: 'gl-link', onClick: () => ensureRefs(project.id, true) }, '重试')),
                  )
                : null,
              bucket.status === 'ready' || bucket.branches.length
                ? renderGroup(project, 'branch', '分支', bucket.branches, !!groups.branch, !!bucket.truncated)
                : null,
              bucket.status === 'ready' || bucket.tags.length
                ? renderGroup(project, 'tag', 'Tag', bucket.tags, !!groups.tag, !!bucket.truncated)
                : null,
            ),
          ),
        );
      };

      const renderGroup = (project, kind, label, items, open, truncated) => {
        return h(
          'div',
          { key: kind, className: 'gl-subgroup' },
          h(
            'div',
            {
              className: 'gl-row gl-group-row' + (open ? ' gl-group-open' : ''),
              role: 'button',
              tabIndex: 0,
              'aria-expanded': open,
              onClick: () => toggleGroup(project.id, kind),
              onKeyDown: onRowKey(() => toggleGroup(project.id, kind)),
            },
            h(
              'span',
              { className: 'gl-icon gl-icon-sm gl-group-icon' },
              h('span', { className: 'gl-group-mark' }, h(GlyphIcon, { name: kind === 'branch' ? 'branch' : 'tag', size: 15 })),
              h('span', { className: 'gl-group-caret' }, h(GlyphIcon, { name: open ? 'chevron-down' : 'chevron-right', size: 14 })),
            ),
            h('span', { className: 'gl-group-label' }, label),
            h('span', { className: 'gl-count', title: truncated ? '只读取了前 300 条' : undefined }, String(items.length) + (truncated ? '+' : '')),
          ),
          h(
            'div',
            { className: 'gl-children-wrap gl-sub' + (open ? ' gl-children-open' : '') },
            h(
              'div',
              { className: 'gl-children gl-children-sub' },
              items.length === 0
                ? h('div', { className: 'gl-empty gl-empty-sm' }, kind === 'branch' ? '没有分支' : '没有 Tag')
                : items.map((item) => renderRef(project, kind, item)),
            ),
          ),
        );
      };

      const renderRef = (project, kind, item) => {
        // A ref only reads as "current" while its detail is on screen; the
        // overview and the project feed have their own selected row.
        const active =
          viewMode === 'ref' &&
          !!selection &&
          selection.projectId === project.id &&
          selection.kind === kind &&
          selection.name === item.name;
        return h(
          'div',
          {
            key: kind + ':' + item.name,
            className: 'gl-row gl-ref' + (active ? ' gl-active' : ''),
            title: item.name,
            role: 'button',
            tabIndex: 0,
            'aria-current': active ? 'true' : undefined,
            onClick: () => selectRef(project.id, kind, item.name),
            onKeyDown: onRowKey(() => selectRef(project.id, kind, item.name)),
          },
          h('span', { className: 'gl-icon gl-icon-sm' }, h(GlyphIcon, { name: kind === 'branch' ? 'branch' : 'tag', size: 14 })),
          h('span', { className: 'gl-name' }, item.name),
          kind === 'branch' && item.default ? h('span', { className: 'gl-flag' }, '默认') : null,
        );
      };

      const renderEmptyState = (title, description, action) =>
        h(
          'div',
          { className: 'gl-empty-state' },
          h('span', { className: 'gl-empty-icon' }, h(GlyphIcon, { name: 'commit', size: 32 })),
          h('div', { className: 'gl-empty-title' }, title),
          description ? h('div', { className: 'gl-empty-desc' }, description) : null,
          action || null,
        );

      const renderEventRow = (item, webUrl, showProject) => {
        const view = describeEvent(item, webUrl);
        return h(
          'div',
          { key: 'ev' + item.id + ':' + (item.projectId || ''), className: 'gl-event' },
          h(
            'span',
            {
              className: 'gl-avatar',
              style: { background: avatarColor(item.authorUsername || item.authorName || '?') },
              'aria-hidden': true,
            },
            String(item.authorName || item.authorUsername || '?').slice(0, 1).toUpperCase(),
          ),
          h(
            'div',
            { className: 'gl-event-main' },
            h(
              'div',
              { className: 'gl-event-title' },
              h('span', { className: 'gl-event-author' }, item.authorName || item.authorUsername || '某人'),
              h('span', { className: 'gl-event-action' }, view.action),
              view.subject ? h('span', { className: 'gl-event-subject', title: view.subject }, view.subject) : null,
              showProject && item.projectName
                ? h('span', { className: 'gl-event-project', title: item.projectName }, item.projectName)
                : null,
            ),
            h(
              'div',
              { className: 'gl-event-meta' },
              view.detail
                ? view.url
                  ? h(
                      'a',
                      {
                        className: 'gl-event-detail',
                        href: view.url,
                        title: view.detail,
                        target: '_blank',
                        rel: 'noreferrer noopener',
                      },
                      view.detail,
                    )
                  : h('span', { className: 'gl-event-detail', title: view.detail }, view.detail)
                : null,
              h('span', { className: 'gl-event-time' }, (view.detail ? ' · ' : '') + formatTime(item.createdAt)),
            ),
          ),
          showProject && item.projectName && notes[item.projectName]
            ? h(
                'span',
                {
                  className: 'gl-event-note',
                  title: '项目备注：' + notes[item.projectName],
                },
                notes[item.projectName],
              )
            : null,
        );
      };

      const renderFilterTabs = () =>
        h(
          'div',
          { className: 'gl-subtabs', role: 'tablist', 'aria-label': '活动筛选' },
          EVENT_FILTERS.map((filter) =>
            h(
              'button',
              {
                key: filter.key,
                type: 'button',
                role: 'tab',
                'aria-selected': eventFilter === filter.key,
                className: 'gl-subtab' + (eventFilter === filter.key ? ' gl-subtab-active' : ''),
                onClick: () => setEventFilter(filter.key),
              },
              filter.label,
            ),
          ),
        );

      const renderFeed = (state, options) => {
        const list = state.items || [];
        if (state.status === 'loading') return h('div', { className: 'gl-empty' }, '读取活动…');
        if (state.status === 'error') {
          return h(
            'div',
            { className: 'gl-empty gl-error-text' },
            state.error,
            h('div', { className: 'gl-error-actions' }, h('button', { className: 'gl-link', onClick: options.onRetry }, '重试')),
          );
        }
        if (!list.length) return h('div', { className: 'gl-empty' }, options.emptyText);
        return h(
          'div',
          { className: 'gl-events' },
          h(
            'div',
            { className: 'gl-timeline' },
            groupByDay(list, (item) => item.createdAt).map((group) =>
              h(
                'div',
                { key: 'day-' + group.key, className: 'gl-day' },
                h(
                  'div',
                  { className: 'gl-day-head' },
                  h('span', { className: 'gl-day-node' }, h(GlyphIcon, { name: 'commit', size: 14 })),
                  h('span', { className: 'gl-day-label' }, group.label),
                ),
                group.items.map((item) => renderEventRow(item, options.webUrl(item), options.showProject)),
              ),
            ),
          ),
          state.hasMore
            ? h(
                'div',
                { className: 'gl-more' },
                h(
                  'button',
                  { className: 'gl-btn', disabled: state.status === 'more', onClick: options.onMore },
                  state.status === 'more' ? '加载中…' : '加载更多',
                ),
              )
            : null,
        );
      };

      const renderActivity = () => {
        if (!activityProject) {
          return renderEmptyState('选一个项目', '点左侧的项目名，就能看到这个项目的活动记录。');
        }
        return h(
          'div',
          { className: 'gl-activity' },
          renderFilterTabs(),
          renderFeed(events, {
            emptyText:
              eventFilter === 'push'
                ? '这个项目还没有推送事件'
                : eventFilter === 'merge'
                  ? '这个项目还没有合并事件'
                  : '这个项目还没有相关活动',
            showProject: false,
            webUrl: () => activityProject.webUrl,
            onRetry: () => loadEvents(activeProjectId, eventFilter, true),
            onMore: () => loadEvents(activeProjectId, eventFilter, false, events.page + 1),
          }),
        );
      };

      const renderOverview = () =>
        h(
          'div',
          { className: 'gl-activity' },
          renderFilterTabs(),
          renderFeed(overview, {
            emptyText:
              eventFilter === 'push'
                ? '还没有推送事件'
                : eventFilter === 'merge'
                  ? '还没有合并事件'
                  : '还没有任何活动',
            showProject: true,
            webUrl: (item) => item.projectWebUrl || '',
            onRetry: () => loadOverview(eventFilter, true, 1),
            onMore: () => loadOverview(eventFilter, false, overview.page + 1),
          }),
        );

      const renderMain = () => {
        if (phase === 'loading') return renderEmptyState('正在连接 GitLab…', '正在读取本机保存的连接设置。');
        if (phase === 'error') {
          return renderEmptyState(
            '宿主接口不可用',
            bootError || '插件没能连上 Host 侧的 /gitlab/api。',
            h('button', { className: 'gl-btn', onClick: () => window.location.reload() }, '重新加载面板'),
          );
        }
        if (phase === 'needs-config') {
          return h(
            'div',
            { className: 'gl-empty-state' },
            h('div', { className: 'gl-form-card' },
              h('div', { className: 'gl-empty-title', style: { marginTop: 0 } }, '连接你的 GitLab'),
              h('div', { className: 'gl-empty-desc', style: { marginBottom: '12px' } },
                '填好实例地址和个人访问令牌（read_api 权限）。保存后会立即读取项目列表。'),
              h(ConnectionForm, {
                initialBaseUrl: connection.baseUrl,
                hasToken: connection.hasToken,
                autoFocus: true,
                busy: connect.busy,
                error: connect.error,
                onSubmit: saveConnection,
              }),
            ),
          );
        }
        if (viewMode === 'overview') return renderOverview();
        if (viewMode === 'activity') return renderActivity();
        if (!selection) {
          return renderEmptyState('选择左侧的分支或 Tag', '展开项目可以看到它的分支与 Tag，点一条就能看最近的提交记录。');
        }
        if (commits.status === 'loading') return renderEmptyState('读取提交…', selection.name);
        if (commits.status === 'error') {
          return renderEmptyState(
            '读取提交失败',
            commits.error,
            h('button', { className: 'gl-btn', onClick: () => loadCommits(selection.projectId, selection.kind, selection.name) }, '重试'),
          );
        }
        const items = commits.items || [];
        const newest = items[0];
        return h(
          'div',
          { className: 'gl-detail' },
          h(
            'div',
            { className: 'gl-detail-head' },
            h(
              'div',
              { className: 'gl-detail-title' },
              h('span', { className: 'gl-detail-icon' }, h(GlyphIcon, { name: selection.kind === 'branch' ? 'branch' : 'tag', size: 18 })),
              h('h2', { className: 'gl-detail-name', title: selection.name }, selection.name),
              selectedRefItem && selectedRefItem.default ? h('span', { className: 'gl-badge gl-badge-brand' }, '默认分支') : null,
              selectedRefItem && selectedRefItem.protected ? h('span', { className: 'gl-badge gl-badge-warn' }, '受保护') : null,
            ),
            h(
              'div',
              { className: 'gl-detail-meta' },
              h('span', null, h('b', null, '项目 '), selectedProject ? selectedProject.pathWithNamespace : ''),
              h('span', null, h('b', null, '最近提交 '), newest ? formatTime(newest.committedDate) : '—'),
              h('span', null, h('b', null, '读取 '), String(items.length) + ' 条提交'),
              selectedRefItem && selectedRefItem.commit && selectedRefItem.commit.authorName
                ? h('span', null, h('b', null, '最后作者 '), selectedRefItem.commit.authorName)
                : null,
              tagNote
                ? h('span', { title: selectedRefItem.message }, h('b', null, '说明 '), tagNote)
                : null,
            ),
          ),
          h(
            'div',
            { className: 'gl-commits' },
            items.length === 0
              ? h('div', { className: 'gl-empty' }, '这条引用还没有提交')
              : [
                  h(
                    'div',
                    { key: 'timeline', className: 'gl-timeline' },
                    groupByDay(items, (commit) => commit.committedDate).map((group) =>
                    h(
                      'div',
                      { key: 'day-' + group.key, className: 'gl-day' },
                      h(
                        'div',
                        { className: 'gl-day-head' },
                        h('span', { className: 'gl-day-node' }, h(GlyphIcon, { name: 'commit', size: 14 })),
                        h('span', { className: 'gl-day-label' }, group.label),
                      ),
                      group.items.map((commit) =>
                        h(
                          'div',
                          { key: commit.id || commit.shortId, className: 'gl-commit' },
                          h(
                            'span',
                            {
                              className: 'gl-avatar',
                              style: { background: avatarColor(commit.authorName || '?') },
                              'aria-hidden': true,
                            },
                            String(commit.authorName || '?').slice(0, 1).toUpperCase(),
                          ),
                          h(
                            'div',
                            { className: 'gl-commit-main' },
                            h('div', { className: 'gl-commit-title', title: commit.title }, commit.title),
                            h(
                              'div',
                              { className: 'gl-commit-meta' },
                              (commit.authorName || '未知作者') + ' · ' + formatTime(commit.committedDate),
                            ),
                          ),
                          commit.tags && commit.tags.length
                            ? h(
                                'span',
                                { className: 'gl-commit-tags' },
                                commit.tags.slice(0, 3).map((tag) =>
                                  h(
                                    'a',
                                    {
                                      key: tag,
                                      className: 'gl-tag-pill',
                                      href: selectedProject ? selectedProject.webUrl + '/-/tags/' + encodeRefPath(tag) : undefined,
                                      target: '_blank',
                                      rel: 'noreferrer noopener',
                                      title: 'Tag ' + tag,
                                    },
                                    h(GlyphIcon, { name: 'tag', size: 11 }),
                                    tag,
                                  ),
                                ),
                              )
                            : null,
                          commit.webUrl
                            ? h(
                                'a',
                                {
                                  className: 'gl-commit-sha',
                                  href: commit.webUrl,
                                  target: '_blank',
                                  rel: 'noreferrer noopener',
                                  title: commit.id,
                                },
                                commit.shortId,
                              )
                            : h('span', { className: 'gl-commit-sha', title: commit.id }, commit.shortId),
                        ),
                      ),
                    ),
                    ),
                  ),
                  commits.hasMore
                    ? h(
                        'div',
                        { className: 'gl-more' },
                        h(
                          'button',
                          {
                            className: 'gl-btn',
                            disabled: commits.status === 'more',
                            onClick: () =>
                              loadCommits(selection.projectId, selection.kind, selection.name, false, commits.page + 1),
                          },
                          commits.status === 'more' ? '加载中…' : '加载更多',
                        ),
                      )
                    : null,
                ],
          ),
        );
      };

      return h(
        'div',
        {
          className:
            'gl-root' +
            (isMac ? ' gl-mac' : '') +
            (lightsPad > 0 ? ' gl-under-lights' : '') +
            (layout.leftOpen ? '' : ' gl-left-closed'),
          style: {
            '--gl-pane-head-pad': Math.max(16, 8 + lightsPad) + 'px',
            '--gl-main-head-pad': Math.max(16, lightsPad - 32) + 'px',
          },
          ref: rootRef,
        },
        h('style', { key: 'gl-style' }, CSS),

        layout.leftOpen
          ? h(
              'aside',
              { className: 'gl-pane gl-left', style: { width: layout.leftW } },
              h(
                'div',
                { className: 'gl-pane-head' },
                h('span', { className: 'gl-pane-title' }, 'GitLab'),
                h(
                  'div',
                  { className: 'gl-head-actions' },
                  h(IconAction, { icon: 'refresh', title: '刷新项目与分支', busy: projectsBusy, onClick: refreshAll }),
                  h(IconAction, { icon: 'link', title: '连接设置', onClick: openDialog }),
                  h(IconAction, { icon: 'chevron-left', title: '收起左栏', onClick: () => setLayout((prev) => Object.assign({}, prev, { leftOpen: false })) }),
                ),
              ),
              h(
                'div',
                { className: 'gl-filter-row' },
                h(
                  'div',
                  { className: 'gl-search' },
                  h('span', { className: 'gl-search-icon' }, h(GlyphIcon, { name: 'search', size: 16 })),
                  h('input', {
                    className: 'gl-search-input',
                    type: 'search',
                    value: query,
                    placeholder: '筛选已加载项目',
                    'aria-label': '筛选已加载项目',
                    onChange: (event) => setQuery(event.target.value),
                    onKeyDown: (event) => {
                      if (event.key === 'Escape') setQuery('');
                    },
                  }),
                ),
              ),
              phase === 'ready' && projects.length
                ? h(
                    'div',
                    { className: 'gl-overview' },
                    h(
                      'div',
                      {
                        className:
                          'gl-row gl-project gl-overview-row' + (viewMode === 'overview' ? ' gl-project-active' : ''),
                        role: 'button',
                        tabIndex: 0,
                        'aria-current': viewMode === 'overview' ? 'true' : undefined,
                        title: '所有项目的动态',
                        onClick: () => setViewMode('overview'),
                        onKeyDown: onRowKey(() => setViewMode('overview')),
                      },
                      h('span', { className: 'gl-icon' }, h(GlyphIcon, { name: 'pulse', size: 16 })),
                      h('span', { className: 'gl-name' }, '总览'),
                      h('span', { className: 'gl-overview-hint' }, '全部项目'),
                    ),
                  )
                : null,
              phase === 'ready' && !projectsError && filtered.length
                ? h(
                    'div',
                    { className: 'gl-tree-head' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'gl-tree-head-btn' + (sortDir ? ' gl-tree-head-active' : ''),
                        title: sortDir
                          ? '按名称' + (sortDir > 0 ? '正序' : '倒序') + '，点击切换'
                          : '点击按名称排序',
                        'aria-label': '按项目名称排序',
                        onClick: cycleSort,
                      },
                      h('span', { className: 'gl-tree-head-label' }, '项目'),
                      sortDir
                        ? h(
                            'span',
                            { className: 'gl-tree-head-arrow' },
                            h(GlyphIcon, { name: sortDir > 0 ? 'arrow-up' : 'arrow-down', size: 12 }),
                          )
                        : null,
                    ),
                    h('span', { className: 'gl-tree-head-spacer' }),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'gl-icon-btn gl-icon-btn-sm',
                        title: allExpanded ? '收起全部项目与分组' : '展开全部项目与分组',
                        'aria-label': allExpanded ? '收起全部' : '展开全部',
                        disabled: !filtered.length,
                        onClick: toggleAll,
                      },
                      h(GlyphIcon, { name: allExpanded ? 'collapse-all' : 'expand-all', size: 13 }),
                    ),
                    h(
                      'span',
                      { className: 'gl-tree-head-count', title: projectsTruncated ? 'GitLab 只返回了最近活跃的前 200 个成员项目' : undefined },
                      '共 ' + filtered.length + ' 个' + (projectsTruncated ? '（前 200）' : ''),
                    ),
                  )
                : null,
              h('div', { className: 'gl-tree' }, renderLeft()),
              h(
                'div',
                { className: 'gl-footer' },
                h(
                  'span',
                  { className: 'gl-plugin-version', title: 'GitLab 工作台版本' },
                  'GitLab 工作台 ' + VERSION + (connection.user ? ' · @' + connection.user.username : ''),
                ),
                h(
                  'button',
                  {
                    className:
                      'gl-update-btn' + (updateCheck.status === 'stale' ? ' gl-update-stale' : ''),
                    type: 'button',
                    title: updateCheck.detail || '对比本地插件文件与正在运行的版本',
                    disabled: updateCheck.status === 'busy',
                    onClick: checkUpdate,
                  },
                  updateCheck.text || '检查更新',
                ),
              ),
            )
          : h(
              'div',
              { className: 'gl-rail gl-rail-left' },
              h(
                'button',
                {
                  className: 'gl-icon-btn',
                  title: '展开项目/分支',
                  'aria-label': '展开项目/分支',
                  onClick: () => setLayout((prev) => Object.assign({}, prev, { leftOpen: true })),
                },
                h(GlyphIcon, { name: 'chevron-right', size: 16 }),
              ),
            ),

        layout.leftOpen
          ? h('div', {
              className: 'gl-split',
              role: 'separator',
              'aria-orientation': 'vertical',
              'aria-label': '调整左栏宽度',
              tabIndex: 0,
              onMouseDown: startDrag,
              onKeyDown: (event) => {
                const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
                if (!step) return;
                event.preventDefault();
                setLayout((prev) => Object.assign({}, prev, { leftW: clamp(prev.leftW + step, 200, 560) }));
              },
            })
          : null,

        h(
          'main',
          { className: 'gl-main' },
          h(
            'div',
            { className: 'gl-main-head' },
            h(
              'div',
              { className: 'gl-crumbs' },
              viewMode === 'overview'
                ? [
                    h('span', { key: 'o', className: 'gl-crumb gl-crumb-strong' }, '总览'),
                    h('span', { key: 's', className: 'gl-crumb-sep' }, '/'),
                    h('span', { key: 'a', className: 'gl-crumb' }, '所有项目动态'),
                  ]
                : viewMode === 'activity'
                ? activityProject
                  ? [
                      h('span', { key: 'p', className: 'gl-crumb', title: activityProject.pathWithNamespace }, activityProject.name),
                      h('span', { key: 's1', className: 'gl-crumb-sep' }, '/'),
                      h('span', { key: 'k', className: 'gl-crumb gl-crumb-strong' }, '活动'),
                    ]
                  : h('span', { className: 'gl-crumb' }, 'GitLab 项目')
                : selection && selectedProject
                  ? [
                      h('span', { key: 'p', className: 'gl-crumb', title: selectedProject.pathWithNamespace }, selectedProject.name),
                      h('span', { key: 's1', className: 'gl-crumb-sep' }, '/'),
                      h('span', { key: 'k', className: 'gl-crumb' }, selection.kind === 'branch' ? '分支' : 'Tag'),
                      h('span', { key: 's2', className: 'gl-crumb-sep' }, '/'),
                      h('span', { key: 'n', className: 'gl-crumb gl-crumb-strong', title: selection.name }, selection.name),
                    ]
                  : h('span', { className: 'gl-crumb' }, 'GitLab 项目'),
            ),
            h(
              'div',
              { className: 'gl-main-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'gl-icon-btn gl-bell-btn' + (notifyOpen ? ' gl-bell-open' : ''),
                  title: notify.enabled
                    ? notify.unread
                      ? '活动通知：' + notify.unread + ' 条未读'
                      : '活动通知'
                    : '活动通知已关闭',
                  'aria-label': '活动通知',
                  'aria-expanded': notifyOpen,
                  onClick: () => setNotifyOpen((prev) => !prev),
                },
                h(GlyphIcon, { name: 'bell', size: 16 }),
                notify.enabled && notify.unread
                  ? h('span', { className: 'gl-bell-badge' }, notify.unread > 99 ? '99+' : String(notify.unread))
                  : null,
              ),
              webLink
                ? h(
                    'a',
                    { className: 'gl-link-btn', href: webLink, target: '_blank', rel: 'noreferrer noopener' },
                    h(GlyphIcon, { name: 'external', size: 14 }),
                    '在 GitLab 打开',
                  )
                : null,
              h(IconAction, {
                icon: 'refresh',
                title:
                  viewMode === 'overview' ? '刷新总览' : viewMode === 'activity' ? '刷新活动' : '刷新提交',
                busy:
                  viewMode === 'overview'
                    ? overview.status === 'loading'
                    : viewMode === 'activity'
                      ? events.status === 'loading'
                      : commits.status === 'loading',
                disabled:
                  viewMode === 'overview' ? false : viewMode === 'activity' ? !activeProjectId : !selection,
                onClick: () => {
                  if (viewMode === 'overview') {
                    loadOverview(eventFilter, true, 1);
                  } else if (viewMode === 'activity') {
                    if (activeProjectId) loadEvents(activeProjectId, eventFilter, true);
                  } else if (selection) {
                    loadCommits(selection.projectId, selection.kind, selection.name, true);
                  }
                },
              }),
            ),
          ),
          h('div', { className: 'gl-body' }, renderMain()),
        ),

        notifyOpen
          ? [
              h('div', { key: 'gl-notify-mask', className: 'gl-notify-mask', onClick: () => setNotifyOpen(false) }),
              h(
                'div',
                { key: 'gl-notify', className: 'gl-notify', role: 'dialog', 'aria-label': '活动通知' },
                h(
                  'div',
                  { className: 'gl-notify-head' },
                  h('span', { className: 'gl-notify-title' }, '活动通知'),
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'switch',
                      'aria-checked': notify.enabled,
                      'aria-label': '接收活动通知',
                      className: 'gl-switch' + (notify.enabled ? ' gl-switch-on' : ''),
                      title: notify.enabled ? '关闭接收' : '开启接收',
                      onClick: toggleNotify,
                    },
                    h('span', { className: 'gl-switch-knob' }),
                  ),
                ),
                h(
                  'div',
                  { className: 'gl-notify-body' },
                  !notify.enabled
                    ? h('div', { className: 'gl-notify-empty' }, '通知已关闭，打开右上角开关才会继续接收。')
                    : notify.items.length === 0
                      ? h('div', { className: 'gl-notify-empty' }, '暂时没有新活动')
                      : notify.items.map((item) => renderBubble(item)),
                ),
                h(
                  'div',
                  { className: 'gl-notify-foot' },
                  h(
                    'span',
                    { className: 'gl-notify-count' },
                    notify.items.length
                      ? notify.unread + ' 条未读 / 共 ' + notify.items.length + ' 条'
                      : '暂无记录',
                  ),
                  h(
                    'button',
                    { className: 'gl-link', disabled: !notify.unread, onClick: markNotificationsRead },
                    '全部已读',
                  ),
                ),
              ),
            ]
          : null,

        dialog
          ? h(
              Modal,
              { title: '连接设置', onClose: () => setDialog(null) },
              h(
                'div',
                { className: 'gl-form-card', style: { border: 0, padding: 0, width: '100%' } },
                connection.baseUrl && connection.hasToken
                  ? h(
                      'p',
                      { className: 'gl-help' },
                      '当前已连接 ' + connection.baseUrl +
                        (connection.user ? '（@' + connection.user.username + '）' : '') +
                        '。留空令牌表示沿用已保存的令牌。',
                    )
                  : null,
                h(ConnectionForm, {
                  initialBaseUrl: dialog.baseUrl || connection.baseUrl,
                  hasToken: connection.hasToken,
                  autoFocus: true,
                  busy: connect.busy,
                  error: connect.error,
                  onSubmit: saveConnection,
                  onClear: () => saveConnection({ baseUrl: connection.baseUrl, clearToken: true }),
                }),
              ),
            )
          : null,
      );
    }

    function PanelButton(props) {
      // The sidebar owns the clickable button; this entry only renders the icon.
      const size = Number(props.size) || 18;
      const [unread, setUnread] = useState(notifyStore.unread);
      const [enabled, setEnabled] = useState(notifyStore.enabled);
      useEffect(() => {
        startNotifyPolling();
        return subscribeNotify(() => {
          setUnread(notifyStore.unread);
          setEnabled(notifyStore.enabled);
        });
      }, []);
      return h(
        'span',
        {
          title: unread ? unread + ' 条 GitLab 活动通知' : 'GitLab 项目工作台',
          'aria-hidden': true,
          style: {
            position: 'relative',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: size,
            height: size,
            color: 'currentColor',
          },
        },
        h(GlyphIcon, { name: 'branch', size }),
        enabled && unread ? h('span', { className: 'gl-panel-badge' }, unread > 99 ? '99+' : String(unread)) : null,
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'gitlab', order: 6, label: 'GitLab 项目工作台' },
              (props) => h(PanelButton, props),
            ),
          ),
        );
        ctx.effect(() =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'gitlab' }, (props) => h(Workbench, props)),
          ),
        );
      },
    };
  },
});
