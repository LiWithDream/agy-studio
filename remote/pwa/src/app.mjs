/**
 * AGY Studio Remote Control PWA Entry (Zero-XSS, strict CSP, mobile + desktop responsive).
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  autoResizeTextarea,
  renderComposerFooterBar,
  renderMediaPreviewStrip,
} from './composer-bar.mjs';
import { createConvoActionHandlers } from './convo-actions.mjs';
import {
  clearDeviceIdentity,
  defaultDeviceName,
  loadDeviceIdentity,
  saveDeviceIdentity,
} from './crypto-store.mjs';
import { renderOverviewPanel } from './overview-panel.mjs';
import { createPairViewController } from './pair-view.mjs';
import {
  renderFilterChipsView,
  renderSidebarListView,
} from './sidebar-view.mjs';
import {
  buildOpusReviewPrompt,
  renderMobileMoreMenu,
  renderOpusGateBanner,
  renderResumeBanner,
} from './studio-panel.mjs';
import {
  STORAGE_KEYS,
  applyThemePref,
  bindNativeAndroidBridge,
  bindViewportHeightSync,
  createAlertManager,
  createMobileHistoryController,
  createMoreMenuController,
  createNewChatController,
  createOpusGateActions,
  defaultOverviewCollapsed,
  loadConversationDraft,
  readStoredJsonSet,
  readStoredPref,
  renderConnectionNoticeBar,
  renderSlashCommandBar,
  saveConversationDraft,
  syncTurboConfirmBar,
  triggerGuardedAuthReload,
  writeStoredJsonSet,
  writeStoredPref,
} from './mobile-enhancements.mjs';
import { renderDetailTimeline as renderTimelineView } from './timeline-view.mjs';
import { createInitialViewerState, createViewerController } from './viewer-drawer.mjs';
import {
  DESKTOP_BREAKPOINT_PX,
  PANE_WIDTH_BOUNDS,
  UUID_RE,
  clampPaneWidth,
  copyTextWithFeedback,
  formatPresetBadge,
  getDefaultPaneWidth,
  isRunningStatus,
  isSafeNonTurboPreset,
  mergeSummariesDelta,
  normalizeWsStatus,
  requiresTurboAck,
  resolveLayoutMode,
} from './ui-helpers.mjs';
import {
  createWorkspaceShellDom,
  renderSidebarProjectsBar as renderSidebarProjectsBarView,
} from './workspace-shell.mjs';
import { createIdempotencyKey, createRemoteWsClient } from './ws-client.mjs';

const storedLayoutPref = readStoredPref(STORAGE_KEYS.layoutPref, 'auto');
const initialLayoutPref =
  storedLayoutPref === 'desktop' || storedLayoutPref === 'mobile' ? storedLayoutPref : 'auto';
const storedThemePref = readStoredPref(STORAGE_KEYS.themePref, 'auto');
const initialThemePref =
  storedThemePref === 'light' || storedThemePref === 'dark' ? storedThemePref : 'auto';
const storedGroupBy = readStoredPref(STORAGE_KEYS.sidebarGroupBy, 'recent');
const storedOverviewCol = readStoredPref(STORAGE_KEYS.overviewCollapsed, '');

const state = {
  identity: null,
  health: null,
  pairingCode: '',
  deviceName: defaultDeviceName(),
  turboAcknowledged: false,
  pairingBusy: false,
  pairingError: '',
  showFullFingerprint: false,
  wsStatus: 'disconnected',
  wsDetail: '',
  wsRttMs: null,
  hostAttached: false,
  source: 'cdp',
  globalPreset: null,
  capabilities: null,
  conversations: [],
  filter: 'all', // all | running | waiting
  includeSubagents: false,
  searchQuery: '',
  selectedId: null,
  snapshots: new Map(), // cascadeId -> snapshot object
  streams: new Map(), // cascadeId -> streaming text string
  snapshotLoading: false,
  snapshotError: '',
  mobileView: 'list', // list | detail
  mobileTab: 'chats', // chats | approvals | overview
  layoutPref: initialLayoutPref, // auto | desktop | mobile
  themePref: initialThemePref, // auto | light | dark
  sidebarCollapsed: readStoredPref(STORAGE_KEYS.sidebarCollapsed, 'false') === 'true',
  overviewCollapsed:
    storedOverviewCol === 'true' || storedOverviewCol === 'false'
      ? storedOverviewCol === 'true'
      : defaultOverviewCollapsed(),
  sidebarGroupBy: storedGroupBy === 'project' ? 'project' : 'recent',
  collapsedProjects: readStoredJsonSet(STORAGE_KEYS.collapsedProjects),
  expandedProjectGroups: new Set(),
  draftText: '',
  draftMedia: [],
  draftIdempotencyKey: createIdempotencyKey(),
  turboWriteConfirmed: false,
  pendingApproveKeys: new Map(),
  pendingResumeKeys: new Map(),
  cancelConfirmArmedCid: '',
  studioOverview: null,
  studioDrawerOpen: false,
  moreMenuOpen: false,
  selectedProjectId: '',
  resumeState: null,
  modelCatalog: null,
  slashCommands: null,
  usageRange: 'day',
  viewer: createInitialViewerState(),
  modelPopoverOpen: false,
  contextPopoverOpen: false,
  showHiddenModels: false,
  modelSelectBusy: false,
  streamStartedAt: 0,
  sendBusy: false,
  cancelBusy: false,
  resumeBusy: false,
  compactBusy: false,
  opusDismissBusy: false,
  approvingHash: '',
  approvingByCid: new Map(),
  actionError: '',
  actionNotice: '',
  newChatOpen: false,
  newChatBusy: false,
  newChatProjectId: '',
  newChatPrompt: '',
  newChatTurboConfirmed: false,
  newChatError: '',
};

const alertManager = createAlertManager();

let wsClient = null;
let snapshotRefreshTimer = null;
let pendingForceOverview = false;
let studioOverviewSeq = 0;
let lastOverviewRefreshAt = 0;
let modelReqSeq = 0;
let studioOverviewRetryTimer = null;
let actionNoticeTimer = null;
let swReloading = false;
let workspaceRefs = null;
let globalListenersBound = false;
const rootEl = document.getElementById('app');

function setActionNotice(msg) {
  state.actionNotice = String(msg || '');
  if (actionNoticeTimer) {
    clearTimeout(actionNoticeTimer);
    actionNoticeTimer = null;
  }
  if (state.actionNotice) {
    actionNoticeTimer = setTimeout(() => {
      actionNoticeTimer = null;
      if (state.actionNotice && state.identity && workspaceRefs) {
        state.actionNotice = '';
        syncComposerControls();
      }
    }, 3400);
  }
}

function clearStudioOverviewRetry() {
  if (studioOverviewRetryTimer) {
    clearTimeout(studioOverviewRetryTimer);
    studioOverviewRetryTimer = null;
  }
}

function getResolvedLayoutMode() {
  const w = typeof window !== 'undefined' ? window.innerWidth : DESKTOP_BREAKPOINT_PX;
  return resolveLayoutMode(state.layoutPref, w);
}

function layoutButtonLabel(pref) {
  if (pref === 'desktop') return '视图: 桌面';
  if (pref === 'mobile') return '视图: 移动';
  return '视图: 自动';
}

function themeButtonLabel(pref) {
  if (pref === 'light') return '外观: 浅色';
  if (pref === 'dark') return '外观: 深色';
  return '外观: 跟随系统';
}

function syncPaneAriaValues(viewportWidth, sbRes, ovRes) {
  if (!workspaceRefs) return;
  if (workspaceRefs.sidebarResizer) {
    workspaceRefs.sidebarResizer.setAttribute('aria-valuemin', String(sbRes.min));
    workspaceRefs.sidebarResizer.setAttribute('aria-valuemax', String(sbRes.max));
    workspaceRefs.sidebarResizer.setAttribute('aria-valuenow', String(sbRes.value));
  }
  if (workspaceRefs.overviewResizer) {
    workspaceRefs.overviewResizer.setAttribute('aria-valuemin', String(ovRes.min));
    workspaceRefs.overviewResizer.setAttribute('aria-valuemax', String(ovRes.max));
    workspaceRefs.overviewResizer.setAttribute('aria-valuenow', String(ovRes.value));
  }
}

function applyLayoutAttrs() {
  if (!rootEl) return;
  applyThemePref(state.themePref);
  const resolvedMode = getResolvedLayoutMode();
  const vw = typeof window !== 'undefined' ? Number(window.innerWidth || DESKTOP_BREAKPOINT_PX) : DESKTOP_BREAKPOINT_PX;
  rootEl.setAttribute('data-layout-mode', resolvedMode);
  rootEl.setAttribute('data-mobile-view', state.mobileView);
  rootEl.setAttribute('data-mobile-tab', state.mobileTab);
  rootEl.setAttribute('data-sidebar-collapsed', state.sidebarCollapsed ? 'true' : 'false');
  rootEl.setAttribute('data-overview-collapsed', state.overviewCollapsed ? 'true' : 'false');

  const rawSb = Number(readStoredPref(STORAGE_KEYS.sidebarWidth, ''));
  const rawOv = Number(readStoredPref(STORAGE_KEYS.overviewWidth, ''));
  const hasStoredSb = Number.isFinite(rawSb) && rawSb >= PANE_WIDTH_BOUNDS.sidebar.min;
  const hasStoredOv = Number.isFinite(rawOv) && rawOv >= PANE_WIDTH_BOUNDS.overview.min;
  const defSb = getDefaultPaneWidth('sidebar', vw);
  const defOv = getDefaultPaneWidth('overview', vw);
  const initOv = hasStoredOv ? Math.min(PANE_WIDTH_BOUNDS.overview.max, Math.round(rawOv)) : defOv;
  const sbRes = clampPaneWidth('sidebar', hasStoredSb ? rawSb : defSb, {
    viewportWidth: vw,
    otherPaneWidth: state.overviewCollapsed ? 0 : initOv,
    otherCollapsed: state.overviewCollapsed,
  });
  const ovRes = clampPaneWidth('overview', hasStoredOv ? rawOv : defOv, {
    viewportWidth: vw,
    otherPaneWidth: state.sidebarCollapsed ? 0 : sbRes.value,
    otherCollapsed: state.sidebarCollapsed,
  });

  if (rootEl.style?.setProperty) {
    if (resolvedMode === 'desktop' && (hasStoredSb || sbRes.value < defSb)) {
      rootEl.style.setProperty('--rc-sidebar-w', `${sbRes.value}px`);
    } else {
      rootEl.style.removeProperty('--rc-sidebar-w');
    }
    if (resolvedMode === 'desktop' && (hasStoredOv || ovRes.value < defOv)) {
      rootEl.style.setProperty('--rc-overview-w', `${ovRes.value}px`);
    } else {
      rootEl.style.removeProperty('--rc-overview-w');
    }
  }
  syncPaneAriaValues(vw, sbRes, ovRes);

  if (workspaceRefs && rootEl.contains(workspaceRefs.topbar)) {
    workspaceRefs.layoutModeBtn.textContent = layoutButtonLabel(state.layoutPref);
    workspaceRefs.sidebarToggleBtn.setAttribute('aria-pressed', state.sidebarCollapsed ? 'false' : 'true');
    workspaceRefs.overviewToggleBtn.setAttribute('aria-pressed', state.overviewCollapsed ? 'false' : 'true');
    workspaceRefs.navChatsBtn.setAttribute('aria-pressed', state.mobileTab === 'chats' ? 'true' : 'false');
    workspaceRefs.navApprovalsBtn.setAttribute('aria-pressed', state.mobileTab === 'approvals' ? 'true' : 'false');
    workspaceRefs.navOverviewBtn.setAttribute('aria-pressed', state.mobileTab === 'overview' ? 'true' : 'false');
    workspaceRefs.draftInput.placeholder =
      resolvedMode === 'mobile'
        ? '输入指令…'
        : vw <= 1260
          ? '输入指令继续当前会话（⌘/Ctrl+Enter 发送，支持粘贴截图）…'
          : '输入指令继续当前会话（Ctrl/Cmd + Enter 发送，可 Ctrl/Cmd+V 粘贴截图）…';
    workspaceRefs.searchInput.placeholder =
      resolvedMode === 'mobile' ? '搜索会话 / ID…' : '搜索会话 (⌘K) / ID…';
    renderMoreMenu();
  }
}

function ensureGlobalUiListeners() {
  if (globalListenersBound || typeof window === 'undefined') return;
  globalListenersBound = true;
  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) return;
    resizeRaf = window.requestAnimationFrame(() => {
      resizeRaf = 0;
      applyLayoutAttrs();
    });
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && (state.modelPopoverOpen || state.contextPopoverOpen || state.moreMenuOpen || state.newChatOpen || state.viewer.open)) {
      state.modelPopoverOpen = false;
      state.contextPopoverOpen = false;
      state.moreMenuOpen = false;
      if (!state.newChatBusy) state.newChatOpen = false;
      if (state.viewer.open) state.viewer.open = false;
      renderMoreMenu();
      renderNewChatOverlay();
      viewerCtrl.render();
      syncComposerControls();
      return;
    }
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
    if (!state.identity || !workspaceRefs || !rootEl?.contains(workspaceRefs.topbar)) return;
    const key = String(ev.key || '').toLowerCase();
    if (key === 'k') {
      ev.preventDefault();
      if (getResolvedLayoutMode() === 'desktop' && state.sidebarCollapsed) {
        state.sidebarCollapsed = false;
        writeStoredPref(STORAGE_KEYS.sidebarCollapsed, 'false');
        applyLayoutAttrs();
      } else if (getResolvedLayoutMode() === 'mobile') {
        state.mobileTab = 'chats';
        state.mobileView = 'list';
        applyLayoutAttrs();
        renderSidebarList();
      }
      workspaceRefs.searchInput?.focus();
    } else if (key === 'b' && !ev.shiftKey) {
      if (getResolvedLayoutMode() !== 'desktop') return;
      ev.preventDefault();
      state.sidebarCollapsed = !state.sidebarCollapsed;
      writeStoredPref(STORAGE_KEYS.sidebarCollapsed, state.sidebarCollapsed ? 'true' : 'false');
      applyLayoutAttrs();
    } else if (ev.key === '.' && !ev.shiftKey) {
      if (getResolvedLayoutMode() !== 'desktop') return;
      ev.preventDefault();
      state.overviewCollapsed = !state.overviewCollapsed;
      writeStoredPref(STORAGE_KEYS.overviewCollapsed, state.overviewCollapsed ? 'true' : 'false');
      applyLayoutAttrs();
    }
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('click', (ev) => {
      const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      if (state.moreMenuOpen && workspaceRefs?.moreMenu) {
        const insideMenu =
          path.includes(workspaceRefs.moreMenu) || workspaceRefs.moreMenu.contains(ev.target);
        if (!insideMenu) {
          state.moreMenuOpen = false;
          renderMoreMenu();
        }
      }
      if ((!state.modelPopoverOpen && !state.contextPopoverOpen) || !workspaceRefs?.composerCard) return;
      if (path.includes(workspaceRefs.composerCard) || workspaceRefs.composerCard.contains(ev.target)) {
        return;
      }
      state.modelPopoverOpen = false;
      state.contextPopoverOpen = false;
      syncComposerControls();
    });
  }
}

function updateGlobalPreset(nextPreset) {
  if (nextPreset === undefined) return;
  if (nextPreset !== state.globalPreset) {
    state.globalPreset = nextPreset;
    state.turboWriteConfirmed = false;
  }
}

const pairView = createPairViewController({
  state,
  rootEl,
  render,
  onPaired: () => startWorkspaceSession(),
});

async function handleUnpairDevice() {
  state.moreMenuOpen = false;
  if (wsClient) {
    wsClient.dispose();
    wsClient = null;
  }
  await clearDeviceIdentity().catch(() => {});
  state.identity = null;
  state.conversations = [];
  state.snapshots.clear();
  state.streams.clear();
  state.selectedId = null;
  state.mobileView = 'list';
  state.mobileTab = 'chats';
  state.turboAcknowledged = false;
  state.turboWriteConfirmed = false;
  state.draftMedia = [];
  state.draftIdempotencyKey = createIdempotencyKey();
  state.pendingApproveKeys.clear();
  state.pendingResumeKeys.clear();
  state.approvingByCid.clear();
  state.approvingHash = '';
  state.studioOverview = null;
  state.studioDrawerOpen = false;
  state.selectedProjectId = '';
  state.resumeState = null;
  state.modelCatalog = null;
  state.slashCommands = null;
  state.viewer = createInitialViewerState();
  state.modelPopoverOpen = false;
  state.contextPopoverOpen = false;
  state.newChatOpen = false;
  state.newChatBusy = false;
  state.newChatTurboConfirmed = false;
  alertManager.reset();
  state.showHiddenModels = false;
  state.modelSelectBusy = false;
  state.streamStartedAt = 0;
  setActionNotice('');
  clearStudioOverviewRetry();
  resetCancelConfirm();
  workspaceRefs = null;
  pairView.loadHealthForPairing();
}

const moreMenuCtrl = createMoreMenuController({
  state,
  getMenuEl: () => workspaceRefs?.moreMenu,
  getWsClient: () => wsClient,
  renderMenu: renderMobileMoreMenu,
  formatPresetBadge,
  layoutButtonLabel,
  themeButtonLabel,
  writeThemePref: (v) => writeStoredPref(STORAGE_KEYS.themePref, v),
  getLayoutMode: getResolvedLayoutMode,
  onToggleDesktopOverview: () => {
    state.overviewCollapsed = !state.overviewCollapsed;
    writeStoredPref(STORAGE_KEYS.overviewCollapsed, state.overviewCollapsed ? 'true' : 'false');
    applyLayoutAttrs();
  },
  alertManager,
  setActionNotice,
  writeLayoutPref: (v) => writeStoredPref(STORAGE_KEYS.layoutPref, v),
  applyLayoutAttrs,
  renderSidebarList,
  renderStudioPanels,
  refreshAllData,
  handleUnpairDevice,
});
const renderMoreMenu = () => moreMenuCtrl.render();

function toggleMoreMenu(ev) {
  ev?.stopPropagation?.();
  state.moreMenuOpen = !state.moreMenuOpen;
  if (state.moreMenuOpen && (state.modelPopoverOpen || state.contextPopoverOpen)) {
    state.modelPopoverOpen = false;
    state.contextPopoverOpen = false;
    syncComposerControls();
  }
  renderMoreMenu();
}

function ensureWorkspaceShell() {
  if (workspaceRefs && rootEl.contains(workspaceRefs.topbar)) {
    return workspaceRefs;
  }
  const { topbar, ...restRefs } = createWorkspaceShellDom({
    rootEl,
    state,
    layoutButtonLabel,
    handlers: {
      onToggleSidebar: () => {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        writeStoredPref(STORAGE_KEYS.sidebarCollapsed, state.sidebarCollapsed ? 'true' : 'false');
        applyLayoutAttrs();
      },
      onCycleLayoutMode: () => {
        const order = ['auto', 'desktop', 'mobile'];
        const next = order[(order.indexOf(state.layoutPref) + 1) % order.length];
        state.layoutPref = next;
        writeStoredPref(STORAGE_KEYS.layoutPref, next);
        applyLayoutAttrs();
        renderSidebarList();
      },
      onToggleOverview: () => {
        state.overviewCollapsed = !state.overviewCollapsed;
        writeStoredPref(STORAGE_KEYS.overviewCollapsed, state.overviewCollapsed ? 'true' : 'false');
        applyLayoutAttrs();
      },
      onResizePane: (kind, widthPx, { commit = false } = {}) => {
        const cssVar = kind === 'sidebar' ? '--rc-sidebar-w' : '--rc-overview-w';
        const storeKey = kind === 'sidebar' ? STORAGE_KEYS.sidebarWidth : STORAGE_KEYS.overviewWidth;
        const vw = typeof window !== 'undefined' ? Number(window.innerWidth || DESKTOP_BREAKPOINT_PX) : DESKTOP_BREAKPOINT_PX;
        if (widthPx === null) {
          rootEl?.style?.removeProperty?.(cssVar);
          if (commit) {
            writeStoredPref(storeKey, '');
            applyLayoutAttrs();
          }
          return;
        }
        const otherPane = kind === 'sidebar' ? workspaceRefs?.overviewPane : workspaceRefs?.sidebar;
        const otherCollapsed = kind === 'sidebar' ? state.overviewCollapsed : state.sidebarCollapsed;
        const clamped = clampPaneWidth(kind, widthPx, {
          viewportWidth: vw,
          otherPaneWidth: otherCollapsed ? 0 : Math.round(otherPane?.getBoundingClientRect?.().width || 0),
          otherCollapsed,
        });
        rootEl?.style?.setProperty?.(cssVar, `${clamped.value}px`);
        const resizerEl = kind === 'sidebar' ? workspaceRefs?.sidebarResizer : workspaceRefs?.overviewResizer;
        resizerEl?.setAttribute('aria-valuemax', String(clamped.max));
        resizerEl?.setAttribute('aria-valuenow', String(clamped.value));
        if (commit) writeStoredPref(storeKey, String(clamped.value));
      },
      onRefreshAll: () => refreshAllData(),
      onUnpair: () => handleUnpairDevice(),
      onToggleMoreMenu: toggleMoreMenu,
      onSearchInput: (q) => {
        state.searchQuery = q;
        renderSidebarList();
      },
      onOpenNewChat: () => {
        state.newChatOpen = true;
        state.newChatProjectId = state.selectedProjectId || '';
        state.newChatError = '';
        state.newChatTurboConfirmed = false;
        mobileHistory.enterModal();
        renderNewChatOverlay();
      },
      onBackToList: () => mobileHistory.leaveDetail(),
      onOpenArtifacts: () => viewerCtrl.openArtifacts(state.selectedId || ''),
      onOpenGitDiff: () => viewerCtrl.openGit({ cascadeId: state.selectedId || '' }),
      onRefreshSelectedSnapshot: () => {
        if (state.selectedId) {
          fetchAndRenderSnapshot(state.selectedId);
          refreshStudioOverview(state.selectedId);
        }
      },
      onDismissActionBanner: () => {
        state.actionError = '';
        setActionNotice('');
        syncComposerControls();
      },
      onToggleTurboWrite: (checked) => {
        state.turboWriteConfirmed = checked;
        syncComposerControls();
      },
      onDraftInput: (val, target) => {
        state.draftText = val;
        if (state.selectedId) saveConversationDraft(state.selectedId, state.draftText);
        state.draftIdempotencyKey = createIdempotencyKey();
        state.actionError = '';
        autoResizeTextarea(target);
        syncComposerControls();
      },
      onSendDraft: () => handleSendDraft(),
      onAttachImageFiles: (files) => attachImageFiles(files),
      onCancelConvo: () => handleCancelConvo(),
      onSwitchMobileTab: (tab) => {
        state.mobileTab = tab;
        state.mobileView = 'list';
        applyLayoutAttrs();
        renderSidebarList();
        if (tab === 'overview') {
          renderStudioPanels();
        }
      },
    },
  });
  workspaceRefs = {
    topbar,
    ...restRefs,
  };
  applyLayoutAttrs();
  return workspaceRefs;
}

function canSteer() {
  const role = state.identity?.role || 'observe';
  return role === 'steer' || role === 'admin';
}

const viewerCtrl = createViewerController({
  state,
  getHostEl: () => workspaceRefs?.viewerDrawer || null,
  getWsClient: () => wsClient,
  canSteer,
  onEnterModal: () => mobileHistory.enterModal(),
  onLeaveModal: () => {
    if (typeof window !== 'undefined' && window.history?.state?.rcView === 'modal') {
      try {
        window.history.back();
      } catch {}
    }
  },
  onInsertQuickReply: (text) => {
    if (!state.selectedId || !text) return;
    state.draftText = text;
    saveConversationDraft(state.selectedId, text);
    state.draftIdempotencyKey = createIdempotencyKey();
    syncComposerControls();
    workspaceRefs?.draftInput?.focus();
  },
});

const convoActions = createConvoActionHandlers({
  state,
  getWsClient: () => wsClient,
  canSteer,
  createIdempotencyKey,
  setActionNotice,
  syncComposerControls: () => syncComposerControls(),
  renderDetailTimeline: () => renderDetailTimeline(),
  fetchAndRenderSnapshot: (cid) => fetchAndRenderSnapshot(cid),
  refreshAllData: () => refreshAllData(),
});
const {
  resetCancelConfirm,
  attachImageFiles,
  handleSelectModelOption,
  handleSendDraft,
  handleApproveStep,
  handleCancelConvo,
  handleResumeConvo,
  handleCompactConvo,
} = convoActions;

const newChatCtrl = createNewChatController({
  state,
  getRefs: () => workspaceRefs,
  getWsClient: () => wsClient,
  canSteer,
  isTurboPreset: requiresTurboAck,
  createIdempotencyKey,
  uuidRe: UUID_RE,
  setActionNotice,
  selectConversation,
  refreshAllData,
  onRequestClose: () => mobileHistory.leaveModal(),
});
const renderNewChatOverlay = () => newChatCtrl.render();
const mobileHistory = createMobileHistoryController({
  state,
  getLayoutMode: getResolvedLayoutMode,
  onNavigateToList: () => {
    state.mobileView = 'list';
    state.moreMenuOpen = state.modelPopoverOpen = state.contextPopoverOpen = false;
    renderMoreMenu();
    applyLayoutAttrs();
    syncComposerControls();
  },
  onNavigateToDetail: (cid) => {
    if (cid && UUID_RE.test(cid)) selectConversation(cid, { skipHistoryPush: true });
  },
  onCloseOverlays: () => {
    state.moreMenuOpen = state.modelPopoverOpen = state.contextPopoverOpen = false;
    renderMoreMenu();
    syncComposerControls();
  },
  onCloseModal: () => {
    if (state.viewer.open) {
      state.viewer.open = false;
      viewerCtrl.render();
      return;
    }
    if (state.newChatBusy) return;
    state.newChatOpen = false;
    state.newChatError = '';
    renderNewChatOverlay();
  },
});

function refreshModels(cascadeId = state.selectedId) {
  if (!wsClient) return;
  const seq = ++modelReqSeq;
  const reqCid = cascadeId || '';
  wsClient
    .fetchModels(reqCid)
    .then((res) => {
      if (!res?.ok || !wsClient || seq !== modelReqSeq) return;
      if (reqCid && state.selectedId !== reqCid) return;
      state.modelCatalog = res;
      if (Array.isArray(res.slashCommands) && res.slashCommands.length > 0) {
        state.slashCommands = res.slashCommands;
      }
      if (state.identity) syncComposerControls();
    })
    .catch(() => {});
}

function getEffectiveResumeState(cid) {
  if (!cid) return null;
  const snap = state.snapshots.get(cid);
  const direct = state.resumeState && state.resumeState.cascadeId === cid ? state.resumeState : null;
  const rs = direct || snap?.resumeState || null;
  if (!rs || rs.interrupted !== true || rs.active === true) return null;
  const convo = state.conversations.find((c) => c.id === cid);
  const statusStr = String(snap?.status ?? convo?.status ?? '');
  if (/RUNNING|BUSY|CANCEL|WAIT/i.test(statusStr)) return null;
  if ((snap?.waitingSteps?.length || 0) > 0 || (convo?.waitingSteps?.length || 0) > 0) return null;
  return rs;
}

function renderSidebarProjectsBar() {
  renderSidebarProjectsBarView(ensureWorkspaceShell(), state, {
    onSelectProject: (nextPid) => {
      state.selectedProjectId = nextPid || '';
      renderStudioPanels();
      renderSidebarList();
    },
  });
}

function renderStudioPanels() {
  const refs = ensureWorkspaceShell();
  const selectedConvo =
    state.selectedId ? state.conversations.find((c) => c.id === state.selectedId) || null : null;
  const snapshot = state.selectedId ? state.snapshots.get(state.selectedId) || null : null;
  renderOverviewPanel(refs.overviewPane, {
    overview: state.studioOverview,
    selectedConvo,
    snapshot,
    wsStatus: state.wsStatus,
    hostAttached: state.hostAttached,
    globalPreset: state.globalPreset,
    deviceName: state.identity?.deviceName || '',
    role: state.identity?.role || 'observe',
    selectedProjectId: state.selectedProjectId,
    usageRange: state.usageRange,
    onChangeUsageRange: (nextRange) => {
      state.usageRange = nextRange;
      renderStudioPanels();
    },
    onSelectProject: (nextPid) => {
      state.selectedProjectId = nextPid || '';
      renderStudioPanels();
      renderSidebarList();
    },
    onOpenProjectGit: ({ projectId }) => {
      viewerCtrl.openGit({ projectId, cascadeId: '' });
    },
    onCopyId: (cid, btn) => copyTextWithFeedback(btn, cid, { idleText: '复制 ID', doneText: '已复制' }),
  });
  renderSidebarProjectsBar();
}

function syncComposerControls() {
  const refs = ensureWorkspaceShell();
  const writable = canSteer();
  const online = Boolean(state.hostAttached && state.wsStatus === 'connected');
  const hasSelection = Boolean(state.selectedId);
  const needTurboConfirm = requiresTurboAck(state.globalPreset);

  refs.composerCard.setAttribute('data-writable', writable ? 'true' : 'false');
  refs.composerCard.setAttribute('data-has-selection', hasSelection ? 'true' : 'false');
  refs.roleBanner.setAttribute('data-writable', writable ? 'true' : 'false');
  if (writable) {
    refs.roleBannerText.textContent = '受控远程操控模式：支持远程发送消息、停止当前任务与仅本次 (Allow Once) / 拒绝审批。';
    refs.roleBannerPill.setAttribute('data-tone', 'ok');
    refs.roleBannerPill.textContent = String(state.identity?.role || 'steer').toUpperCase();
    refs.composerRow.classList.remove('rc-hidden');
  } else {
    refs.roleBannerText.textContent = '只读观察模式 (observe)：如需远程发送、停止或审批，请在 Mac 桌面端「AGY Studio 设置 → 远程控制」将此设备一键升为协作 (steer) 或重新配对。';
    refs.roleBannerPill.setAttribute('data-tone', 'info');
    refs.roleBannerPill.textContent = 'READ-ONLY';
    refs.composerRow.classList.add('rc-hidden');
  }

  syncTurboConfirmBar(refs.turboWriteLabel, refs.turboWriteCheckbox, refs.turboWriteText, {
    writable,
    needTurboConfirm,
    confirmed: state.turboWriteConfirmed,
    busy: state.sendBusy || state.resumeBusy,
  });
  if (refs.newChatBtn) {
    refs.newChatBtn.classList.toggle('rc-hidden', !writable);
    refs.newChatBtn.disabled = !online || state.newChatBusy;
  }
  renderNewChatOverlay();

  const activeConvo = hasSelection ? state.conversations.find((c) => c.id === state.selectedId) || null : null;
  const activeSnap = hasSelection ? state.snapshots.get(state.selectedId) || null : null;
  const authStatus = activeSnap?.status ?? activeConvo?.status;
  let streamEntry = hasSelection ? state.streams.get(state.selectedId) || null : null;
  if (
    streamEntry &&
    typeof streamEntry === 'object' &&
    authStatus &&
    !isRunningStatus(authStatus) &&
    streamEntry.updatedAt &&
    Date.now() - streamEntry.updatedAt > 15_000
  ) {
    state.streams.delete(state.selectedId);
    streamEntry = null;
  }
  const streamText = typeof streamEntry === 'string' ? streamEntry : streamEntry?.text ?? '';
  const isStreaming = Boolean(
    hasSelection &&
      (isRunningStatus(authStatus) ||
        (typeof streamEntry === 'object' && streamEntry && isRunningStatus(streamEntry.status)))
  );

  renderResumeBanner(refs.resumeBanner, {
    resumeState: isStreaming ? null : getEffectiveResumeState(state.selectedId),
    canWrite: writable,
    online,
    needTurboConfirm,
    turboConfirmed: state.turboWriteConfirmed,
    busy: state.resumeBusy,
    onResume: handleResumeConvo,
  });

  const activeOpusGate =
    !isStreaming && state.selectedId && state.studioOverview?.activeCascade?.cascadeId === state.selectedId
      ? state.studioOverview.activeCascade.opusGate
      : null;
  renderOpusGateBanner(refs.opusBanner, {
    opusGate: activeOpusGate,
    canWrite: writable,
    online,
    busy: state.opusDismissBusy,
    reviewerModel: state.studioOverview?.studioPrefs?.opusGateModel || 'carbon',
    onReview: opusGateActions.triggerReview,
    onDismiss: opusGateActions.dismiss,
  });

  renderMediaPreviewStrip(refs.mediaStrip, state.draftMedia, {
    disabled: state.sendBusy,
    onRemove: (imgId) => {
      state.draftMedia = state.draftMedia.filter((m) => m.id !== imgId);
      state.draftIdempotencyKey = createIdempotencyKey();
      syncComposerControls();
    },
  });

  if (refs.draftInput.value !== state.draftText) {
    refs.draftInput.value = state.draftText;
  }
  autoResizeTextarea(refs.draftInput);
  renderSlashCommandBar(refs.slashBar, {
    draftText: state.draftText,
    slashCommands: state.slashCommands,
    writable,
    online: Boolean(online && hasSelection && !state.sendBusy),
    onPick: (nextCmd) => {
      state.draftText = nextCmd;
      if (state.selectedId) saveConversationDraft(state.selectedId, nextCmd);
      state.draftIdempotencyKey = createIdempotencyKey();
      refs.draftInput.value = nextCmd;
      autoResizeTextarea(refs.draftInput);
      syncComposerControls();
      refs.draftInput.focus();
    },
  });
  refs.draftInput.disabled = !writable || !online || !hasSelection || state.sendBusy;
  refs.sendBtn.textContent = state.sendBusy ? '发送中…' : '发送';
  const hasDraftPayload = Boolean(state.draftText.trim()) || state.draftMedia.length > 0;
  refs.sendBtn.disabled =
    !writable ||
    !online ||
    !hasSelection ||
    state.sendBusy ||
    !hasDraftPayload ||
    (needTurboConfirm && !state.turboWriteConfirmed);
  if (state.cancelBusy) {
    refs.cancelBtn.textContent = '停止中…';
  } else if (state.cancelConfirmArmedCid && state.cancelConfirmArmedCid === state.selectedId) {
    refs.cancelBtn.textContent = '确认停止？';
  } else {
    refs.cancelBtn.textContent = '停止';
  }
  refs.cancelBtn.disabled = !writable || !online || !hasSelection || state.cancelBusy;

  const showCancelControl = Boolean(
    isStreaming || state.cancelBusy || (state.cancelConfirmArmedCid && state.cancelConfirmArmedCid === state.selectedId)
  );
  refs.composerCard.setAttribute('data-streaming', showCancelControl ? 'true' : 'false');
  const activeMetrics =
    hasSelection && state.studioOverview?.activeCascade?.cascadeId === state.selectedId
      ? state.studioOverview.activeCascade.metrics || null
      : null;

  renderComposerFooterBar(refs, {
    catalog: state.modelCatalog,
    studioPrefs: state.studioOverview?.studioPrefs || state.modelCatalog?.studioPrefs || null,
    modelPopoverOpen: state.modelPopoverOpen,
    contextPopoverOpen: state.contextPopoverOpen,
    showHiddenModels: state.showHiddenModels,
    modelBusy: state.modelSelectBusy,
    metrics: activeMetrics,
    quota: state.studioOverview?.quota || null,
    canWrite: writable,
    online,
    hasSelection,
    sendBusy: state.sendBusy,
    compactBusy: state.compactBusy,
    compactSupported: state.capabilities?.compact !== false,
    mediaCount: state.draftMedia.length,
    onToggleModelPopover: () => {
      state.modelPopoverOpen = !state.modelPopoverOpen;
      if (state.modelPopoverOpen) state.contextPopoverOpen = false;
      if (!state.modelPopoverOpen) state.showHiddenModels = false;
      if (state.modelPopoverOpen && (!state.modelCatalog || !state.modelCatalog.families?.length)) {
        refreshModels(state.selectedId);
      }
      syncComposerControls();
    },
    onToggleContextPopover: () => {
      state.contextPopoverOpen = !state.contextPopoverOpen;
      if (state.contextPopoverOpen) {
        state.modelPopoverOpen = false;
        state.showHiddenModels = false;
      }
      syncComposerControls();
    },
    onToggleShowHiddenModels: () => {
      state.showHiddenModels = !state.showHiddenModels;
      syncComposerControls();
    },
    onSelectModelOption: handleSelectModelOption,
    onCloseModelPopover: () => {
      state.modelPopoverOpen = false;
      state.showHiddenModels = false;
      syncComposerControls();
    },
    onCloseContextPopover: () => {
      state.contextPopoverOpen = false;
      syncComposerControls();
    },
    onCompact: handleCompactConvo,
    onPickImages: () => refs.mediaFileInput?.click(),
    onScrollBottom: (act) => {
      if (act === 'back') {
        state.mobileView = 'list';
        applyLayoutAttrs();
      } else {
        refs.timeline.scrollTop = refs.timeline.scrollHeight;
      }
    },
  });

  if (state.actionError) {
    refs.actionBanner.classList.remove('rc-hidden');
    refs.actionBanner.setAttribute('data-tone', 'danger');
    refs.actionBanner.textContent = state.actionError;
  } else if (state.actionNotice) {
    refs.actionBanner.classList.remove('rc-hidden');
    refs.actionBanner.setAttribute('data-tone', 'ok');
    refs.actionBanner.textContent = state.actionNotice;
  } else {
    refs.actionBanner.classList.add('rc-hidden');
    refs.actionBanner.textContent = '';
  }
}

const opusGateActions = createOpusGateActions({
  state,
  getWsClient: () => wsClient,
  canSteer,
  requiresTurboAck,
  createIdempotencyKey,
  buildPrompt: buildOpusReviewPrompt,
  setActionNotice,
  syncComposerControls,
  refreshStudioOverview,
  refreshAllData,
});

function renderTopStatus() {
  const refs = ensureWorkspaceShell();
  applyLayoutAttrs();

  const wsInfo = normalizeWsStatus(state.wsStatus, state.wsDetail);
  refs.brandDot.setAttribute('data-state', state.wsStatus);
  refs.wsPill.setAttribute('data-tone', wsInfo.tone);
  refs.wsPill.textContent =
    state.wsStatus === 'connected' && state.wsRttMs > 0 ? `${wsInfo.label} · ${state.wsRttMs}ms` : wsInfo.label;

  refs.hostPill.setAttribute('data-tone', state.hostAttached ? 'ok' : 'warn');
  refs.hostPill.setAttribute('data-connected', state.hostAttached && state.wsStatus === 'connected' ? 'true' : 'false');
  refs.hostPill.textContent = state.hostAttached ? 'CDP' : '只读离线';
  refs.hostPill.title = state.hostAttached
    ? `CDP 实时 (${state.source || 'cdp'})`
    : '宿主离线 · 磁盘只读';

  const presetInfo = formatPresetBadge(state.globalPreset);
  const isSafePreset = isSafeNonTurboPreset(state.globalPreset);
  refs.presetPill.setAttribute('data-tone', presetInfo.tone);
  refs.presetPill.setAttribute('data-safe', isSafePreset ? 'true' : 'false');
  refs.presetPill.textContent = Number(state.globalPreset) === 3 ? 'TURBO' : presetInfo.label;
  refs.presetPill.title = `本机权限策略：${presetInfo.label}`;

  const devName = state.identity?.deviceName || '已配对设备';
  const role = state.identity?.role || 'observe';
  refs.devicePill.textContent = `${devName} (${role})`;

  renderConnectionNoticeBar(refs.noticeBar, {
    state,
    onRepair: () => handleUnpairDevice(),
    onReconnect: () => wsClient?.reconnectNow?.(),
    onRelogin: () => {
      try {
        window.location.reload();
      } catch {}
    },
  });
  syncComposerControls();
}

function renderFilterChips() {
  renderFilterChipsView({
    state,
    refs: ensureWorkspaceShell(),
    onSelectFilter: (id) => {
      state.filter = id;
      renderFilterChips();
      renderSidebarList();
    },
    onSelectGroupBy: (id) => {
      state.sidebarGroupBy = id;
      writeStoredPref(STORAGE_KEYS.sidebarGroupBy, id);
      renderFilterChips();
      renderSidebarList();
    },
    onToggleSubagents: () => {
      state.includeSubagents = !state.includeSubagents;
      renderFilterChips();
      renderSidebarList();
      if (wsClient) {
        wsClient.refreshList(state.includeSubagents).then(applyConvoListResult).catch(() => {});
      }
    },
    onSelectProject: (nextPid) => {
      state.selectedProjectId = nextPid || '';
      renderStudioPanels();
      renderFilterChips();
      renderSidebarList();
    },
  });
}

function renderSidebarList() {
  renderSidebarListView({
    state,
    refs: ensureWorkspaceShell(),
    resolvedLayoutMode: getResolvedLayoutMode(),
    onSelectConversation: selectConversation,
    onToggleCollapseProject: (projKey) => {
      if (!projKey) return;
      if (state.collapsedProjects.has(projKey)) state.collapsedProjects.delete(projKey);
      else state.collapsedProjects.add(projKey);
      writeStoredJsonSet(STORAGE_KEYS.collapsedProjects, state.collapsedProjects);
      renderSidebarList();
    },
    onExpandProjectGroup: (projKey) => {
      if (!projKey) return;
      state.expandedProjectGroups.add(projKey);
      renderSidebarList();
    },
    onSelectProject: (nextPid) => {
      state.selectedProjectId = nextPid || '';
      renderStudioPanels();
      renderFilterChips();
      renderSidebarList();
    },
    onOpenProjectGit: ({ projectId }) => viewerCtrl.openGit({ projectId }),
    onOpenNewChatInProject: (projectId) => {
      state.newChatOpen = true;
      state.newChatProjectId = projectId || '';
      state.newChatError = '';
      state.newChatTurboConfirmed = false;
      mobileHistory.enterModal();
      renderNewChatOverlay();
    },
  });
}

function renderDetailTimeline() {
  renderTimelineView({
    state,
    refs: ensureWorkspaceShell(),
    onSelectConversation: selectConversation,
    onApprove: handleApproveStep,
    onOpenArtifact: (cid, fileName) => viewerCtrl.openArtifacts(cid, fileName),
    onOpenGitDiff: ({ cascadeId, projectId }) => viewerCtrl.openGit({ cascadeId, projectId }),
  });
}

function renderWorkspace() {
  renderTopStatus();
  renderStudioPanels();
  renderFilterChips();
  renderSidebarList();
  renderDetailTimeline();
}

function render() {
  if (!state.identity) {
    pairView.renderPairingScreen();
  } else {
    renderWorkspace();
  }
}

function applyConvoListResult(result) {
  if (!result || typeof result !== 'object') return;
  if (result.source) state.source = result.source;
  if (result.globalPreset !== undefined) updateGlobalPreset(result.globalPreset);
  if (Array.isArray(result.conversations)) {
    state.conversations = result.conversations;
    alertManager.observeConversations(state.conversations);
    if (!state.selectedId && result.conversations.length > 0 && getResolvedLayoutMode() === 'desktop') {
      const firstTop = result.conversations.find((c) => !c.parentConversationId) || result.conversations[0];
      if (firstTop && UUID_RE.test(firstTop.id)) {
        selectConversation(firstTop.id);
        return;
      }
    }
  }
  renderWorkspace();
}

function refreshStudioOverview(cascadeId = state.selectedId) {
  if (!wsClient) return;
  lastOverviewRefreshAt = Date.now();
  const reqSeq = ++studioOverviewSeq;
  const reqCid = cascadeId || '';
  wsClient
    .fetchStudioOverview(reqCid)
    .then((ov) => {
      if (!ov || !wsClient || reqSeq !== studioOverviewSeq) return;
      if (reqCid && state.selectedId !== reqCid) return;
      clearStudioOverviewRetry();
      state.studioOverview = ov;
      if (state.identity) {
        renderStudioPanels();
        renderFilterChips();
        renderSidebarList();
        renderDetailTimeline();
        syncComposerControls();
      }
    })
    .catch(() => {
      if (!wsClient || !state.identity || state.studioOverview || state.wsStatus !== 'connected') return;
      if (!studioOverviewRetryTimer) {
        studioOverviewRetryTimer = setTimeout(() => {
          studioOverviewRetryTimer = null;
          if (wsClient && state.identity && state.wsStatus === 'connected') {
            refreshStudioOverview(state.selectedId);
          }
        }, 2000);
      }
    });
}

function applySnapshot(cascadeId, snap) {
  if (!cascadeId || !snap) return;
  state.snapshots.set(cascadeId, snap);
  if (state.selectedId === cascadeId) {
    state.resumeState = snap.resumeState ?? null;
  }
  if (isRunningStatus(snap.status) && typeof snap.streamingText === 'string' && snap.streamingText) {
    const steps = Array.isArray(snap.steps) ? snap.steps : [];
    const lastIdx = steps.length > 0 ? steps[steps.length - 1].idx : 0;
    state.streams.set(cascadeId, {
      stepIdx: lastIdx,
      text: snap.streamingText,
      thinkingText: '',
      status: snap.status || '',
      stepCount: steps.length,
      updatedAt: Date.now(),
    });
  } else {
    state.streams.delete(cascadeId);
  }
}

async function fetchAndRenderSnapshot(cascadeId) {
  if (!wsClient || !cascadeId) return;
  state.snapshotLoading = true;
  state.snapshotError = '';
  if (state.selectedId === cascadeId) renderDetailTimeline();
  try {
    const snap = await wsClient.fetchSnapshot(cascadeId);
    applySnapshot(cascadeId, snap);
  } catch (err) {
    if (state.selectedId === cascadeId) {
      state.snapshotError = String(err?.message || '获取会话快照失败');
    }
  } finally {
    if (state.selectedId === cascadeId) {
      state.snapshotLoading = false;
      renderDetailTimeline();
      renderStudioPanels();
      syncComposerControls();
    }
  }
}

function scheduleSelectedSnapshotRefresh({ forceOverview = false } = {}) {
  if (!state.selectedId) return;
  if (forceOverview) pendingForceOverview = true;
  if (snapshotRefreshTimer) return;
  snapshotRefreshTimer = setTimeout(() => {
    snapshotRefreshTimer = null;
    const forceOv = pendingForceOverview;
    pendingForceOverview = false;
    if (state.selectedId && wsClient) {
      const targetId = state.selectedId;
      if (forceOv || Date.now() - lastOverviewRefreshAt > 1200) refreshStudioOverview(targetId);
      wsClient
        .fetchSnapshot(targetId)
        .then((snap) => {
          applySnapshot(targetId, snap);
          if (state.selectedId === targetId) {
            renderDetailTimeline();
            syncComposerControls();
          }
        })
        .catch(() => {});
    }
  }, 450);
}

async function selectConversation(cascadeId, { skipHistoryPush = false } = {}) {
  if (!cascadeId || !UUID_RE.test(cascadeId)) return;
  if (state.selectedId !== cascadeId) {
    if (state.selectedId) saveConversationDraft(state.selectedId, state.draftText);
    state.draftText = loadConversationDraft(cascadeId);
    state.draftIdempotencyKey = createIdempotencyKey();
    state.draftMedia = [];
    state.turboWriteConfirmed = false;
    state.resumeState = null;
    state.modelPopoverOpen = false;
    state.contextPopoverOpen = false;
    state.streamStartedAt = 0;
    state.actionError = '';
    state.actionNotice = '';
    resetCancelConfirm();
  }
  state.selectedId = cascadeId;
  state.mobileView = 'detail';
  if (!skipHistoryPush) mobileHistory.enterDetail(cascadeId);
  state.snapshotError = '';
  state.snapshotLoading = !state.snapshots.has(cascadeId);
  renderWorkspace();

  if (!wsClient) return;
  refreshStudioOverview(cascadeId);
  refreshModels(cascadeId);
  wsClient
    .fetchResumeState(cascadeId)
    .then((rs) => {
      if (state.selectedId === cascadeId && rs) {
        state.resumeState = rs;
        syncComposerControls();
      }
    })
    .catch(() => {});
  try {
    const snap = await wsClient.watchConversation(cascadeId);
    if (snap && state.selectedId === cascadeId) {
      applySnapshot(cascadeId, snap);
      state.snapshotLoading = false;
      renderDetailTimeline();
      syncComposerControls();
    }
  } catch (err) {
    if (state.selectedId === cascadeId) {
      state.snapshotLoading = false;
      state.snapshotError = String(err?.message || '加载会话失败');
      renderDetailTimeline();
    }
  }
}

function refreshAllData() {
  if (!wsClient) return;
  wsClient.refreshList(state.includeSubagents).then(applyConvoListResult).catch(() => {});
  refreshStudioOverview(state.selectedId);
  refreshModels(state.selectedId);
  if (state.selectedId) {
    fetchAndRenderSnapshot(state.selectedId);
  }
}

function handleTapDelta(delta) {
  const { kind, data } = delta;
  if (!data || typeof data !== 'object') return;

  if (kind === 'host_status') {
    const wasAttached = state.hostAttached;
    if ('hostAttached' in data) state.hostAttached = Boolean(data.hostAttached);
    if ('globalPreset' in data) updateGlobalPreset(data.globalPreset);
    if ('capabilities' in data) state.capabilities = data.capabilities;
    if ('source' in data) state.source = data.source;
    renderTopStatus();
    renderStudioPanels();
    if (!wasAttached && state.hostAttached) {
      refreshAllData();
    }
    return;
  }

  if (kind === 'summaries') {
    if (data.globalPreset !== undefined) updateGlobalPreset(data.globalPreset);
    if (data.source) state.source = data.source;
    state.conversations = mergeSummariesDelta(state.conversations, data);
    alertManager.observeConversations(state.conversations);
    renderTopStatus();
    renderFilterChips();
    renderSidebarList();
    if (state.selectedId) {
      scheduleSelectedSnapshotRefresh();
    }
    return;
  }

  if (kind === 'stream') {
    const cid = data.cascadeId;
    if (!cid) return;
    const prev = state.streams.get(cid);
    const prevText = typeof prev === 'string' ? prev : prev?.text ?? prev?.streamingText ?? '';
    const prevStepIdx = typeof prev === 'object' && prev ? prev.stepIdx : null;
    const incomingStepIdx = Number.isInteger(data.stepIdx) ? data.stepIdx : prevStepIdx;
    let nextText = prevText;
    let gapDetected = false;

    if (typeof data.chunk === 'string' && Number.isInteger(data.offset)) {
      const sameStep = prevStepIdx !== null && prevStepIdx === incomingStepIdx;
      if (data.reset || !sameStep) {
        if (data.offset === 0) {
          nextText = data.chunk;
        } else {
          nextText = data.chunk;
          gapDetected = true;
        }
      } else if (data.offset === prevText.length) {
        nextText = prevText + data.chunk;
      } else if (data.offset >= 0 && data.offset < prevText.length) {
        nextText = prevText.slice(0, data.offset) + data.chunk;
      } else {
        gapDetected = true;
        nextText = prevText + data.chunk;
      }
    } else if (typeof data.streamingText === 'string') {
      nextText = data.streamingText;
    } else if (typeof data.text === 'string') {
      nextText = data.text;
    }

    const nextThinking = typeof data.thinkingText === 'string' ? data.thinkingText : '';
    const stUpper = String(data.status || '').toUpperCase();
    const isFinished =
      Boolean(data.completed || data.stepDone) ||
      stUpper === 'DONE' ||
      stUpper === 'IDLE' ||
      stUpper === 'ERROR' ||
      stUpper === 'CANCELED';

    if (isFinished) {
      state.streams.delete(cid);
    } else {
      state.streams.set(cid, {
        stepIdx: incomingStepIdx,
        text: nextText,
        thinkingText: nextThinking,
        status: data.status || '',
        stepCount: Number.isFinite(Number(data.stepCount)) ? Number(data.stepCount) : null,
        updatedAt: Date.now(),
      });
    }
    if (cid === state.selectedId) {
      const snap = state.snapshots.get(cid);
      const stepAdvanced = Number.isFinite(Number(data.stepCount)) && snap && data.stepCount > (snap.steps?.length || 0);
      if (isFinished) syncComposerControls();
      if (gapDetected || isFinished || stepAdvanced) {
        scheduleSelectedSnapshotRefresh({ forceOverview: isFinished });
      } else {
        renderDetailTimeline();
      }
    }
  }
}

function startWorkspaceSession() {
  ensureGlobalUiListeners();
  mobileHistory.bind();
  clearStudioOverviewRetry();
  if (wsClient) {
    wsClient.dispose();
    wsClient = null;
  }
  renderWorkspace();
  wsClient = createRemoteWsClient(state.identity, {
    onStatus: (status, detail) => {
      state.wsStatus = status;
      state.wsDetail = detail || '';
      if (status !== 'connected') state.wsRttMs = null;
      if (state.identity) {
        renderTopStatus();
        renderStudioPanels();
      }
      if (status === 'auth_expired') {
        const hasDraft = Boolean((state.draftText && state.draftText.trim()) || state.draftMedia.length > 0);
        triggerGuardedAuthReload({ hasUnsentDraft: hasDraft });
      }
    },
    onRtt: (rttMs) => {
      state.wsRttMs = rttMs;
      if (state.identity) renderTopStatus();
    },
    onHealth: (health) => {
      if (!health || typeof health !== 'object') return;
      const wasAttached = state.hostAttached;
      if ('hostAttached' in health) state.hostAttached = Boolean(health.hostAttached);
      if (health.globalPreset !== undefined) updateGlobalPreset(health.globalPreset);
      if (health.capabilities) state.capabilities = health.capabilities;
      state.source = state.hostAttached ? 'cdp' : 'disk';
      if (state.identity) {
        renderTopStatus();
        renderStudioPanels();
        if (!wasAttached && state.hostAttached) {
          refreshAllData();
        }
      }
    },
    onWelcome: (msg) => {
      state.streams.clear();
      let roleUpdated = false;
      if (msg.deviceRole && state.identity && state.identity.role !== msg.deviceRole) {
        state.identity.role = msg.deviceRole;
        roleUpdated = true;
        saveDeviceIdentity(state.identity).catch(() => {});
      }
      if (msg.health) {
        state.hostAttached = Boolean(msg.health.hostAttached);
        if (msg.health.globalPreset !== undefined) updateGlobalPreset(msg.health.globalPreset);
        state.capabilities = msg.health.capabilities ?? state.capabilities;
        if (Array.isArray(msg.health.slashCommands) && msg.health.slashCommands.length > 0) {
          state.slashCommands = msg.health.slashCommands;
        }
      }
      if (Array.isArray(msg.conversations)) {
        applyConvoListResult({
          conversations: msg.conversations,
          source: msg.health?.hostAttached ? 'cdp' : 'disk',
          globalPreset: msg.health?.globalPreset,
        });
      } else {
        wsClient.refreshList(state.includeSubagents).then(applyConvoListResult).catch(() => {});
      }
      refreshStudioOverview(state.selectedId);
      refreshModels(state.selectedId);
      renderTopStatus();
      if (roleUpdated) {
        renderDetailTimeline();
      }
    },
    onRoleChanged: (nextRole) => {
      if (!state.identity || !nextRole || state.identity.role === nextRole) return;
      state.identity.role = nextRole;
      saveDeviceIdentity(state.identity).catch(() => {});
      setActionNotice(`设备权限已更新为 ${nextRole.toUpperCase()}`);
      renderTopStatus();
      renderStudioPanels();
      renderDetailTimeline();
    },
    onEpochReset: () => refreshAllData(),
    onDelta: handleTapDelta,
    onSnapshot: (cid, snap) => {
      applySnapshot(cid, snap);
      if (state.selectedId === cid) {
        state.snapshotLoading = false;
        renderDetailTimeline();
        renderStudioPanels();
        syncComposerControls();
      }
    },
    onError: () => {},
  });
}

async function boot() {
  applyThemePref(state.themePref);
  bindViewportHeightSync();
  bindNativeAndroidBridge({
    state,
    canSteer,
    createIdempotencyKey,
    uuidRe: UUID_RE,
    selectConversation,
    syncComposerControls,
    setActionNotice,
    onCloseOverlays: mobileHistory.closeOverlays,
    onCloseModal: mobileHistory.closeModal,
    onNavigateToList: mobileHistory.navigateToList,
    onNativeResume: () => {
      wsClient?.handleNativeResume?.();
      if (state.selectedId && state.wsStatus === 'connected') scheduleSelectedSnapshotRefresh();
    },
    onNativeNetworkChange: (info) => wsClient?.handleNetworkChange?.(info),
    onNativeKeepAliveChanged: () => {
      if (state.identity) {
        renderMoreMenu();
        renderTopStatus();
      }
    },
  });
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    if (typeof navigator.serviceWorker.addEventListener === 'function') {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || swReloading) return;
        if (
          state.pairingCode ||
          state.pairingBusy ||
          state.sendBusy ||
          (state.draftText && state.draftText.trim()) ||
          (Array.isArray(state.draftMedia) && state.draftMedia.length > 0)
        ) {
          return;
        }
        swReloading = true;
        try {
          window.location.reload();
        } catch {}
      });
    }
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((reg) => reg?.update?.().catch(() => {}))
      .catch(() => {});
  }

  const rawHash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const hashParams = new URLSearchParams(rawHash);
  const pairParam = (hashParams.get('pair') || '').trim();
  if (pairParam) {
    state.pairingCode = pairParam;
    try {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    } catch {}
  }

  let stored = null;
  try {
    stored = await loadDeviceIdentity();
  } catch (err) {
    state.pairingError = String(err?.message || '初始化本地密钥存储失败');
  }

  if (stored && stored.deviceId && stored.privateKey && !pairParam) {
    state.identity = stored;
    startWorkspaceSession();
    return;
  }

  // If #pair= was provided while already paired, allow pairing new code cleanly
  if (stored && pairParam) {
    state.identity = null;
  }

  await pairView.loadHealthForPairing();
}

boot();
