/**
 * AGY Studio Remote PWA — Safe DOM Builders, Formatters & State Selectors
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DESKTOP_BREAKPOINT_PX = 960;
export const PANE_WIDTH_BOUNDS = {
  sidebar: { min: 200, max: 420, compactDefault: 236, wideDefault: 284, default: 264 },
  overview: { min: 240, max: 440, compactDefault: 264, wideDefault: 316, default: 296 },
  minCenter: 480,
};

export function getDefaultPaneWidth(kind, viewportWidth = 1280) {
  const b = kind === 'sidebar' ? PANE_WIDTH_BOUNDS.sidebar : PANE_WIDTH_BOUNDS.overview;
  const vw = Number(viewportWidth);
  if (Number.isFinite(vw) && vw > 0 && vw <= 1180) return b.compactDefault;
  if (Number.isFinite(vw) && vw >= 1481) return b.wideDefault;
  return b.default;
}

export function clampPaneWidth(
  kind,
  rawWidth,
  { viewportWidth = 1280, otherPaneWidth = 0, otherCollapsed = false } = {}
) {
  const b = kind === 'sidebar' ? PANE_WIDTH_BOUNDS.sidebar : PANE_WIDTH_BOUNDS.overview;
  const vw = Number(viewportWidth);
  const otherKind = kind === 'sidebar' ? 'overview' : 'sidebar';
  const effectiveOther = otherCollapsed
    ? 0
    : Number.isFinite(Number(otherPaneWidth)) && Number(otherPaneWidth) > 0
      ? Number(otherPaneWidth)
      : getDefaultPaneWidth(otherKind, vw);
  const viewportCap =
    Number.isFinite(vw) && vw > 0 ? Math.floor(vw - effectiveOther - PANE_WIDTH_BOUNDS.minCenter) : b.max;
  const maxAllowed = Math.max(b.min, Math.min(b.max, viewportCap));
  const fallback = getDefaultPaneWidth(kind, vw);
  const target = Number.isFinite(Number(rawWidth)) ? Math.round(Number(rawWidth)) : fallback;
  return {
    min: b.min,
    max: maxAllowed,
    value: Math.max(b.min, Math.min(maxAllowed, target)),
  };
}
const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_SHAPES = {
  sidebar: [
    ['rect', { x: '2', y: '2.75', width: '12', height: '10.5', rx: '2' }],
    ['line', { x1: '6.25', y1: '2.75', x2: '6.25', y2: '13.25' }],
  ],
  overview: [
    ['rect', { x: '2', y: '2.75', width: '12', height: '10.5', rx: '2' }],
    ['line', { x1: '9.75', y: '2.75', x2: '9.75', y2: '13.25' }],
  ],
  refresh: [
    ['path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.45-3.6' }],
    ['polyline', { points: '13.4 2.4 13.4 5.6 10.2 5.6' }],
  ],
  more: [
    ['circle', { cx: '3.5', cy: '8', r: '1.15', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '8', cy: '8', r: '1.15', fill: 'currentColor', stroke: 'none' }],
    ['circle', { cx: '12.5', cy: '8', r: '1.15', fill: 'currentColor', stroke: 'none' }],
  ],
  doc: [
    ['path', { d: 'M4.25 2.25h5l3 3v8.5a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1z' }],
    ['polyline', { points: '9.25 2.25 9.25 5.25 12.25 5.25' }],
    ['line', { x1: '5.5', y1: '8.5', x2: '10.5', y2: '8.5' }],
    ['line', { x1: '5.5', y1: '11.2', x2: '8.5', y2: '11.2' }],
  ],
  git: [
    ['circle', { cx: '5', cy: '3.75', r: '1.5' }],
    ['circle', { cx: '5', cy: '12.25', r: '1.5' }],
    ['circle', { cx: '11', cy: '6', r: '1.5' }],
    ['line', { x1: '5', y1: '5.25', x2: '5', y2: '10.75' }],
    ['path', { d: 'M11 7.5v1a2.5 2.5 0 0 1-2.5 2.5H5' }],
  ],
  arrowDown: [
    ['line', { x1: '8', y1: '2.75', x2: '8', y2: '12.5' }],
    ['polyline', { points: '4.25 8.75 8 12.75 11.75 8.75' }],
  ],
};

export function createSvgIcon(kind, { size = 15, className = 'rc-svg-icon' } = {}) {
  const shapes = ICON_SHAPES[kind];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.45');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (shapes) {
    for (const [tag, attrs] of shapes) {
      const node = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        node.setAttribute(k, v);
      }
      svg.appendChild(node);
    }
  }
  return svg;
}

export function resolveLayoutMode(pref, viewportWidth = 1024) {
  if (pref === 'desktop' || pref === 'mobile') return pref;
  const w = Number(viewportWidth);
  return Number.isFinite(w) && w >= DESKTOP_BREAKPOINT_PX ? 'desktop' : 'mobile';
}

export function formatResetCountdown(sec, nowMs = Date.now()) {
  const raw = Number(sec);
  if (!Number.isFinite(raw) || raw <= 0) return '';
  let total = raw;
  if (raw > 1e12) {
    total = Math.floor(raw / 1000) - Math.floor(nowMs / 1000);
  } else if (raw > 1e9) {
    total = Math.floor(raw) - Math.floor(nowMs / 1000);
  }
  if (!Number.isFinite(total) || total <= 0) return '';
  const mins = Math.ceil(total / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function copyTextWithFeedback(btn, text, { idleText = '复制', doneText = '已复制' } = {}) {
  const val = String(text ?? '');
  if (!val || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
  navigator.clipboard
    .writeText(val)
    .then(() => {
      if (!btn) return;
      btn.textContent = doneText;
      btn.setAttribute('data-copied', 'true');
      setTimeout(() => {
        btn.textContent = idleText;
        btn.removeAttribute('data-copied');
      }, 1400);
    })
    .catch(() => {});
}

/* Safe DOM helper — strictly textContent / setAttribute only */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props || {})) {
    if (val === undefined || val === null || val === false) continue;
    if (key === 'className') {
      node.className = String(val);
    } else if (key === 'text') {
      node.textContent = String(val);
    } else if (key === 'onClick' && typeof val === 'function') {
      node.addEventListener('click', val);
    } else if (key === 'onInput' && typeof val === 'function') {
      node.addEventListener('input', val);
    } else if (key === 'onChange' && typeof val === 'function') {
      node.addEventListener('change', val);
    } else if (key === 'onSubmit' && typeof val === 'function') {
      node.addEventListener('submit', val);
    } else if (key === 'disabled') {
      node.disabled = Boolean(val);
    } else if (key === 'checked') {
      node.checked = Boolean(val);
    } else if (key === 'value') {
      node.value = String(val);
    } else if (key === 'open') {
      node.open = Boolean(val);
    } else if (key === 'style') {
      if (typeof val === 'object') {
        for (const [cssProp, cssVal] of Object.entries(val)) {
          if (cssVal === undefined || cssVal === null || cssVal === false) continue;
          if (cssProp.startsWith('--') || cssProp.includes('-')) {
            node.style.setProperty(cssProp, String(cssVal));
          } else {
            node.style[cssProp] = String(cssVal);
          }
        }
      } else if (typeof val === 'string') {
        for (const decl of val.split(';')) {
          const idx = decl.indexOf(':');
          if (idx <= 0) continue;
          const prop = decl.slice(0, idx).trim();
          const v = decl.slice(idx + 1).trim();
          if (prop && v) node.style.setProperty(prop, v);
        }
      }
    } else {
      node.setAttribute(key, String(val));
    }
  }
  return appendNodes(node, ...children);
}

