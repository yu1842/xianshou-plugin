'use strict';

/**
 * 先手协议 · 控制台（DSH 客户端半边）
 *
 * 形态：单文件 CJS，只 require('react')。
 * 原因：DSH 的 client 半边是"惰性 CJS 模块表"，由 ModuleLoader 在首次 require 时执行；
 * 多文件相对 require 依赖宿主如何解析模块路径，单文件是唯一不依赖宿主打包器的写法。
 *
 * 注册的两个槽位：
 *   sidebar.panellist —— 侧边栏入口（多值槽位，按 order 排序）
 *   main              —— 整页面板（键控槽位，key 必须等于入口 id，否则 selectPanel 找不到目标）
 *
 * 数据来源按可用性探测，任意一个可用即可工作：
 *   1. ctx.xianshouFeed 服务（宿主半边未来可提供）
 *   2. ctx.on(...) 广播的 xianshou/* 事件
 *   3. window.__XIANSHOU_FEED__ 注入（预览挂具 / 集成测试）
 * 全都不可用时显示"数据源未连接"，不填充任何假数据。
 */

const React = require('react');

const h = React.createElement;

const PANEL_ID = 'xianshou';
const PLUGIN_TAG = 'dsh-plugin-xianshou';
const PACKAGE_VERSION = '0.2.2';

/** 权限点。宿主权限服务存在时按这两个 key 判定；不存在时按只读降级。 */
const PERMISSIONS = Object.freeze({ view: 'xianshou.view', operate: 'xianshou.operate' });

const MODULES = Object.freeze([
  { id: 'overview', label: '概览', icon: 'grid', hint: '红区任务、待回收与最需要处理的一项' },
  { id: 'tasks', label: '任务台账', icon: 'list', hint: '按分区与状态筛选全部任务' },
  { id: 'gate', label: '先手闸门', icon: 'shield', hint: '拦截模式与最近的拦截记录' },
  { id: 'ledger', label: '留痕账本', icon: 'split', hint: '[自] / [AI] / [改] 的比例与判定' },
  { id: 'recalls', label: '回收队列', icon: 'clock', hint: '24 小时与 7 天两次复述' },
  { id: 'refusal', label: '拒绝率', icon: 'scale', hint: '判断力是否在线' },
  { id: 'health', label: '健康度', icon: 'pulse', hint: '四个指标一起看' },
  { id: 'settings', label: '设置', icon: 'gear', hint: '主题、密度与数据源诊断' },
]);

const MODULE_IDS = MODULES.map((m) => m.id);

const ZONE_META = Object.freeze({
  red: { label: '红区', tone: 'danger', note: '必须先手' },
  yellow: { label: '黄区', tone: 'accent', note: '可先问，须能复述' },
  green: { label: '绿区', tone: 'success', note: '放开用' },
});

const STATUS_META = Object.freeze({
  open: { label: '进行中', tone: 'neutral' },
  delivered: { label: '已交付', tone: 'teal' },
  rework: { label: '需重做', tone: 'danger' },
});

const THRESHOLDS = Object.freeze({
  aiRatioRecall: 0.3,
  aiRatioRework: 0.6,
  recallPass: 0.8,
  refusalHealthyMin: 0.15,
  refusalHealthyMax: 0.4,
  refusalBlindBelow: 0.1,
  minSamples: 5,
});

const RECALL_QUESTIONS = Object.freeze([
  '这个结论的核心逻辑是什么？',
  '我最不确定的是哪一点？',
  '如果对方反问，我靠什么回答？',
]);

const FEED_EVENTS = Object.freeze([
  'xianshou/domain-event',
  'xianshou/notify',
  'xianshou/gate-bypassed',
  'xianshou/gate-denied',
  'xianshou/ready',
]);

// ─────────────────────────────────────────────────────────────
// 纯逻辑（不依赖 React，可直接单测）
// ─────────────────────────────────────────────────────────────

function pct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

/**
 * 容错读：客户端的 ctx 也是 Cordis 上下文，未 inject 的服务属性会抛异常。
 * 面板里任何"猜着读"的地方都必须经过它，否则一次异常就是白屏。
 */
function safeRead(target, key) {
  if (!target) return undefined;
  try {
    return target[key];
  } catch {
    return undefined;
  }
}

function safeCall(ctx, key, ...args) {
  const fn = safeRead(ctx, key);
  if (typeof fn !== 'function') return undefined;
  try {
    return fn.apply(ctx, args);
  } catch {
    return undefined;
  }
}

