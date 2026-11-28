/**
 * AGY Studio Remote PWA — Sandboxed Read-Only Artifact & Git Diff Viewer Drawer
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import { appendNodes, clearNode, copyTextWithFeedback, el, formatRelativeTime } from './ui-helpers.mjs';
import { formatWriteError } from './mobile-enhancements.mjs';
import { renderSafeMarkdown } from './timeline-view.mjs';

function formatBytes(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${Math.round(v)} B`;
}

function artifactKindBadge(kind) {
  if (kind === 'plan') return { label: '计划', tone: 'info' };
  if (kind === 'walkthrough') return { label: '总结', tone: 'ok' };
  if (kind === 'task') return { label: '清单', tone: 'warn' };
  return { label: '文档', tone: 'neutral' };
}

function statusBadgeTone(status) {
  if (status === 'A' || status === '?') return 'ok';
  if (status === 'D') return 'danger';
  if (status === 'R') return 'info';
  return 'warn';
}

export function renderUnifiedDiffDom(diffText) {
  const wrap = el('div', { className: 'rc-diff-code' });
  const text = String(diffText || '');
  if (!text.trim()) {
    wrap.appendChild(el('div', { className: 'rc-empty', text: '无文本差异（可能是空变更或二进制文件）。' }));
    return wrap;
  }
  const lines = text.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    let kind = 'ctx';
    if (line.startsWith('@@')) kind = 'hunk';
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git') || line.startsWith('index ')) kind = 'meta';
    else if (line.startsWith('+')) kind = 'add';
    else if (line.startsWith('-')) kind = 'del';
    wrap.appendChild(
      el(
        'div',
        { className: `rc-diff-line is-${kind}` },
        el('span', { className: 'rc-diff-text', text: line || ' ' })
      )
    );
  }
  return wrap;
}

function renderArtifactsTab(viewer, { canWrite, online, onSelectArtifact, onRefreshArtifacts, onQuickReply }) {
  const body = el('div', { className: 'rc-viewer-body' });
  if (viewer.artifactsLoading) {
    body.appendChild(el('div', { className: 'rc-empty', text: '正在加载会话文档列表…' }));
    return body;
  }
  if (viewer.artifactsError) {
    body.appendChild(el('div', { className: 'rc-error-banner', text: viewer.artifactsError }));
    return body;
  }
  const list = Array.isArray(viewer.artifacts) ? viewer.artifacts : [];
  if (list.length === 0) {
    body.appendChild(
      el(
        'div',
        { className: 'rc-empty' },
        el('div', { text: '当前会话暂无 Markdown 文档（如 implementation_plan.md / walkthrough.md）。' }),
        el('button', {
          type: 'button',
          className: 'rc-btn is-sm',
          text: '重新扫描',
          onClick: () => onRefreshArtifacts?.(),
        })
      )
    );
    return body;
  }

  // Selector strip
  const chips = el('div', { className: 'rc-viewer-chips' });
  for (const item of list) {
    const selected = viewer.activeArtifactName === item.name;
    const badge = artifactKindBadge(item.kind);
    chips.appendChild(
      el(
        'button',
        {
          type: 'button',
          className: 'rc-chip',
          'aria-pressed': selected ? 'true' : 'false',
          onClick: () => onSelectArtifact?.(item.name),
        },
        el('span', { className: 'rc-pill', 'data-tone': badge.tone, text: badge.label }),
        el('span', { text: item.name })
      )
    );
  }
  body.appendChild(chips);

  if (viewer.artifactReadLoading) {
    body.appendChild(el('div', { className: 'rc-empty', text: '正在读取文档内容…' }));
    return body;
  }
  if (viewer.artifactReadError) {
    body.appendChild(el('div', { className: 'rc-error-banner', text: viewer.artifactReadError }));
    return body;
  }
  const doc = viewer.activeArtifactDoc;
  if (!doc) {
    body.appendChild(el('div', { className: 'rc-empty', text: '请选择上方文档查看内容。' }));
    return body;
  }

  const copyBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm',
    text: '复制全文',
    onClick: () => copyTextWithFeedback(copyBtn, doc.content || '', { idleText: '复制全文', doneText: '已复制' }),
  });

  const actionButtons = [copyBtn];
  if (canWrite && online && doc.kind === 'plan') {
    actionButtons.push(
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm is-primary',
        text: '填入「批准按计划执行」',
        onClick: () => onQuickReply?.('批准该计划，请开始按方案实施。'),
      })
    );
  }

  body.appendChild(
    el(
      'div',
      { className: 'rc-viewer-meta-row' },
      el('span', {
        className: 'rc-convo-meta',
        text: `${doc.name} · ${formatBytes(doc.sizeBytes)}${doc.updatedAt ? ` · ${formatRelativeTime(doc.updatedAt)}` : ''}`,
      }),
      el('div', { className: 'rc-dock-group' }, ...actionButtons)
    )
  );
  if (doc.truncated) {
    body.appendChild(
      el('div', { className: 'rc-viewer-warn', text: '文档超过 128 KB 上限，已截断显示前段内容。' })
    );
  }
  body.appendChild(el('div', { className: 'rc-viewer-md' }, renderSafeMarkdown(doc.content || '')));
  return body;
}

function renderGitTab(
  viewer,
  { projects = [], onRefreshGit, onSelectProjectGit, onSelectDirtyFile, onSelectCommit, onSelectCommitFile, onBackToGitList }
) {
  const body = el('div', { className: 'rc-viewer-body' });
  if (viewer.gitLoading) {
    body.appendChild(el('div', { className: 'rc-empty', text: '正在读取仓库 Git 状态…' }));
    return body;
  }
  const buildProjectPicker = () =>
    Array.isArray(projects) && projects.length > 0 && onSelectProjectGit
      ? el(
          'div',
          { className: 'rc-viewer-file-list' },
          ...projects.map((p) =>
            el(
              'button',
              {
                type: 'button',
                className: 'rc-viewer-file-row',
                onClick: () => onSelectProjectGit(p.id),
              },
              el('span', { className: 'rc-pill', 'data-tone': 'info', text: 'Git' }),
              el('span', { className: 'rc-viewer-file-path', text: p.name || p.shortPath || p.id }),
              p.shortPath ? el('span', { className: 'rc-viewer-file-stat', text: p.shortPath }) : null
            )
          )
        )
      : null;

  if (viewer.gitError) {
    body.appendChild(el('div', { className: 'rc-error-banner', text: viewer.gitError }));
    const fallbackPicker = buildProjectPicker();
    if (fallbackPicker) {
      body.appendChild(el('div', { className: 'rc-convo-meta', text: '可选择其他已授权仓库查看 Git 变更：' }));
      body.appendChild(fallbackPicker);
    }
    return body;
  }

  const status = viewer.gitStatus;
  if (!status) {
    const pickerList = buildProjectPicker();
    body.appendChild(
      el(
        'div',
        { className: 'rc-empty' },
        el('div', {
          text: pickerList
            ? '当前会话未绑定特定 Git 分支，可直接选择下方项目查看变更：'
            : '当前会话未绑定本地 Git 仓库，可在概览页选择任意项目查看 Git 变更。',
        }),
        pickerList ? null : el('button', {
          type: 'button',
          className: 'rc-btn is-sm',
          text: '重试读取',
          onClick: () => onRefreshGit?.(),
        })
      )
    );
    if (pickerList) body.appendChild(pickerList);
    return body;
  }

  // Repo header summary
  const repoPills = [
    el('span', { className: 'rc-pill', 'data-tone': 'info', text: `⎇ ${status.branch || 'HEAD'}` }),
    el('span', {
      className: 'rc-pill',
      'data-tone': status.dirtyCount > 0 ? 'warn' : 'ok',
      text: status.dirtyCount > 0 ? `${status.dirtyCount} 个修改` : '工作区干净',
    }),
  ];
  if (status.added > 0 || status.deleted > 0) {
    repoPills.push(el('span', { className: 'rc-pill', text: `+${status.added} / -${status.deleted}` }));
  }
  if (status.ahead > 0) {
    repoPills.push(el('span', { className: 'rc-pill', 'data-tone': 'info', text: `↑${status.ahead}` }));
  }
  if (status.behind > 0) {
    repoPills.push(el('span', { className: 'rc-pill', 'data-tone': 'warn', text: `↓${status.behind}` }));
  }

  const activeProjId = viewer.projectId || status.projectId || '';
  const switcherSelect =
    Array.isArray(projects) && projects.length > 1 && onSelectProjectGit
      ? el(
          'select',
          {
            className: 'rc-select rc-viewer-proj-select',
            'aria-label': '切换仓库',
            title: '切换查看其他项目仓库',
            value: activeProjId,
            onChange: (ev) => {
              const nextPid = String(ev.target?.value || '');
              if (nextPid) onSelectProjectGit(nextPid);
            },
          },
          ...projects.map((p) =>
            el('option', {
              value: p.id,
              text: p.name || p.shortPath || p.id,
              ...(p.id === activeProjId ? { selected: 'selected' } : {}),
            })
          )
        )
      : null;

  body.appendChild(
    el(
      'div',
      { className: 'rc-viewer-meta-row' },
      el(
        'div',
        { className: 'rc-viewer-repo-head' },
        el('strong', { text: status.repoName || 'Git 仓库' }),
        status.shortPath ? el('span', { className: 'rc-mono rc-ov-muted', text: status.shortPath }) : null
      ),
      el(
        'div',
        { className: 'rc-dock-group' },
        switcherSelect,
        el('button', {
          type: 'button',
          className: 'rc-btn is-sm',
          text: '刷新',
          onClick: () => onRefreshGit?.(),
        })
      )
    )
  );
  body.appendChild(el('div', { className: 'rc-studio-pills' }, ...repoPills));

  // If viewing a specific file diff
  if (viewer.diffTarget) {
    body.appendChild(
      el(
        'div',
        { className: 'rc-viewer-subhead' },
        el('button', {
          type: 'button',
          className: 'rc-btn is-sm',
          text: '‹ 返回列表',
          onClick: () => onBackToGitList?.(),
        }),
        el('span', {
          className: 'rc-mono rc-viewer-filepath',
          text: viewer.diffTarget.commitHash
            ? `${viewer.diffTarget.commitHash.slice(0, 7)} · ${viewer.diffTarget.filePath}`
            : viewer.diffTarget.filePath,
        })
      )
    );
    if (viewer.diffLoading) {
      body.appendChild(el('div', { className: 'rc-empty', text: '正在加载单文件 Diff…' }));
      return body;
    }
    if (viewer.diffError) {
      body.appendChild(el('div', { className: 'rc-error-banner', text: viewer.diffError }));
      return body;
    }
    if (viewer.diffResult?.truncated) {
      body.appendChild(
        el('div', { className: 'rc-viewer-warn', text: 'Diff 超过 64 KB 上限，已截断显示。' })
      );
    }
    body.appendChild(renderUnifiedDiffDom(viewer.diffResult?.diff || ''));
    return body;
  }

  // If viewing files in a selected commit
  if (viewer.selectedCommit) {
    body.appendChild(
      el(
        'div',
        { className: 'rc-viewer-subhead' },
        el('button', {
          type: 'button',
          className: 'rc-btn is-sm',
          text: '‹ 返回仓库',
          onClick: () => onBackToGitList?.(true),
        }),
        el('span', {
          className: 'rc-mono',
          text: `${viewer.selectedCommit.shortHash} ${viewer.selectedCommit.subject || ''}`,
        })
      )
    );
    if (viewer.commitFilesLoading) {
      body.appendChild(el('div', { className: 'rc-empty', text: '正在加载提交文件列表…' }));
      return body;
    }
    if (viewer.commitFilesError) {
      body.appendChild(el('div', { className: 'rc-error-banner', text: viewer.commitFilesError }));
      return body;
    }
    const cFiles = Array.isArray(viewer.commitFiles) ? viewer.commitFiles : [];
    const listWrap = el('div', { className: 'rc-viewer-file-list' });
    for (const f of cFiles) {
      listWrap.appendChild(
        el(
          'button',
          {
            type: 'button',
            className: 'rc-viewer-file-row',
            disabled: Boolean(f.sensitive),
            onClick: () => {
              if (!f.sensitive) onSelectCommitFile?.(viewer.selectedCommit.hash, f.path);
            },
          },
          el('span', { className: 'rc-pill', 'data-tone': f.sensitive ? 'danger' : statusBadgeTone(f.status), text: f.status || 'M' }),
          el('span', { className: 'rc-mono rc-viewer-file-path', text: f.path }),
          f.sensitive
            ? el('span', { className: 'rc-pill', 'data-tone': 'danger', text: '敏感已隐藏' })
            : el('span', { className: 'rc-viewer-file-stat', text: `+${f.added || 0} -${f.deleted || 0}` })
        )
      );
    }
    body.appendChild(listWrap);
    return body;
  }

  // Dirty files list
  const dirty = Array.isArray(status.dirtyFiles) ? status.dirtyFiles : [];
  body.appendChild(el('div', { className: 'rc-sec-label', text: `工作区变更 (${dirty.length})` }));
  if (dirty.length === 0) {
    body.appendChild(el('div', { className: 'rc-convo-meta', text: '当前工作区没有未提交的变更。' }));
  } else {
    const dirtyList = el('div', { className: 'rc-viewer-file-list' });
    for (const f of dirty) {
      dirtyList.appendChild(
        el(
          'button',
          {
            type: 'button',
            className: 'rc-viewer-file-row',
            disabled: Boolean(f.sensitive),
            onClick: () => {
              if (!f.sensitive) onSelectDirtyFile?.(f.path);
            },
          },
          el('span', { className: 'rc-pill', 'data-tone': f.sensitive ? 'danger' : statusBadgeTone(f.status), text: f.status || 'M' }),
          el('span', { className: 'rc-mono rc-viewer-file-path', text: f.path }),
          f.sensitive
            ? el('span', { className: 'rc-pill', 'data-tone': 'danger', text: '敏感已隐藏' })
            : el('span', { className: 'rc-viewer-file-stat', text: `+${f.added || 0} -${f.deleted || 0}` })
        )
      );
    }
    body.appendChild(dirtyList);
  }

  // Recent commits
  const commits = Array.isArray(status.commits) ? status.commits : [];
  if (commits.length > 0) {
    body.appendChild(el('div', { className: 'rc-sec-label', text: `最近提交 (${commits.length})` }));
    const commitList = el('div', { className: 'rc-viewer-file-list' });
    for (const c of commits) {
      commitList.appendChild(
        el(
          'button',
          {
            type: 'button',
            className: 'rc-viewer-commit-row',
            onClick: () => onSelectCommit?.(c),
          },
          el(
            'div',
            { className: 'rc-convo-top' },
            el('span', { className: 'rc-pill', 'data-tone': 'neutral', text: c.shortHash }),
            el('span', { className: 'rc-viewer-commit-subj', text: c.subject || '(无提交说明)' })
          ),
          el('div', {
            className: 'rc-convo-meta',
            text: `${c.author || ''}${c.date ? ` · ${formatRelativeTime(c.date)}` : ''}`,
          })
        )
      );
    }
    body.appendChild(commitList);
  }

  return body;
}

export function renderViewerDrawer(
  container,
  {
    viewer,
    projects = [],
    canWrite = false,
    online = false,
    onSwitchTab = null,
    onClose = null,
    onSelectArtifact = null,
    onRefreshArtifacts = null,
    onQuickReply = null,
    onRefreshGit = null,
    onSelectProjectGit = null,
    onSelectDirtyFile = null,
    onSelectCommit = null,
    onSelectCommitFile = null,
    onBackToGitList = null,
  } = {}
) {
  if (!container) return;
  clearNode(container);
  if (!viewer || !viewer.open) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  const tab = viewer.tab === 'git' ? 'git' : 'artifacts';
  const sheet = el(
    'div',
    {
      className: 'rc-viewer-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '文档与代码变更阅读器',
      onClick: (ev) => ev?.stopPropagation?.(),
    },
    el(
      'div',
      { className: 'rc-viewer-head' },
      el(
        'div',
        { className: 'rc-viewer-tabs' },
        el('button', {
          type: 'button',
          className: 'rc-chip',
          'aria-pressed': tab === 'artifacts' ? 'true' : 'false',
          text: '文档 (Artifacts)',
          onClick: () => onSwitchTab?.('artifacts'),
        }),
        el('button', {
          type: 'button',
          className: 'rc-chip',
          'aria-pressed': tab === 'git' ? 'true' : 'false',
          text: 'Git 变更',
          onClick: () => onSwitchTab?.('git'),
        })
      ),
      el('button', {
        type: 'button',
        className: 'rc-icon-btn',
        'aria-label': '关闭阅读器',
        text: '✕',
        onClick: () => onClose?.(),
      })
    ),
    tab === 'git'
      ? renderGitTab(viewer, {
          projects,
          onRefreshGit,
          onSelectProjectGit,
          onSelectDirtyFile,
          onSelectCommit,
          onSelectCommitFile,
          onBackToGitList,
        })
      : renderArtifactsTab(viewer, {
          canWrite,
          online,
          onSelectArtifact,
          onRefreshArtifacts,
          onQuickReply,
        })
  );

  const backdrop = el(
    'div',
    {
      className: 'rc-viewer-backdrop',
      onClick: () => onClose?.(),
    },
    sheet
  );
  appendNodes(container, backdrop);
}

export function createInitialViewerState() {
  return {
    open: false,
    tab: 'artifacts',
    cascadeId: '',
    projectId: '',
    artifacts: [],
    artifactsLoading: false,
    artifactsError: '',
    activeArtifactName: '',
    activeArtifactDoc: null,
    artifactReadLoading: false,
    artifactReadError: '',
    gitStatus: null,
    gitLoading: false,
    gitError: '',
    selectedCommit: null,
    commitFiles: [],
    commitFilesLoading: false,
    commitFilesError: '',
    diffTarget: null,
    diffResult: null,
    diffLoading: false,
    diffError: '',
  };
}

export function resolveGitScopeFromState(state, opts = {}) {
  const hasExplicitCid = Boolean(opts && Object.prototype.hasOwnProperty.call(opts, 'cascadeId'));
  const explicitPid = String(opts?.projectId || '');
  const viewerCid = String(state?.viewer?.cascadeId || '');
  const fallbackCid =
    state?.viewer?.open && state?.viewer?.projectId ? viewerCid : viewerCid || state?.selectedId || '';
  const cid = hasExplicitCid ? String(opts.cascadeId || '') : explicitPid ? '' : fallbackCid;
  const wtMeta = cid ? state?.studioOverview?.worktreeByCid?.[cid] : null;
  const projects = Array.isArray(state?.studioOverview?.projects) ? state.studioOverview.projects : [];
  let matchedUnique = '';
  if (!wtMeta?.projectId && wtMeta?.repoName) {
    const byName = projects.filter((p) => p && p.name === wtMeta.repoName);
    if (byName.length === 1) {
      matchedUnique = byName[0].id || '';
    }
  }
  const pid =
    explicitPid || state?.viewer?.projectId || wtMeta?.projectId || matchedUnique || state?.selectedProjectId || '';
  // When bound worktree was cleaned (branch cleared by studio-bridge) and repo projectId is known,
  // query by projectId directly so stale deleted worktree paths never block repo Git inspection.
  const effectiveCid = wtMeta && !wtMeta.branch && pid ? '' : cid;
  return { projectId: pid, cascadeId: effectiveCid, hasWorktreeMeta: Boolean(wtMeta) };
}

export function createViewerController({
  state,
  getHostEl,
  getWsClient,
  canSteer,
  onEnterModal,
  onLeaveModal,
  onInsertQuickReply,
}) {
  let reqSeq = 0;

  function render() {
    const host = getHostEl?.();
    if (!host) return;
    renderViewerDrawer(host, {
      viewer: state.viewer,
      projects: Array.isArray(state.studioOverview?.projects) ? state.studioOverview.projects : [],
      canWrite: Boolean(canSteer?.()),
      online: Boolean(state.hostAttached && state.wsStatus === 'connected'),
      onSwitchTab: (nextTab) => {
        state.viewer.tab = nextTab;
        if (nextTab === 'artifacts') {
          loadArtifacts(state.viewer.cascadeId || state.selectedId || '');
        } else {
          const fallbackCid = state.viewer.projectId ? '' : state.selectedId || '';
          loadGitStatus({
            cascadeId: state.viewer.cascadeId || fallbackCid,
            projectId: state.viewer.projectId || state.selectedProjectId || '',
          });
        }
        render();
      },
      onClose: () => close(),
      onSelectArtifact: (fileName) => {
        loadArtifactDoc(state.viewer.cascadeId || state.selectedId || '', fileName);
      },
      onRefreshArtifacts: () => {
        loadArtifacts(state.viewer.cascadeId || state.selectedId || '');
      },
      onQuickReply: (text) => {
        close();
        onInsertQuickReply?.(text);
      },
      onRefreshGit: () => {
        const fallbackCid = state.viewer.projectId ? '' : state.selectedId || '';
        loadGitStatus({
          cascadeId: state.viewer.cascadeId || fallbackCid,
          projectId: state.viewer.projectId || state.selectedProjectId || '',
        });
      },
      onSelectProjectGit: (projectId) => {
        loadGitStatus({ projectId, cascadeId: '' });
      },
      onSelectDirtyFile: (filePath) => {
        loadGitDiff({ filePath });
      },
      onSelectCommit: (commit) => {
        loadCommitFiles(commit);
      },
      onSelectCommitFile: (commitHash, filePath) => {
        loadGitDiff({ commitHash, filePath });
      },
      onBackToGitList: (clearCommit = false) => {
        if (state.viewer.diffTarget) {
          state.viewer.diffTarget = null;
          state.viewer.diffResult = null;
          state.viewer.diffError = '';
          state.viewer.diffLoading = false;
        } else if (clearCommit) {
          state.viewer.selectedCommit = null;
          state.viewer.commitFiles = [];
          state.viewer.commitFilesError = '';
        }
        render();
      },
    });
  }

  function close() {
    if (!state.viewer.open) return;
    state.viewer.open = false;
    render();
    onLeaveModal?.();
  }

  async function loadArtifactDoc(cascadeId, fileName) {
    const wsClient = getWsClient?.();
    if (!wsClient || !cascadeId || !fileName) return;
    const seq = ++reqSeq;
    state.viewer.activeArtifactName = fileName;
    state.viewer.activeArtifactDoc = null;
    state.viewer.artifactReadLoading = true;
    state.viewer.artifactReadError = '';
    render();
    try {
      const doc = await wsClient.readArtifact(cascadeId, fileName);
      if (seq !== reqSeq || !state.viewer.open) return;
      state.viewer.activeArtifactDoc = doc;
    } catch (err) {
      if (seq !== reqSeq || !state.viewer.open) return;
      state.viewer.artifactReadError = formatWriteError(err);
    } finally {
      if (seq === reqSeq) {
        state.viewer.artifactReadLoading = false;
        render();
      }
    }
  }

  async function loadArtifacts(cascadeId, targetFileName = '') {
    const wsClient = getWsClient?.();
    if (!wsClient || !cascadeId) {
      state.viewer.artifacts = [];
      state.viewer.artifactsLoading = false;
      state.viewer.artifactsError = cascadeId ? '网关未连接' : '请先选择一个会话';
      render();
      return;
    }
    const seq = ++reqSeq;
    state.viewer.cascadeId = cascadeId;
    state.viewer.artifactsLoading = true;
    state.viewer.artifactsError = '';
    render();
    try {
      const res = await wsClient.fetchArtifacts(cascadeId);
      if (seq !== reqSeq || !state.viewer.open) return;
      const list = Array.isArray(res?.artifacts) ? res.artifacts : [];
      state.viewer.artifacts = list;
      state.viewer.artifactsLoading = false;
      const pick =
        (targetFileName && list.find((a) => a.name === targetFileName)?.name) ||
        targetFileName ||
        list[0]?.name ||
        '';
      render();
      if (pick) {
        loadArtifactDoc(cascadeId, pick);
      }
    } catch (err) {
      if (seq !== reqSeq || !state.viewer.open) return;
      state.viewer.artifactsLoading = false;
      state.viewer.artifactsError = formatWriteError(err);
      render();
    }
  }

  function resolveGitScope(opts = {}) {
    return resolveGitScopeFromState(state, opts);
  }

  async function loadGitStatus({ projectId = '', cascadeId = '' } = {}) {
    const wsClient = getWsClient?.();
    const scope = resolveGitScope({ projectId, cascadeId });
    state.viewer.projectId = scope.projectId;
    state.viewer.cascadeId = scope.cascadeId;
    state.viewer.selectedCommit = null;
    state.viewer.commitFiles = [];
    state.viewer.commitFilesError = '';
    state.viewer.diffTarget = null;
    state.viewer.diffResult = null;
    state.viewer.diffError = '';
    const hasOverviewProjects = Array.isArray(state.studioOverview?.projects) && state.studioOverview.projects.length > 0;
    if (!wsClient || (!scope.projectId && !scope.cascadeId) || (!scope.projectId && !scope.hasWorktreeMeta && hasOverviewProjects)) {
      state.viewer.gitStatus = null;
      state.viewer.gitLoading = false;
      state.viewer.gitError = '';
      render();
      return;
    }
    const seq = ++reqSeq;
    state.viewer.gitLoading = true;
    state.viewer.gitError = '';
    render();
    try {
      const res = await wsClient.fetchProjectGitStatus(scope);
      if (seq !== reqSeq || !state.viewer.open) return;
      state.viewer.gitStatus = res;
      if (res?.projectId) state.viewer.projectId = res.projectId;
    } catch (err) {
      if (seq !== reqSeq || !state.viewer.open) return;
      state.viewer.gitStatus = null;
      state.viewer.gitError = formatWriteError(err);
    } finally {
      if (seq === reqSeq) {
        state.viewer.gitLoading = false;
        render();
      }
    }
  }

  async function loadCommitFiles(commit) {
    const wsClient = getWsClient?.();
    if (!wsClient || !commit?.hash) return;
    const scope = resolveGitScope();
    const seq = ++reqSeq;
    state.viewer.selectedCommit = commit;
    state.viewer.commitFiles = [];
    state.viewer.commitFilesLoading = true;
    state.viewer.commitFilesError = '';
    render();
    try {
      const res = await wsClient.fetchProjectGitDiff({ ...scope, commitHash: commit.hash });
      if (seq !== reqSeq || !state.viewer.open) return;
      state.viewer.commitFiles = Array.isArray(res?.files) ? res.files : [];
    } catch (err) {
      if (seq !== reqSeq || !state.viewer.open) return;
      state.viewer.commitFilesError = formatWriteError(err);
    } finally {
      if (seq === reqSeq) {
        state.viewer.commitFilesLoading = false;
        render();
      }
    }
  }

  async function loadGitDiff({ filePath = '', commitHash = '' } = {}) {
    const wsClient = getWsClient?.();
    if (!wsClient || !filePath) return;
    const scope = resolveGitScope();
    const seq = ++reqSeq;
    state.viewer.diffTarget = { filePath, commitHash };
    state.viewer.diffResult = null;
    state.viewer.diffLoading = true;
    state.viewer.diffError = '';
    render();
    try {
      const res = await wsClient.fetchProjectGitDiff({ ...scope, filePath, commitHash });
      if (seq !== reqSeq || !state.viewer.open) return;
      state.viewer.diffResult = res;
    } catch (err) {
      if (seq !== reqSeq || !state.viewer.open) return;
      state.viewer.diffError = formatWriteError(err);
    } finally {
      if (seq === reqSeq) {
        state.viewer.diffLoading = false;
        render();
      }
    }
  }

  function openArtifacts(cascadeId = '', fileName = '') {
    const cid = cascadeId || state.selectedId || '';
    const wasOpen = state.viewer.open;
    state.viewer.open = true;
    state.viewer.tab = 'artifacts';
    state.viewer.cascadeId = cid;
    if (!wasOpen) onEnterModal?.();
    loadArtifacts(cid, fileName);
  }

  function openGit({ projectId = '', cascadeId = '' } = {}) {
    const wasOpen = state.viewer.open;
    state.viewer.open = true;
    state.viewer.tab = 'git';
    state.viewer.projectId = projectId || '';
    state.viewer.cascadeId = cascadeId || (projectId ? '' : state.selectedId || '');
    if (!wasOpen) onEnterModal?.();
    loadGitStatus({ projectId: state.viewer.projectId, cascadeId: state.viewer.cascadeId });
  }

  return { render, close, openArtifacts, openGit };
}