export function appendNodes(parent, ...items) {
  for (const child of items.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
    } else {
      parent.appendChild(child);
    }
  }
  return parent;
}

export function mergeSummariesDelta(prevList, data) {
  if (Array.isArray(data?.conversations)) {
    return data.conversations;
  }
  const next = new Map((Array.isArray(prevList) ? prevList : []).map((c) => [c.id, c]));
  if (Array.isArray(data?.changed)) {
    for (const item of data.changed) {
      if (item && item.id) {
        const prevItem = next.get(item.id) || {};
        const merged = { ...prevItem, ...item };
        if ('waitingSteps' in item && !('waitingSubagents' in item)) {
          merged.waitingSubagents = Array.isArray(prevItem.waitingSubagents) ? prevItem.waitingSubagents : [];
        }
        next.set(item.id, merged);
      }
    }
  }
  if (Array.isArray(data?.removed)) {
    for (const rmId of data.removed) {
      next.delete(rmId);
    }
  }
  if (data?.summaries && typeof data.summaries === 'object') {
    for (const [cid, patch] of Object.entries(data.summaries)) {
      if (patch === null) next.delete(cid);
      else next.set(cid, { ...(next.get(cid) || { id: cid }), ...patch, id: cid });
    }
  }
  if (data?.byParent && typeof data.byParent === 'object') {
    const changedIds = new Set(Array.isArray(data.changed) ? data.changed.map((x) => x?.id).filter(Boolean) : []);
    const removedIds = new Set(Array.isArray(data.removed) ? data.removed : []);
    for (const [pid, conv] of next.entries()) {
      if (!conv) continue;
      const prevSubMap = new Map(
        (Array.isArray(conv.waitingSubagents) ? conv.waitingSubagents : [])
          .filter((s) => s && s.id && !removedIds.has(s.id))
          .map((s) => [s.id, s])
      );
      const queue = Array.isArray(data.byParent[pid]) ? [...data.byParent[pid]] : [];
      if (queue.length === 0) {
        if (!changedIds.has(pid) || !Array.isArray(conv.waitingSubagents)) {
          conv.waitingSubagents = [];
        }
        continue;
      }
      const seen = new Set([pid]);
      const wSubs = [];
      while (queue.length > 0) {
        const childId = queue.shift();
        if (!childId || seen.has(childId)) continue;
        seen.add(childId);
        const child = next.get(childId);
        if (child) {
          if (Array.isArray(child.waitingSteps) && child.waitingSteps.length > 0) {
            wSubs.push({
              id: child.id,
              title: child.title || child.summary || child.id,
              waitingSteps: child.waitingSteps,
            });
          }
        } else if (prevSubMap.has(childId)) {
          const prevSub = prevSubMap.get(childId);
          if (Array.isArray(prevSub.waitingSteps) && prevSub.waitingSteps.length > 0) {
            wSubs.push(prevSub);
          }
        }
        const grand = data.byParent[childId];
        if (Array.isArray(grand)) {
          for (const g of grand) queue.push(g);
        }
      }
      conv.waitingSubagents = wSubs;
    }
  }
  return Array.from(next.values());
}