function parseQuery(raw) {
  const out = {};
  String(raw || '')
    .split('&')
    .filter(Boolean)
    .forEach((pair) => {
      const index = pair.indexOf('=');
      const key = index >= 0 ? pair.slice(0, index) : pair;
      const value = index >= 0 ? pair.slice(index + 1) : '';
      try {
        out[decodeURIComponent(key)] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    });
  return out;
}

function formatQuery(query) {
  const entries = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return '';
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`;
}

/**
 * 面板内路由。
 *
 * 为什么用 hash 而不是路径：DSH 的前端静态服务对未知路径返回 404（不做 history fallback），
 * 插件也没有注册服务端路由的公开接口。hash 不经过服务端，刷新与深链都成立。
 */
function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = String(pathPart || '').split('/').filter(Boolean);
  if (segments[0] !== PANEL_ID) return { module: 'overview', id: null, query: {} };
  const moduleId = MODULE_IDS.indexOf(segments[1]) >= 0 ? segments[1] : 'overview';
  let id = null;
  if (segments[2]) {
    try {
      id = decodeURIComponent(segments[2]);
    } catch {
      id = segments[2];
    }
  }
  return { module: moduleId, id, query: parseQuery(queryPart) };
}

function formatRoute(route) {
  const moduleId = MODULE_IDS.indexOf(route && route.module) >= 0 ? route.module : 'overview';
  const id = route && route.id ? `/${encodeURIComponent(route.id)}` : '';
  return `#${PANEL_ID}/${moduleId}${id}${formatQuery(route && route.query)}`;
}

/**
 * 权限探测：只认明确的权限服务。
 *
 * 这里刻意不泛化探测 `ctx.auth` / `ctx.get('access')` —— 任何带 `has()` 的对象
 * 都可能被误当成权限服务（比如 feature flag 注册表），一旦误判就会把入口静默关掉，
 * 而"入口消失"是最难排查的失败模式。宁可少一层管控，也要保证失败可见。
 */
function pickPermissionService(ctx) {
  if (!ctx) return null;
  const candidates = [safeCall(ctx, 'get', 'permissions'), safeRead(ctx, 'permissions')];
  for (const candidate of candidates) {
    if (candidate && typeof candidate.has === 'function') return candidate;
  }
  return null;
}

/**
 * 访问级别（四档，别混用）：
 *   hidden   完全不注册入口 —— 只有显式配置才能到这档
 *   locked   入口仍在，点开是一张"无权限"说明页，不渲染任何模块内容
 *   view     入口可见、面板可读、写操作禁用
 *   operate  全部可用
 *
 * 关键取舍：自动探测到"拒绝"时走 locked 而不是 hidden。
 * 入口消失会让用户以为插件没装上；入口还在但说明原因，才查得动。
 */
function resolveAccess(ctx, options) {
  const override = options && options.access;
  // deny 是 0.2.0 的旧写法，等价于 hidden，保留兼容
  const wantsHidden = override === 'hidden' || override === 'deny';

  const service = pickPermissionService(ctx);
  if (service) {
    let canView = false;
    let canOperate = false;
    try {
      canView = service.has(PERMISSIONS.view) === true;
      canOperate = service.has(PERMISSIONS.operate) === true;
    } catch {
      canView = false;
      canOperate = false;
    }
    if (!canView) {
      if (wantsHidden) return { level: 'hidden', source: 'override', reason: '部署配置隐藏了入口' };
      return {
        level: 'locked',
        source: 'host',
        reason: `宿主权限服务拒绝了 ${PERMISSIONS.view}。入口保留但内容锁定，请让管理员授予该权限点。`,
      };
    }
    return {
      level: canOperate ? 'operate' : 'view',
      source: 'host',
      reason: canOperate ? '已获得查看与操作权限' : `只读：缺少 ${PERMISSIONS.operate}`,
    };
  }

  if (wantsHidden) return { level: 'hidden', source: 'override', reason: '部署配置隐藏了入口' };
  if (override === 'view' || override === 'operate') {
    return { level: override, source: 'override', reason: '由部署配置指定访问级别' };
  }
  return {
    level: 'view',
    source: 'default',
    reason: `未检测到平台权限服务，按只读开放；写操作需要 ${PERMISSIONS.operate}`,
  };
}

function emptyFeed() {
  return { tasks: {}, order: [], notifications: [], denials: [], ready: null, events: 0, updatedAt: null };
}

function blankTask(id) {
  return {
    id,
    title: id,
    zone: 'yellow',
    status: 'open',
    hasDraft: false,
    aiRatio: 0,
    selfRatio: 0,
    segments: [],
    recalls: [],
    gates: [],
    refusals: { accepted: 0, rejected: 0, partial: 0 },
    updatedAt: null,
  };
}

function envelopeOf(input) {
  if (!input || typeof input !== 'object') return null;
  const type = input.type || input.event || null;
  const payload = input.payload || input.data || input.detail || {};
  if (!type) return null;
  return { type, payload };
}

/**
 * 事件归约：把 xianshou/* 事件折叠成面板需要的状态。
 * 纯函数、无副作用，便于用真实事件序列做断言。
 */
function reduceFeed(state, input) {
  const envelope = envelopeOf(input);
  if (!envelope) return state;
  const next = {
    tasks: { ...state.tasks },
    order: state.order.slice(),
    notifications: state.notifications.slice(-19),
    denials: state.denials.slice(-19),
    ready: state.ready,
    events: state.events + 1,
    updatedAt: envelope.payload && envelope.payload.at ? envelope.payload.at : state.updatedAt,
  };

  if (envelope.type === 'xianshou/ready') {
    next.ready = envelope.payload || {};
    return next;
  }
  if (envelope.type === 'xianshou/notify') {
    next.notifications.push(envelope.payload);
    return next;
  }
  if (envelope.type === 'xianshou/gate-bypassed' || envelope.type === 'xianshou/gate-denied') {
    next.denials.push({ kind: envelope.type, ...envelope.payload });
    return next;
  }
  if (envelope.type !== 'xianshou/domain-event') return next;

  const event = envelope.payload || {};
  const taskId = event.taskId;
  if (!taskId) return next;
  const task = { ...(next.tasks[taskId] || blankTask(taskId)) };
  if (!next.tasks[taskId]) next.order.unshift(taskId);

  switch (event.type) {
    case 'task.created':
      task.zone = event.zone || task.zone;
      task.status = 'open';
      if (event.title) task.title = event.title;
      break;
    case 'task.saved':
      if (event.zone) task.zone = event.zone;
      if (typeof event.hasDraft === 'boolean') task.hasDraft = event.hasDraft;
      if (event.status) task.status = event.status;
      if (event.title) task.title = event.title;
      break;
    case 'draft.accepted':
      task.hasDraft = true;
      task.draftChars = event.chars || 0;
      break;
    case 'segment.marked':
      task.aiRatio = typeof event.aiRatio === 'number' ? event.aiRatio : task.aiRatio;
      break;
    case 'task.delivered':
      task.status = 'delivered';
      task.gates = Array.isArray(event.gates) ? event.gates.slice() : task.gates;
      break;
    case 'recall.failed':
      task.status = 'rework';
      task.zone = 'yellow';
      task.recallScore = event.score;
      break;
    case 'refusal.recorded': {
      const decision = event.decision;
      task.refusals = { ...task.refusals };
      if (decision === 'accepted' || decision === 'rejected' || decision === 'partial') {
        task.refusals[decision] += 1;
      }
      break;
    }
    default:
      break;
  }

  next.tasks[taskId] = task;
  next.updatedAt = event.at || next.updatedAt;
  return next;
}

function taskList(state) {
  return state.order.map((id) => state.tasks[id]).filter(Boolean);
}

function refusalTally(tasks) {
  const tally = { accepted: 0, rejected: 0, partial: 0, total: 0, rate: null, band: 'insufficient' };
  tasks.forEach((task) => {
    tally.accepted += task.refusals.accepted;
    tally.rejected += task.refusals.rejected;
    tally.partial += task.refusals.partial;
  });
  tally.total = tally.accepted + tally.rejected + tally.partial;
  if (tally.total === 0) return tally;
  const rate = (tally.rejected + tally.partial * 0.5) / tally.total;
  tally.rate = Math.round(rate * 10000) / 10000;
  if (tally.total < THRESHOLDS.minSamples) tally.band = 'insufficient';
  else if (tally.rate < THRESHOLDS.refusalBlindBelow) tally.band = 'blind';
  else if (tally.rate < THRESHOLDS.refusalHealthyMin) tally.band = 'insufficient';
  else if (tally.rate <= THRESHOLDS.refusalHealthyMax) tally.band = 'healthy';
  else tally.band = 'contrarian';
  return tally;
}

function deriveOverview(tasks) {
  const zones = { red: 0, yellow: 0, green: 0 };
  let pendingRecalls = 0;
  let delivered = 0;
  let aiTotal = 0;
  let aiSamples = 0;
  tasks.forEach((task) => {
    if (zones[task.zone] !== undefined) zones[task.zone] += 1;
    if (task.status === 'delivered') delivered += 1;
    pendingRecalls += task.gates.filter((gate) => !task.recalls.some((r) => r.window === gate.window)).length;
    if (task.aiRatio > 0) {
      aiTotal += task.aiRatio;
      aiSamples += 1;
    }
  });
  return {
    total: tasks.length,
    zones,
    delivered,
    pendingRecalls,
    avgAiRatio: aiSamples === 0 ? null : Math.round((aiTotal / aiSamples) * 10000) / 10000,
    needsDraft: tasks.filter((task) => task.zone === 'red' && !task.hasDraft && task.status !== 'delivered').length,
  };
}

function filterTasks(tasks, criteria) {
  const query = String((criteria && criteria.q) || '').trim().toLowerCase();
  const zone = criteria && criteria.zone;
  const status = criteria && criteria.status;
  const sort = (criteria && criteria.sort) || 'updated';
  const filtered = tasks.filter((task) => {
    if (zone && zone !== 'all' && task.zone !== zone) return false;
    if (status && status !== 'all' && task.status !== status) return false;
    if (query && !`${task.title} ${task.id}`.toLowerCase().includes(query)) return false;
    return true;
  });
  if (sort === 'risk') {
    const weight = { red: 0, yellow: 1, green: 2 };
    filtered.sort((a, b) => (weight[a.zone] ?? 9) - (weight[b.zone] ?? 9));
  } else if (sort === 'title') {
    filtered.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'));
  }
  return filtered;
}

function aiBand(ratio) {
  if (typeof ratio !== 'number' || ratio <= 0) return { band: 'empty', tone: 'neutral', label: '未留痕' };
  if (ratio > THRESHOLDS.aiRatioRework) return { band: 'rework', tone: 'danger', label: '需重做' };
  if (ratio >= THRESHOLDS.aiRatioRecall) return { band: 'recall', tone: 'accent', label: '需回收' };
  return { band: 'healthy', tone: 'success', label: '正常' };
}

function createdAtLabel(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ─────────────────────────────────────────────────────────────
// 数据源
// ─────────────────────────────────────────────────────────────

/**
 * 建立数据源。返回 { getState, subscribe, source }，source 会直接显示在界面上 ——
 * 用户必须知道自己看到的是实时数据、注入数据，还是根本没有数据。
 */
function createFeed(ctx, options) {
  let state = emptyFeed();
  const listeners = new Set();
  const disposers = [];
  let source = 'none';

  const publish = (next) => {
    state = next;
    listeners.forEach((listener) => listener());
  };
  const ingest = (input) => publish(reduceFeed(state, input));

  if (options && options.initialEvents && options.initialEvents.length > 0) {
    options.initialEvents.forEach((event) => {
      state = reduceFeed(state, event);
    });
    source = 'injected';
  }

  const injected = typeof window !== 'undefined' ? window.__XIANSHOU_FEED__ : null;
  if (injected && Array.isArray(injected.events) && injected.events.length > 0) {
    injected.events.forEach((event) => {
      state = reduceFeed(state, event);
    });
    source = 'injected';
  }
  if (injected && typeof injected.push === 'function') {
    injected.push = (event) => ingest(event);
  }

  const feedService = safeRead(ctx, 'xianshouFeed');
  if (feedService && typeof feedService.subscribe === 'function') {
    try {
      const off = feedService.subscribe((event) => ingest(event));
      if (typeof off === 'function') disposers.push(off);
      source = 'service';
    } catch {
      /* 服务存在但签名不符：忽略，继续尝试下一种来源 */
    }
  }

  if (source === 'none' && typeof safeRead(ctx, 'on') === 'function') {
    FEED_EVENTS.forEach((type) => {
      const off = safeCall(ctx, 'on', type, (payload) => ingest({ type, payload }));
      if (typeof off === 'function') disposers.push(off);
    });
    source = 'broadcast';
  }

  if (source === 'none' && source !== 'injected' && state.events > 0) source = 'injected';

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get source() {
      return source;
    },
    dispose() {
      disposers.forEach((off) => {
        try {
          off();
        } catch {
          /* 卸载期间的失败不应中断清理 */
        }
      });
      listeners.clear();
    },
    ingest,
  };
}

// ─────────────────────────────────────────────────────────────
// 样式（只用宿主令牌，且每个令牌都带兜底值）
// ─────────────────────────────────────────────────────────────

const CSS = `
.xs-root{
  --xs-fg:var(--dsw-alias-text-primary,inherit);
  --xs-fg-soft:var(--dsw-alias-text-secondary,#3d4a5c);
  --xs-fg-faint:var(--dsw-alias-text-tertiary,#6b7889);
  --xs-surface:var(--dsw-alias-surface-primary,transparent);
  --xs-surface-2:var(--dsw-alias-surface-secondary,rgba(0,0,0,.03));
  --xs-line:var(--dsw-alias-border-primary,rgba(0,0,0,.12));
  --xs-accent:var(--dsw-alias-brand-primary,#b45309);
  --xs-danger:var(--dsw-alias-danger-primary,#b91c1c);
  --xs-success:var(--dsw-alias-success-primary,#166534);
  --xs-teal:var(--dsw-alias-info-primary,#0f766e);
  --xs-ring:var(--dsw-focus-ring-color,rgba(180,83,9,.55));
  --xs-radius:var(--dsw-radius-md,4px);
  --xs-radius-sm:var(--dsw-radius-sm,2px);
  --xs-gap:16px;
  display:flex;flex-direction:column;height:100%;min-height:0;
  color:var(--xs-fg);font-size:14px;line-height:1.6;
}
.xs-root[data-density="compact"]{--xs-gap:10px;font-size:13px}
.xs-root :focus-visible{outline:2px solid var(--xs-ring);outline-offset:2px;border-radius:var(--xs-radius-sm)}
.xs-header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between;
  padding:18px 22px 12px;border-bottom:1px solid var(--xs-line)}
.xs-title{margin:0;font-size:17px;font-weight:650;letter-spacing:.01em}
.xs-subtitle{margin:4px 0 0;font-size:12.5px;color:var(--xs-fg-faint)}
.xs-header-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.xs-body{display:grid;grid-template-columns:190px minmax(0,1fr);min-height:0;flex:1}
.xs-nav{display:flex;flex-direction:column;gap:2px;padding:12px 10px;border-right:1px solid var(--xs-line);overflow:auto}
.xs-nav-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:0;border-radius:var(--xs-radius);
  background:transparent;color:var(--xs-fg-soft);font:inherit;text-align:left;cursor:pointer}
.xs-nav-item:hover{background:var(--xs-surface-2);color:var(--xs-fg)}
.xs-nav-item[aria-current="page"]{background:var(--xs-surface-2);color:var(--xs-fg);font-weight:600;
  box-shadow:inset 2px 0 0 var(--xs-accent)}
.xs-nav-count{margin-left:auto;font-size:11px;color:var(--xs-fg-faint);font-variant-numeric:tabular-nums}
.xs-main{min-width:0;overflow:auto;padding:18px 22px 40px}
.xs-section{margin-bottom:calc(var(--xs-gap) * 1.2)}
.xs-section-head{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;justify-content:space-between;margin-bottom:10px}
.xs-section-title{margin:0;font-size:14px;font-weight:650}
.xs-section-hint{margin:0;font-size:12px;color:var(--xs-fg-faint)}
.xs-cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.xs-card{border:1px solid var(--xs-line);border-radius:var(--xs-radius);padding:14px 16px;background:var(--xs-surface)}
.xs-card-label{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--xs-fg-faint)}
.xs-card-value{font-size:24px;font-weight:650;margin-top:6px;font-variant-numeric:tabular-nums}
.xs-card-note{font-size:12px;color:var(--xs-fg-faint);margin-top:4px}
.xs-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;
  font-size:11.5px;font-weight:600;border:1px solid currentColor;background:transparent}
.xs-badge[data-tone="danger"]{color:var(--xs-danger)}
.xs-badge[data-tone="accent"]{color:var(--xs-accent)}
.xs-badge[data-tone="success"]{color:var(--xs-success)}
.xs-badge[data-tone="teal"]{color:var(--xs-teal)}
.xs-badge[data-tone="neutral"]{color:var(--xs-fg-soft)}
.xs-meter{height:8px;border-radius:999px;background:var(--xs-surface-2);overflow:hidden;margin-top:8px}
.xs-meter-fill{height:100%;border-radius:999px;background:currentColor}
.xs-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.xs-input{flex:1 1 180px;min-width:120px;padding:7px 10px;border:1px solid var(--xs-line);border-radius:var(--xs-radius);
  background:var(--xs-surface);color:var(--xs-fg);font:inherit}
.xs-chip{padding:4px 10px;border:1px solid var(--xs-line);border-radius:999px;background:transparent;
  color:var(--xs-fg-soft);font:inherit;font-size:12.5px;cursor:pointer}
.xs-chip[aria-pressed="true"]{border-color:var(--xs-accent);color:var(--xs-accent);font-weight:600}
.xs-btn{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:var(--xs-radius);
  border:1px solid var(--xs-line);background:var(--xs-surface);color:var(--xs-fg);font:inherit;font-size:13px;cursor:pointer}
.xs-btn:hover:not([disabled]){border-color:var(--xs-accent);color:var(--xs-accent)}
.xs-btn[data-variant="primary"]{background:var(--xs-accent);border-color:var(--xs-accent);color:#fff}
.xs-btn[data-variant="primary"]:hover:not([disabled]){opacity:.9;color:#fff}
.xs-btn[disabled]{opacity:.45;cursor:not-allowed}
.xs-list{display:flex;flex-direction:column;border:1px solid var(--xs-line);border-radius:var(--xs-radius);overflow:hidden}
.xs-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;
  padding:11px 14px;border-bottom:1px solid var(--xs-line);background:transparent;border-left:0;border-right:0;border-top:0;
  width:100%;text-align:left;font:inherit;color:var(--xs-fg);cursor:pointer}
.xs-row:last-child{border-bottom:0}
.xs-row:hover{background:var(--xs-surface-2)}
.xs-row[aria-selected="true"]{background:var(--xs-surface-2);box-shadow:inset 3px 0 0 var(--xs-accent)}
.xs-row-title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xs-row-meta{font-size:12px;color:var(--xs-fg-faint);margin-top:2px}
.xs-row-right{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--xs-fg-soft)}
.xs-detail{border:1px solid var(--xs-line);border-radius:var(--xs-radius);padding:14px 16px;margin-top:12px}
.xs-kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:13px}
.xs-kv dt{color:var(--xs-fg-faint)}
.xs-kv dd{margin:0}
.xs-empty{border:1px dashed var(--xs-line);border-radius:var(--xs-radius);padding:28px 22px;text-align:center;color:var(--xs-fg-soft)}
.xs-empty-title{font-weight:600;margin:0 0 6px}
.xs-empty-body{margin:0;font-size:13px;color:var(--xs-fg-faint);line-height:1.7}
.xs-note{border-left:3px solid var(--xs-accent);padding:10px 14px;background:var(--xs-surface-2);font-size:13px}
.xs-note[data-tone="danger"]{border-left-color:var(--xs-danger)}
.xs-note[data-tone="teal"]{border-left-color:var(--xs-teal)}
.xs-table{width:100%;border-collapse:collapse;font-size:13px}
.xs-table th{text-align:left;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--xs-fg-faint);padding:8px 10px;border-bottom:1px solid var(--xs-line);font-weight:600}
.xs-table td{padding:9px 10px;border-bottom:1px solid var(--xs-line);vertical-align:top}
.xs-table tr:last-child td{border-bottom:0}
.xs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.xs-grid-2{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.xs-stack{display:flex;flex-direction:column;gap:8px}
.xs-inline{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.xs-field{display:flex;flex-direction:column;gap:4px;font-size:13px}
.xs-field select,.xs-field input{padding:6px 9px;border:1px solid var(--xs-line);border-radius:var(--xs-radius);
  background:var(--xs-surface);color:var(--xs-fg);font:inherit}
.xs-toast{position:sticky;bottom:0;margin-top:16px;padding:10px 14px;border-radius:var(--xs-radius);
  background:var(--xs-surface-2);border:1px solid var(--xs-line);font-size:13px}
.xs-foot{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 22px;border-top:1px solid var(--xs-line);
  font-size:12px;color:var(--xs-fg-faint)}
.xs-dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.xs-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@media (max-width:900px){
  .xs-body{grid-template-columns:1fr}
  .xs-nav{flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--xs-line);padding:8px 12px}
  .xs-nav-item{width:auto;white-space:nowrap}
  .xs-nav-item[aria-current="page"]{box-shadow:inset 0 -2px 0 var(--xs-accent)}
  .xs-nav-count{display:none}
  .xs-header{padding:14px 16px 10px}
  .xs-main{padding:14px 16px 32px}
}
@media (max-width:560px){
  .xs-cards{grid-template-columns:1fr 1fr}
  .xs-card-value{font-size:20px}
  .xs-row{grid-template-columns:minmax(0,1fr)}
  .xs-row-right{justify-content:flex-start}
}
@media (prefers-reduced-motion:reduce){
  .xs-root *{transition:none !important;animation:none !important}
}
`;

let styleInjected = false;
function ensureStyles() {
  if (styleInjected || typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin="${PLUGIN_TAG}"]`)) {
    styleInjected = true;
    return;
  }
  const element = document.createElement('style');
  // data-plugin 让宿主的"无主样式清扫"不会回收它
  element.setAttribute('data-plugin', PLUGIN_TAG);
  element.textContent = CSS;
  document.head.appendChild(element);
  styleInjected = true;
}

// ─────────────────────────────────────────────────────────────
// 基础组件
// ─────────────────────────────────────────────────────────────

function Icon({ name, size }) {
  const common = {
    width: size || 16,
    height: size || 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  const paths = {
    grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
    list: ['M8 6h12', 'M8 12h12', 'M8 18h12', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
    shield: ['M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z', 'M9 12l2 2 4-4'],
    split: ['M12 3v18', 'M5 7h4l3 5', 'M19 7h-4l-3 5'],
    clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
    scale: ['M12 4v16', 'M6 8h12', 'M6 8l-3 7h6z', 'M18 8l-3 7h6z'],
    pulse: ['M3 12h4l2-5 4 10 2-5h6'],
    gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-4l-.4 2.1a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L6 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.1h4l.4-2.1a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z'],
  };
  return h('svg', common, (paths[name] || []).map((d, index) => h('path', { key: index, d })));
}

/** 侧边栏入口图标：闸门的门框 + 一支穿过去的箭头。 */
function SidebarIcon() {
  return h(
    'svg',
    {
      width: 20,
      height: 20,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.6,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('path', { d: 'M5 20V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v14' }),
    h('path', { d: 'M3 20h18' }),
    h('path', { d: 'M10 11h4' }),
    h('path', { d: 'M13 8.5 15.5 11 13 13.5' }),
  );
}

function Badge({ tone, children }) {
  return h('span', { className: 'xs-badge', 'data-tone': tone || 'neutral' }, children);
}

function Meter({ value, tone }) {
  const safe = Math.min(1, Math.max(0, typeof value === 'number' ? value : 0));
  return h(
    'div',
    { className: 'xs-meter', role: 'img', 'aria-label': `占比 ${Math.round(safe * 100)}%` },
    h('div', { className: 'xs-meter-fill', style: { width: `${Math.round(safe * 100)}%`, color: `var(--xs-${tone || 'accent'})` } }),
  );
}

function Section({ title, hint, children, actions }) {
  return h(
    'section',
    { className: 'xs-section' },
    h(
      'div',
      { className: 'xs-section-head' },
      h('div', null, h('h3', { className: 'xs-section-title' }, title), hint ? h('p', { className: 'xs-section-hint' }, hint) : null),
      actions || null,
    ),
    children,
  );
}

function Empty({ title, body }) {
  return h('div', { className: 'xs-empty' }, h('p', { className: 'xs-empty-title' }, title), h('p', { className: 'xs-empty-body' }, body));
}

function Note({ tone, children }) {
  return h('div', { className: 'xs-note', 'data-tone': tone || 'accent' }, children);
}

function Card({ label, value, note }) {
  return h(
    'div',
    { className: 'xs-card' },
    h('div', { className: 'xs-card-label' }, label),
    h('div', { className: 'xs-card-value' }, value),
    note ? h('div', { className: 'xs-card-note' }, note) : null,
  );
}

// ─────────────────────────────────────────────────────────────
// 视图
// ─────────────────────────────────────────────────────────────

function OverviewView({ state, tasks, onNavigate }) {
  const stats = deriveOverview(tasks);
  const tally = refusalTally(tasks);
  return h(
    'div',
    null,
    h(Section, { title: '今天的账', hint: '数字来自本会话事件流，未连接数据源时不会编造' },
      h(
        'div',
        { className: 'xs-cards' },
        h(Card, { label: '红区任务', value: stats.zones.red, note: `其中 ${stats.needsDraft} 个还没落稿` }),
        h(Card, { label: '待回收', value: stats.pendingRecalls, note: '24 小时 / 7 天窗口' }),
        h(Card, { label: '平均 [AI] 占比', value: stats.avgAiRatio === null ? '—' : pct(stats.avgAiRatio), note: aiBand(stats.avgAiRatio).label }),
        h(Card, { label: '拒绝率', value: tally.rate === null ? '—' : pct(tally.rate), note: `样本 ${tally.total}` }),
      ),
    ),
    stats.needsDraft > 0
      ? h(
          Section,
          { title: '最需要处理的一项' },
          h(Note, null, `有 ${stats.needsDraft} 个红区任务还没有先手稿。闸门会拦住这些任务上的写入调用 —— 先花 20 分钟写个丑版本，再让 AI 介入。`),
          h('div', { style: { marginTop: 10 } },
            h('button', { type: 'button', className: 'xs-btn', onClick: () => onNavigate('tasks', null, { zone: 'red' }) }, '去任务台账看')),
        )
      : null,
    h(
      Section,
      { title: '按分区' },
      h(
        'div',
        { className: 'xs-cards' },
        ['red', 'yellow', 'green'].map((zone) =>
          h(
            'div',
            { className: 'xs-card', key: zone },
            h('div', { className: 'xs-card-label' }, ZONE_META[zone].label),
            h('div', { className: 'xs-card-value' }, stats.zones[zone]),
            h('div', { className: 'xs-card-note' }, ZONE_META[zone].note),
          ),
        ),
      ),
    ),
  );
}

function TasksView({ state, tasks, route, access, onNavigate }) {
  const criteria = {
    q: route.query.q || '',
    zone: route.query.zone || 'all',
    status: route.query.status || 'all',
    sort: route.query.sort || 'updated',
  };
  const visible = filterTasks(tasks, criteria);
  const selected = route.id ? state.tasks[route.id] : null;
  const update = (patch) => onNavigate('tasks', route.id, { ...criteria, ...patch });

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'xs-toolbar' },
      h('input', {
        className: 'xs-input',
        type: 'search',
        value: criteria.q,
        placeholder: '搜索任务标题或 ID',
        'aria-label': '搜索任务',
        onChange: (event) => update({ q: event.target.value }),
      }),
      h(
        'div',
        { className: 'xs-inline' },
        ['all', 'red', 'yellow', 'green'].map((zone) =>
          h(
            'button',
            {
              key: zone,
              type: 'button',
              className: 'xs-chip',
              'aria-pressed': criteria.zone === zone,
              onClick: () => update({ zone }),
            },
            zone === 'all' ? '全部' : ZONE_META[zone].label,
          ),
        ),
      ),
      h(
        'select',
        {
          className: 'xs-input',
          style: { flex: '0 0 auto', width: 'auto' },
          value: criteria.sort,
          'aria-label': '排序方式',
          onChange: (event) => update({ sort: event.target.value }),
        },
        h('option', { value: 'updated' }, '最近更新'),
        h('option', { value: 'risk' }, '风险优先'),
        h('option', { value: 'title' }, '标题'),
      ),
    ),
    visible.length === 0
      ? h(Empty, { title: '没有匹配的任务', body: '换个筛选条件，或在会话里用 xianshou_start 建档。归档、绿区任务不会占用这里的注意力。' })
      : h(
          'div',
          { className: 'xs-list', role: 'list' },
          visible.map((task) =>
            h(
              'button',
              {
                key: task.id,
                type: 'button',
                className: 'xs-row',
                role: 'listitem',
                'aria-selected': route.id === task.id,
                onClick: () => onNavigate('tasks', route.id === task.id ? null : task.id, criteria),
              },
              h(
                'div',
                { style: { minWidth: 0 } },
                h('div', { className: 'xs-row-title' }, task.title),
                h('div', { className: 'xs-row-meta' }, `${task.id} · ${STATUS_META[task.status] ? STATUS_META[task.status].label : task.status}`),
              ),
              h(
                'div',
                { className: 'xs-row-right' },
                h(Badge, { tone: ZONE_META[task.zone] ? ZONE_META[task.zone].tone : 'neutral' }, ZONE_META[task.zone] ? ZONE_META[task.zone].label : task.zone),
                h('span', null, task.aiRatio > 0 ? pct(task.aiRatio) : '未留痕'),
              ),
            ),
          ),
        ),
    selected
      ? h(
          'div',
          { className: 'xs-detail' },
          h('h3', { className: 'xs-section-title', style: { marginBottom: 10 } }, selected.title),
          h(
            'dl',
            { className: 'xs-kv' },
            h('dt', null, '任务 ID'), h('dd', { className: 'xs-mono' }, selected.id),
            h('dt', null, '分区'), h('dd', null, `${ZONE_META[selected.zone].label} · ${ZONE_META[selected.zone].note}`),
            h('dt', null, '状态'), h('dd', null, STATUS_META[selected.status] ? STATUS_META[selected.status].label : selected.status),
            h('dt', null, '先手稿'), h('dd', null, selected.hasDraft ? `已落稿${selected.draftChars ? ` · ${selected.draftChars} 字` : ''}` : '未落稿'),
            h('dt', null, '[AI] 占比'), h('dd', null, selected.aiRatio > 0 ? pct(selected.aiRatio) : '未留痕'),
            h('dt', null, '回收窗口'), h('dd', null, selected.gates.length === 0 ? '未生成' : selected.gates.map((g) => (g.window === 'd24h' ? '24 小时' : '7 天')).join(' / ')),
            h('dt', null, '更新时间'), h('dd', null, createdAtLabel(selected.updatedAt)),
          ),
          h(
            'div',
            { className: 'xs-inline', style: { marginTop: 12 } },
            h('button', { type: 'button', className: 'xs-btn', onClick: () => onNavigate('ledger', selected.id, {}) }, '看留痕'),
            h('button', { type: 'button', className: 'xs-btn', onClick: () => onNavigate('recalls', selected.id, {}) }, '看回收'),
            access.level === 'operate'
              ? h('button', { type: 'button', className: 'xs-btn', 'data-variant': 'primary', onClick: () => onNavigate('gate', selected.id, {}) }, '检查闸门')
              : h('button', { type: 'button', className: 'xs-btn', disabled: true, title: access.reason }, '检查闸门'),
          ),
        )
      : null,
  );
}

function GateView({ state, tasks, access }) {
  const denials = state.denials.slice().reverse();
  const blocked = tasks.filter((task) => task.zone === 'red' && !task.hasDraft && task.status !== 'delivered');
  return h(
    'div',
    null,
    h(
      Section,
      { title: '拦截模式', hint: '模式由宿主侧配置决定，此处只读展示' },
      h(
        'div',
        { className: 'xs-cards' },
        [
          { id: 'advisory', label: 'advisory', note: '只记录不拦，让跳过可见' },
          { id: 'ask', label: 'ask（默认）', note: '走宿主审批，可临时放行' },
          { id: 'deny', label: 'deny', note: '直接拒绝 + 单调守卫' },
        ].map((mode) =>
          h(
            'div',
            { className: 'xs-card', key: mode.id },
            h('div', { className: 'xs-card-label' }, mode.label),
            h('div', { className: 'xs-card-note', style: { marginTop: 8 } }, mode.note),
          ),
        ),
      ),
    ),
    h(
      Section,
      { title: '当前会被拦下的任务', hint: '红区、未落稿、未交付' },
      blocked.length === 0
        ? h(Empty, { title: '闸门当前没有待办', body: '没有欠稿的红区任务。绿区与黄区任务本来就不拦 —— 这是设计，不是漏判。' })
        : h(
            'div',
            { className: 'xs-list' },
            blocked.map((task) =>
              h(
                'div',
                { className: 'xs-row', key: task.id, role: 'listitem' },
                h('div', { style: { minWidth: 0 } }, h('div', { className: 'xs-row-title' }, task.title), h('div', { className: 'xs-row-meta' }, task.id)),
                h('div', { className: 'xs-row-right' }, h(Badge, { tone: 'danger' }, '缺先手稿')),
              ),
            ),
          ),
    ),
    h(
      Section,
      { title: '最近的拦截记录', hint: '来自 xianshou/gate-* 事件' },
      denials.length === 0
        ? h(Empty, { title: '还没有拦截记录', body: '被拦时会记在这里。advisory 模式下记录的是"放行但记账"，同样会显示。' })
        : h(
            'table',
            { className: 'xs-table' },
            h('thead', null, h('tr', null, h('th', null, '类型'), h('th', null, '任务'), h('th', null, '工具'))),
            h(
              'tbody',
              null,
              denials.map((item, index) =>
                h(
                  'tr',
                  { key: index },
                  h('td', null, item.kind === 'xianshou/gate-denied' ? '已拒绝' : '放行并记账'),
                  h('td', { className: 'xs-mono' }, item.taskId || '—'),
                  h('td', { className: 'xs-mono' }, item.tool || '—'),
                ),
              ),
            ),
          ),
    ),
    access.level !== 'operate'
      ? h(Note, { tone: 'danger' }, `当前为${access.level === 'view' ? '只读' : '受限'}访问：${access.reason}。修改闸门模式需要在 profile 配置中调整，界面不提供写入入口。`)
      : h(Note, { tone: 'teal' }, '闸门模式请在 profile patch 里修改（gate.mode）；界面只读展示，避免两处配置打架。'),
  );
}

function LedgerView({ state, tasks, route, onNavigate }) {
  const selected = route.id ? state.tasks[route.id] : tasks[0];
  if (!selected) return h(Empty, { title: '还没有可核对的账本', body: '任务产生留痕后，这里会显示 [自] / [AI] / [改] 的比例与判定。' });
  const band = aiBand(selected.aiRatio);
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'xs-toolbar' },
      h(
        'select',
        {
          className: 'xs-input',
          style: { flex: '0 0 auto', width: 'auto' },
          value: selected.id,
          'aria-label': '选择任务',
          onChange: (event) => onNavigate('ledger', event.target.value, {}),
        },
        tasks.map((task) => h('option', { key: task.id, value: task.id }, `${task.title}（${task.id}）`)),
      ),
    ),
    h(
      Section,
      { title: '来源比例', hint: '按权重计算，默认权重取字符数' },
      h(
        'div',
        { className: 'xs-card' },
        h('div', { className: 'xs-inline', style: { justifyContent: 'space-between' } },
          h('span', { className: 'xs-card-label' }, '[AI] 占比'),
          h(Badge, { tone: band.tone }, band.label),
        ),
        h('div', { className: 'xs-card-value' }, selected.aiRatio > 0 ? pct(selected.aiRatio) : '未留痕'),
        h(Meter, { value: selected.aiRatio, tone: band.tone }),
        h('div', { className: 'xs-card-note' },
          band.band === 'rework' ? '超过 60%：你交了一份自己没参与建造的东西，应打回重做先手。'
            : band.band === 'recall' ? '30%–60%：结构可能是 AI 给的，先做一次回收测试再交付。'
            : band.band === 'healthy' ? '低于 30%：你在主导，AI 在辅助。'
            : '还没有标记任何段落，先标记再谈比例。'),
      ),
    ),
    h(
      Section,
      { title: '判定阈值' },
      h(
        'table',
        { className: 'xs-table' },
        h('thead', null, h('tr', null, h('th', null, '[AI] 占比'), h('th', null, '含义'), h('th', null, '建议动作'))),
        h(
          'tbody',
          null,
          h('tr', null, h('td', null, '< 30%'), h('td', null, '你在主导'), h('td', null, '保持')),
          h('tr', null, h('td', null, '30%–60%'), h('td', null, '只做了填充'), h('td', null, '做一次回收')),
          h('tr', null, h('td', null, '> 60%'), h('td', null, '没参与建造'), h('td', null, '打回红区重做')),
        ),
      ),
    ),
  );
}

function RecallsView({ state, tasks, route, access, onNavigate, notify }) {
  const withGates = tasks.filter((task) => task.gates.length > 0);
  const selected = route.id ? state.tasks[route.id] : withGates[0];
  const [draft, setDraft] = React.useState({ answers: ['', '', ''], scores: [1, 1, 1] });
  React.useEffect(() => {
    setDraft({ answers: ['', '', ''], scores: [1, 1, 1] });
  }, [selected ? selected.id : null]);

  if (!selected) {
    return h(Empty, {
      title: '回收队列是空的',
      body: '任务交付后才会生成 24 小时与 7 天两个回收窗口。答不出来即打回 —— 这是整套机制里唯一无法伪造的动作。',
    });
  }
  const answered = new Set(selected.recalls.map((r) => r.window));
  const pending = selected.gates.filter((gate) => !answered.has(gate.window));

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'xs-toolbar' },
      h(
        'select',
        {
          className: 'xs-input',
          style: { flex: '0 0 auto', width: 'auto' },
          value: selected.id,
          'aria-label': '选择任务',
          onChange: (event) => onNavigate('recalls', event.target.value, {}),
        },
        withGates.map((task) => h('option', { key: task.id, value: task.id }, `${task.title}（${task.id}）`)),
      ),
      h(Badge, { tone: pending.length > 0 ? 'accent' : 'success' }, pending.length > 0 ? `${pending.length} 个待答` : '全部已答'),
    ),
    h(
      Section,
      { title: '待回收窗口', hint: '合上材料再答，答不出来就是没学会' },
      pending.length === 0
        ? h(Empty, { title: '这个任务的回收都做完了', body: '同一窗口不能重答 —— 允许重答就等于允许刷分。' })
        : h(
            'div',
            { className: 'xs-list' },
            pending.map((gate) =>
              h(
                'div',
                { className: 'xs-row', key: gate.window, style: { cursor: 'default' } },
                h('div', null, h('div', { className: 'xs-row-title' }, gate.window === 'd24h' ? '24 小时回收' : '7 天回收'), h('div', { className: 'xs-row-meta' }, `到期 ${createdAtLabel(gate.scheduledFor)}`)),
                h('div', { className: 'xs-row-right' }, h(Badge, { tone: 'teal' }, '待答')),
              ),
            ),
          ),
    ),
    h(
      Section,
      { title: '三个问题', hint: '口头或写下均可；插件只记录，不替你判断真假' },
      h(
        'div',
        { className: 'xs-stack' },
        RECALL_QUESTIONS.map((question, index) =>
          h(
            'div',
            { className: 'xs-field', key: index },
            h('label', { htmlFor: `xs-q-${index}` }, `${index + 1}. ${question}`),
            h('textarea', {
              id: `xs-q-${index}`,
              className: 'xs-input',
              rows: 2,
              value: draft.answers[index],
              placeholder: '用一句完整的话回答',
              onChange: (event) => {
                const answers = draft.answers.slice();
                answers[index] = event.target.value;
                setDraft({ ...draft, answers });
              },
            }),
            h(
              'div',
              { className: 'xs-inline' },
              h('span', { style: { fontSize: 12, color: 'var(--xs-fg-faint)' } }, '自评：'),
              [0, 1, 2].map((score) =>
                h(
                  'button',
                  {
                    key: score,
                    type: 'button',
                    className: 'xs-chip',
                    'aria-pressed': draft.scores[index] === score,
                    onClick: () => {
                      const scores = draft.scores.slice();
                      scores[index] = score;
                      setDraft({ ...draft, scores });
                    },
                  },
                  score === 0 ? '讲不出' : score === 1 ? '卡壳' : '讲得清',
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'xs-inline', style: { marginTop: 12 } },
        h(
          'button',
          {
            type: 'button',
            className: 'xs-btn',
            'data-variant': 'primary',
            disabled: access.level !== 'operate',
            title: access.level === 'operate' ? '在会话里提交这次回收' : access.reason,
            onClick: () => {
              const filled = draft.answers.filter((a) => a.trim().length > 0).length;
              if (filled < 3) {
                notify('三题都要写一句完整的话，缺一题无法判定。');
                return;
              }
              notify('已暂存。正式提交请在会话里调用 xianshou_recall，避免界面与账本两处写入。');
            },
          },
          '暂存这次回收',
        ),
        h('span', { style: { fontSize: 12, color: 'var(--xs-fg-faint)' } },
          access.level === 'operate' ? '界面只做暂存；写账本仍走会话工具，保证只有一条写入路径。' : access.reason),
      ),
    ),
  );
}

function RefusalView({ tasks, access, notify }) {
  const tally = refusalTally(tasks);
  const bandTone = tally.band === 'blind' ? 'danger' : tally.band === 'healthy' ? 'success' : tally.band === 'contrarian' ? 'accent' : 'neutral';
  const headline =
    tally.rate === null ? '还没有样本'
      : tally.band === 'insufficient' ? `样本不足（${tally.total} 条），暂不判定`
      : tally.band === 'blind' ? '你可能在盲从'
      : tally.band === 'healthy' ? '判断力在线'
      : '你在为反对而反对';

  return h(
    'div',
    null,
    h(
      Section,
      { title: '实质否决率', hint: '（否决 + 0.5 × 部分修改）/ 总数' },
      tally.rate === null
        ? h(Empty, { title: '还没有记录过采纳或否决', body: '每次你明确否定或改写了一条 AI 建议，都值得记一次。这是唯一能反映判断力是否在线的指标。' })
        : h(
            'div',
            { className: 'xs-card' },
            h('div', { className: 'xs-inline', style: { justifyContent: 'space-between' } },
              h('span', { className: 'xs-card-label' }, '当前拒绝率'),
              h(Badge, { tone: bandTone }, headline),
            ),
            h('div', { className: 'xs-card-value' }, tally.rate === null ? '—' : pct(tally.rate)),
            tally.band === 'insufficient' ? null : h(Meter, { value: tally.rate, tone: bandTone }),
            h('div', { className: 'xs-card-note' }, `样本 ${tally.total} · 健康区间 15%–40%`),
          ),
    ),
    h(
      Section,
      { title: '计数' },
      h(
        'table',
        { className: 'xs-table' },
        h('thead', null, h('tr', null, h('th', null, '直接采纳'), h('th', null, '实质否决'), h('th', null, '部分修改'))),
        h('tbody', null, h('tr', null, h('td', null, tally.accepted), h('td', null, tally.rejected), h('td', null, `${tally.partial}（按半权计）`))),
      ),
    ),
    h(
      Section,
      { title: '为什么这个指标值得看' },
      h(Note, null, '82% 的人对 AI 输出有信心，同一批人里 68% 经常发现它出错。一个从不拒绝 AI 建议的人，几乎不可能是判断正确的那一个 —— 他只是在没看的情况下点了同意。'),
    ),
    h(
      'div',
      { className: 'xs-inline' },
      h(
        'button',
        {
          type: 'button',
          className: 'xs-btn',
          disabled: access.level !== 'operate',
          title: access.level === 'operate' ? undefined : access.reason,
          onClick: () => notify('记录否决请走会话工具 xianshou_refusal，确保账本只有一条写入路径。'),
        },
        '记录一次否决',
      ),
      h('span', { style: { fontSize: 12, color: 'var(--xs-fg-faint)' } }, '界面不直接写账本，避免与工具写入冲突。'),
    ),
  );
}

function HealthView({ tasks }) {
  const stats = deriveOverview(tasks);
  const tally = refusalTally(tasks);
  const metrics = [
    { key: 'recall', label: '无提示复述准确率', value: null, target: '≥ 80%', note: '样本来自回收记录；界面不推算，只展示已有值。' },
    { key: 'autonomy', label: '首版自主率', value: null, target: '≥ 50%', note: 'AI 介入前已成型的部分占交付物多少。' },
    { key: 'refusal', label: '拒绝率', value: tally.rate, target: '15%–40%', note: '判断力是否在线。' },
    { key: 'migration', label: '跨任务迁移率', value: null, target: '逐月上升', note: '复用既有框架而非每次从零问 AI。' },
  ];
  return h(
    'div',
    null,
    h(Section, { title: `健康度（${stats.total} 个任务）`, hint: '四个指标一起看；任何一个单独看都会被伪装' },
      h('div', { className: 'xs-grid-2' },
        metrics.map((metric) =>
          h('div', { className: 'xs-card', key: metric.key },
            h('div', { className: 'xs-card-label' }, metric.label),
            h('div', { className: 'xs-card-value' }, metric.value === null ? '样本不足' : pct(metric.value)),
            h('div', { className: 'xs-card-note' }, `目标 ${metric.target}`),
            h('div', { className: 'xs-card-note' }, metric.note),
          ),
        ),
      ),
    ),
    h(Note, { tone: 'teal' }, '这里刻意不给总分。总分会被优化，四个分开的指标不会。'),
  );
}

function SettingsView({ access, feed, route, onNavigate, theme, density, onTheme, onDensity, notify }) {
  const diagnostics = [
    ['插件版本', PACKAGE_VERSION],
    ['访问级别', `${access.level}（${access.source}）`],
    ['权限说明', access.reason],
    ['数据源', feed.source === 'none' ? '未连接' : feed.source],
    ['已接收事件', String(feed.getState().events)],
    ['当前路由', formatRoute(route)],
    ['模块数量', String(MODULES.length)],
  ];
  return h(
    'div',
    null,
    h(
      Section,
      { title: '外观' },
      h(
        'div',
        { className: 'xs-grid-2' },
        h('label', { className: 'xs-field' },
          '主题',
          h('select', { value: theme, onChange: (event) => onTheme(event.target.value) },
            h('option', { value: 'auto' }, '跟随宿主'),
            h('option', { value: 'light' }, '浅色'),
            h('option', { value: 'dark' }, '深色'),
          ),
        ),
        h('label', { className: 'xs-field' },
          '密度',
          h('select', { value: density, onChange: (event) => onDensity(event.target.value) },
            h('option', { value: 'cozy' }, '宽松'),
            h('option', { value: 'compact' }, '紧凑'),
          ),
        ),
      ),
    ),
    h(
      Section,
      { title: '诊断', hint: '反馈问题时把这组信息一起贴上' },
      h(
        'dl',
        { className: 'xs-kv' },
        diagnostics.map(([key, value]) => [h('dt', { key: `${key}-k` }, key), h('dd', { key: `${key}-v`, className: 'xs-mono' }, value)]),
      ),
      h(
        'div',
        { className: 'xs-inline', style: { marginTop: 12 } },
        h(
          'button',
          {
            type: 'button',
            className: 'xs-btn',
            onClick: async () => {
              const text = diagnostics.map(([k, v]) => `${k}: ${v}`).join('\n');
              try {
                await navigator.clipboard.writeText(text);
                notify('诊断信息已复制。');
              } catch {
                notify('复制失败：浏览器拒绝了剪贴板权限，可以手动选中上面的内容。');
              }
            },
          },
          '复制诊断信息',
        ),
        h('button', { type: 'button', className: 'xs-btn', onClick: () => onNavigate('overview', null, {}) }, '回到概览'),
      ),
    ),
    h(
      Section,
      { title: '权限与写入边界' },
      h(Note, null,
        `入口可见性与写操作由权限点控制：查看需 ${PERMISSIONS.view}，操作需 ${PERMISSIONS.operate}。` +
        '界面只做展示与暂存，所有会改账本的动作都在会话工具里完成 —— 一条写入路径比两处都能写更安全。'),
    ),
  );
}

// ─────────────────────────────────────────────────────────────
// 面板
// ─────────────────────────────────────────────────────────────

function ConsolePage(props) {
  const ctx = (props && props.ctx) || ConsolePage.__ctx || null;
  const feed = React.useMemo(() => createFeed(ctx, props && props.feedOptions), [ctx]);
  const access = React.useMemo(() => resolveAccess(ctx, props && props.accessOptions), [ctx]);

  React.useEffect(() => () => feed.dispose(), [feed]);
  React.useEffect(() => ensureStyles(), []);

  const [state, setState] = React.useState(feed.getState());
  React.useEffect(() => feed.subscribe(() => setState(feed.getState())), [feed]);

  const initialRoute = React.useMemo(() => {
    // 预览挂具/测试可直接给初始路由；正常挂载走 location.hash，深链与刷新都成立
    if (props && props.initialRoute) return props.initialRoute;
    if (typeof window === 'undefined') return { module: 'overview', id: null, query: {} };
    return parseRoute(window.location.hash);
  }, []);
  const [route, setRoute] = React.useState(initialRoute);
  const [theme, setTheme] = React.useState('auto');
  const [density, setDensity] = React.useState('cozy');
  const [toast, setToast] = React.useState('');

  const toastTimer = React.useRef(null);
  const notify = React.useCallback((message) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4000);
  }, []);
  React.useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onHashChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = React.useCallback((moduleId, id, query) => {
    const next = { module: moduleId, id: id || null, query: query || {} };
    setRoute(next);
    if (typeof window !== 'undefined') {
      const hash = formatRoute(next);
      if (window.location.hash !== hash) window.location.hash = hash;
    }
  }, []);

  const tasks = taskList(state);

  if (access.level === 'locked') {
    return h(
      'div',
      { className: 'xs-root', 'data-density': density, 'data-theme': theme },
      h(
        'header',
        { className: 'xs-header' },
        h('div', null, h('h1', { className: 'xs-title' }, '先手协议'), h('p', { className: 'xs-subtitle' }, '无访问权限')),
        h('div', { className: 'xs-header-tools' }, h(Badge, { tone: 'danger' }, '已锁定')),
      ),
      h('div', { className: 'xs-main' },
        h(Empty, {
          title: '入口在，但内容被锁住了',
          body: `${access.reason}\n\n这说明插件本身已经加载成功（入口能出现就证明槽位注册生效），缺的只是权限。`,
        }),
        h('div', { style: { marginTop: 14 } },
          h(Note, { tone: 'danger' }, `需要的权限点：${PERMISSIONS.view}（查看）与 ${PERMISSIONS.operate}（操作）。`),
        ),
      ),
    );
  }

  const counts = {
    tasks: tasks.length,
    recalls: tasks.reduce((sum, task) => sum + task.gates.filter((g) => !task.recalls.some((r) => r.window === g.window)).length, 0),
  };

  const views = {
    overview: h(OverviewView, { state, tasks, onNavigate: navigate }),
    tasks: h(TasksView, { state, tasks, route, access, onNavigate: navigate }),
    gate: h(GateView, { state, tasks, access }),
    ledger: h(LedgerView, { state, tasks, route, onNavigate: navigate }),
    recalls: h(RecallsView, { state, tasks, route, access, onNavigate: navigate, notify }),
    refusal: h(RefusalView, { tasks, access, notify }),
    health: h(HealthView, { tasks }),
    settings: h(SettingsView, { access, feed, route, onNavigate: navigate, theme, density, onTheme: setTheme, onDensity: setDensity, notify }),
  };

  return h(
    'div',
    { className: 'xs-root', 'data-density': density, 'data-theme': theme },
    h(
      'header',
      { className: 'xs-header' },
      h(
        'div',
        null,
        h('h1', { className: 'xs-title' }, '先手协议'),
        h('p', { className: 'xs-subtitle' }, MODULES.find((m) => m.id === route.module).hint),
      ),
      h(
        'div',
        { className: 'xs-header-tools' },
        h(Badge, { tone: access.level === 'operate' ? 'success' : access.level === 'view' ? 'accent' : 'danger' },
          access.level === 'operate' ? '可操作' : access.level === 'view' ? '只读' : '已锁定'),
        h(Badge, { tone: feed.source === 'none' ? 'neutral' : 'teal' },
          feed.source === 'none' ? '数据源未连接' : `数据源 ${feed.source}`),
      ),
    ),
    h(
      'div',
      { className: 'xs-body' },
      h(
        'nav',
        { className: 'xs-nav', 'aria-label': '先手协议模块' },
        MODULES.map((module) =>
          h(
            'button',
            {
              key: module.id,
              type: 'button',
              className: 'xs-nav-item',
              'aria-current': route.module === module.id ? 'page' : undefined,
              title: module.hint,
              onClick: () => navigate(module.id, null, {}),
            },
            h(Icon, { name: module.icon }),
            h('span', null, module.label),
            module.id === 'tasks' && counts.tasks > 0 ? h('span', { className: 'xs-nav-count' }, counts.tasks) : null,
            module.id === 'recalls' && counts.recalls > 0 ? h('span', { className: 'xs-nav-count' }, counts.recalls) : null,
          ),
        ),
      ),
      h('main', { className: 'xs-main' },
        feed.source === 'none' && tasks.length === 0
          ? h(
              'div',
              { style: { marginBottom: 14 } },
              h(Note, { tone: 'teal' },
                '数据源未连接：面板还没收到任何 xianshou 事件。下面各模块会保持空状态，不会用示例数据填充。' +
                '如果刚装好插件，请重启 dsh web 让客户端插件进入插件名册。'),
            )
          : null,
        views[route.module],
        toast ? h('div', { className: 'xs-toast', role: 'status' }, toast) : null,
      ),
    ),
    h(
      'footer',
      { className: 'xs-foot' },
      h('span', null, `v${PACKAGE_VERSION}`),
      h('span', null, '·'),
      h('span', null, `${state.events} 个事件`),
      h('span', null, '·'),
      h('span', null, access.reason),
    ),
  );
}

// ─────────────────────────────────────────────────────────────
// 插件入口
// ─────────────────────────────────────────────────────────────

const name = 'xianshou-console';

/** 只依赖 slots：locale 等其它服务按可选方式取，缺了不影响挂载。 */
const inject = ['slots'];

function apply(ctx) {
  const options = safeRead(ctx, 'config') || {};
  const access = resolveAccess(ctx, options);
  if (access.level === 'hidden') {
    // 只有显式配置才隐藏入口。自动探测到的"拒绝"仍然注册，原因见 resolveAccess 的注释。
    if (typeof console !== 'undefined' && console.info) {
      console.info(`[xianshou] 控制台入口未注册：${access.reason}`);
    }
    return;
  }

  const page = (props) => h(ConsolePage, { ...(props || {}), ctx, accessOptions: options });
  page.__ctx = ctx;

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 1,
        label: () => '先手协议',
      },
      SidebarIcon,
    ),
  );

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        // main 是键控槽位：key 必须与入口 id 一致，否则 selectPanel 找不到目标
        key: PANEL_ID,
      },
      page,
    ),
  );
}

module.exports = {
  name,
  inject,
  apply,
  __internals: {
    PANEL_ID,
    MODULES,
    PERMISSIONS,
    THRESHOLDS,
    RECALL_QUESTIONS,
    parseRoute,
    formatRoute,
    resolveAccess,
    reduceFeed,
    emptyFeed,
    deriveOverview,
    refusalTally,
    filterTasks,
    aiBand,
    createdAtLabel,
    pct,
    createFeed,
    ConsolePage,
    CSS,
  },
};
