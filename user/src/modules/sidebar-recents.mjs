/**
 * Sidebar Enhancements: Collapsed project folder status badges, top Recents section,
 * pinned drag-to-composer, and native sidebar Projects hiding.
 */
import {
  classifyRunningSubkind,
  createBgTaskStatusClient,
  formatRunningBreakdownTooltip,
  formatRunningPillText,
  formatRunningStatusTooltip,
  pickDominantRunningSubkind,
  renderRunningGlyphHtml,
} from './sidebar-status.mjs';
import {
  attachConversationDragTransfer as attachConversationDragTransferRaw,
  attachFileDragTransfer,
  buildCiderConversationPayload as buildCiderConversationPayloadRaw,
  buildCiderFilePayload,
  extractDroppedContextMentions,
  hasDroppedContextPayload,
} from './sidebar-dnd.mjs';

export function createSidebarRecentsModule(rt) {
  const { FEAT, L, CFG_UI_STATE, trustLocalOverrides, docRoot, state: rtState, frame, later, cancelLater, escapeHtml, persistUiPrefsToDaemon, syncAttrTargetSet, hooks } = rt;
  const activeReactFiber = (...args) => hooks.activeReactFiber?.(...args);
  const getActiveCascadeId = (...args) => hooks.getActiveCascadeId?.(...args) || '';
  const appendDroppedMentionsToPdComposer = (...args) => hooks.appendDroppedMentionsToPdComposer?.(...args);
  const openProjectsView = (...args) => hooks.openProjectsView?.(...args);
  const closeProjectsView = (...args) => hooks.closeProjectsView?.(...args);

  /* ==========================================================================
   * 8. Sidebar Enhancements: Collapsed Project Status Badges + Top Recents
   *    - Purely reads in-memory Redux `trajectorySummaries` (0 network calls).
   *    - Badges automatically fade on hover to yield to native `+ / ⋯` actions.
   *    - Top `最近对话` sorts `pending > running > recent` with 0ms router switch.
   * ========================================================================== */
  const SIDEBAR_IGNORED_TYPES = new Set([21, 22, 23]);
  const PENDING_TERM_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 5l3 3-3 3"/><path d="M8 11h4.5"/></svg>';
  const PENDING_LOCK_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
  const PENDING_BELL_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 6.5a3.5 3.5 0 1 0-7 0c0 3.2-1.3 4.3-1.3 4.3h9.6s-1.3-1.1-1.3-4.3"/><path d="M6.8 13a1.3 1.3 0 0 0 2.4 0"/></svg>';
  const RECENT_PLUS_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>';
  const RECENT_PIN_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.7 2.8l3.5 3.5-1.4 1.4-.9-.3-2.6 2.6.4 1.6-1.1 1.1-2.5-2.5-2.6 2.6-.7-.7 2.6-2.6-2.5-2.5 1.1-1.1 1.6.4 2.6-2.6-.3-.9z"/></svg>';
  const RECENT_MORE_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><circle cx="3.5" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="12.5" cy="8" r="1.2"/></svg>';
  const RECENT_FOLDER_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 4.4A1.2 1.2 0 0 1 3.4 3.2h3.1l1.2 1.3h4.9a1.2 1.2 0 0 1 1.2 1.2v6.1a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2V4.4z"/></svg>';
  const RECENT_RENAME_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.3 2.7l2 2-7.8 7.8-2.6.6.6-2.6 7.8-7.8z"/></svg>';
  const RECENT_ARCHIVE_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.2" y="3" width="11.6" height="2.8" rx="0.8"/><path d="M3.2 5.8v6.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.8"/><path d="M6.4 8.8h3.2"/></svg>';
  const RECENT_TRASH_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M6 4.5V3.3a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8v1.2"/><path d="M4.2 4.5l.7 8.1a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.7-8.1"/></svg>';
  const RECENT_COPY_SVG =
    '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.2" y="5.2" width="8" height="8" rx="1.4"/><path d="M10.8 5.2V3.6a1.4 1.4 0 0 0-1.4-1.4H3.6a1.4 1.4 0 0 0-1.4 1.4v5.8a1.4 1.4 0 0 0 1.4 1.4h1.6"/></svg>';

  rtState.sidebarStoreRef = null;
  let sidebarStoreUnsub = null;
  let sidebarSyncTimer = 0;
  let cachedSidebarActionsCtx = null;
  let recentExpanded = false;
  let recentPageLimit = 50;
  rtState.recentLastSig = '';
  let recentRenamingId = '';
  let recentMenuState = null;
  let recentMenuDocBound = false;
  let recentItemsById = new Map();
  let recentLastDragEndTs = 0;

  const bgStatusClient = createBgTaskStatusClient({
    onUpdated: () => {
      if (rtState.disposed) return;
      rtState.recentLastSig = '';
      scheduleSidebarSync();
      hooks.refreshProjectsViewIfOpen?.();
    },
    callRpc: (action, payload, timeoutMs) =>
      typeof window !== 'undefined' && typeof window.__agProjectCall === 'function'
        ? window.__agProjectCall(action, payload, timeoutMs)
        : Promise.resolve(null),
  });

  /* ---- v2.34+ Conversation & File Drag-to-Composer (`application/context-scope-item-cider`) ---- */
  const buildCiderConversationPayload = (id, title) =>
    buildCiderConversationPayloadRaw(id, title, L('对话', 'Conversation'));
  const attachConversationDragTransfer = (dt, id, title) =>
    attachConversationDragTransferRaw(dt, id, title, L('对话', 'Conversation'));
  void buildCiderConversationPayload;
  void buildCiderFilePayload;

  /* Bridge native pointer-dragged Pinned Sidebar rows (`[data-testid="conversation-row-sidebar"]`) into composers */
  let pinnedDragState = null;
  let pinnedDragOverCid = null;
  let pinnedDragGhostEl = null;
  function getLayoutReduxStore() {
    const bindings = findSidebarBindings();
    if (bindings && bindings.store && typeof bindings.store.dispatch === 'function') {
      return bindings.store;
    }
    return null;
  }
  function setPinnedChatDragOverTarget(nextCid) {
    const normalized = nextCid || null;
    if (pinnedDragOverCid === normalized) return;
    pinnedDragOverCid = normalized;
    const store = getLayoutReduxStore();
    if (store) {
      try {
        store.dispatch({ type: 'layout/setDragOverChatCascadeId', payload: normalized });
        if (normalized) {
          store.dispatch({ type: 'layout/setPendingSplitDrop', payload: null });
        }
      } catch {}
    }
  }
  function removePinnedDragGhost() {
    if (pinnedDragGhostEl) {
      try {
        pinnedDragGhostEl.remove();
      } catch {}
      pinnedDragGhostEl = null;
    }
    if (docRoot) docRoot.removeAttribute('data-ag-pinned-ghost-active');
  }
  function updatePinnedDragGhost(st, x, y) {
    if (!st || x <= st.sidebarRight - 8 || !document.body) {
      removePinnedDragGhost();
      return;
    }
    if (!pinnedDragGhostEl) {
      const ghost = document.createElement('div');
      ghost.id = 'ag-pinned-drag-ghost';
      ghost.className = 'ag-pinned-drag-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('data-ag-i18n-ignore', '1');
      ghost.innerHTML = `<span class="ag-pinned-drag-ghost-title">${escapeHtml(st.title)}</span><span class="ag-pinned-drag-ghost-pin">${RECENT_PIN_SVG}</span>`;
      document.body.appendChild(ghost);
      pinnedDragGhostEl = ghost;
    }
    if (docRoot) docRoot.setAttribute('data-ag-pinned-ghost-active', 'true');
    pinnedDragGhostEl.style.width = `${st.rowWidth}px`;
    pinnedDragGhostEl.style.transform = `translate3d(${Math.round(x - st.grabOffsetX)}px, ${Math.round(y - st.grabOffsetY)}px, 0)`;
  }
  function clearPinnedDropZoneHighlightOnly() {
    if (docRoot) docRoot.removeAttribute('data-ag-pinned-chat-drop');
    setPinnedChatDragOverTarget(null);
    document
      .querySelectorAll('#antigravity\\.agentSidePanelInputBox[data-ag-convo-drop], [data-ag-pd-composer-box][data-drag="convo"]')
      .forEach((el) => {
        el.removeAttribute('data-ag-convo-drop');
        if (el.getAttribute('data-drag') === 'convo') el.removeAttribute('data-drag');
      });
  }
  function clearPinnedComposerDropHighlights() {
    clearPinnedDropZoneHighlightOnly();
    removePinnedDragGhost();
  }
  function findComposerUnderPoint(x, y) {
    const pdView = document.querySelector('#ag-claude-projects-view:not([hidden])');
    if (pdView) {
      const pdBox = pdView.querySelector('[data-ag-pd-composer-box]');
      if (pdBox) {
        const pdLeft = pdBox.closest('.ag-pd-left') || pdBox;
        const r = pdLeft.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return { kind: 'project', el: pdBox };
        }
      }
    }
    const views = document.querySelectorAll('[data-testid="conversation-view"]');
    for (const view of views) {
      const r = view.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const box = view.querySelector('[id="antigravity.agentSidePanelInputBox"]');
        const boxRect = box ? box.getBoundingClientRect() : null;
        const inBox = Boolean(
          boxRect && boxRect.width > 0 && boxRect.height > 0 && x >= boxRect.left && x <= boxRect.right && y >= boxRect.top && y <= boxRect.bottom
        );
        /* Leave left/right edge bands (~14%, capped at 96px) outside the composer free for official split-pane drag */
        const splitEdge = Math.min(96, r.width * 0.14);
        if (!inBox && r.width >= 360 && (x - r.left < splitEdge || r.right - x < splitEdge)) {
          return null;
        }
        return { kind: 'native', el: box || view, viewEl: view, targetCid: view.getAttribute('data-cascade-id') || '' };
      }
    }
    const nativeBoxes = document.querySelectorAll('[id="antigravity.agentSidePanelInputBox"]');
    for (const box of nativeBoxes) {
      const r = box.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const viewEl = box.closest('[data-testid="conversation-view"]');
        return { kind: 'native', el: box, viewEl, targetCid: (viewEl && viewEl.getAttribute('data-cascade-id')) || '' };
      }
    }
    return null;
  }
  let dispatchingSyntheticPointerCancel = false;
  function cancelNativeDndSilently() {
    /* Cancel dnd-kit PointerSensor via synthetic pointercancel instead of Escape (which can stop live generation) */
    dispatchingSyntheticPointerCancel = true;
    try {
      const cancelEv =
        typeof PointerEvent === 'function'
          ? new PointerEvent('pointercancel', { bubbles: true, cancelable: false })
          : new Event('pointercancel', { bubbles: true });
      window.dispatchEvent(cancelEv);
    } catch {}
    dispatchingSyntheticPointerCancel = false;
  }
  const onPinnedRowPointerDown = (ev) => {
    if (rtState.disposed || ev.button !== 0 || ev.altKey) return;
    if (
      ev.target &&
      ev.target.closest &&
      ev.target.closest('button, input, textarea, [contenteditable="true"], .agy-row-actions')
    ) {
      return;
    }
    const row = ev.target && ev.target.closest && ev.target.closest('[data-testid="conversation-row-sidebar"][data-cascade-id]');
    if (!row) return;
    /* Only intercept Pinned rows (native unpinned rows keep native split-drag unless unified Recents replaces them) */
    const isPinnedRow =
      row.getAttribute('data-pinned') === 'true' ||
      Boolean(row.closest && row.closest('[data-ag-sb-unified="pinned"]'));
    if (!isPinnedRow) return;
    const cid = row.getAttribute('data-cascade-id');
    if (!cid) return;
    const a = row.querySelector('a[href]');
    const span = row.querySelector('.flex-col > span');
    const title =
      (span && span.textContent && span.textContent.trim()) ||
      (a && a.getAttribute('aria-label')) ||
      cid.slice(0, 8);
    const rowRect = row.getBoundingClientRect();
    const sbEl = row.closest('.bg-sidebar');
    const sbRect = sbEl ? sbEl.getBoundingClientRect() : null;
    pinnedDragState = {
      id: cid,
      title,
      startX: ev.clientX,
      startY: ev.clientY,
      active: false,
      grabOffsetX: rowRect.width > 0 ? Math.max(12, Math.min(rowRect.width - 12, ev.clientX - rowRect.left)) : 48,
      grabOffsetY: rowRect.height > 0 ? Math.max(8, Math.min(rowRect.height - 8, ev.clientY - rowRect.top)) : 16,
      rowWidth: rowRect.width > 0 ? Math.max(168, Math.min(248, Math.round(rowRect.width))) : 216,
      sidebarRight: sbRect && sbRect.width > 0 ? sbRect.right : rowRect.right || 256
    };
  };
  const onPinnedRowPointerMove = (ev) => {
    if (!pinnedDragState || rtState.disposed) return;
    if (ev.altKey) {
      clearPinnedComposerDropHighlights();
      return;
    }
    const dx = ev.clientX - pinnedDragState.startX;
    const dy = ev.clientY - pinnedDragState.startY;
    if (!pinnedDragState.active && dx * dx + dy * dy < 49) return;
    pinnedDragState.active = true;
    updatePinnedDragGhost(pinnedDragState, ev.clientX, ev.clientY);
    const hit = findComposerUnderPoint(ev.clientX, ev.clientY);
    if (!hit) {
      clearPinnedDropZoneHighlightOnly();
      return;
    }
    if (hit.kind === 'project') {
      if (docRoot) docRoot.setAttribute('data-ag-pinned-chat-drop', 'true');
      setPinnedChatDragOverTarget(null);
      hit.el.setAttribute('data-drag', 'convo');
    } else if (hit.kind === 'native') {
      const targetCid = hit.targetCid || '';
      if (targetCid && targetCid === pinnedDragState.id) {
        clearPinnedDropZoneHighlightOnly();
        return;
      }
      if (docRoot) docRoot.setAttribute('data-ag-pinned-chat-drop', 'true');
      if (targetCid) {
        setPinnedChatDragOverTarget(targetCid);
        const store = getLayoutReduxStore();
        if (store) {
          frame(() => {
            if (pinnedDragState && pinnedDragOverCid === targetCid) {
              try {
                if (store.getState && store.getState().layout && store.getState().layout.pendingSplitDrop) {
                  store.dispatch({ type: 'layout/setPendingSplitDrop', payload: null });
                }
              } catch {}
            }
          });
        }
      } else {
        setPinnedChatDragOverTarget(null);
        hit.el.setAttribute('data-ag-convo-drop', 'true');
      }
    }
  };
  const onPinnedRowPointerUp = (ev) => {
    if (!pinnedDragState) return;
    const st = pinnedDragState;
    pinnedDragState = null;
    clearPinnedComposerDropHighlights();
    if (!st.active || rtState.disposed || ev.altKey) return;
    const hit = findComposerUnderPoint(ev.clientX, ev.clientY);
    if (!hit) return;
    if (hit.kind === 'project') {
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      cancelNativeDndSilently();
      const projView = document.getElementById('ag-claude-projects-view');
      const projId = projView && projView.getAttribute('data-ag-pd-proj-id');
      const compInput = hit.el.querySelector('#ag-pd-composer-input');
      if (projId && compInput) {
        appendDroppedMentionsToPdComposer({ id: projId }, compInput, [
          {
            kind: 'conversation',
            label: st.title,
            scopeItem: {
              $typeName: 'exa.codeium_common_pb.ContextScopeItem',
              scopeItem: {
                case: 'conversation',
                value: {
                  $typeName: 'exa.codeium_common_pb.ConversationScopeItem',
                  id: st.id,
                  title: st.title,
                  source: ''
                }
              }
            }
          }
        ]);
      }
      return;
    }
    if (hit.kind === 'native') {
      const targetCid = hit.targetCid || '';
      if (targetCid && targetCid === st.id) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation();
      cancelNativeDndSilently();
      const store = getLayoutReduxStore();
      if (targetCid && store) {
        store.dispatch({ type: 'layout/setPendingSplitDrop', payload: null });
        store.dispatch({
          type: 'layout/setPendingChatDrop',
          payload: {
            cascadeId: targetCid,
            payload: { type: 'conversation', conversationId: st.id, title: st.title }
          }
        });
        return;
      }
      try {
        if (typeof DataTransfer === 'function' && typeof DragEvent === 'function') {
          const dt = new DataTransfer();
          attachConversationDragTransfer(dt, st.id, st.title);
          hit.el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        }
      } catch {}
    }
  };
  const onPinnedRowPointerCancel = () => {
    if (dispatchingSyntheticPointerCancel) return;
    pinnedDragState = null;
    clearPinnedComposerDropHighlights();
  };
  document.addEventListener('pointerdown', onPinnedRowPointerDown, true);
  window.addEventListener('pointermove', onPinnedRowPointerMove, true);
  window.addEventListener('pointerup', onPinnedRowPointerUp, true);
  window.addEventListener('pointercancel', onPinnedRowPointerCancel, true);
  rtState.recentCollapsed = (() => {
    try {
      if (trustLocalOverrides && typeof localStorage === 'object' && localStorage) {
        const v = localStorage.getItem('ag_claude_ux_recent_collapsed');
        if (v === '1' || v === '0') return v === '1';
      }
    } catch {}
    return Boolean(CFG_UI_STATE.recentCollapsed);
  })();
  rtState.unifiedRecentCollapsed = (() => {
    try {
      if (trustLocalOverrides && typeof localStorage === 'object' && localStorage) {
        const v = localStorage.getItem('ag_claude_ux_unified_recents_collapsed');
        if (v === '1' || v === '0') return v === '1';
      }
    } catch {}
    return Boolean(CFG_UI_STATE.unifiedRecentCollapsed);
  })();

  function protoSeconds(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (ts.seconds !== undefined && ts.seconds !== null) return Number(ts.seconds) || 0;
    return 0;
  }

  function pendingSubkindOf(waitingStep) {
    const tool = String((waitingStep && waitingStep.metadata && waitingStep.metadata.toolCall && waitingStep.metadata.toolCall.name) || '')
      .split(':')
      .pop();
    if (tool === 'ask_permission') {
      try {
        const args = JSON.parse((waitingStep.metadata && waitingStep.metadata.toolCall && waitingStep.metadata.toolCall.argumentsJson) || '{}');
        if (args.command || args.CommandLine) return 'terminal';
        if (args.read_file || args.write_file || args.Path || args.AbsolutePath || args.TargetFile) return 'lock';
      } catch {}
      return 'lock';
    }
    if (/run_command|command/i.test(tool)) return 'terminal';
    return 'bell';
  }

  function hasIndexKey(idxCol, id) {
    if (!idxCol || !id) return false;
    if (typeof idxCol.has === 'function') return idxCol.has(id);
    if (Array.isArray(idxCol)) return idxCol.includes(id);
    if (typeof idxCol === 'object') return Object.prototype.hasOwnProperty.call(idxCol, id);
    return false;
  }

  function getIndexSize(idxCol) {
    if (!idxCol) return 0;
    if (typeof idxCol.size === 'number') return idxCol.size;
    if (Array.isArray(idxCol)) return idxCol.length;
    if (typeof idxCol === 'object') return Object.keys(idxCol).length;
    return 0;
  }

  function isSummaryPinned(id, summary, state) {
    if (summary && summary.annotations && summary.annotations.pinned) return true;
    const idxPinned =
      state && state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.pinned;
    return hasIndexKey(idxPinned, id);
  }

  function isSidebarVisibleSummary(id, summary, state) {
    if (!id || !summary) return false;
    if (summary.annotations && summary.annotations.archived) return false;
    if (summary.trajectoryMetadata && summary.trajectoryMetadata.parentConversationId) return false;
    if (summary.trajectoryMetadata && summary.trajectoryMetadata.isBattleModeFork) return false;
    if (
      summary.trajectoryMetadata &&
      summary.trajectoryMetadata.sourceMetadata &&
      summary.trajectoryMetadata.sourceMetadata.hideFromConversationList
    ) {
      return false;
    }
    if (SIDEBAR_IGNORED_TYPES.has(summary.trajectoryType)) return false;
    /* Antigravity partitions top-level conversations between `indexes.pinned` and `indexes.sidebar`
     * (`indexes.sidebar` excludes pinned conversations). Pinned items and external summaries are still visible. */
    if (isSummaryPinned(id, summary, state)) return true;
    const primarySummaries = state && state.trajectorySummaries && state.trajectorySummaries.summaries;
    if (primarySummaries && !Object.prototype.hasOwnProperty.call(primarySummaries, id)) {
      return true;
    }
    const idxSidebar =
      state && state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.sidebar;
    if (idxSidebar && getIndexSize(idxSidebar) > 0 && !hasIndexKey(idxSidebar, id)) {
      return false;
    }
    return true;
  }

  /* Left sidebar & Recents rely on native CSS `text-autospace: normal` (1/8em optical boundary, matching right-pane prose
   * without mutating DOM text nodes or polluting copied conversation titles with extra ASCII spaces). */
  let legacySidebarCjkRestored = false;
  function restoreLegacySidebarCjkNodes(force = false) {
    if (!force && legacySidebarCjkRestored) return;
    legacySidebarCjkRestored = true;
    document.querySelectorAll('[data-ag-orig-cjk]').forEach((el) => {
      const orig = el.getAttribute('data-ag-orig-cjk');
      el.removeAttribute('data-ag-orig-cjk');
      if (orig !== null && el.childNodes.length === 1 && el.firstChild && el.firstChild.nodeType === 3) {
        el.firstChild.nodeValue = orig;
      }
    });
  }

  function classifySidebarConversation(id, summary, state, activeId, hasFocus) {
    if (!isSidebarVisibleSummary(id, summary, state)) return null;

    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const byParent = state && state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.byParent;
    let waitingStep = (summary.waitingSteps && summary.waitingSteps[0]) || null;
    const rawChildren = byParent && byParent[id];
    if (!waitingStep && rawChildren) {
      const childIds =
        typeof rawChildren[Symbol.iterator] === 'function'
          ? rawChildren
          : typeof rawChildren === 'object'
            ? Object.keys(rawChildren)
            : [];
      for (const cid of childIds) {
        const ch = summaries[cid];
        if (ch && ch.waitingSteps && ch.waitingSteps.length) {
          waitingStep = ch.waitingSteps[0];
          break;
        }
      }
    }
    const title = String((summary.annotations && summary.annotations.title) || summary.summary || id);
    if (waitingStep) {
      return { kind: 'pending', subkind: pendingSubkindOf(waitingStep), title };
    }

    const runCls = classifyRunningSubkind(id, summary, state, bgStatusClient.getCachedState(id));
    if (runCls) {
      return {
        kind: 'running',
        subkind: runCls.subkind,
        detail: runCls.detail,
        needsBgLookup: runCls.needsBgLookup,
        title,
      };
    }

    if (!summary.notFullyIdle) {
      const marked = Boolean(summary.annotations && summary.annotations.markedAsUnread);
      const isFocusedHere = activeId === id && hasFocus;
      if (marked || !isFocusedHere) {
        const lastMod = protoSeconds(summary.lastModifiedTime);
        const remoteView = protoSeconds(summary.annotations && summary.annotations.lastUserViewTime);
        const localView = Number((state && state.conversation && state.conversation.localLastViewedTimes && state.conversation.localLastViewedTimes[id]) || 0);
        if (marked || (lastMod > 0 && lastMod > Math.max(remoteView, localView))) {
          return { kind: 'unread', subkind: 'dot', title };
        }
      }
    }
    return null;
  }

  function pendingGlyphSvg(subkind) {
    if (subkind === 'terminal') return PENDING_TERM_SVG;
    if (subkind === 'lock') return PENDING_LOCK_SVG;
    return PENDING_BELL_SVG;
  }

  function findSidebarBindings() {
    const sidebar = document.querySelector('[data-testid="conversation-list-sidebar"]');
    if (!sidebar) return null;
    let f = activeReactFiber(sidebar.firstElementChild || sidebar) || activeReactFiber(sidebar);
    let store = null;
    let router = null;
    let stepHandler = null;
    let actionsCtx = cachedSidebarActionsCtx;
    const groupsById = new Map();
    const projectLabels = new Map();

    const scanFiber = (startFiber, maxDepth) => {
      for (let cur = startFiber, d = 0; cur && d < maxDepth; d++, cur = cur.return) {
        const p = cur.memoizedProps;
        if (p && p.sidebarStore && !store) store = p.sidebarStore;
        if (p && p.sidebarRouter && !router) router = p.sidebarRouter;
        if (p && p.sidebarActions && !actionsCtx) actionsCtx = p.sidebarActions;
        if (p && Array.isArray(p.sidebarGroups) && !groupsById.size) {
          for (const g of p.sidebarGroups) {
            if (g && g.id) {
              groupsById.set(g.id, g.conversationIds || []);
              if (g.label || g.name) projectLabels.set(g.id, g.label || g.name);
            }
          }
        }
        if (!groupsById.size) {
          for (let s = cur.memoizedState; s; s = s.next) {
            const v = s.memoizedState;
            if (Array.isArray(v) && v.length && v[0] && Array.isArray(v[0].conversationIds)) {
              for (const g of v) {
                if (g && g.id) {
                  groupsById.set(g.id, g.conversationIds || []);
                  const lbl = g.label || g.name || g.title;
                  if (lbl) projectLabels.set(g.id, lbl);
                }
              }
              if (groupsById.size) break;
            }
          }
        }
        for (let dep = cur.dependencies && cur.dependencies.firstContext; dep; dep = dep.next) {
          const mv = dep.memoizedValue;
          if (!store && mv && mv.store && typeof mv.store.getState === 'function') {
            const st = mv.store.getState();
            if (st && st.trajectorySummaries && st.trajectorySummaries.summaries) {
              store = mv.store;
            }
          }
          if (!router && mv && typeof mv.navigate === 'function' && mv.state && mv.state.location) {
            router = mv;
          }
          if (!stepHandler && mv && mv.stepHandler && typeof mv.stepHandler.openConversation === 'function') {
            stepHandler = mv.stepHandler;
          }
          if (
            !actionsCtx &&
            mv &&
            (typeof mv.updateConversationAnnotations === 'function' || typeof mv.deleteCascadeTrajectory === 'function')
          ) {
            actionsCtx = mv;
          }
        }
        if (store && router && actionsCtx && groupsById.size) break;
      }
    };

    scanFiber(f, 36);
    if (!actionsCtx) {
      const anyRow = sidebar.querySelector('[data-testid="conversation-row-sidebar"]');
      if (anyRow) scanFiber(activeReactFiber(anyRow), 36);
    }
    if (!store) return null;
    if (actionsCtx) cachedSidebarActionsCtx = actionsCtx;

    const st = store.getState && store.getState();
    const rawProjects = (st && st.sidebarProjects && st.sidebarProjects.projects) || [];
    for (const p of rawProjects) {
      if (!p || !p.id || p.id === 'outside-of-project') continue;
      const lbl = p.id === 'default-cli-project' ? L('CLI 项目', 'CLI Project') : String(p.name || '').trim();
      if (lbl && !projectLabels.has(p.id)) projectLabels.set(p.id, lbl);
    }
    for (const hdr of sidebar.querySelectorAll('button[data-testid="project-header"]')) {
      const drop = hdr.closest('[data-sidebar-section-drop-id]');
      const pid = drop && drop.getAttribute('data-sidebar-section-drop-id');
      const lbl = hdr.getAttribute('data-project-label') || (hdr.textContent || '').trim();
      if (pid && lbl && !projectLabels.has(pid)) projectLabels.set(pid, lbl);
    }
    return { sidebar, store, router, stepHandler, actionsCtx, groupsById, projectLabels };
  }

  function resolveProjectHeaderId(btn) {
    const drop = btn.closest('[data-sidebar-section-drop-id]');
    if (drop) {
      const id = drop.getAttribute('data-sidebar-section-drop-id');
      if (id) return id;
    }
    for (let f = activeReactFiber(btn), d = 0; f && d < 10; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p && typeof p.projectId === 'string' && p.projectId) return p.projectId;
      if (p && typeof p.brandedProjectId === 'string' && p.brandedProjectId) return p.brandedProjectId;
    }
    return '';
  }

  function clearAllFolderBadges() {
    document.querySelectorAll('.ag-claude-folder-badges').forEach((el) => el.remove());
    document.querySelectorAll('button[data-testid="project-header"][data-ag-folder-tip]').forEach((btn) => {
      const orig = btn.getAttribute('data-ag-orig-folder-title');
      btn.removeAttribute('data-ag-folder-tip');
      btn.removeAttribute('data-ag-orig-folder-title');
      if (orig) btn.setAttribute('title', orig);
      else btn.removeAttribute('title');
    });
  }

  function syncFolderStatusBadges(bindings, state, activeId, hasFocus) {
    if (!FEAT.folderStatus || !bindings) {
      clearAllFolderBadges();
      return;
    }
    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const headers = bindings.sidebar.querySelectorAll('button[data-testid="project-header"]');
    for (const btn of headers) {
      const host = btn.closest('.group\\/header') || btn.parentElement;
      if (!host) continue;
      if (!host.style.position && !host.classList.contains('relative')) {
        host.style.position = 'relative';
      }
      const collapsed = btn.getAttribute('aria-expanded') === 'false';
      const pid = collapsed ? resolveProjectHeaderId(btn) : '';
      const convIds = pid ? bindings.groupsById.get(pid) : null;
      let badgeWrap = host.querySelector(':scope > .ag-claude-folder-badges');

      if (!collapsed || !convIds || !convIds.length) {
        if (badgeWrap) badgeWrap.remove();
        if (btn.hasAttribute('data-ag-folder-tip')) {
          const orig = btn.getAttribute('data-ag-orig-folder-title');
          btn.removeAttribute('data-ag-folder-tip');
          btn.removeAttribute('data-ag-orig-folder-title');
          if (orig) btn.setAttribute('title', orig);
          else btn.removeAttribute('title');
        }
        continue;
      }

      const buckets = {
        pending: { kind: 'pending', count: 0, subkind: null, titles: [] },
        running: { kind: 'running', count: 0, subkind: 'orbit', items: [], titles: [] },
        unread: { kind: 'unread', count: 0, subkind: 'dot', titles: [] }
      };
      const seen = new Set();
      for (const cid of convIds) {
        if (!cid || seen.has(cid)) continue;
        seen.add(cid);
        const cls = classifySidebarConversation(cid, summaries[cid], state, activeId, hasFocus);
        if (!cls) continue;
        const b = buckets[cls.kind];
        b.count += 1;
        if (cls.kind === 'running') {
          b.items.push({ subkind: cls.subkind || 'orbit', detail: cls.detail || '', title: cls.title || '' });
        } else if (!b.subkind) {
          b.subkind = cls.subkind;
        }
        if (b.titles.length < 3 && cls.title) b.titles.push(cls.title);
      }
      if (buckets.running.count > 0) {
        buckets.running.subkind = pickDominantRunningSubkind(buckets.running.items.map((x) => x.subkind));
      }

      const active = ['pending', 'running', 'unread'].map((k) => buckets[k]).filter((b) => b.count > 0);
      if (!active.length) {
        if (badgeWrap) badgeWrap.remove();
        if (btn.hasAttribute('data-ag-folder-tip')) {
          const orig = btn.getAttribute('data-ag-orig-folder-title');
          btn.removeAttribute('data-ag-folder-tip');
          btn.removeAttribute('data-ag-orig-folder-title');
          if (orig) btn.setAttribute('title', orig);
          else btn.removeAttribute('title');
        }
        continue;
      }

      const kindLabels = FEAT.i18n
        ? { pending: '待处理', running: '运行中', unread: '已完成未读' }
        : { pending: 'pending', running: 'running', unread: 'unread' };
      const summaryLine = active
        .map((b) => (FEAT.i18n ? `${b.count} 个${kindLabels[b.kind]}` : `${b.count} ${kindLabels[b.kind]}`))
        .join(' · ');
      const detailLines = active
        .flatMap((b) =>
          b.kind === 'running'
            ? b.items.slice(0, 3).map((it) => `${it.title} · ${formatRunningStatusTooltip(it, L)}`)
            : b.titles.map((t) => `${kindLabels[b.kind]}${FEAT.i18n ? '：' : ': '}${t}`)
        )
        .slice(0, 4);
      const tip = detailLines.length ? `${summaryLine}\n${detailLines.join('\n')}` : summaryLine;
      if (!btn.hasAttribute('data-ag-folder-tip')) {
        const orig = btn.getAttribute('title');
        if (orig) btn.setAttribute('data-ag-orig-folder-title', orig);
        btn.setAttribute('data-ag-folder-tip', 'true');
      }
      if (btn.getAttribute('title') !== tip) btn.setAttribute('title', tip);

      const html = active
        .slice(0, 2)
        .map((b) => {
          const ico =
            b.kind === 'pending'
              ? pendingGlyphSvg(b.subkind)
              : b.kind === 'running'
                ? renderRunningGlyphHtml(b.subkind)
                : '<span class="ag-claude-unread-dot"></span>';
          const subAttr = b.kind === 'running' ? ` data-subkind="${escapeHtml(b.subkind || 'orbit')}"` : '';
          return `<span class="ag-claude-folder-badge" data-kind="${b.kind}"${subAttr}>${ico}<span>${b.count}</span></span>`;
        })
        .join('');

      if (!badgeWrap) {
        badgeWrap = document.createElement('div');
        badgeWrap.className = 'ag-claude-folder-badges';
        badgeWrap.setAttribute('aria-hidden', 'true');
        host.appendChild(badgeWrap);
      }
      const sig = `${active.map((b) => `${b.kind}:${b.subkind}:${b.count}`).join('|')}`;
      if (badgeWrap.getAttribute('data-ag-sig') !== sig) {
        badgeWrap.setAttribute('data-ag-sig', sig);
        badgeWrap.innerHTML = html;
      }
    }
  }

  function formatRelativeAge(sec, nowSec) {
    if (!sec) return '';
    const diff = Math.max(0, nowSec - sec);
    if (diff < 60) return L('刚刚', 'now');
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  }

  function getSidebarListHost(sidebar) {
    if (!sidebar) return { host: null, container: null };
    const p = sidebar.parentElement;
    const isDedicatedWrap = Boolean(
      p &&
        p !== document.body &&
        !p.classList.contains('bg-sidebar') &&
        !p.querySelector('[data-testid="automations-button"], [data-testid="new-conversation-button"]')
    );
    const host = isDedicatedWrap ? p : sidebar;
    return { host, container: host && host.parentElement };
  }

  function resolveSummaryProjectInfo(id, summary, projectLabels, state) {
    const meta = (summary && summary.trajectoryMetadata) || {};
    let pid = String(meta.projectId || (summary && summary.projectId) || '');
    if ((!pid || pid === 'outside-of-project') && id && state) {
      const byProject = state.trajectorySummaries && state.trajectorySummaries.indexes && state.trajectorySummaries.indexes.byProject;
      if (byProject && typeof byProject === 'object') {
        for (const [candPid, rawIds] of Object.entries(byProject)) {
          if (!candPid || candPid === 'outside-of-project') continue;
          if (hasIndexKey(rawIds, id)) {
            pid = candPid;
            break;
          }
        }
      }
    }
    const rawProjects = (state && state.sidebarProjects && state.sidebarProjects.projects) || [];
    if (pid && pid !== 'outside-of-project') {
      if (projectLabels && projectLabels.has(pid)) return { id: pid, name: projectLabels.get(pid) };
      const found = rawProjects.find((p) => p && p.id === pid);
      if (found) {
        const nm = found.id === 'default-cli-project' ? L('CLI 项目', 'CLI Project') : String(found.name || '').trim();
        if (nm) return { id: pid, name: nm };
      }
      const uri = (meta.workspaceUris && meta.workspaceUris[0]) || '';
      const fallback = decodeURIComponent(String(uri).split('/').filter(Boolean).pop() || '');
      return { id: pid, name: fallback };
    }
    const wsUri = (meta.workspaceUris && meta.workspaceUris[0]) || '';
    if (wsUri) {
      const found = rawProjects.find((p) => p && Array.isArray(p.folderUris) && p.folderUris.includes(wsUri));
      if (found && found.id && found.id !== 'outside-of-project') {
        const nm = found.id === 'default-cli-project' ? L('CLI 项目', 'CLI Project') : String(found.name || '').trim();
        if (nm) return { id: found.id, name: nm };
      }
    }
    return { id: '', name: '' };
  }

  function navigateSidebarConversation(id, bindings) {
    if (!id) return;
    if (bindings && bindings.router && typeof bindings.router.navigate === 'function') {
      try {
        bindings.router.navigate({ to: '/c/$cascadeId', params: { cascadeId: id } });
        return;
      } catch {}
    }
    if (bindings && bindings.stepHandler && typeof bindings.stepHandler.openConversation === 'function') {
      try {
        bindings.stepHandler.openConversation(id);
        return;
      } catch {}
    }
    const link = document.querySelector(`a[href*="/c/${id}"]`);
    if (link && typeof link.click === 'function') {
      link.click();
      return;
    }
    if (typeof history === 'object' && typeof history.pushState === 'function') {
      history.pushState(null, '', `/c/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  function triggerNewConversationFromSidebar(bindings) {
    const newBtn = document.querySelector('[data-testid="new-conversation-button"], a[href="/"]');
    if (newBtn && typeof newBtn.click === 'function') {
      try {
        newBtn.click();
        return;
      } catch {}
    }
    if (bindings && bindings.router && typeof bindings.router.navigate === 'function') {
      try {
        bindings.router.navigate({ to: '/' });
        return;
      } catch {}
    }
    if (typeof history === 'object' && typeof history.pushState === 'function') {
      history.pushState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
  }

  function getSidebarActionsCtx(bindings) {
    return (bindings && bindings.actionsCtx) || cachedSidebarActionsCtx || null;
  }

  async function mutateRecentConversationAnnotation(id, patch, bindings) {
    const act = getSidebarActionsCtx(bindings);
    if (!id || !act || typeof act.updateConversationAnnotations !== 'function') return false;
    try {
      await act.updateConversationAnnotations(id, patch, true);
      rtState.recentLastSig = '';
      scheduleSidebarSync();
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'pinned') && isNativeProjectsHidden()) {
        scheduleSidebarHideSync();
      }
      return true;
    } catch {
      return false;
    }
  }

  async function deleteRecentConversation(id, bindings) {
    const act = getSidebarActionsCtx(bindings);
    if (!id || !act || typeof act.deleteCascadeTrajectory !== 'function') return false;
    try {
      const wasActive = getActiveCascadeId() === id;
      await act.deleteCascadeTrajectory(id);
      if (wasActive) triggerNewConversationFromSidebar(bindings);
      rtState.recentLastSig = '';
      scheduleSidebarSync();
      return true;
    } catch {
      return false;
    }
  }

  function onRecentMenuResize() {
    closeRecentRowMenu();
  }

  function closeRecentRowMenu(onlySource = '') {
    if (onlySource && recentMenuState && recentMenuState.source !== onlySource) return;
    recentMenuState = null;
    const menu = document.getElementById('ag-recent-row-menu');
    if (menu) menu.remove();
    if (recentMenuDocBound) {
      document.removeEventListener('mousedown', onRecentMenuDocDown, true);
      document.removeEventListener('keydown', onRecentMenuDocKey, true);
      window.removeEventListener('resize', onRecentMenuResize);
      recentMenuDocBound = false;
    }
  }

  function onRecentMenuDocDown(ev) {
    const t = ev && ev.target;
    if (t && t.closest && t.closest('#ag-recent-row-menu, [data-ag-recent-menu], [data-ag-sbp-menu]')) return;
    closeRecentRowMenu();
  }

  function onRecentMenuDocKey(ev) {
    if (ev && ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeRecentRowMenu();
    }
  }

  function startRecentInlineRename(id) {
    if (!id) return;
    closeRecentRowMenu();
    recentRenamingId = id;
    rtState.recentLastSig = '';
    syncSidebarEnhancements();
    frame(() => {
      const input = document.querySelector('#ag-claude-recent-section [data-ag-recent-rename-input]');
      if (input) {
        input.focus();
        try {
          input.select();
        } catch {}
      }
    });
  }

  function commitRecentInlineRename(input, commit) {
    if (!input) return;
    const id = input.getAttribute('data-ag-recent-rename-input') || recentRenamingId;
    const orig = input.getAttribute('data-orig-title') || '';
    const nextVal = String(input.value || '').trim();
    recentRenamingId = '';
    rtState.recentLastSig = '';
    if (commit && id && nextVal && nextVal !== orig) {
      mutateRecentConversationAnnotation(id, { title: nextVal }, findSidebarBindings());
    }
    syncSidebarEnhancements();
  }

  async function copyRecentText(text) {
    const str = String(text || '');
    if (!str) return false;
    try {
      if (typeof navigator === 'object' && navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(str);
        return true;
      }
    } catch {}
    try {
      if (typeof document !== 'undefined' && document.body && typeof document.execCommand === 'function') {
        const ta = document.createElement('textarea');
        ta.value = str;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild(ta);
        try {
          ta.select();
          return Boolean(document.execCommand('copy'));
        } finally {
          ta.remove();
        }
      }
    } catch {}
    return false;
  }

  function renderRecentRowMenu() {
    const st = recentMenuState;
    if (!st) {
      closeRecentRowMenu();
      return;
    }
    let menu = document.getElementById('ag-recent-row-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'ag-recent-row-menu';
      menu.setAttribute('role', 'menu');
      menu.setAttribute('data-maga-own', '1');
      menu.setAttribute('data-ag-i18n-ignore', '1');
      menu.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest && ev.target.closest('[data-ag-rm-act]');
        if (!btn || !recentMenuState) return;
        ev.preventDefault();
        ev.stopPropagation();
        const act = btn.getAttribute('data-ag-rm-act');
        const cur = recentMenuState;
        const bindings = findSidebarBindings();
        if (act === 'open-project' && cur.projectId) {
          closeRecentRowMenu();
          if (FEAT.projects) openProjectsView(cur.projectId);
          return;
        }
        if (act === 'pin') {
          closeRecentRowMenu();
          mutateRecentConversationAnnotation(cur.id, { pinned: true }, bindings);
          return;
        }
        if (act === 'rename') {
          if (cur.source === 'sbp' && typeof hooks.startSidebarProjectInlineRename === 'function') {
            closeRecentRowMenu();
            hooks.startSidebarProjectInlineRename(cur.id);
          } else {
            startRecentInlineRename(cur.id);
          }
          return;
        }
        if (act === 'copy-id') {
          const cid = cur.id;
          closeRecentRowMenu();
          copyRecentText(cid).then((ok) => {
            if (ok) hooks.showProjectsFloatingNotice?.(L('已复制对话 ID', 'Conversation ID copied'));
          });
          return;
        }
        if (act === 'archive') {
          closeRecentRowMenu();
          mutateRecentConversationAnnotation(cur.id, { archived: true }, bindings);
          return;
        }
        if (act === 'delete') {
          if (!cur.confirmDelete) {
            cur.confirmDelete = true;
            renderRecentRowMenu();
            return;
          }
          closeRecentRowMenu();
          deleteRecentConversation(cur.id, bindings);
        }
      });
      document.body.appendChild(menu);
    }

    const canMutate = Boolean(getSidebarActionsCtx(findSidebarBindings()));
    const projPart =
      st.projectName && st.projectId && FEAT.projects
        ? `<button type="button" class="ag-rm-item ag-rm-project" data-ag-rm-act="open-project" title="${escapeHtml(L('打开所属项目', 'Open project'))}">${RECENT_FOLDER_SVG}<span class="ag-rm-label">${escapeHtml(st.projectName)}</span></button><div class="ag-rm-sep"></div>`
        : st.projectName
          ? `<div class="ag-rm-meta">${RECENT_FOLDER_SVG}<span class="ag-rm-label">${escapeHtml(st.projectName)}</span></div><div class="ag-rm-sep"></div>`
          : '';
    const delLabel = st.confirmDelete ? L('确认删除？', 'Confirm delete?') : L('删除', 'Delete');
    menu.innerHTML =
      projPart +
      `<button type="button" class="ag-rm-item" data-ag-rm-act="pin"${canMutate ? '' : ' disabled'}>${RECENT_PIN_SVG}<span class="ag-rm-label">${escapeHtml(L('置顶对话', 'Pin'))}</span></button>` +
      `<button type="button" class="ag-rm-item" data-ag-rm-act="rename"${canMutate ? '' : ' disabled'}>${RECENT_RENAME_SVG}<span class="ag-rm-label">${escapeHtml(L('重命名', 'Rename'))}</span></button>` +
      `<button type="button" class="ag-rm-item" data-ag-rm-act="copy-id" title="${escapeHtml(st.id)}">${RECENT_COPY_SVG}<span class="ag-rm-label">${escapeHtml(L('复制对话 ID', 'Copy Conversation ID'))}</span></button>` +
      `<button type="button" class="ag-rm-item" data-ag-rm-act="archive"${canMutate ? '' : ' disabled'}>${RECENT_ARCHIVE_SVG}<span class="ag-rm-label">${escapeHtml(L('归档', 'Archive'))}</span></button>` +
      `<div class="ag-rm-sep"></div>` +
      `<button type="button" class="ag-rm-item ag-rm-danger" data-ag-rm-act="delete" data-confirm="${st.confirmDelete ? '1' : '0'}"${canMutate ? '' : ' disabled'}>${RECENT_TRASH_SVG}<span class="ag-rm-label">${escapeHtml(delLabel)}</span></button>`;

    const menuW = 196;
    const menuH = Math.max(180, menu.offsetHeight || 208);
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    const left = Math.min(Math.max(8, st.x), Math.max(8, vw - menuW - 8));
    const top = st.y + menuH > vh - 8 ? Math.max(8, st.y - menuH) : Math.max(8, st.y);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    if (!recentMenuDocBound) {
      document.addEventListener('mousedown', onRecentMenuDocDown, true);
      document.addEventListener('keydown', onRecentMenuDocKey, true);
      window.addEventListener('resize', onRecentMenuResize);
      recentMenuDocBound = true;
    }
  }

  function openRecentRowMenu(item, x, y, source = 'recent') {
    if (!item || !item.id) return;
    if (recentMenuState && recentMenuState.id === item.id) {
      closeRecentRowMenu();
      return;
    }
    recentMenuState = {
      id: item.id,
      title: item.title,
      projectId: item.projectId || '',
      projectName: item.project || '',
      x,
      y,
      confirmDelete: false,
      source: source || 'recent',
    };
    renderRecentRowMenu();
  }

  function removeRecentSection() {
    closeRecentRowMenu('recent');
    recentRenamingId = '';
    const el = document.getElementById('ag-claude-recent-section');
    if (el) el.remove();
    rtState.recentLastSig = '';
  }

  function syncRecentSection(bindings, state, activeId, hasFocus) {
    const isUnified = Boolean(FEAT.hideSidebarProjects);
    if ((!isUnified && !FEAT.recentSection) || !bindings) {
      removeRecentSection();
      return;
    }
    const { host: sbParent, container: sbGrand } = getSidebarListHost(bindings.sidebar);
    if (!sbParent || !sbGrand) return;

    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    const list = [];
    for (const [id, summary] of Object.entries(summaries)) {
      if (!isSidebarVisibleSummary(id, summary, state)) continue;
      if (isSummaryPinned(id, summary, state)) continue;
      const status = classifySidebarConversation(id, summary, state, activeId, hasFocus);
      const rawTitle = (summary.annotations && summary.annotations.title) || summary.summary;
      const isLiveOrActiveUntitled =
        !rawTitle &&
        (id === activeId ||
          (status && (status.kind === 'running' || status.kind === 'pending')) ||
          Number(summary.stepCount || 0) > 0);
      if (!rawTitle && !isLiveOrActiveUntitled) continue;
      const title = rawTitle ? String(rawTitle) : L('新对话', 'New conversation');
      const updatedAt = Math.max(protoSeconds(summary.lastModifiedTime), protoSeconds(summary.createdTime));
      const priority = status && status.kind === 'pending' ? 3 : status && status.kind === 'running' ? 2 : 1;
      const projInfo = resolveSummaryProjectInfo(id, summary, bindings.projectLabels, state);
      list.push({
        id,
        title,
        project: projInfo.name,
        projectId: projInfo.id,
        updatedAt,
        status,
        priority
      });
    }
    if (!list.length && !isUnified) {
      removeRecentSection();
      return;
    }
    list.sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt);
    recentItemsById = new Map(list.map((it) => [it.id, it]));
    const limit = isUnified ? recentPageLimit : recentExpanded ? 8 : 4;
    const items = list.slice(0, limit);
    const total = list.length;
    const nowBucket = Math.floor(Date.now() / 30000);
    const nowSec = Math.floor(Date.now() / 1000);
    const mode = isUnified ? 'unified' : 'compact';

    let sec = document.getElementById('ag-claude-recent-section');
    const desiredRef = isUnified ? sbParent.nextSibling : sbParent;
    const wrongParent = !sec || sec.parentElement !== sbGrand;
    const wrongPosition =
      sec &&
      sec.parentElement === sbGrand &&
      (isUnified ? sec.previousSibling !== sbParent : sec.nextSibling !== sbParent);

    if (wrongParent) {
      if (sec) sec.remove();
      sec = document.createElement('section');
      sec.id = 'ag-claude-recent-section';
      sec.setAttribute('data-ag-i18n-ignore', '1');
      sec.setAttribute('aria-label', L('最近对话', 'Recents'));
      sec.addEventListener('click', (ev) => {
        const newBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-new]');
        if (newBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeRecentRowMenu();
          if (rtState.projectsViewOpen) closeProjectsView();
          triggerNewConversationFromSidebar(findSidebarBindings() || bindings);
          return;
        }
        const hdr = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-toggle]');
        if (hdr) {
          if (sec.getAttribute('data-mode') === 'unified') {
            rtState.unifiedRecentCollapsed = !rtState.unifiedRecentCollapsed;
            try {
              localStorage.setItem('ag_claude_ux_unified_recents_collapsed', rtState.unifiedRecentCollapsed ? '1' : '0');
            } catch {}
          } else {
            rtState.recentCollapsed = !rtState.recentCollapsed;
            try {
              localStorage.setItem('ag_claude_ux_recent_collapsed', rtState.recentCollapsed ? '1' : '0');
            } catch {}
          }
          persistUiPrefsToDaemon();
          rtState.recentLastSig = '';
          syncSidebarEnhancements();
          return;
        }
        const more = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-more]');
        if (more) {
          if (sec.getAttribute('data-mode') === 'unified') {
            recentPageLimit += 50;
          } else {
            recentExpanded = !recentExpanded;
          }
          rtState.recentLastSig = '';
          syncSidebarEnhancements();
          return;
        }
        const pinBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-pin]');
        if (pinBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          closeRecentRowMenu();
          const cid = pinBtn.getAttribute('data-ag-recent-pin');
          mutateRecentConversationAnnotation(cid, { pinned: true }, findSidebarBindings() || bindings);
          return;
        }
        const menuBtn = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-menu]');
        if (menuBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          const cid = menuBtn.getAttribute('data-ag-recent-menu');
          const item = recentItemsById.get(cid);
          const r = menuBtn.getBoundingClientRect();
          openRecentRowMenu(item, r.right + 4, r.bottom + 4);
          return;
        }
        if (ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-rename-input]')) {
          ev.stopPropagation();
          return;
        }
        const row = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-id]');
        if (row) {
          if (Date.now() - recentLastDragEndTs < 260) return;
          const cid = row.getAttribute('data-ag-recent-id');
          if (recentRenamingId && recentRenamingId === cid) return;
          closeRecentRowMenu();
          if (rtState.projectsViewOpen) closeProjectsView();
          const curBindings = findSidebarBindings() || bindings;
          navigateSidebarConversation(cid, curBindings);
          scheduleSidebarSync();
        }
      });
      sec.addEventListener('dragstart', (ev) => {
        if (
          ev.target &&
          ev.target.closest &&
          ev.target.closest('[data-ag-recent-pin], [data-ag-recent-menu], [data-ag-recent-rename-input], [data-ag-recent-open-proj]')
        ) {
          ev.preventDefault();
          return;
        }
        const row = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-id]');
        if (!row) return;
        const cid = row.getAttribute('data-ag-recent-id');
        if (!cid || (recentRenamingId && recentRenamingId === cid)) {
          ev.preventDefault();
          return;
        }
        const item = recentItemsById.get(cid);
        const title = (item && item.title) || row.getAttribute('data-ag-recent-title') || '';
        attachConversationDragTransfer(ev.dataTransfer, cid, title);
        row.setAttribute('data-dragging', 'true');
      });
      sec.addEventListener('dragend', (ev) => {
        recentLastDragEndTs = Date.now();
        const row = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-id]');
        if (row) row.removeAttribute('data-dragging');
        sec.querySelectorAll('[data-dragging="true"]').forEach((n) => n.removeAttribute('data-dragging'));
      });
      sec.addEventListener('contextmenu', (ev) => {
        if (sec.getAttribute('data-mode') !== 'unified') return;
        const row = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-id]');
        if (!row) return;
        const cid = row.getAttribute('data-ag-recent-id');
        if (recentRenamingId && recentRenamingId === cid) return;
        const item = recentItemsById.get(cid);
        if (!item) return;
        ev.preventDefault();
        ev.stopPropagation();
        openRecentRowMenu(item, ev.clientX + 2, ev.clientY + 2);
      });
      sec.addEventListener('keydown', (ev) => {
        const input = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-rename-input]');
        if (input) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            ev.stopPropagation();
            commitRecentInlineRename(input, true);
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            commitRecentInlineRename(input, false);
          }
          return;
        }
        const row = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-id]');
        if (row && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          if (rtState.projectsViewOpen) closeProjectsView();
          const cid = row.getAttribute('data-ag-recent-id');
          navigateSidebarConversation(cid, findSidebarBindings() || bindings);
          scheduleSidebarSync();
        }
      });
      sec.addEventListener(
        'blur',
        (ev) => {
          const input = ev.target && ev.target.closest && ev.target.closest('[data-ag-recent-rename-input]');
          if (input) commitRecentInlineRename(input, true);
        },
        true
      );
      sbGrand.insertBefore(sec, desiredRef);
      rtState.recentLastSig = '';
    } else if (wrongPosition) {
      sbGrand.insertBefore(sec, desiredRef);
      rtState.recentLastSig = '';
    }

    if (sec.getAttribute('data-mode') !== mode) {
      sec.setAttribute('data-mode', mode);
      rtState.recentLastSig = '';
    }

    if (recentRenamingId && sec.querySelector('[data-ag-recent-rename-input]')) {
      return;
    }

    const isCollapsed = isUnified ? rtState.unifiedRecentCollapsed : rtState.recentCollapsed;
    if (isCollapsed) {
      if (sec.getAttribute('data-collapsed') !== '1') sec.setAttribute('data-collapsed', '1');
    } else if (sec.hasAttribute('data-collapsed')) {
      sec.removeAttribute('data-collapsed');
    }
    const sig = `${mode}|${FEAT.i18n ? 1 : 0}|${isCollapsed ? 1 : 0}|${isUnified ? recentPageLimit : recentExpanded ? 1 : 0}|${recentRenamingId}|${activeId}|${nowBucket}|${total}|${items
      .map((it) => `${it.id}:${it.title}:${it.project}:${hooks.getConversationBranchBadge?.(it.id) || ''}:${it.status ? `${it.status.kind}-${it.status.subkind}-${it.status.detail || ''}` : 'idle'}:${Math.floor(it.updatedAt / 60)}`)
      .join(';')}`;
    if (sig === rtState.recentLastSig) return;
    rtState.recentLastSig = sig;
    sec.setAttribute('aria-label', L('最近对话', 'Recents'));

    const headerHtml = isUnified
      ? `<div class="ag-recent-hdr-bar"><button type="button" class="ag-recent-hdr" data-ag-recent-toggle aria-expanded="${!isCollapsed}"><span>${L('最近对话', 'Recents')}</span><span class="ag-recent-chevron">▾</span></button><button type="button" class="ag-recent-new-btn" data-ag-recent-new title="${escapeHtml(L('新建对话', 'New conversation'))}" aria-label="${escapeHtml(L('新建对话', 'New conversation'))}">${RECENT_PLUS_SVG}</button></div>`
      : `<button type="button" class="ag-recent-hdr" data-ag-recent-toggle aria-expanded="${!isCollapsed}"><span>${L('最近对话', 'Recents')}</span><span class="ag-recent-chevron">▾</span></button>`;

    const moreHtml = isUnified
      ? total > items.length
        ? `<button type="button" class="ag-recent-more" data-ag-recent-more>${escapeHtml(
            FEAT.i18n ? `显示更多（还有 ${total - items.length} 条）` : `Show more (${total - items.length} left)`
          )}</button>`
        : ''
      : total > 4
        ? `<button type="button" class="ag-recent-more" data-ag-recent-more>${recentExpanded ? L('收起', 'Show less') : L('展开更多', 'Show more')}</button>`
        : '';

    const rowsHtml = isCollapsed
      ? ''
      : items.length
        ? `<div class="ag-recent-list">${items
            .map((it) => {
              const isAct = it.id === activeId;
              const isRenaming = isUnified && recentRenamingId === it.id;
              const age = formatRelativeAge(it.updatedAt, nowSec);
              let sideHtml = `<span>${escapeHtml(age)}</span>`;
              if (it.status && it.status.kind === 'pending') {
                sideHtml = `<span class="ag-claude-folder-badge" data-kind="pending">${pendingGlyphSvg(it.status.subkind)}</span>`;
              } else if (it.status && it.status.kind === 'running') {
                sideHtml = renderRunningGlyphHtml(it.status.subkind);
              } else if (it.status && it.status.kind === 'unread') {
                sideHtml = `<span class="ag-claude-unread-dot"></span>${age ? `<span>${escapeHtml(age)}</span>` : ''}`;
              }
              const wtBranch = hooks.getConversationBranchBadge?.(it.id) || '';
              const tipParts = [it.title];
              if (it.status && it.status.kind === 'running') tipParts.push(formatRunningStatusTooltip(it.status, L));
              if (it.project) tipParts.push(`${L('所属项目：', 'Project: ')}${it.project}`);
              if (wtBranch) tipParts.push(`Worktree: ${wtBranch}`);
              const tip = tipParts.join('\n');
              const actionsHtml =
                isUnified && !isRenaming
                  ? `<div class="ag-recent-actions"><button type="button" class="ag-recent-act-btn" data-ag-recent-pin="${escapeHtml(it.id)}" title="${escapeHtml(L('置顶对话', 'Pin'))}" aria-label="${escapeHtml(L('置顶对话', 'Pin'))}">${RECENT_PIN_SVG}</button><button type="button" class="ag-recent-act-btn" data-ag-recent-menu="${escapeHtml(it.id)}" title="${escapeHtml(L('更多选项', 'More options'))}" aria-label="${escapeHtml(L('更多选项', 'More options'))}">${RECENT_MORE_SVG}</button></div>`
                  : '';
              const branchPillHtml = '';
              const mainInner = isRenaming
                ? `<input type="text" class="ag-recent-rename-input" data-ag-recent-rename-input="${escapeHtml(it.id)}" data-orig-title="${escapeHtml(it.title)}" value="${escapeHtml(it.title)}" />`
                : `<div class="ag-recent-title">${escapeHtml(it.title)}</div>`;
              return `<div class="ag-recent-row" role="button" tabindex="0"${isRenaming ? '' : ' draggable="true"'} data-ag-recent-id="${escapeHtml(it.id)}" data-ag-recent-title="${escapeHtml(it.title)}" data-active="${isAct ? 'true' : 'false'}"${it.project ? ` data-has-project="true"` : ''}${isRenaming ? ' data-renaming="true"' : ''} title="${escapeHtml(tip)}"><div class="ag-recent-main">${mainInner}</div>${isRenaming ? '' : `<div class="ag-recent-side">${sideHtml}</div>${actionsHtml}`}</div>`;
            })
            .join('')}</div>` + moreHtml
        : `<div class="ag-recent-empty">${escapeHtml(L('暂无最近对话', 'No recent conversations'))}</div>`;

    sec.innerHTML = `${headerHtml}${rowsHtml}`;
  }

  function scheduleSidebarSync() {
    if (rtState.disposed || sidebarSyncTimer) return;
    sidebarSyncTimer = later(() => {
      sidebarSyncTimer = 0;
      syncSidebarEnhancements();
    }, 90);
  }

  let sidebarHideRaf = 0;
  function isNativeProjectsHidden() {
    return Boolean(FEAT.hideSidebarProjects || hooks.isSidebarProjectsCapActive?.());
  }
  function scheduleSidebarHideSync() {
    if (rtState.disposed || sidebarHideRaf) return;
    sidebarHideRaf = frame(() => {
      sidebarHideRaf = 0;
      if (!rtState.disposed && isNativeProjectsHidden()) syncSidebarHideNativeProjects();
    });
  }

  function syncSidebarEnhancements() {
    if (rtState.disposed) return;
    restoreLegacySidebarCjkNodes();
    const unifiedRecentsOn = Boolean(FEAT.hideSidebarProjects);
    if (!FEAT.folderStatus && !FEAT.recentSection && !unifiedRecentsOn) {
      if (sidebarStoreUnsub) {
        sidebarStoreUnsub();
        sidebarStoreUnsub = null;
        rtState.sidebarStoreRef = null;
      }
      clearAllFolderBadges();
      removeRecentSection();
      return;
    }
    const bindings = findSidebarBindings();
    if (!bindings) {
      if (unifiedRecentsOn) clearSidebarHideNativeProjects();
      return;
    }
    if (rtState.sidebarStoreRef !== bindings.store) {
      if (sidebarStoreUnsub) sidebarStoreUnsub();
      rtState.sidebarStoreRef = bindings.store;
      if (typeof bindings.store.subscribe === 'function') {
        sidebarStoreUnsub = bindings.store.subscribe(() => {
          scheduleSidebarSync();
          if (isNativeProjectsHidden()) scheduleSidebarHideSync();
        });
      } else {
        sidebarStoreUnsub = null;
      }
    }
    const state = bindings.store.getState();
    const activeId = getActiveCascadeId();
    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    const bgCandidates = [];
    const summaries = (state && state.trajectorySummaries && state.trajectorySummaries.summaries) || {};
    for (const [cid, sum] of Object.entries(summaries)) {
      if (!sum || sum.killed || !isSidebarVisibleSummary(cid, sum, state)) continue;
      const runCls = classifyRunningSubkind(cid, sum, state, null);
      if (runCls && runCls.needsBgLookup) {
        bgCandidates.push({
          id: cid,
          sig: `${protoSeconds(sum.lastModifiedTime)}:${sum.stepCount || 0}:${sum.backgroundTaskCount || 0}`,
        });
      }
    }
    bgStatusClient.syncCandidates(bgCandidates);
    syncFolderStatusBadges(bindings, state, activeId, hasFocus);
    syncRecentSection(bindings, state, activeId, hasFocus);
    hooks.syncSidebarProjects?.(bindings, state, activeId, hasFocus);
    if (hooks.isSidebarProjectsCapActive?.()) scheduleSidebarHideSync();
    hooks.syncConvProjectTopbar?.();
  }

  const onWindowSidebarEvent = () => scheduleSidebarSync();
  window.addEventListener('focus', onWindowSidebarEvent);
  window.addEventListener('blur', onWindowSidebarEvent);
  window.addEventListener('popstate', onWindowSidebarEvent);


  let sidebarHideScrollEl = null;
  let sidebarListLayoutMo = null;
  let sidebarListLayoutTarget = null;

  function syncPinnedSidebarRowTooltips(root) {
    const scope = root || document;
    const pinGlyphSpans = new Set();
    scope.querySelectorAll('[data-testid="conversation-row-sidebar"][data-pinned="true"] span > svg[data-project-glyph]').forEach((svg) => {
      if (svg.parentElement) pinGlyphSpans.add(svg.parentElement);
    });
    syncAttrTargetSet('data-maga-pin-glyph', pinGlyphSpans);

    const rows = scope.querySelectorAll('[data-testid="conversation-row-sidebar"][data-pinned="true"][data-subtext]');
    for (const row of rows) {
      const subtext = String(row.getAttribute('data-subtext') || '').trim();
      const link = row.querySelector('a[href]');
      if (!subtext) {
        if (link && link.getAttribute('data-ag-pin-tip') === '1') {
          link.removeAttribute('title');
          link.removeAttribute('data-ag-pin-tip');
        }
        continue;
      }
      const titleSpan = row.querySelector('.flex-col > span');
      const baseTitle = String((link && link.getAttribute('aria-label')) || (titleSpan && titleSpan.textContent) || '').trim();
      const tip = baseTitle ? `${baseTitle}\n${L('所属项目：', 'Project: ')}${subtext}` : `${L('所属项目：', 'Project: ')}${subtext}`;
      const target = link || row;
      if (target.getAttribute('title') !== tip) {
        target.setAttribute('title', tip);
        target.setAttribute('data-ag-pin-tip', '1');
      }
    }
  }

  function clearPinnedSidebarRowTooltips() {
    document.querySelectorAll('[data-ag-pin-tip="1"]').forEach((el) => {
      el.removeAttribute('title');
      el.removeAttribute('data-ag-pin-tip');
    });
    document.querySelectorAll('[data-maga-pin-glyph="1"]').forEach((el) => {
      el.removeAttribute('data-maga-pin-glyph');
    });
  }

  function parseVirtualTranslateY(el) {
    if (!el) return 0;
    const tf = String((el.style && el.style.transform) || '');
    const m = tf.match(/translateY\(([-\d.]+)px\)/i);
    if (m) return Number(m[1]) || 0;
    return 0;
  }

  let pinnedMeasureRetryTimer = 0;
  let pinnedMeasureRetries = 0;

  function clearPinnedMeasureRetry() {
    if (pinnedMeasureRetryTimer) {
      if (typeof cancelLater === 'function') cancelLater(pinnedMeasureRetryTimer);
      else clearTimeout(pinnedMeasureRetryTimer);
      pinnedMeasureRetryTimer = 0;
    }
    pinnedMeasureRetries = 0;
  }

  function schedulePinnedMeasureRetry() {
    if (rtState.disposed || pinnedMeasureRetryTimer || pinnedMeasureRetries >= 6) return;
    pinnedMeasureRetries += 1;
    pinnedMeasureRetryTimer = later(() => {
      pinnedMeasureRetryTimer = 0;
      if (!rtState.disposed && isNativeProjectsHidden()) syncSidebarHideNativeProjects();
    }, 80);
  }

  function countActiveStoreKeptItems(state) {
    const ts = state && state.trajectorySummaries;
    const summaries = (ts && ts.summaries) || {};
    const indexes = (ts && ts.indexes) || {};
    const toIds = (col) => {
      if (!col) return [];
      if (typeof col[Symbol.iterator] === 'function' && typeof col !== 'string') return Array.from(col);
      if (typeof col === 'object') return Object.keys(col);
      return [];
    };
    const pinnedIds = new Set();
    for (const id of toIds(indexes.pinned)) {
      if (id && !(summaries[id] && summaries[id].annotations && summaries[id].annotations.archived)) pinnedIds.add(id);
    }
    for (const [id, s] of Object.entries(summaries)) {
      if (id && s && s.annotations && s.annotations.pinned && !s.annotations.archived) pinnedIds.add(id);
    }
    let coordCount = 0;
    for (const id of toIds(indexes.coordinator)) {
      if (id && !(summaries[id] && summaries[id].annotations && summaries[id].annotations.archived)) coordCount += 1;
    }
    return { pinnedCount: pinnedIds.size, coordCount, total: pinnedIds.size + coordCount };
  }

  function estimatePinnedBootstrapHeight(cutIdx, storeKept) {
    const estRows = Math.max(Number(cutIdx) || 0, storeKept.total + (storeKept.pinnedCount > 0 ? 1 : 0) + (storeKept.coordCount > 0 ? 1 : 0), 2);
    return Math.max(72, Math.min(360, estRows * 36));
  }

  function clearSidebarHideNativeProjects() {
    clearPinnedMeasureRetry();
    if (sidebarHideScrollEl) {
      sidebarHideScrollEl.removeEventListener('scroll', onSidebarHideScroll);
      sidebarHideScrollEl = null;
    }
    if (sidebarListLayoutMo) {
      try {
        sidebarListLayoutMo.disconnect();
      } catch {}
      sidebarListLayoutMo = null;
      sidebarListLayoutTarget = null;
    }
    const scrollBox = document.querySelector('[data-testid="conversation-list-sidebar"]');
    const { host: sbParent } = getSidebarListHost(scrollBox);
    if (sbParent) {
      sbParent.removeAttribute('data-ag-sb-unified');
      sbParent.style.removeProperty('--ag-sb-pinned-height');
    }
    if (scrollBox && scrollBox !== sbParent) {
      scrollBox.removeAttribute('data-ag-sb-unified');
      scrollBox.style.removeProperty('--ag-sb-pinned-height');
    }
    const list = scrollBox && scrollBox.firstElementChild;
    if (!list) return;
    list.style.removeProperty('--ag-sb-proj-shift');
    delete list.dataset.agProjIdx;
    delete list.dataset.agConvIdx;
    delete list.dataset.agProjShift;
    delete list.dataset.agCutIdx;
    delete list.dataset.agPinnedH;
    for (const child of list.children) {
      child.removeAttribute('data-ag-sb-hide-proj');
      child.removeAttribute('data-ag-sb-shift-up');
    }
  }

  function onSidebarHideScroll() {
    syncSidebarHideNativeProjects();
  }

  function syncSidebarHideNativeProjects() {
    const scrollBox = document.querySelector('[data-testid="conversation-list-sidebar"]');
    if (scrollBox && !rtState.disposed) {
      syncPinnedSidebarRowTooltips(scrollBox);
    }
    const capActive = Boolean(hooks.isSidebarProjectsCapActive?.());
    if (rtState.disposed || (!FEAT.hideSidebarProjects && !capActive)) {
      clearSidebarHideNativeProjects();
      return;
    }
    const { host: sbParent } = getSidebarListHost(scrollBox);
    const list = scrollBox && scrollBox.firstElementChild;
    if (!scrollBox || !sbParent || !list) return;

    /* Guard against hiding native sidebar lists when custom sidebar section failed to mount on a live React host */
    const hasReactHost = Boolean(
      document.getElementById('root') ||
        Object.keys(list).some((k) => k.startsWith('__react')) ||
        Object.keys(scrollBox).some((k) => k.startsWith('__react'))
    );
    const expectedSecId = FEAT.hideSidebarProjects ? 'ag-claude-recent-section' : 'ag-claude-sidebar-projects';
    if (hasReactHost && !document.getElementById(expectedSecId)) {
      const bindings = findSidebarBindings();
      if (bindings) {
        if (FEAT.hideSidebarProjects) {
          syncRecentSection(
            bindings,
            bindings.store.getState(),
            getActiveCascadeId(),
            typeof document.hasFocus === 'function' ? document.hasFocus() : true
          );
        } else {
          hooks.syncSidebarProjects?.(
            bindings,
            bindings.store.getState(),
            getActiveCascadeId(),
            typeof document.hasFocus === 'function' ? document.hasFocus() : true
          );
        }
      }
      if (!document.getElementById(expectedSecId)) {
        clearSidebarHideNativeProjects();
        return;
      }
    }

    const storeKept = countActiveStoreKeptItems(findSidebarBindings()?.store?.getState?.());
    const indexed = [];
    for (const child of list.children) {
      const rawIdx = child.getAttribute('data-index');
      if (rawIdx === null || rawIdx === '') continue;
      const idx = Number(rawIdx);
      if (Number.isFinite(idx)) indexed.push({ idx, el: child });
    }
    if (!indexed.length) {
      if (storeKept.total > 0) {
        const estH = estimatePinnedBootstrapHeight(0, storeKept);
        const nextPinnedPx = `${estH}px`;
        if (sbParent.getAttribute('data-ag-sb-unified') !== 'pinned') sbParent.setAttribute('data-ag-sb-unified', 'pinned');
        if (sbParent.style.getPropertyValue('--ag-sb-pinned-height') !== nextPinnedPx) sbParent.style.setProperty('--ag-sb-pinned-height', nextPinnedPx);
        schedulePinnedMeasureRetry();
      }
      return;
    }
    indexed.sort((a, b) => a.idx - b.idx);

    /* Sections that stay native above the cut: Pinned and (v2.34+) Coordinators, which the native list
       renders BEFORE Pinned. Match by testid / data-title first so localized header text cannot misfire. */
    const KEPT_HDR_RE = /^(pinned|置顶对话|coordinators|协调器|编排器)$/i;
    const isKeptSectionHeader = (sh) =>
      Boolean(
        sh &&
        (sh.querySelector('[data-testid="pinned-section-header"], [data-testid="coordinator-section-header"]') ||
          KEPT_HDR_RE.test(String(sh.getAttribute('data-title') || '').trim()) ||
          KEPT_HDR_RE.test(String(sh.textContent || '').trim()))
      );
    let cutItem = indexed.find((x) => Boolean(x.el.querySelector('[data-testid="sidebar-add-project-button"]')));
    if (!cutItem) {
      cutItem = indexed.find((x) => {
        const sh = x.el.querySelector('[data-testid="section-header"]');
        return Boolean(sh && !isKeptSectionHeader(sh));
      });
    }

    if (cutItem) {
      const measuredH = cutItem.idx === 0 ? 0 : Math.max(0, Math.round(parseVirtualTranslateY(cutItem.el)));
      let pinnedH = measuredH;
      if (measuredH > 0) {
        clearPinnedMeasureRetry();
      } else if (cutItem.idx > 0 || storeKept.total > 0) {
        pinnedH = estimatePinnedBootstrapHeight(cutItem.idx, storeKept);
        schedulePinnedMeasureRetry();
      } else {
        clearPinnedMeasureRetry();
      }
      const nextCutStr = String(cutItem.idx);
      const nextPinnedStr = String(pinnedH);
      if (list.dataset.agCutIdx !== nextCutStr) list.dataset.agCutIdx = nextCutStr;
      if (list.dataset.agPinnedH !== nextPinnedStr) list.dataset.agPinnedH = nextPinnedStr;
    }

    const hasPinnedHdr = indexed.some((x) => {
      const sh = x.el.querySelector('[data-testid="section-header"]');
      return isKeptSectionHeader(sh);
    });

    if (list.dataset.agCutIdx === undefined && !hasPinnedHdr) {
      /* Structure did not match any known section header — do NOT lock scrollTop or hide native list */
      clearSidebarHideNativeProjects();
      return;
    }

    /* Bind scroll lock & virtual-list observer only after confirming the native sidebar structure matches */
    if (sidebarHideScrollEl !== scrollBox) {
      if (sidebarHideScrollEl) sidebarHideScrollEl.removeEventListener('scroll', onSidebarHideScroll);
      sidebarHideScrollEl = scrollBox;
      scrollBox.addEventListener('scroll', onSidebarHideScroll, { passive: true });
    }
    if (typeof MutationObserver !== 'undefined' && sidebarListLayoutTarget !== list) {
      if (sidebarListLayoutMo) {
        try {
          sidebarListLayoutMo.disconnect();
        } catch {}
      }
      sidebarListLayoutTarget = list;
      sidebarListLayoutMo = new MutationObserver((muts) => {
        if (rtState.disposed || (!FEAT.hideSidebarProjects && !hooks.isSidebarProjectsCapActive?.())) return;
        for (const m of muts) {
          if (m.attributeName === 'data-subtext') {
            syncPinnedSidebarRowTooltips(scrollBox);
            return;
          }
          if ((m.attributeName === 'style' || m.attributeName === 'data-index') && m.target && m.target.parentElement === list) {
            syncSidebarHideNativeProjects();
            return;
          }
        }
      });
      sidebarListLayoutMo.observe(list, {
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'data-subtext', 'data-index']
      });
    }
    if (scrollBox.scrollTop > 0) {
      try {
        scrollBox.scrollTop = 0;
      } catch {}
    }

    if (list.dataset.agCutIdx === undefined) {
      // Only pinned section exists in virtual list (no native Projects/Conversations headers rendered)
      const last = indexed[indexed.length - 1];
      const lastY = parseVirtualTranslateY(last.el);
      const lastRectH = (last.el.getBoundingClientRect && last.el.getBoundingClientRect().height) || 0;
      let estH = Math.max(0, Math.round(lastY + (lastRectH || 33) + 12));
      if ((estH === 0 || (lastY === 0 && lastRectH === 0)) && (hasPinnedHdr || storeKept.total > 0)) {
        estH = estimatePinnedBootstrapHeight(indexed.length, storeKept);
        schedulePinnedMeasureRetry();
      } else {
        clearPinnedMeasureRetry();
      }
      const nextUnified = estH > 0 ? 'pinned' : 'empty';
      const nextPinnedPx = `${estH}px`;
      if (sbParent.getAttribute('data-ag-sb-unified') !== nextUnified) sbParent.setAttribute('data-ag-sb-unified', nextUnified);
      if (sbParent.style.getPropertyValue('--ag-sb-pinned-height') !== nextPinnedPx) sbParent.style.setProperty('--ag-sb-pinned-height', nextPinnedPx);
      for (const { el } of indexed) {
        if (el.hasAttribute('data-ag-sb-hide-proj')) el.removeAttribute('data-ag-sb-hide-proj');
        if (el.hasAttribute('data-ag-sb-shift-up')) el.removeAttribute('data-ag-sb-shift-up');
      }
      return;
    }

    let cutIdx = Number(list.dataset.agCutIdx);
    let pinnedH = Number(list.dataset.agPinnedH) || 0;
    /* If a newly pinned row pushed past the cached cutIdx while the cut header scrolled out, expand cutIdx safely */
    if (!cutItem) {
      let maxPinnedIdx = -1;
      let maxPinnedBottom = pinnedH;
      for (const { idx, el } of indexed) {
        const rowEl = el.querySelector('[data-testid="conversation-row-sidebar"][data-pinned="true"]');
        if (rowEl) {
          if (idx > maxPinnedIdx) maxPinnedIdx = idx;
          const b = Math.round(parseVirtualTranslateY(el) + ((el.getBoundingClientRect && el.getBoundingClientRect().height) || 33));
          if (b > maxPinnedBottom) maxPinnedBottom = b;
        }
      }
      if (maxPinnedIdx >= cutIdx) {
        cutIdx = maxPinnedIdx + 1;
        pinnedH = maxPinnedBottom;
        const nextCutStr = String(cutIdx);
        const nextPinnedStr = String(pinnedH);
        if (list.dataset.agCutIdx !== nextCutStr) list.dataset.agCutIdx = nextCutStr;
        if (list.dataset.agPinnedH !== nextPinnedStr) list.dataset.agPinnedH = nextPinnedStr;
      }
    }
    const nextUnified = pinnedH > 0 ? 'pinned' : 'empty';
    const nextPinnedPx = `${pinnedH}px`;
    if (sbParent.getAttribute('data-ag-sb-unified') !== nextUnified) sbParent.setAttribute('data-ag-sb-unified', nextUnified);
    if (sbParent.style.getPropertyValue('--ag-sb-pinned-height') !== nextPinnedPx) sbParent.style.setProperty('--ag-sb-pinned-height', nextPinnedPx);
    if (list.style.getPropertyValue('--ag-sb-proj-shift')) list.style.removeProperty('--ag-sb-proj-shift');

    for (const { idx, el } of indexed) {
      if (el.hasAttribute('data-ag-sb-shift-up')) el.removeAttribute('data-ag-sb-shift-up');
      const isPinnedRow = Boolean(el.querySelector('[data-testid="conversation-row-sidebar"][data-pinned="true"]'));
      if (idx >= cutIdx && !isPinnedRow) {
        if (el.getAttribute('data-ag-sb-hide-proj') !== '1') el.setAttribute('data-ag-sb-hide-proj', '1');
      } else {
        if (el.hasAttribute('data-ag-sb-hide-proj')) el.removeAttribute('data-ag-sb-hide-proj');
      }
    }
  }

  function dispose() {
    clearPinnedMeasureRetry();
    document.removeEventListener('pointerdown', onPinnedRowPointerDown, true);
    window.removeEventListener('pointermove', onPinnedRowPointerMove, true);
    window.removeEventListener('pointerup', onPinnedRowPointerUp, true);
    window.removeEventListener('pointercancel', onPinnedRowPointerCancel, true);
    clearPinnedComposerDropHighlights();
    window.removeEventListener('focus', onWindowSidebarEvent);
    window.removeEventListener('blur', onWindowSidebarEvent);
    window.removeEventListener('popstate', onWindowSidebarEvent);
    bgStatusClient.dispose();
    if (sidebarStoreUnsub) {
      sidebarStoreUnsub();
      sidebarStoreUnsub = null;
      rtState.sidebarStoreRef = null;
    }
    clearAllFolderBadges();
    removeRecentSection();
    clearSidebarHideNativeProjects();
    restoreLegacySidebarCjkNodes(true);
    clearPinnedSidebarRowTooltips();
  }

  return {
    RECENT_PIN_SVG,
    RECENT_MORE_SVG,
    RECENT_FOLDER_SVG,
    RECENT_RENAME_SVG,
    RECENT_ARCHIVE_SVG,
    RECENT_TRASH_SVG,
    syncSidebarEnhancements,
    syncSidebarHideNativeProjects,
    clearSidebarHideNativeProjects,
    syncPinnedSidebarRowTooltips,
    clearPinnedSidebarRowTooltips,
    attachConversationDragTransfer,
    attachFileDragTransfer,
    hasDroppedContextPayload,
    extractDroppedContextMentions,
    protoSeconds,
    isSummaryPinned,
    isSidebarVisibleSummary,
    findSidebarBindings,
    getSidebarListHost,
    navigateSidebarConversation,
    closeRecentRowMenu,
    syncRecentSection,
    scheduleSidebarSync,
    classifySidebarConversation,
    pendingGlyphSvg,
    renderRunningGlyphHtml,
    formatRunningStatusTooltip,
    formatRunningPillText,
    formatRunningBreakdownTooltip,
    pickDominantRunningSubkind,
    formatRelativeAge,
    openRecentRowMenu,
    mutateRecentConversationAnnotation,
    triggerNewConversationFromSidebar,
    dispose,
  };
}
