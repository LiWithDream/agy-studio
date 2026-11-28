/**
 * AGY Studio Remote PWA — Studio v1.3 Status Strip, Projects & Worktrees Drawer,
 * Interrupted-Task Silent Resume Banner, and Opus Gate Proposal Card.
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import { appendNodes, clearNode, el } from './ui-helpers.mjs';

export function formatCompactTokens(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

export function formatResumeReason(reason) {
  switch (reason) {
    case 'aborted':
      return '上次任务在运行中意外中断';
    case 'mid_tool':
      return '上次工具执行后未继续完成';
    case 'canceled':
      return '上次执行被暂停或取消';
    case 'interrupted':
      return '上次执行被中断';
    case 'error':
      return '上次执行遇到错误而停止';
    case 'max_steps':
      return '上次任务达到步数或预算上限';
    case 'unanswered':
      return '上一条指令尚未得到回复';
    default:
      return '检测到未完成任务，支持一键静默续跑';
  }
}

export function renderStudioStrip(container, { overview, open, selectedProjectId = '', onToggleProjects } = {}) {
  if (!container) return;
  clearNode(container);

  if (!overview) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  const pillsGroup = el('div', { className: 'rc-studio-pills' });
  const q = overview.quota;
  if (q?.claude && (q.claude.fiveHourRemainingPct !== null || q.claude.weeklyRemainingPct !== null)) {
    const h5 = q.claude.fiveHourRemainingPct !== null ? `${Math.round(q.claude.fiveHourRemainingPct)}%` : '--';
    const wk = q.claude.weeklyRemainingPct !== null ? `${Math.round(q.claude.weeklyRemainingPct)}%` : '--';
    const tone =
      (q.claude.fiveHourRemainingPct !== null && q.claude.fiveHourRemainingPct <= 15) ||
      (q.claude.weeklyRemainingPct !== null && q.claude.weeklyRemainingPct <= 15)
        ? 'warn'
        : 'ok';
    pillsGroup.appendChild(
      el('span', { className: 'rc-pill', 'data-tone': tone, text: `Claude 5h:${h5} 周:${wk}` })
    );
  }
  if (q?.gemini && (q.gemini.fiveHourRemainingPct !== null || q.gemini.weeklyRemainingPct !== null)) {
    const h5 = q.gemini.fiveHourRemainingPct !== null ? `${Math.round(q.gemini.fiveHourRemainingPct)}%` : '--';
    const wk = q.gemini.weeklyRemainingPct !== null ? `${Math.round(q.gemini.weeklyRemainingPct)}%` : '--';
    pillsGroup.appendChild(
      el('span', { className: 'rc-pill', 'data-tone': 'info', text: `Gemini 5h:${h5} 周:${wk}` })
    );
  }

  const tu = overview.todayUsage;
  if (tu && (tu.totalTokens > 0 || tu.requests > 0)) {
    pillsGroup.appendChild(
      el('span', {
        className: 'rc-pill',
        'data-tone': 'neutral',
        text: `今日 ${formatCompactTokens(tu.totalTokens)} tok (${tu.requests} req)`,
      })
    );
  } else {
    pillsGroup.appendChild(
      el('span', { className: 'rc-pill', 'data-tone': 'neutral', text: '今日 0 tok' })
    );
  }

  const projCount = Array.isArray(overview.projects) ? overview.projects.length : 0;
  const activeProj = selectedProjectId && Array.isArray(overview.projects)
    ? overview.projects.find((p) => p.id === selectedProjectId)
    : null;
  const toggleBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm',
    'aria-expanded': open ? 'true' : 'false',
    text: activeProj
      ? `项目: ${activeProj.name} (${projCount})`
      : `项目 & Worktree (${projCount})`,
    onClick: () => onToggleProjects?.(),
  });

  container.append(pillsGroup, toggleBtn);
}

export function renderProjectsDrawer(
  container,
  { overview, open, selectedProjectId = '', onSelectProject, onClose } = {}
) {
  if (!container) return;
  clearNode(container);

  if (!open || !overview) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  const head = el(
    'div',
    { className: 'rc-drawer-head' },
    el('strong', { text: 'Projects & Git Worktrees（只读视图）' }),
    el(
      'div',
      { className: 'rc-dock-group' },
      selectedProjectId
        ? el('button', {
            type: 'button',
            className: 'rc-btn is-sm',
            text: '清除筛选',
            onClick: () => onSelectProject?.(''),
          })
        : null,
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm',
        text: '收起',
        onClick: () => onClose?.(),
      })
    )
  );
  container.appendChild(head);

  const projects = Array.isArray(overview.projects) ? overview.projects : [];
  if (projects.length === 0) {
    container.appendChild(el('div', { className: 'rc-convo-meta', text: '暂未发现已授权本地项目目录。' }));
    return;
  }

  const grid = el('div', { className: 'rc-project-grid' });
  for (const proj of projects) {
    const isSelected = Boolean(selectedProjectId && selectedProjectId === proj.id);
    const wtList = Array.isArray(proj.worktrees) ? proj.worktrees : [];
    const wtChips = el('div', { className: 'rc-convo-meta' });
    for (const wt of wtList.slice(0, 6)) {
      const label = wt.branch || wt.name || 'worktree';
      wtChips.appendChild(
        el('span', {
          className: 'rc-pill',
          'data-tone': wt.isMain ? 'neutral' : 'info',
          text: wt.isMain ? `${label} (main)` : label,
        })
      );
    }
    if (wtList.length === 0) {
      wtChips.appendChild(el('span', { className: 'rc-convo-meta', text: '非 Git 仓库或无 worktree' }));
    }

    const card = el(
      'div',
      { className: 'rc-project-card', 'data-selected': isSelected ? 'true' : 'false' },
      el(
        'div',
        { className: 'rc-convo-top' },
        el('span', { className: 'rc-convo-title', text: proj.name || 'Project' }),
        el('button', {
          type: 'button',
          className: 'rc-btn is-sm',
          text: isSelected ? '取消筛选' : '只看此项目',
          onClick: () => onSelectProject?.(isSelected ? '' : proj.id),
        })
      ),
      el('div', { className: 'rc-mono', text: proj.shortPath || '' }),
      wtChips
    );
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

export function renderResumeBanner(
  container,
  { resumeState, canWrite = false, online = false, needTurboConfirm = false, turboConfirmed = false, busy = false, onResume } = {}
) {
  if (!container) return;
  clearNode(container);

  if (!resumeState || resumeState.interrupted !== true || resumeState.active === true || resumeState.lastIdx < 0) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  const disabled = !canWrite || !online || busy || (needTurboConfirm && !turboConfirmed);
  let hint = '';
  if (!canWrite) hint = '当前设备为只读模式 (observe)，不可触发续跑';
  else if (!online) hint = '宿主离线，无法静默续跑';
  else if (needTurboConfirm && !turboConfirmed) hint = '请先勾选下方 TURBO 高危确认框';

  appendNodes(
    container,
    el(
      'div',
      { className: 'rc-studio-card-head' },
      el('span', { className: 'rc-resume-title', text: `▶ ${formatResumeReason(resumeState.reason)}` }),
      el('span', { className: 'rc-pill rc-resume-step-pill', 'data-tone': 'warn', text: `step #${resumeState.lastIdx}` })
    ),
    hint ? el('div', { className: 'rc-convo-meta', text: hint }) : null,
    el(
      'div',
      { className: 'rc-dock-group rc-resume-actions' },
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm is-primary',
        disabled,
        text: busy ? '续跑发送中…' : '▶ 静默续跑 (Resume)',
        onClick: () => onResume?.(resumeState),
      })
    )
  );
}

export function buildOpusReviewPrompt(prop, reviewerModel = 'carbon') {
  const isOpus = String(reviewerModel || '').toLowerCase() === 'opus';
  const modelId = isOpus ? 'claude-opus-5-5-high' : 'gemini-4-carbon-high';
  const modelLabel = isOpus ? 'Opus High' : 'Carbon High';
  const kind = String(prop?.kind || prop?.trigger || 'review');
  const reason = String(prop?.summary || prop?.reason || '检查点审查建议').trim();
  return `请加载 opus-gate 技能，直接发起一次 ${modelLabel}（${modelId}）审查（不要走配额门禁），针对当前检查点 [${kind}]：${reason}，检查变更风险、边界问题与回归隐患，给出明确结论和可落地的修复建议。`;
}

export function renderOpusGateBanner(
  container,
  { opusGate, canWrite = false, online = true, busy = false, reviewerModel = 'carbon', onReview = null, onDismiss } = {}
) {
  if (!container) return;
  clearNode(container);

  const prop = opusGate?.proposal;
  if (!prop || !prop.id) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  const isOpus = String(reviewerModel || '').toLowerCase() === 'opus';
  const reviewLabel = isOpus ? '✦ 发起 Opus 审查' : '✦ 发起 Carbon 审查';

  appendNodes(
    container,
    el(
      'div',
      { className: 'rc-studio-card-head' },
      el('span', { text: `🛡 Opus Gate 检查点建议 (${prop.kind || prop.trigger || 'review'})` }),
      prop.recommendedTier
        ? el('span', { className: 'rc-pill', 'data-tone': 'warn', text: `建议 ${prop.recommendedTier}` })
        : null
    ),
    el('div', { className: 'rc-convo-meta', text: prop.summary || prop.reason || '检测到潜在高风险变更建议复核。' }),
    canWrite
      ? el(
          'div',
          { className: 'rc-dock-group' },
          onReview
            ? el('button', {
                type: 'button',
                className: 'rc-btn is-sm is-primary rc-opus-review-btn',
                disabled: busy || !online,
                text: busy ? '处理中…' : reviewLabel,
                onClick: () => onReview?.(prop, isOpus ? 'opus' : 'carbon'),
              })
            : null,
          el('button', {
            type: 'button',
            className: 'rc-btn is-sm rc-opus-dismiss-btn',
            disabled: busy,
            text: busy ? '处理中…' : '忽略建议',
            onClick: () => onDismiss?.(prop),
          })
        )
      : null
  );
}

export function renderMobileMoreMenu(
  container,
  {
    open = false,
    hostLine = '',
    deviceLine = '',
    role = 'observe',
    presetLabel = '',
    themeLabel = '',
    layoutLabel = '',
    overviewLabel = '查看配额与概览',
    alertLabel = '',
    keepAliveLabel = '',
    updateLabel = '',
    onReconnectNow = null,
    onToggleKeepAlive = null,
    onCheckForUpdate = null,
    onToggleAlerts = null,
    onCycleTheme = null,
    onCycleLayout = null,
    onOpenOverview = null,
    onRefreshAll = null,
    onOpenNativeSettings = null,
    onUnpair = null,
  } = {}
) {
  if (!container) return;
  clearNode(container);
  if (!open) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');
  appendNodes(
    container,
    el(
      'div',
      { className: 'rc-more-meta' },
      el('div', { className: 'rc-more-meta-line', text: `${hostLine} · ${String(role || 'observe').toUpperCase()}` }),
      deviceLine ? el('div', { className: 'rc-more-meta-sub', text: `设备：${deviceLine}` }) : null,
      el('div', { className: 'rc-more-meta-sub', text: `权限策略：${presetLabel || '--'}` })
    ),
    onReconnectNow
      ? el('button', {
          type: 'button',
          className: 'rc-more-item',
          text: '立即重新连接',
          onClick: (ev) => {
            ev?.stopPropagation?.();
            onReconnectNow?.();
          },
        })
      : null,
    keepAliveLabel && onToggleKeepAlive
      ? el('button', {
          type: 'button',
          className: 'rc-more-item',
          text: keepAliveLabel,
          onClick: (ev) => {
            ev?.stopPropagation?.();
            onToggleKeepAlive?.();
          },
        })
      : null,
    onOpenNativeSettings
      ? el('button', {
          type: 'button',
          className: 'rc-more-item',
          text: '原生应用设置（服务器 / 缓存）',
          onClick: (ev) => {
            ev?.stopPropagation?.();
            onOpenNativeSettings?.();
          },
        })
      : null,
    updateLabel && onCheckForUpdate
      ? el('button', {
          type: 'button',
          className: 'rc-more-item',
          text: updateLabel,
          onClick: (ev) => {
            ev?.stopPropagation?.();
            onCheckForUpdate?.();
          },
        })
      : null,
    alertLabel && onToggleAlerts
      ? el('button', {
          type: 'button',
          className: 'rc-more-item',
          text: alertLabel,
          onClick: (ev) => {
            ev?.stopPropagation?.();
            onToggleAlerts?.();
          },
        })
      : null,
    themeLabel && onCycleTheme
      ? el('button', {
          type: 'button',
          className: 'rc-more-item',
          text: themeLabel,
          onClick: (ev) => {
            ev?.stopPropagation?.();
            onCycleTheme?.();
          },
        })
      : null,
    el('button', {
      type: 'button',
      className: 'rc-more-item',
      text: `切换${layoutLabel}`,
      onClick: (ev) => {
        ev?.stopPropagation?.();
        onCycleLayout?.();
      },
    }),
    el('button', {
      type: 'button',
      className: 'rc-more-item',
      text: overviewLabel || '查看配额与概览',
      onClick: (ev) => {
        ev?.stopPropagation?.();
        onOpenOverview?.();
      },
    }),
    el('button', {
      type: 'button',
      className: 'rc-more-item',
      text: '刷新全部数据',
      onClick: (ev) => {
        ev?.stopPropagation?.();
        onRefreshAll?.();
      },
    }),
    el('div', { className: 'rc-more-divider' }),
    el('button', {
      type: 'button',
      className: 'rc-more-item is-danger',
      text: '解除并重新配对',
      onClick: (ev) => {
        ev?.stopPropagation?.();
        onUnpair?.();
      },
    })
  );
}
