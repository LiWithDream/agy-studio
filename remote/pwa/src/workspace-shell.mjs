/**
 * AGY Studio Remote PWA — Workspace Shell DOM Builder & Project Filter Strip
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import { clampPaneWidth, clearNode, createSvgIcon, el, getDefaultPaneWidth } from './ui-helpers.mjs';

export function createWorkspaceShellDom({ rootEl, state, layoutButtonLabel, handlers = {} }) {
  clearNode(rootEl);

  const brandDot = el('span', { className: 'rc-brand-dot' });
  const wsPill = el('span', { className: 'rc-pill' });
  const hostPill = el('span', { className: 'rc-pill rc-desktop-only rc-topbar-host' });
  const presetPill = el('span', { className: 'rc-pill rc-desktop-only rc-topbar-preset' });
  const devicePill = el('span', { className: 'rc-pill rc-desktop-only rc-topbar-device' });

  const sidebarToggleBtn = el(
    'button',
    {
      type: 'button',
      className: 'rc-topbar-icon-btn rc-desktop-only',
      'aria-label': '折叠或展开会话栏',
      title: '折叠或展开会话栏 (⌘B)',
      onClick: () => handlers.onToggleSidebar?.(),
    },
    createSvgIcon('sidebar', { size: 15 })
  );

  const layoutModeBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm rc-desktop-only rc-topbar-layout',
    title: '切换桌面 / 移动视图适配模式',
    text: layoutButtonLabel(state.layoutPref),
    onClick: () => handlers.onCycleLayoutMode?.(),
  });

  const overviewToggleBtn = el(
    'button',
    {
      type: 'button',
      className: 'rc-topbar-icon-btn rc-desktop-only',
      title: '折叠或展开右侧 Overview 面板 (⌘.)',
      onClick: () => handlers.onToggleOverview?.(),
    },
    createSvgIcon('overview', { size: 15 }),
    el('span', { text: '概览' })
  );

  const refreshBtn = el(
    'button',
    {
      type: 'button',
      className: 'rc-topbar-icon-btn rc-desktop-only',
      'aria-label': '刷新全部数据',
      title: '刷新全部数据',
      onClick: () => handlers.onRefreshAll?.(),
    },
    createSvgIcon('refresh', { size: 15 })
  );

  const desktopMoreBtn = el(
    'button',
    {
      type: 'button',
      className: 'rc-topbar-icon-btn rc-desktop-only',
      'aria-label': '更多设置与连接信息',
      title: '主题、视图、设备与重配对',
      onClick: (ev) => handlers.onToggleMoreMenu?.(ev),
    },
    createSvgIcon('more', { size: 15 })
  );

  const unpairBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-danger rc-desktop-only rc-topbar-unpair',
    text: '重配对',
    onClick: () => handlers.onUnpair?.(),
  });

  const mobileRefreshBtn = el('button', {
    type: 'button',
    className: 'rc-icon-btn rc-mobile-only',
    'aria-label': '刷新',
    title: '刷新',
    text: '↻',
    onClick: () => handlers.onRefreshAll?.(),
  });

  const mobileMoreBtn = el('button', {
    type: 'button',
    className: 'rc-icon-btn rc-mobile-only',
    'aria-label': '更多选项',
    title: '更多选项',
    text: '⋯',
    onClick: (ev) => handlers.onToggleMoreMenu?.(ev),
  });

  const moreMenu = el('div', { className: 'rc-more-menu rc-hidden', role: 'menu' });

  const topbar = el(
    'header',
    { className: 'rc-topbar' },
    el(
      'div',
      { className: 'rc-topbar-left' },
      sidebarToggleBtn,
      brandDot,
      el('span', { className: 'rc-topbar-title', text: 'AGY Studio' }),
      wsPill,
      hostPill,
      presetPill
    ),
    el(
      'div',
      { className: 'rc-topbar-right' },
      devicePill,
      layoutModeBtn,
      refreshBtn,
      overviewToggleBtn,
      desktopMoreBtn,
      unpairBtn,
      mobileRefreshBtn,
      mobileMoreBtn
    )
  );

  const noticeBar = el('div', { className: 'rc-notice-bar rc-hidden' });
  const studioStrip = el('div', { className: 'rc-studio-strip rc-hidden' });
  const projectsDrawer = el('div', { className: 'rc-projects-drawer rc-hidden' });

  const searchInput = el('input', {
    className: 'rc-search',
    type: 'search',
    placeholder: '搜索会话 (⌘K) / ID…',
    value: state.searchQuery,
    onInput: (ev) => handlers.onSearchInput?.(ev.target.value),
  });

  const newChatBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-primary rc-new-chat-btn',
    title: '新建会话',
    text: '+ 新会话',
    onClick: () => handlers.onOpenNewChat?.(),
  });
  const searchRow = el('div', { className: 'rc-search-row' }, searchInput, newChatBtn);
  const filterRow = el('div', { className: 'rc-filter-row' });
  const groupRow = el('div', { className: 'rc-group-row' });
  const sidebarList = el('div', { className: 'rc-scroll-list' });
  const sidebarProjects = el('div', { className: 'rc-sidebar-projects rc-hidden' });
  sidebarProjects.addEventListener(
    'wheel',
    (ev) => {
      if (sidebarProjects.scrollWidth <= sidebarProjects.clientWidth) return;
      if (Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) {
        sidebarProjects.scrollLeft += ev.deltaY;
        ev.preventDefault();
      }
    },
    { passive: false }
  );
  const sidebarResizer = el('div', {
    className: 'rc-pane-resizer is-left rc-desktop-only',
    title: '拖拽或方向键调整会话栏宽度（双击或按 Enter 重置）',
    role: 'separator',
    tabindex: '0',
    'aria-label': '调整会话栏宽度',
    'aria-orientation': 'vertical',
    'aria-valuemin': '200',
    'aria-valuemax': '420',
    'aria-valuenow': '264',
  });
  const bindPaneResizer = (handleEl, kind) => {
    if (!handleEl || typeof window === 'undefined') return;
    const getClampOpts = () => {
      const otherPane = kind === 'sidebar' ? overviewPane : sidebar;
      const otherCollapsed = kind === 'sidebar' ? Boolean(state.overviewCollapsed) : Boolean(state.sidebarCollapsed);
      const otherPaneWidth = otherCollapsed ? 0 : Math.round(otherPane.getBoundingClientRect().width) || 0;
      return {
        viewportWidth: Number(window.innerWidth || 0),
        otherPaneWidth,
        otherCollapsed,
      };
    };
    const commitReset = () => handlers.onResizePane?.(kind, null, { commit: true });
    handleEl.addEventListener('dblclick', commitReset);
    handleEl.addEventListener('keydown', (ev) => {
      const k = ev.key;
      if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'Home' && k !== 'End' && k !== 'Enter' && k !== ' ') {
        return;
      }
      ev.preventDefault();
      if (k === 'Enter' || k === ' ') {
        commitReset();
        return;
      }
      const clampOpts = getClampOpts();
      const targetPane = kind === 'sidebar' ? sidebar : overviewPane;
      const fallback = getDefaultPaneWidth(kind, clampOpts.viewportWidth);
      const currentW = Math.round(targetPane.getBoundingClientRect().width) || fallback;
      const bounds = clampPaneWidth(kind, currentW, clampOpts);
      if (k === 'Home') {
        handlers.onResizePane?.(kind, bounds.min, { commit: true });
        return;
      }
      if (k === 'End') {
        handlers.onResizePane?.(kind, bounds.max, { commit: true });
        return;
      }
      const step = ev.shiftKey ? 32 : 16;
      const delta = k === 'ArrowRight' ? (kind === 'sidebar' ? step : -step) : kind === 'sidebar' ? -step : step;
      const next = clampPaneWidth(kind, currentW + delta, clampOpts);
      handlers.onResizePane?.(kind, next.value, { commit: true });
    });
    handleEl.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      const pointerId = ev.pointerId;
      try {
        handleEl.setPointerCapture?.(pointerId);
      } catch {}
      const startX = ev.clientX;
      const targetPane = kind === 'sidebar' ? sidebar : overviewPane;
      const clampOpts = getClampOpts();
      const fallback = getDefaultPaneWidth(kind, clampOpts.viewportWidth);
      const startW = Math.round(targetPane.getBoundingClientRect().width) || fallback;
      rootEl.setAttribute('data-resizing', 'true');
      handleEl.classList.add('is-active');
      let rafId = 0;
      let pendingWidth = startW;
      const flushMove = () => {
        rafId = 0;
        handlers.onResizePane?.(kind, pendingWidth, { commit: false });
      };
      const computeNext = (clientX) => {
        const dx = clientX - startX;
        return clampPaneWidth(kind, kind === 'sidebar' ? startW + dx : startW - dx, clampOpts).value;
      };
      const onMove = (moveEv) => {
        pendingWidth = computeNext(moveEv.clientX);
        if (typeof window.requestAnimationFrame === 'function') {
          if (!rafId) rafId = window.requestAnimationFrame(flushMove);
        } else {
          flushMove();
        }
      };
      const onUp = (upEv) => {
        if (rafId) {
          window.cancelAnimationFrame?.(rafId);
          rafId = 0;
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        try {
          if (handleEl.hasPointerCapture?.(pointerId)) handleEl.releasePointerCapture(pointerId);
        } catch {}
        rootEl.removeAttribute('data-resizing');
        handleEl.classList.remove('is-active');
        handlers.onResizePane?.(kind, computeNext(upEv.clientX), { commit: true });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  };
  const sidebar = el(
    'aside',
    { className: 'rc-sidebar' },
    el('div', { className: 'rc-sidebar-head' }, searchRow, filterRow, groupRow),
    sidebarList,
    sidebarProjects,
    sidebarResizer
  );

  const detailTitle = el('h2', { className: 'rc-detail-title', text: '请选择一个会话' });
  const detailSub = el('div', { className: 'rc-detail-sub' });
  const backBtn = el('button', {
    type: 'button',
    className: 'rc-icon-btn rc-back-btn rc-mobile-only',
    'aria-label': '返回会话列表',
    title: '返回会话列表',
    text: '‹',
    onClick: () => handlers.onBackToList?.(),
  });

  const detailHead = el(
    'div',
    { className: 'rc-detail-head' },
    backBtn,
    el('div', { className: 'rc-detail-title-wrap' }, detailTitle, detailSub),
    el(
      'div',
      { className: 'rc-detail-actions' },
      el(
        'button',
        {
          type: 'button',
          className: 'rc-btn is-sm rc-btn-with-icon rc-desktop-only',
          title: '查看当前会话 Markdown 文档 (Artifacts)',
          onClick: () => handlers.onOpenArtifacts?.(),
        },
        createSvgIcon('doc', { size: 13 }),
        el('span', { text: '文档' })
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'rc-btn is-sm rc-btn-with-icon rc-desktop-only',
          title: '查看仓库 Git 变更与 Diff',
          onClick: () => handlers.onOpenGitDiff?.(),
        },
        createSvgIcon('git', { size: 13 }),
        el('span', { text: 'Git' })
      ),
      el(
        'button',
        {
          type: 'button',
          className: 'rc-btn is-sm rc-btn-with-icon rc-desktop-only',
          title: '拉取当前会话最新快照',
          onClick: () => handlers.onRefreshSelectedSnapshot?.(),
        },
        createSvgIcon('refresh', { size: 13 }),
        el('span', { text: '刷新' })
      ),
      el('button', {
        type: 'button',
        className: 'rc-icon-btn rc-mobile-only',
        'aria-label': '文档与代码变更',
        title: '文档与 Git Diff',
        text: '📄',
        onClick: () => handlers.onOpenArtifacts?.(),
      }),
      el('button', {
        type: 'button',
        className: 'rc-icon-btn rc-mobile-only',
        'aria-label': '刷新快照',
        title: '刷新快照',
        text: '↻',
        onClick: () => handlers.onRefreshSelectedSnapshot?.(),
      }),
      el('button', {
        type: 'button',
        className: 'rc-icon-btn rc-mobile-only',
        'aria-label': '更多选项',
        title: '更多选项',
        text: '⋯',
        onClick: (ev) => handlers.onToggleMoreMenu?.(ev),
      })
    )
  );

  const roleBanner = el('div', { className: 'rc-readonly-banner' });
  const roleBannerText = el('span', { text: '' });
  const roleBannerPill = el('span', { className: 'rc-pill', 'data-tone': 'info', text: 'OBSERVE' });
  roleBanner.append(roleBannerText, roleBannerPill);

  const timeline = el('div', { className: 'rc-timeline' });
  const scrollFab = el(
    'button',
    {
      type: 'button',
      className: 'rc-scroll-fab rc-hidden',
      'aria-label': '回到底部',
      title: '回到底部',
      onClick: () => {
        timeline.scrollTop = timeline.scrollHeight;
        scrollFab.classList.add('rc-hidden');
      },
    },
    createSvgIcon('arrowDown', { size: 13 }),
    el('span', { className: 'rc-desktop-only', text: '回到底部' })
  );
  timeline.addEventListener('scroll', () => {
    const gap = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    if (gap > 140) {
      scrollFab.classList.remove('rc-hidden');
    } else {
      scrollFab.classList.add('rc-hidden');
    }
  });
  const timelineWrap = el('div', { className: 'rc-timeline-wrap' }, timeline, scrollFab);

  const resumeBanner = el('div', { className: 'rc-resume-card rc-hidden' });
  const opusBanner = el('div', { className: 'rc-opus-card rc-hidden' });
  const actionBanner = el('div', {
    className: 'rc-action-banner rc-hidden',
    title: '点击关闭提示',
    onClick: () => handlers.onDismissActionBanner?.(),
  });
  const turboWriteCheckbox = el('input', {
    id: 'rc-turbo-write-ack',
    type: 'checkbox',
    checked: state.turboWriteConfirmed,
    onChange: (ev) => handlers.onToggleTurboWrite?.(Boolean(ev.target.checked)),
  });
  const turboWriteText = el('span', { text: 'TURBO 自动执行确认（远程发送将直接执行本机操作）' });
  const turboWriteLabel = el(
    'label',
    { className: 'rc-turbo-inline rc-hidden', for: 'rc-turbo-write-ack' },
    turboWriteCheckbox,
    turboWriteText
  );

  const draftInput = el('textarea', {
    className: 'rc-composer-input',
    rows: '1',
    placeholder: '输入指令继续当前会话（Ctrl/Cmd + Enter 发送，可 Ctrl/Cmd+V 粘贴截图）…',
    value: state.draftText,
    onInput: (ev) => handlers.onDraftInput?.(ev.target.value, ev.target),
  });
  draftInput.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      handlers.onSendDraft?.();
    }
  });
  draftInput.addEventListener('paste', (ev) => {
    const items = ev.clipboardData?.items;
    if (!items || !items.length) return;
    const files = [];
    for (const item of items) {
      if (item.kind === 'file' && String(item.type || '').startsWith('image/')) {
        const f = item.getAsFile?.();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      ev.preventDefault();
      handlers.onAttachImageFiles?.(files);
    }
  });

  const mediaFileInput = el('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/gif',
    multiple: 'true',
    className: 'rc-hidden',
    onChange: (ev) => {
      const files = ev.target?.files ? Array.from(ev.target.files) : [];
      if (files.length > 0) handlers.onAttachImageFiles?.(files);
      if (ev.target) ev.target.value = '';
    },
  });

  const sendBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-primary rc-send-btn',
    text: '发送',
    onClick: () => handlers.onSendDraft?.(),
  });
  const cancelBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-danger rc-cancel-btn',
    text: '停止',
    onClick: () => handlers.onCancelConvo?.(),
  });
  const composerRow = el('div', { className: 'rc-composer-row' }, draftInput, sendBtn, cancelBtn);
  const slashBar = el('div', { className: 'rc-slash-bar rc-hidden' });
  const mediaStrip = el('div', { className: 'rc-media-strip rc-hidden' });
  const modelPopover = el('div', { className: 'rc-model-popover rc-hidden' });
  const contextPopover = el('div', { className: 'rc-ctx-popover rc-hidden' });
  const composerFooter = el('div', { className: 'rc-composer-footer' });

  const composerCard = el(
    'div',
    { className: 'rc-composer-card' },
    modelPopover,
    contextPopover,
    mediaStrip,
    slashBar,
    turboWriteLabel,
    composerRow,
    composerFooter,
    mediaFileInput
  );
  const bottomDock = el(
    'footer',
    { className: 'rc-bottom-dock is-composer' },
    el(
      'div',
      { className: 'rc-composer-shell' },
      resumeBanner,
      opusBanner,
      actionBanner,
      composerCard
    )
  );

  const overviewResizer = el('div', {
    className: 'rc-pane-resizer is-right rc-desktop-only',
    title: '拖拽或方向键调整概览栏宽度（双击或按 Enter 重置）',
    role: 'separator',
    tabindex: '0',
    'aria-label': '调整概览栏宽度',
    'aria-orientation': 'vertical',
    'aria-valuemin': '240',
    'aria-valuemax': '440',
    'aria-valuenow': '296',
  });
  const detail = el(
    'section',
    { className: 'rc-detail' },
    detailHead,
    roleBanner,
    timelineWrap,
    bottomDock,
    overviewResizer
  );

  const overviewPane = el('aside', { className: 'rc-overview' });
  bindPaneResizer(sidebarResizer, 'sidebar');
  bindPaneResizer(overviewResizer, 'overview');

  const navChatsBtn = el('button', {
    type: 'button',
    className: 'rc-mobile-nav-btn',
    text: '会话',
    onClick: () => handlers.onSwitchMobileTab?.('chats'),
  });
  const navApprovalsBadge = el('span', { className: 'rc-nav-badge rc-hidden', text: '0' });
  const navApprovalsBtn = el(
    'button',
    {
      type: 'button',
      className: 'rc-mobile-nav-btn',
      onClick: () => handlers.onSwitchMobileTab?.('approvals'),
    },
    el('span', { text: '待审批' }),
    navApprovalsBadge
  );
  const navOverviewBtn = el('button', {
    type: 'button',
    className: 'rc-mobile-nav-btn',
    text: '概览',
    onClick: () => handlers.onSwitchMobileTab?.('overview'),
  });
  const mobileNav = el(
    'nav',
    { className: 'rc-mobile-nav', 'aria-label': '移动端主导航' },
    navChatsBtn,
    navApprovalsBtn,
    navOverviewBtn
  );

  const newChatModal = el('div', { className: 'rc-new-chat-host rc-hidden' });
  const viewerDrawer = el('div', { className: 'rc-viewer-host rc-hidden' });
  const main = el('main', { className: 'rc-main' }, sidebar, detail, overviewPane);
  rootEl.append(topbar, moreMenu, noticeBar, studioStrip, projectsDrawer, main, mobileNav, newChatModal, viewerDrawer);

  return {
    topbar,
    moreMenu,
    sidebarToggleBtn,
    layoutModeBtn,
    overviewToggleBtn,
    desktopMoreBtn,
    brandDot,
    wsPill,
    hostPill,
    presetPill,
    devicePill,
    noticeBar,
    studioStrip,
    projectsDrawer,
    roleBanner,
    roleBannerText,
    roleBannerPill,
    resumeBanner,
    opusBanner,
    actionBanner,
    composerCard,
    modelPopover,
    contextPopover,
    mediaStrip,
    mediaFileInput,
    composerFooter,
    turboWriteLabel,
    turboWriteText,
    turboWriteCheckbox,
    composerRow,
    slashBar,
    draftInput,
    sendBtn,
    cancelBtn,
    searchInput,
    newChatBtn,
    newChatModal,
    viewerDrawer,
    filterRow,
    groupRow,
    sidebarList,
    sidebarProjects,
    detailTitle,
    detailSub,
    timeline,
    scrollFab,
    overviewPane,
    sidebar,
    sidebarResizer,
    overviewResizer,
    mobileNav,
    navChatsBtn,
    navApprovalsBtn,
    navApprovalsBadge,
    navOverviewBtn,
  };
}

export function renderSidebarProjectsBar(refs, state, { onSelectProject } = {}) {
  if (!refs?.sidebarProjects) return;
  clearNode(refs.sidebarProjects);
  const projects = Array.isArray(state.studioOverview?.projects) ? state.studioOverview.projects : [];
  if (projects.length === 0) {
    refs.sidebarProjects.classList.add('rc-hidden');
    return;
  }
  refs.sidebarProjects.classList.remove('rc-hidden');
  refs.sidebarProjects.appendChild(
    el('button', {
      type: 'button',
      className: 'rc-chip',
      'aria-pressed': !state.selectedProjectId ? 'true' : 'false',
      text: '全部项目',
      onClick: () => onSelectProject?.(''),
    })
  );
  for (const proj of projects) {
    const active = state.selectedProjectId === proj.id;
    refs.sidebarProjects.appendChild(
      el('button', {
        type: 'button',
        className: 'rc-chip',
        'aria-pressed': active ? 'true' : 'false',
        text: proj.name || 'Project',
        onClick: () => onSelectProject?.(active ? '' : proj.id),
      })
    );
  }
}