export function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function formatTime(ts) {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function formatRelativeTime(ts) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? ts : Date.parse(String(ts));
  if (!Number.isFinite(ms)) return '';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

export function isRunningStatus(status) {
  if (status === 2 || status === 8) return true;
  const s = String(status || '').toUpperCase();
  return s.includes('RUNNING') || s.includes('WAITING');
}

export function normalizeRunStatus(status) {
  if (status === 2) return { label: '运行中', tone: 'info' };
  if (status === 8) return { label: '待处理', tone: 'warn' };
  if (status === 4 || status === 7) return { label: '错误', tone: 'danger' };
  if (status === 6) return { label: '已取消', tone: 'neutral' };
  const s = String(status || '').toUpperCase();
  if (s.includes('RUNNING')) return { label: '运行中', tone: 'info' };
  if (s.includes('ERROR') || s.includes('FAIL')) return { label: '错误', tone: 'danger' };
  if (s.includes('CANCEL')) return { label: '已取消', tone: 'neutral' };
  if (s.includes('IDLE') || status === 1 || status === 3) return { label: '空闲', tone: 'neutral' };
  return { label: s || '未知', tone: 'neutral' };
}

export function normalizeStepStatus(status) {
  if (status === 1) return { label: 'QUEUED', tone: 'neutral' };
  if (status === 2) return { label: 'RUNNING', tone: 'info' };
  if (status === 3) return { label: 'DONE', tone: 'ok' };
  if (status === 4 || status === 7) return { label: 'ERROR', tone: 'danger' };
  if (status === 5) return { label: 'CLEARED', tone: 'neutral' };
  if (status === 6) return { label: 'CANCELED', tone: 'warn' };
  if (status === 8) return { label: 'WAITING', tone: 'warn' };
  const s = String(status || '').toUpperCase();
  if (s === 'DONE') return { label: 'DONE', tone: 'ok' };
  if (s === 'RUNNING') return { label: 'RUNNING', tone: 'info' };
  if (s === 'ERROR') return { label: 'ERROR', tone: 'danger' };
  return { label: s || 'STEP', tone: 'neutral' };
}

export function isSafeNonTurboPreset(preset) {
  if (typeof preset === 'boolean' || preset === null || preset === undefined) return false;
  if (typeof preset === 'string' && !/^\d+$/.test(preset.trim())) return false;
  const n = Number(preset);
  return n === 1 || n === 2;
}

export function formatPresetBadge(preset) {
  if (typeof preset === 'boolean' || preset === null || preset === undefined) {
    return { label: 'Preset 未知', tone: 'warn' };
  }
  if (typeof preset === 'string' && !/^\d+$/.test(preset.trim())) {
    return { label: 'Preset 未知', tone: 'warn' };
  }
  const n = Number(preset);
  if (n === 3) return { label: 'TURBO (3)', tone: 'danger' };
  if (n === 2) return { label: 'REVIEW (2)', tone: 'ok' };
  if (n === 1) return { label: 'SAFE (1)', tone: 'ok' };
  if (n === 0) return { label: 'UNSPECIFIED (0)', tone: 'warn' };
  if (Number.isFinite(n)) return { label: `Preset ${n}`, tone: 'warn' };
  return { label: 'Preset 未知', tone: 'warn' };
}

export function normalizeWsStatus(status, detail = '') {
  switch (status) {
    case 'connected':
      return { label: '已连接', tone: 'ok' };
    case 'connecting':
      return { label: '握手连接中', tone: 'warn' };
    case 'reconnecting':
      return { label: detail || '重连中…', tone: 'warn' };
    case 'offline':
      return { label: detail || '网络已断开', tone: 'warn' };
    case 'auth_expired':
      return { label: '登录态已过期', tone: 'danger' };
    case 'revoked':
      return { label: '设备已吊销', tone: 'danger' };
    case 'error':
      return { label: detail || '连接异常', tone: 'danger' };
    default:
      return { label: '未连接', tone: 'neutral' };
  }
}

export function shortFingerprint(fp) {
  const s = String(fp || '');
  if (!s) return '未知';
  if (s.length <= 20) return s;
  return `${s.slice(0, 10)}…${s.slice(-8)}`;
}

export function requiresTurboAck(preset) {
  return !isSafeNonTurboPreset(preset);
}

export function collectPendingApprovals(state) {
  const out = [];
  const seenKeys = new Set();
  const byId = new Map(state.conversations.map((c) => [c.id, c]));

  const pushWaiting = (cascadeId, title, parentTitle, isSubagent, w) => {
    if (!w || typeof w !== 'object') return;
    const key = `${cascadeId}:${w.stepIndex ?? ''}:${w.waitingStepHash || w.toolName || ''}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    out.push({
      cascadeId,
      title,
      parentTitle,
      isSubagent,
      ...w,
    });
  };

  for (const convo of state.conversations) {
    const parentTitle = convo.parentConversationId ? byId.get(convo.parentConversationId)?.title || null : null;
    const list = Array.isArray(convo.waitingSteps) ? convo.waitingSteps : [];
    for (const w of list) {
      pushWaiting(
        convo.id,
        convo.title || convo.summary || convo.id.slice(0, 8),
        parentTitle,
        Boolean(convo.parentConversationId),
        w
      );
    }

    const subList = Array.isArray(convo.waitingSubagents) ? convo.waitingSubagents : [];
    for (const sub of subList) {
      if (!sub || !sub.id) continue;
      const subTitle = sub.title || sub.summary || sub.id.slice(0, 8);
      const subWaiting = Array.isArray(sub.waitingSteps) ? sub.waitingSteps : [];
      for (const w of subWaiting) {
        pushWaiting(sub.id, subTitle, convo.title || convo.summary || convo.id.slice(0, 8), true, w);
      }
    }
  }
  return out;
}

export function getEffectiveWaitingCount(state, convo) {
  let count = Array.isArray(convo.waitingSteps) ? convo.waitingSteps.length : 0;
  const countedSubIds = new Set();
  const subList = Array.isArray(convo.waitingSubagents) ? convo.waitingSubagents : [];
  for (const sub of subList) {
    if (!sub || !sub.id) continue;
    countedSubIds.add(sub.id);
    count += Array.isArray(sub.waitingSteps) ? sub.waitingSteps.length : 0;
  }
  for (const c of state.conversations) {
    if (c.parentConversationId === convo.id && !countedSubIds.has(c.id) && Array.isArray(c.waitingSteps)) {
      count += c.waitingSteps.length;
    }
  }
  return count;
}

export function findConversationMeta(state, cascadeId) {
  if (!cascadeId) return null;
  const direct = state.conversations.find((c) => c.id === cascadeId);
  if (direct) return direct;
  for (const parent of state.conversations) {
    const subList = Array.isArray(parent.waitingSubagents) ? parent.waitingSubagents : [];
    const hit = subList.find((sub) => sub && sub.id === cascadeId);
    if (hit) {
      return {
        id: hit.id,
        title: hit.title || hit.summary || hit.id,
        summary: hit.summary || '',
        status: 'WAITING',
        parentConversationId: parent.id,
        waitingSteps: Array.isArray(hit.waitingSteps) ? hit.waitingSteps : [],
      };
    }
  }
  return null;
}

export function filterConversations(state) {
  const q = state.searchQuery.trim().toLowerCase();
  return state.conversations
    .filter((c) => {
      if (!state.includeSubagents && c.parentConversationId) return false;
      if (state.selectedProjectId) {
        const wtMeta = state.studioOverview?.worktreeByCid?.[c.id];
        const cidPid = String(c.projectId || wtMeta?.projectId || '');
        if (cidPid !== state.selectedProjectId) return false;
      }
      if (state.filter === 'running' && !isRunningStatus(c.status)) return false;
      if (state.filter === 'waiting' && getEffectiveWaitingCount(state, c) === 0) return false;
      if (q) {
        const wtMeta = state.studioOverview?.worktreeByCid?.[c.id];
        const projects = Array.isArray(state.studioOverview?.projects) ? state.studioOverview.projects : [];
        const pid = String(c.projectId || wtMeta?.projectId || '');
        const projName = pid ? projects.find((p) => p.id === pid)?.name || '' : '';
        const hay = `${c.title || ''} ${c.summary || ''} ${c.id || ''} ${wtMeta?.branch || ''} ${wtMeta?.repoName || ''} ${projName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const wa = getEffectiveWaitingCount(state, a) > 0 ? 1 : 0;
      const wb = getEffectiveWaitingCount(state, b) > 0 ? 1 : 0;
      if (wa !== wb) return wb - wa;
      const ta = Number(a.lastModifiedTime || 0) || Date.parse(a.lastModifiedTime || 0) || 0;
      const tb = Number(b.lastModifiedTime || 0) || Date.parse(b.lastModifiedTime || 0) || 0;
      return tb - ta;
    });
}
