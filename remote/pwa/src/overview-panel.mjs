/**
 * AGY Studio Remote PWA — Right Overview Panel (Studio Workbench + Mobile Overview Tab)
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import { formatCompactTokens } from './studio-panel.mjs';
import {
  appendNodes,
  clearNode,
  copyTextWithFeedback,
  el,
  formatPresetBadge,
  formatResetCountdown,
  normalizeRunStatus,
  normalizeWsStatus,
} from './ui-helpers.mjs';

function buildMeterRow(label, pct, { resetSec = null, tone = 'blue' } = {}) {
  const validPct = pct !== null && pct !== undefined && Number.isFinite(Number(pct));
  const clamped = validPct ? Math.max(0, Math.min(100, Math.round(Number(pct)))) : 0;
  const resetText = formatResetCountdown(resetSec);
  const metaText = validPct
    ? `${clamped}%${resetText ? ` · ${resetText}` : ''}`
    : '--';

  return el(
    'div',
    { className: 'rc-meter-row' },
    el(
      'div',
      { className: 'rc-meter-top' },
      el('span', { className: 'rc-meter-label', text: label }),
      el('span', { className: 'rc-meter-val', text: metaText })
    ),
    el(
      'div',
      { className: 'rc-meter-track' },
      el('div', {
        className: 'rc-meter-fill',
        'data-tone': validPct && clamped <= 15 ? 'warn' : tone,
        style: { width: `${clamped}%` },
      })
    )
  );
}

function renderQuotaCard(quota) {
  const headerChildren = [el('strong', { className: 'rc-ov-card-title', text: '配额与窗口' })];
  if (quota?.tierName) {
    headerChildren.push(el('span', { className: 'rc-pill', 'data-tone': 'info', text: quota.tierName }));
  }

  const body = el('div', { className: 'rc-ov-card-stack' });
  const hasClaude =
    quota?.claude &&
    (quota.claude.fiveHourRemainingPct !== null || quota.claude.weeklyRemainingPct !== null);
  const hasGemini =
    quota?.gemini &&
    (quota.gemini.fiveHourRemainingPct !== null || quota.gemini.weeklyRemainingPct !== null);

  if (hasClaude) {
    body.appendChild(
      el(
        'div',
        { className: 'rc-ov-pool' },
        el('div', { className: 'rc-ov-pool-name', text: 'Claude' }),
        buildMeterRow('5 小时剩余', quota.claude.fiveHourRemainingPct, {
          resetSec: quota.claude.fiveHourResetSec,
          tone: 'accent',
        }),
        buildMeterRow('周配额剩余', quota.claude.weeklyRemainingPct, {
          resetSec: quota.claude.weeklyResetSec,
          tone: 'accent',
        })
      )
    );
  }

  if (hasGemini) {
    body.appendChild(
      el(
        'div',
        { className: 'rc-ov-pool' },
        el('div', { className: 'rc-ov-pool-name', text: 'Gemini' }),
        buildMeterRow('5 小时剩余', quota.gemini.fiveHourRemainingPct, {
          resetSec: quota.gemini.fiveHourResetSec,
          tone: 'blue',
        }),
        buildMeterRow('周配额剩余', quota.gemini.weeklyRemainingPct, {
          resetSec: quota.gemini.weeklyResetSec,
          tone: 'blue',
        })
      )
    );
  }

  if (!hasClaude && !hasGemini) {
    body.appendChild(el('div', { className: 'rc-convo-meta', text: '等待宿主同步模型配额…' }));
  }

  return el(
    'section',
    { className: 'rc-ov-card' },
    el('div', { className: 'rc-ov-card-head' }, ...headerChildren),
    body
  );
}

function renderUsageCard(todayUsage, { usageDays = [], usageRange = 'day', onChangeUsageRange = null } = {}) {
  const days = Array.isArray(usageDays) ? usageDays : [];
  const mode = usageRange === '30d' ? '30d' : usageRange === '7d' ? '7d' : 'day';
  const sliced = mode === '30d' ? days.slice(-30) : mode === '7d' ? days.slice(-7) : [];

  let totalTokens = Number(todayUsage?.totalTokens || 0);
  let requests = Number(todayUsage?.requests || 0);
  let uncached = Number(todayUsage?.uncached || 0);
  let cacheRead = Number(todayUsage?.cacheRead || 0);
  let output = Number(todayUsage?.output || 0);

  if (mode !== 'day' && sliced.length > 0) {
    totalTokens = 0;
    requests = 0;
    uncached = 0;
    cacheRead = 0;
    output = 0;
    for (const d of sliced) {
      totalTokens += Number(d?.totalTokens || 0);
      requests += Number(d?.requests || 0);
      uncached += Number(d?.uncached || 0);
      cacheRead += Number(d?.cacheRead || 0);
      output += Number(d?.output || 0);
    }
  }

  const inputTotal = uncached + cacheRead;
  const hitPct = inputTotal > 0 ? Math.round((cacheRead / inputTotal) * 100) : 0;

  const denom = Math.max(1, uncached + cacheRead + output);
  const cacheWidth = Math.round((cacheRead / denom) * 100);
  const uncachedWidth = Math.round((uncached / denom) * 100);
  const outputWidth = Math.max(0, 100 - cacheWidth - uncachedWidth);

  const rangeButtons =
    days.length > 1 && onChangeUsageRange
      ? el(
          'div',
          { className: 'rc-usage-tabs' },
          ...[
            { id: 'day', label: '今日' },
            { id: '7d', label: '7天' },
            { id: '30d', label: '30天' },
          ].map((t) =>
            el('button', {
              type: 'button',
              className: 'rc-usage-tab',
              'aria-pressed': mode === t.id ? 'true' : 'false',
              text: t.label,
              onClick: () => onChangeUsageRange(t.id),
            })
          )
        )
      : el('span', { className: 'rc-ov-muted', text: todayUsage?.date || '今天' });

  const titleEl = el('strong', {
    className: 'rc-ov-card-title',
    text: mode === 'day' ? '今日用量' : mode === '7d' ? '近 7 天用量' : '近 30 天用量',
  });
  const kpiValEl = el('span', { className: 'rc-ov-kpi', text: `${formatCompactTokens(totalTokens)} tok` });
  const kpiMetaEl = el('span', {
    className: 'rc-ov-muted',
    text: `${requests} req${inputTotal > 0 ? ` · 缓存 ${hitPct}%` : ''}`,
  });
  const legendCacheText = el('span', { text: `缓存读 ${formatCompactTokens(cacheRead)}` });
  const legendUncachedText = el('span', { text: `未缓存 ${formatCompactTokens(uncached)}` });
  const legendOutputText = el('span', { text: `输出 ${formatCompactTokens(output)}` });

  const setSummaryMetrics = ({ labelPrefix = '', tot = totalTokens, req = requests, c = cacheRead, u = uncached, o = output }) => {
    const inp = c + u;
    const hit = inp > 0 ? Math.round((c / inp) * 100) : 0;
    kpiValEl.textContent = `${formatCompactTokens(tot)} tok`;
    kpiMetaEl.textContent = `${labelPrefix ? `${labelPrefix} · ` : ''}${req} req${inp > 0 ? ` · 缓存 ${hit}%` : ''}`;
    legendCacheText.textContent = `缓存读 ${formatCompactTokens(c)}`;
    legendUncachedText.textContent = `未缓存 ${formatCompactTokens(u)}`;
    legendOutputText.textContent = `输出 ${formatCompactTokens(o)}`;
  };

  let trendChart = null;
  if (mode !== 'day' && sliced.length > 0) {
    const maxDayTok = Math.max(1, ...sliced.map((d) => Number(d?.totalTokens || 0)));
    const gridEl = el(
      'div',
      { className: 'rc-usage-grid', 'aria-hidden': 'true' },
      el('div', { className: 'rc-usage-grid-line' }),
      el('div', { className: 'rc-usage-grid-line' }),
      el('div', { className: 'rc-usage-grid-line' }),
      el('div', { className: 'rc-usage-grid-line is-base' }),
      el('span', { className: 'rc-usage-max-tick', text: formatCompactTokens(maxDayTok) })
    );
    const barsRow = el('div', { className: 'rc-usage-bars', 'data-range': mode });
    const colNodes = [];
    const clearActiveCol = () => {
      for (const n of colNodes) n.removeAttribute('data-active');
      setSummaryMetrics({});
    };

    for (const d of sliced) {
      const tok = Number(d?.totalTokens || 0);
      const reqs = Number(d?.requests || 0);
      const heightPct = tok > 0 ? Math.max(4, Math.round((tok / maxDayTok) * 100)) : 0;
      const dCache = Number(d?.cacheRead || 0);
      const dUncached = Number(d?.uncached || 0);
      const dOutput = Number(d?.output || 0);
      const dDenom = Math.max(1, dCache + dUncached + dOutput);
      const cPct = Math.round((dCache / dDenom) * 100);
      const uPct = Math.round((dUncached / dDenom) * 100);
      const oPct = Math.max(0, 100 - cPct - uPct);
      const label = String(d?.date || '').slice(5);
      const colNode = el(
        'div',
        {
          className: 'rc-usage-col',
          tabindex: '0',
          role: 'button',
          'aria-label': `${d?.date || ''}: ${formatCompactTokens(tok)} tok, ${reqs} req`,
        },
        el(
          'div',
          { className: 'rc-usage-col-track' },
          tok > 0
            ? el(
                'div',
                { className: 'rc-usage-col-bar', style: { height: `${heightPct}%` } },
                el('div', { className: 'rc-usage-col-seg is-output', style: { height: `${oPct}%` } }),
                el('div', { className: 'rc-usage-col-seg is-uncached', style: { height: `${uPct}%` } }),
                el('div', { className: 'rc-usage-col-seg is-cache', style: { height: `${cPct}%` } })
              )
            : el('div', { className: 'rc-usage-col-zero' })
        ),
        mode === '7d' ? el('span', { className: 'rc-usage-col-label', text: label }) : null
      );
      const activateCol = () => {
        for (const n of colNodes) {
          if (n === colNode) n.setAttribute('data-active', 'true');
          else n.removeAttribute('data-active');
        }
        setSummaryMetrics({
          labelPrefix: label || d?.date || '',
          tot: tok,
          req: reqs,
          c: dCache,
          u: dUncached,
          o: dOutput,
        });
      };
      colNode.addEventListener('pointerenter', activateCol);
      colNode.addEventListener('focus', activateCol);
      colNode.addEventListener('click', activateCol);
      colNodes.push(colNode);
      barsRow.appendChild(colNode);
    }

    const chartWrap = el('div', { className: 'rc-usage-chart', 'data-range': mode }, gridEl, barsRow);
    chartWrap.addEventListener('pointerleave', clearActiveCol);
    chartWrap.addEventListener('focusout', (ev) => {
      if (!chartWrap.contains(ev?.relatedTarget)) clearActiveCol();
    });
    trendChart = chartWrap;
  }

  return el(
    'section',
    { className: 'rc-ov-card' },
    el('div', { className: 'rc-ov-card-head' }, titleEl, rangeButtons),
    el('div', { className: 'rc-ov-kpi-row' }, kpiValEl, kpiMetaEl),
    trendChart ||
      el(
        'div',
        { className: 'rc-usage-bar' },
        el('div', { className: 'rc-usage-seg is-cache', style: { width: `${totalTokens > 0 ? cacheWidth : 0}%` } }),
        el('div', { className: 'rc-usage-seg is-uncached', style: { width: `${totalTokens > 0 ? uncachedWidth : 0}%` } }),
        el('div', { className: 'rc-usage-seg is-output', style: { width: `${totalTokens > 0 ? outputWidth : 0}%` } })
      ),
    el(
      'div',
      { className: 'rc-ov-legend' },
      el('span', { className: 'rc-ov-legend-item' }, el('span', { className: 'rc-ov-legend-dot is-cache' }), legendCacheText),
      el('span', { className: 'rc-ov-legend-item' }, el('span', { className: 'rc-ov-legend-dot is-uncached' }), legendUncachedText),
      el('span', { className: 'rc-ov-legend-item' }, el('span', { className: 'rc-ov-legend-dot is-output' }), legendOutputText)
    )
  );
}

function renderActiveSessionCard({
  overview,
  selectedConvo,
  snapshot,
  wsStatus,
  hostAttached,
  globalPreset,
  deviceName,
  role,
  onCopyId,
  onOpenProjectGit = null,
}) {
  const cid = selectedConvo?.id || snapshot?.cascadeId || '';
  if (!cid) {
    const wsInfo = normalizeWsStatus(wsStatus);
    const presetInfo = formatPresetBadge(globalPreset);
    return el(
      'section',
      { className: 'rc-ov-card' },
      el(
        'div',
        { className: 'rc-ov-card-head' },
        el('strong', { className: 'rc-ov-card-title', text: '终端连接与宿主' }),
        el('span', { className: 'rc-pill', 'data-tone': wsInfo.tone, text: wsInfo.label })
      ),
      el(
        'div',
        { className: 'rc-ov-kv-list' },
        el('div', { className: 'rc-ov-kv' }, el('span', { text: '宿主' }), el('span', { text: hostAttached ? 'CDP 在线' : '磁盘只读' })),
        el('div', { className: 'rc-ov-kv' }, el('span', { text: '权限策略' }), el('span', { text: presetInfo.label })),
        el('div', { className: 'rc-ov-kv' }, el('span', { text: '本机角色' }), el('span', { text: `${deviceName || '已配对设备'} (${role || 'observe'})` }))
      )
    );
  }

  const runInfo = normalizeRunStatus(snapshot?.status ?? selectedConvo?.status);
  const wtMeta = overview?.worktreeByCid?.[cid] || null;
  const activeMeta =
    overview?.activeCascade?.cascadeId === cid ? overview.activeCascade : null;
  const stepsCount = Math.max(
    Number(selectedConvo?.stepCount || 0),
    Array.isArray(snapshot?.steps) ? snapshot.steps.length : 0
  );
  const ctxPct = activeMeta?.metrics?.ctxLimit > 0 ? Math.round(Number(activeMeta.metrics.ctxPct || 0)) : null;

  const copyBtn = el('button', {
    type: 'button',
    className: 'rc-code-copy',
    text: '复制 ID',
    onClick: () => {
      if (typeof onCopyId === 'function') {
        onCopyId(cid, copyBtn);
      } else {
        copyTextWithFeedback(copyBtn, cid, { idleText: '复制 ID', doneText: '已复制' });
      }
    },
  });

  const pills = el(
    'div',
    { className: 'rc-studio-pills' },
    el('span', { className: 'rc-pill', 'data-tone': runInfo.tone, text: runInfo.label }),
    el('span', { className: 'rc-pill', text: `${stepsCount} 步` }),
    ctxPct !== null ? el('span', { className: 'rc-pill', text: `上下文 ${ctxPct}%` }) : null,
    wtMeta?.branch ? el('span', { className: 'rc-pill', 'data-tone': 'info', text: `⎇ ${wtMeta.branch}` }) : null,
    activeMeta?.opusGate?.proposal
      ? el('span', { className: 'rc-pill', 'data-tone': 'warn', text: 'Opus Gate 待核' })
      : null,
    activeMeta?.autoCompact?.pending
      ? el('span', { className: 'rc-pill', 'data-tone': 'warn', text: '待 Compact' })
      : null
  );

  const nameMatches =
    !wtMeta?.projectId && wtMeta?.repoName && Array.isArray(overview?.projects)
      ? overview.projects.filter((p) => p && p.name === wtMeta.repoName)
      : [];
  const matchedRepoId = wtMeta?.projectId || (nameMatches.length === 1 ? nameMatches[0].id || '' : '');
  const repoNode = wtMeta?.repoName
    ? onOpenProjectGit && matchedRepoId
      ? el('button', {
          type: 'button',
          className: 'rc-ov-session-repo',
          title: '查看该仓库 Git 状态与 Diff',
          text: `仓库: ${wtMeta.repoName} · Git →`,
          onClick: () => onOpenProjectGit({ projectId: matchedRepoId }),
        })
      : el('div', { className: 'rc-convo-meta', text: `仓库: ${wtMeta.repoName}` })
    : null;

  return el(
    'section',
    { className: 'rc-ov-card' },
    el(
      'div',
      { className: 'rc-ov-card-head' },
      el('strong', { className: 'rc-ov-card-title', text: '当前会话' }),
      copyBtn
    ),
    el('div', { className: 'rc-ov-session-title', text: selectedConvo?.title || selectedConvo?.summary || cid }),
    el('div', { className: 'rc-mono rc-ov-muted', text: cid.slice(0, 18) }),
    pills,
    repoNode
  );
}

function renderProjectsOverviewCard({ overview, selectedProjectId = '', onSelectProject, onOpenProjectGit = null }) {
  const projects = Array.isArray(overview?.projects) ? overview.projects : [];
  const headActions = [];
  if (selectedProjectId) {
    headActions.push(
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm',
        text: '清除筛选',
        onClick: () => onSelectProject?.(''),
      })
    );
  }

  const card = el(
    'section',
    { className: 'rc-ov-card' },
    el(
      'div',
      { className: 'rc-ov-card-head' },
      el('strong', { className: 'rc-ov-card-title', text: `项目与 Worktree (${projects.length})` }),
      ...headActions
    )
  );

  if (projects.length === 0) {
    card.appendChild(el('div', { className: 'rc-convo-meta', text: '暂未发现已授权项目目录。' }));
    return card;
  }

  const list = el('div', { className: 'rc-ov-proj-list' });
  for (const proj of projects) {
    const isSelected = Boolean(selectedProjectId && selectedProjectId === proj.id);
    const wtList = Array.isArray(proj.worktrees) ? proj.worktrees : [];
    const wtChips = el('div', { className: 'rc-studio-pills' });
    for (const wt of wtList.slice(0, 4)) {
      const label = wt.branch || wt.name || 'worktree';
      wtChips.appendChild(
        el('span', {
          className: 'rc-pill',
          'data-tone': wt.isMain ? 'neutral' : 'info',
          text: wt.isMain ? (label === 'main' ? 'main' : `${label} (main)`) : label,
        })
      );
    }
    if (wtList.length > 4) {
      wtChips.appendChild(el('span', { className: 'rc-pill', text: `+${wtList.length - 4}` }));
    }

    list.appendChild(
      el(
        'div',
        { className: 'rc-ov-proj-item', 'data-selected': isSelected ? 'true' : 'false' },
        el(
          'div',
          { className: 'rc-convo-top' },
          el('span', { className: 'rc-ov-proj-name', text: proj.name || 'Project' }),
          el(
            'div',
            { className: 'rc-dock-group' },
            proj.isGitRepo && onOpenProjectGit
              ? el('button', {
                  type: 'button',
                  className: 'rc-btn is-sm',
                  text: 'Git',
                  title: '查看该项目 Git 状态与 Diff',
                  onClick: () => onOpenProjectGit({ projectId: proj.id }),
                })
              : null,
            el('button', {
              type: 'button',
              className: 'rc-btn is-sm',
              text: isSelected ? '取消' : '筛选',
              onClick: () => onSelectProject?.(isSelected ? '' : proj.id),
            })
          )
        ),
        proj.shortPath ? el('div', { className: 'rc-mono rc-ov-muted', text: proj.shortPath }) : null,
        wtList.length > 0 ? wtChips : null
      )
    );
  }
  card.appendChild(list);
  return card;
}

export function renderOverviewPanel(
  container,
  {
    overview = null,
    selectedConvo = null,
    snapshot = null,
    wsStatus = 'disconnected',
    hostAttached = false,
    globalPreset = null,
    deviceName = '',
    role = 'observe',
    selectedProjectId = '',
    usageRange = 'day',
    onChangeUsageRange = null,
    onSelectProject = null,
    onOpenProjectGit = null,
    onCopyId = null,
  } = {}
) {
  if (!container) return;
  clearNode(container);

  const body = el('div', { className: 'rc-overview-body' });
  appendNodes(
    body,
    renderQuotaCard(overview?.quota || null),
    renderUsageCard(overview?.todayUsage || null, {
      usageDays: overview?.usageDays || [],
      usageRange,
      onChangeUsageRange,
    }),
    renderActiveSessionCard({
      overview,
      selectedConvo,
      snapshot,
      wsStatus,
      hostAttached,
      globalPreset,
      deviceName,
      role,
      onCopyId,
      onOpenProjectGit,
    }),
    renderProjectsOverviewCard({ overview, selectedProjectId, onSelectProject, onOpenProjectGit })
  );
  container.appendChild(body);
}
