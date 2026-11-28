/**
 * AGY Studio Remote PWA — Sidebar Filter Chips, Approvals Queue & Conversation List
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  clearNode,
  collectPendingApprovals,
  el,
  filterConversations,
  formatRelativeTime,
  getEffectiveWaitingCount,
  isRunningStatus,
  normalizeRunStatus,
} from './ui-helpers.mjs';

function resolveConversationProjectInfo(state, c) {
  const wtMeta = state.studioOverview?.worktreeByCid?.[c.id] || null;
  const projects = Array.isArray(state.studioOverview?.projects) ? state.studioOverview.projects : [];
  const pid = String(c.projectId || wtMeta?.projectId || '');
  const matchedById = pid ? projects.find((p) => p && p.id === pid) || null : null;
  if (matchedById) {
    return { key: matchedById.id, projectId: matchedById.id, name: matchedById.name || wtMeta?.repoName || 'Project', project: matchedById };
  }
  if (wtMeta?.repoName) {
    const byName = projects.filter((p) => p && p.name === wtMeta.repoName);
    const uniqueProj = byName.length === 1 ? byName[0] : null;
    return { key: uniqueProj?.id || `name:${wtMeta.repoName}`, projectId: uniqueProj?.id || '', name: wtMeta.repoName, project: uniqueProj };
  }
  return { key: 'standalone', projectId: '', name: '独立会话', project: null };
}

function buildConversationRow(state, c, onSelectConversation) {
  const waitCount = getEffectiveWaitingCount(state, c);
  const statusInfo = normalizeRunStatus(c.status);
  const isSelected = state.selectedId === c.id;
  const wtMeta = state.studioOverview?.worktreeByCid?.[c.id] || null;
  return el(
    'button',
    {
      type: 'button',
      className: 'rc-convo-item',
      'data-selected': isSelected ? 'true' : 'false',
      'data-waiting': waitCount > 0 ? 'true' : 'false',
      onClick: () => onSelectConversation?.(c.id),
    },
    el(
      'div',
      { className: 'rc-convo-top' },
      el('span', { className: 'rc-convo-dot', 'data-tone': waitCount > 0 ? 'warn' : statusInfo.tone }),
      el('span', { className: 'rc-convo-title', text: c.title || c.summary || c.id.slice(0, 8) }),
      waitCount > 0
        ? el('span', { className: 'rc-pill rc-convo-status', 'data-tone': 'warn', text: `待审批 ${waitCount}` })
        : el('span', { className: 'rc-pill rc-convo-status', 'data-tone': statusInfo.tone, text: statusInfo.label }),
      c.lastModifiedTime
        ? el('span', { className: 'rc-convo-time', text: formatRelativeTime(c.lastModifiedTime) })
        : null
    ),
    el(
      'div',
      { className: 'rc-convo-meta' },
      c.parentConversationId ? el('span', { className: 'rc-pill', text: '子代理' }) : null,
      wtMeta?.branch ? el('span', { className: 'rc-pill rc-convo-branch', 'data-tone': 'info', text: `⎇ ${wtMeta.branch}` }) : null,
      el('span', { text: `${c.stepCount ?? 0} 步` }),
      c.lastModifiedTime
        ? el('span', { className: 'rc-convo-meta-time', text: `· ${formatRelativeTime(c.lastModifiedTime)}` })
        : null
    )
  );
}

export function renderFilterChipsView({
  state,
  refs,
  onSelectFilter,
  onSelectGroupBy,
  onToggleSubagents,
  onSelectProject = null,
}) {
  clearNode(refs.filterRow);
  clearNode(refs.groupRow);
  if (refs.projFilterRow) clearNode(refs.projFilterRow);

  const pendingCount = collectPendingApprovals(state).length;
  const runningCount = state.conversations.filter(
    (c) => (state.includeSubagents || !c.parentConversationId) && isRunningStatus(c.status)
  ).length;

  refs.navApprovalsBadge.textContent = String(pendingCount);
  if (pendingCount > 0) {
    refs.navApprovalsBadge.classList.remove('rc-hidden');
  } else {
    refs.navApprovalsBadge.classList.add('rc-hidden');
  }

  const filters = [
    { id: 'all', label: `全部 (${state.conversations.filter((c) => state.includeSubagents || !c.parentConversationId).length})` },
    { id: 'waiting', label: `待审批 (${pendingCount})` },
    { id: 'running', label: `运行中 (${runningCount})` },
  ];

  for (const f of filters) {
    refs.filterRow.appendChild(
      el('button', {
        type: 'button',
        className: 'rc-chip',
        'aria-pressed': state.filter === f.id ? 'true' : 'false',
        text: f.label,
        onClick: () => onSelectFilter?.(f.id),
      })
    );
  }

  refs.groupRow.appendChild(el('span', { className: 'rc-group-label', text: '排列' }));
  for (const grp of [
    { id: 'recent', label: '时间流' },
    { id: 'project', label: '按项目' },
  ]) {
    refs.groupRow.appendChild(
      el('button', {
        type: 'button',
        className: 'rc-chip is-compact',
        'aria-pressed': state.sidebarGroupBy === grp.id ? 'true' : 'false',
        text: grp.label,
        onClick: () => onSelectGroupBy?.(grp.id),
      })
    );
  }

  refs.groupRow.appendChild(
    el('button', {
      type: 'button',
      className: 'rc-chip is-compact rc-group-subagent',
      'aria-pressed': state.includeSubagents ? 'true' : 'false',
      text: '含子代理',
      onClick: () => onToggleSubagents?.(),
    })
  );

  if (refs.projFilterRow) {
    const projects = Array.isArray(state.studioOverview?.projects) ? state.studioOverview.projects : [];
    if (projects.length === 0) {
      refs.projFilterRow.classList.add('rc-hidden');
    } else {
      refs.projFilterRow.classList.remove('rc-hidden');
      const countByProj = new Map();
      for (const c of state.conversations) {
        if (!state.includeSubagents && c.parentConversationId) continue;
        const info = resolveConversationProjectInfo(state, c);
        if (info.projectId) {
          countByProj.set(info.projectId, (countByProj.get(info.projectId) || 0) + 1);
        }
      }
      const projSelect = el(
        'select',
        {
          className: 'rc-select rc-sidebar-proj-select',
          'aria-label': '按项目筛选对话',
          value: state.selectedProjectId || '',
          onChange: (ev) => onSelectProject?.(String(ev?.target?.value || '')),
        },
        el('option', {
          value: '',
          text: '项目：全部项目',
          ...(!state.selectedProjectId ? { selected: 'selected' } : {}),
        }),
        ...projects.map((p) => {
          const n = countByProj.get(p.id) || 0;
          const active = state.selectedProjectId === p.id;
          return el('option', {
            value: p.id,
            text: `${p.name || 'Project'} (${n})`,
            ...(active ? { selected: 'selected' } : {}),
          });
        })
      );
      refs.projFilterRow.appendChild(projSelect);
      if (state.selectedProjectId) {
        refs.projFilterRow.appendChild(
          el('button', {
            type: 'button',
            className: 'rc-chip is-compact rc-proj-reset-chip',
            title: '清除项目筛选',
            text: '全部',
            onClick: () => onSelectProject?.(''),
          })
        );
      }
    }
  }
}

export function renderSidebarListView({
  state,
  refs,
  resolvedLayoutMode,
  onSelectConversation,
  onToggleCollapseProject = null,
  onExpandProjectGroup = null,
  onSelectProject = null,
  onOpenProjectGit = null,
  onOpenNewChatInProject = null,
}) {
  clearNode(refs.sidebarList);

  const pendingApprovals = collectPendingApprovals(state);
  const mobileApprovalsOnly = resolvedLayoutMode === 'mobile' && state.mobileTab === 'approvals';

  if (pendingApprovals.length > 0) {
    refs.sidebarList.appendChild(
      el('div', { className: 'rc-sec-label', text: `待审批队列 (${pendingApprovals.length})` })
    );
    for (const item of pendingApprovals) {
      const preview = item.commandLine || item.action || item.interactionCase || '等待确认';
      refs.sidebarList.appendChild(
        el(
          'button',
          {
            type: 'button',
            className: 'rc-approval-item',
            onClick: () => onSelectConversation?.(item.cascadeId),
          },
          el(
            'div',
            { className: 'rc-convo-top' },
            el('span', {
              className: 'rc-convo-title',
              text: item.parentTitle ? `[子代理] ${item.title}` : item.title,
            }),
            el('span', { className: 'rc-pill', 'data-tone': 'warn', text: item.toolName || '审批' })
          ),
          el('div', { className: 'rc-mono', text: preview })
        )
      );
    }
  } else if (mobileApprovalsOnly) {
    refs.sidebarList.appendChild(
      el('div', { className: 'rc-empty', text: '当前没有等待审批的桌面端操作。' })
    );
    return;
  }

  if (mobileApprovalsOnly) {
    return;
  }

  const list = filterConversations(state);
  if (list.length === 0) {
    refs.sidebarList.appendChild(
      el('div', { className: 'rc-sec-label', text: '会话列表 (0)' })
    );
    refs.sidebarList.appendChild(
      el('div', { className: 'rc-empty', text: '当前筛选条件下没有会话' })
    );
    return;
  }

  if (state.sidebarGroupBy === 'project') {
    const groups = new Map();
    for (const c of list) {
      const info = resolveConversationProjectInfo(state, c);
      if (!groups.has(info.key)) {
        groups.set(info.key, { ...info, items: [], hasRunning: false });
      }
      const g = groups.get(info.key);
      g.items.push(c);
      if (isRunningStatus(c.status)) g.hasRunning = true;
    }

    const forceShowAll = Boolean(String(state.searchQuery || '').trim() || state.selectedProjectId);
    const DEFAULT_GROUP_LIMIT = 5;

    for (const grp of groups.values()) {
      const isCollapsed = !forceShowAll && Boolean(state.collapsedProjects?.has?.(grp.key));
      const isExpanded = forceShowAll || Boolean(state.expandedProjectGroups?.has?.(grp.key));
      const visibleItems = isCollapsed
        ? []
        : isExpanded || grp.items.length <= DEFAULT_GROUP_LIMIT
          ? grp.items
          : grp.items.slice(0, DEFAULT_GROUP_LIMIT);

      const actionChildren = [];
      if (grp.projectId && onSelectProject) {
        const filtered = state.selectedProjectId === grp.projectId;
        actionChildren.push(
          el('button', {
            type: 'button',
            className: 'rc-proj-act-btn',
            title: filtered ? '取消仅看此项目' : '仅看此项目对话',
            text: filtered ? '全部' : '仅看',
            onClick: (ev) => {
              ev?.stopPropagation?.();
              onSelectProject(filtered ? '' : grp.projectId);
            },
          })
        );
      }
      if (grp.project?.isGitRepo && onOpenProjectGit) {
        actionChildren.push(
          el('button', {
            type: 'button',
            className: 'rc-proj-act-btn',
            title: '查看该项目 Git 状态与 Diff',
            text: 'Git',
            onClick: (ev) => {
              ev?.stopPropagation?.();
              onOpenProjectGit({ projectId: grp.projectId });
            },
          })
        );
      }
      if (grp.projectId && onOpenNewChatInProject) {
        actionChildren.push(
          el('button', {
            type: 'button',
            className: 'rc-proj-act-btn',
            title: `在 ${grp.name} 下新建会话`,
            text: '+',
            onClick: (ev) => {
              ev?.stopPropagation?.();
              onOpenNewChatInProject(grp.projectId);
            },
          })
        );
      }

      const sectionEl = el(
        'div',
        { className: 'rc-proj-group', 'data-collapsed': isCollapsed ? 'true' : 'false' },
        el(
          'div',
          {
            className: 'rc-proj-group-head',
            role: 'button',
            tabindex: '0',
            'aria-expanded': isCollapsed ? 'false' : 'true',
            onClick: () => onToggleCollapseProject?.(grp.key),
            onKeydown: (ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onToggleCollapseProject?.(grp.key);
              }
            },
          },
          el('span', { className: 'rc-proj-chevron', text: isCollapsed ? '▸' : '▾' }),
          el('span', { className: 'rc-proj-group-name', text: grp.name }),
          el('span', { className: 'rc-proj-group-count', text: String(grp.items.length) }),
          grp.hasRunning ? el('span', { className: 'rc-proj-run-dot', title: '包含运行中会话' }) : null,
          actionChildren.length > 0 ? el('div', { className: 'rc-proj-group-actions' }, ...actionChildren) : null
        )
      );

      if (!isCollapsed) {
        const itemsWrap = el('div', { className: 'rc-proj-group-items' });
        for (const c of visibleItems) {
          itemsWrap.appendChild(buildConversationRow(state, c, onSelectConversation));
        }
        if (grp.items.length > visibleItems.length) {
          const restCount = grp.items.length - visibleItems.length;
          itemsWrap.appendChild(
            el('button', {
              type: 'button',
              className: 'rc-proj-more-btn',
              text: `展开其余 ${restCount} 条会话`,
              onClick: () => onExpandProjectGroup?.(grp.key),
            })
          );
        }
        sectionEl.appendChild(itemsWrap);
      }
      refs.sidebarList.appendChild(sectionEl);
    }
    return;
  }

  refs.sidebarList.appendChild(
    el('div', { className: 'rc-sec-label', text: `会话列表 (${list.length})` })
  );
  for (const c of list) {
    refs.sidebarList.appendChild(buildConversationRow(state, c, onSelectConversation));
  }
}
