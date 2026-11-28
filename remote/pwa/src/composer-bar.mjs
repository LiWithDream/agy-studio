/**
 * AGY Studio Remote PWA — Conversation Bottom Bar V2 (Model/Effort Capsule, SVG Context Ring,
 * Live Speed Pill, Auto-Growing Composer & Client-Side Image Attachment Compression).
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement / createElementNS + textContent only.
 */
import { appendNodes, clearNode, el } from './ui-helpers.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 7;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;
const MAX_IMAGE_DIM = 1600;
const MAX_B64_CHARS = 600_000;
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function readFileAsDataUrl(fileOrBlob) {
  return new Promise((resolve, reject) => {
    if (typeof FileReader !== 'function') {
      reject(new Error('file_reader_unavailable'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('file_read_failed'));
    reader.readAsDataURL(fileOrBlob);
  });
}

function parseDataUrlParts(dataUrl) {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(dataUrl || '').trim());
  if (!m) return null;
  return { mimeType: m[1].toLowerCase(), dataBase64: m[2] };
}

function encodeCanvasDataUrl(canvas, mime, quality) {
  try {
    return canvas.toDataURL(mime, quality);
  } catch {
    return '';
  }
}

export async function compressImageFile(file) {
  if (!file || typeof file !== 'object') {
    throw new Error('invalid_image_file');
  }
  const rawType = String(file.type || 'image/png').toLowerCase();
  const safeName = String(file.name || 'pasted-image.png').slice(0, 128);
  const canCanvas =
    typeof createImageBitmap === 'function' &&
    typeof document !== 'undefined' &&
    typeof document.createElement === 'function';

  // Keep small animated GIFs intact if possible; otherwise compress via Canvas
  if (!canCanvas || (rawType === 'image/gif' && Number(file.size || 0) <= 380_000)) {
    const rawUrl = await readFileAsDataUrl(file);
    const parsed = parseDataUrlParts(rawUrl);
    if (!parsed || !ALLOWED_MIME_TYPES.has(parsed.mimeType)) {
      throw new Error('unsupported_image_type');
    }
    if (parsed.dataBase64.length > MAX_B64_CHARS) {
      throw new Error('image_too_large');
    }
    return {
      id: `img-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: safeName,
      mimeType: parsed.mimeType,
      dataBase64: parsed.dataBase64,
      previewUrl: `data:${parsed.mimeType};base64,${parsed.dataBase64}`,
      sizeBytes: Math.floor((parsed.dataBase64.length * 3) / 4),
    };
  }

  const bitmap = await createImageBitmap(file);
  try {
    const origW = Math.max(1, bitmap.width || 1);
    const origH = Math.max(1, bitmap.height || 1);
    const baseScale = Math.min(1, MAX_IMAGE_DIM / Math.max(origW, origH));

    let chosenUrl = '';
    for (const dimFactor of [1, 0.78, 0.58]) {
      const w = Math.max(1, Math.round(origW * baseScale * dimFactor));
      const h = Math.max(1, Math.round(origH * baseScale * dimFactor));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) throw new Error('canvas_unavailable');
      ctx2d.drawImage(bitmap, 0, 0, w, h);

      for (const mime of ['image/webp', 'image/jpeg']) {
        for (const q of [0.82, 0.68, 0.52]) {
          const candidate = encodeCanvasDataUrl(canvas, mime, q);
          const parsed = parseDataUrlParts(candidate);
          if (parsed && ALLOWED_MIME_TYPES.has(parsed.mimeType) && parsed.dataBase64.length <= MAX_B64_CHARS) {
            chosenUrl = candidate;
            break;
          }
        }
        if (chosenUrl) break;
      }
      if (chosenUrl) break;
    }

    const finalParts = parseDataUrlParts(chosenUrl);
    if (!finalParts || finalParts.dataBase64.length > MAX_B64_CHARS) {
      throw new Error('image_too_large');
    }
    return {
      id: `img-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: safeName,
      mimeType: finalParts.mimeType,
      dataBase64: finalParts.dataBase64,
      previewUrl: `data:${finalParts.mimeType};base64,${finalParts.dataBase64}`,
      sizeBytes: Math.floor((finalParts.dataBase64.length * 3) / 4),
    };
  } finally {
    bitmap.close?.();
  }
}

export function autoResizeTextarea(textarea) {
  if (!textarea || !textarea.style) return;
  const val = String(textarea.value || '');
  if (!val) {
    textarea.style.height = '';
    return;
  }
  textarea.style.height = 'auto';
  const scHeight = Number(textarea.scrollHeight || 0);
  if (scHeight > 0) {
    const nextH = Math.min(180, Math.max(34, scHeight));
    textarea.style.height = `${nextH}px`;
  }
}

export function createSvgContextRing(pct, tone = 'ok') {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const offset = RING_CIRC * (1 - clamped / 100);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'rc-ctx-ring');
  svg.setAttribute('data-tone', tone);
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');

  const track = document.createElementNS(SVG_NS, 'circle');
  track.setAttribute('cx', '10');
  track.setAttribute('cy', '10');
  track.setAttribute('r', String(RING_RADIUS));
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', 'currentColor');
  track.setAttribute('stroke-opacity', '0.2');
  track.setAttribute('stroke-width', '2.5');

  const fill = document.createElementNS(SVG_NS, 'circle');
  fill.setAttribute('cx', '10');
  fill.setAttribute('cy', '10');
  fill.setAttribute('r', String(RING_RADIUS));
  fill.setAttribute('fill', 'none');
  fill.setAttribute('stroke', 'currentColor');
  fill.setAttribute('stroke-width', '2.5');
  fill.setAttribute('stroke-linecap', 'round');
  fill.setAttribute('stroke-dasharray', RING_CIRC.toFixed(2));
  fill.setAttribute('stroke-dashoffset', offset.toFixed(2));
  fill.setAttribute('transform', 'rotate(-90 10 10)');

  svg.appendChild(track);
  svg.appendChild(fill);
  return svg;
}

export function renderMediaPreviewStrip(container, mediaList = [], { disabled = false, onRemove = null } = {}) {
  if (!container) return;
  clearNode(container);
  const items = Array.isArray(mediaList) ? mediaList : [];
  if (items.length === 0) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  for (const item of items) {
    if (!item || !SAFE_DATA_IMAGE_RE.test(String(item.previewUrl || ''))) continue;
    const kb = Math.max(1, Math.round(Number(item.sizeBytes || (item.dataBase64?.length || 0) * 0.75) / 1024));
    container.appendChild(
      el(
        'div',
        { className: 'rc-media-chip' },
        el('img', {
          className: 'rc-media-thumb',
          src: item.previewUrl,
          alt: String(item.name || 'image'),
        }),
        el(
          'div',
          { className: 'rc-media-meta' },
          el('span', { className: 'rc-media-name', text: String(item.name || '图片') }),
          el('span', { className: 'rc-media-size', text: `${kb} KB` })
        ),
        el('button', {
          type: 'button',
          className: 'rc-media-rm',
          disabled,
          'aria-label': `移除 ${item.name || '图片'}`,
          text: '×',
          onClick: () => onRemove?.(item.id),
        })
      )
    );
  }
}

const MODEL_ACCENT_RULES = [
  [/\bneon\b/i, '#e14d67'],
  [/\bargon\b/i, '#7c5ce6'],
  [/\bhydrogen\b/i, '#38a3c7'],
  [/\bcarbon\b/i, '#c78c3c'],
  [/\bflash\b/i, '#eab308'],
  [/\bopus\b/i, '#e07b53'],
  [/\bsonnet\b/i, '#d47c5d'],
  [/\bhaiku\b/i, '#5ea8a0'],
  [/\bgpt\b|\bcodex\b|\bo[134]\b/i, '#8b5cf6'],
];

const TIER_SUFFIX_RE = /\s*\((?:off|low|medium|high|extra\s*high|extra|xhigh|max|minimal)(?:\s+thinking)?\)\s*$/i;

export function stripModelTierSuffix(name) {
  return String(name || '').replace(TIER_SUFFIX_RE, '').trim();
}

export function extractOrchestratorPlanner(baseName = '', plannerLabel = '') {
  const raw = String(baseName || '').trim();
  const arrowMatch = /^orchestrator\s*[·→\-–:]\s*(.+)$/i.exec(raw);
  if (arrowMatch && arrowMatch[1].trim()) return stripModelTierSuffix(arrowMatch[1]);
  const parenMatch = /^orchestrator\s*\(([^)]+)\)$/i.exec(raw);
  if (parenMatch && parenMatch[1].trim()) return stripModelTierSuffix(parenMatch[1]);
  const pLbl = stripModelTierSuffix(plannerLabel);
  if (pLbl && !/^orchestrator$/i.test(pLbl)) return pLbl;
  return '';
}

export function resolveModelAccent(name) {
  const raw = String(name || '').trim();
  const target = /^orchestrator/i.test(raw) ? extractOrchestratorPlanner(raw, '') || raw : raw;
  for (const [re, color] of MODEL_ACCENT_RULES) {
    if (re.test(target)) return color;
  }
  return '#7c5ce6';
}

export function shortenModelName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '模型';
  if (/^orchestrator$/i.test(raw)) return '路由';
  const stripped = raw
    .replace(/^(?:Google\s+)?Gemini\s+\d+(?:\.\d+)?\s+/i, '')
    .replace(/^Claude\s+(?:\d+(?:\.\d+)?\s+)?/i, '')
    .replace(/^OpenAI\s+/i, '')
    .trim();
  if (stripped && stripped.length >= 2 && stripped.length < raw.length) return stripped;
  return raw;
}

export function shortenEffortBadge(effortText) {
  const raw = String(effortText || '').trim();
  if (!raw) return '';
  return raw
    .replace(/\bExtra\s+High\b/i, 'XHigh')
    .replace(/\bExtra\b/i, 'XHigh')
    .replace(/\bMedium\b/i, 'Med')
    .replace(/\bMinimal\b/i, 'Min')
    .trim();
}

export function normalizeTierKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (s === 'xhigh' || s === 'extra' || s === 'extra high' || s === 'extra_high') return 'xhigh';
  if (s === 'high') return 'high';
  if (s === 'medium' || s === 'med') return 'medium';
  if (s === 'low') return 'low';
  if (s === 'max') return 'max';
  if (s === 'minimal' || s === 'min') return 'minimal';
  if (s === 'off') return 'off';
  return s;
}

function lookupDefaultTierKey(defaultTierByFamily, familyName) {
  if (!defaultTierByFamily || typeof defaultTierByFamily !== 'object' || !familyName) return '';
  if (defaultTierByFamily[familyName]) return normalizeTierKey(defaultTierByFamily[familyName]);
  const want = stripModelTierSuffix(familyName).toLowerCase();
  for (const [k, v] of Object.entries(defaultTierByFamily)) {
    if (stripModelTierSuffix(k).toLowerCase() === want && v) {
      return normalizeTierKey(v);
    }
  }
  return '';
}

function isFamilyHiddenByPrefs(fam, studioPrefs) {
  if (!studioPrefs || studioPrefs.customizeModelList !== true) return false;
  const hidden = Array.isArray(studioPrefs.hiddenModels) ? studioPrefs.hiddenModels : [];
  if (hidden.length === 0) return false;
  const famExact = String(fam?.baseName || '').trim().toLowerCase();
  const famBase = stripModelTierSuffix(fam?.baseName || '').toLowerCase();
  for (const raw of hidden) {
    const hExact = String(raw || '').trim().toLowerCase();
    const hBase = stripModelTierSuffix(raw).toLowerCase();
    if (!hExact) continue;
    if (hExact === famExact || (hBase && hBase === famBase)) return true;
  }
  return false;
}

function createOrchestratorPrismSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'rc-model-orch-icon');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const outer = document.createElementNS(SVG_NS, 'polygon');
  outer.setAttribute('points', '8,1.5 14,8 8,14.5 2,8');
  outer.setAttribute('stroke', 'currentColor');
  outer.setAttribute('stroke-width', '1.4');
  outer.setAttribute('stroke-linejoin', 'round');
  outer.setAttribute('fill', 'currentColor');
  outer.setAttribute('fill-opacity', '0.16');

  const core = document.createElementNS(SVG_NS, 'circle');
  core.setAttribute('cx', '8');
  core.setAttribute('cy', '8');
  core.setAttribute('r', '2.1');
  core.setAttribute('fill', 'currentColor');

  svg.appendChild(outer);
  svg.appendChild(core);
  return svg;
}

function createChevronDownSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'rc-model-caret-svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const pathEl = document.createElementNS(SVG_NS, 'path');
  pathEl.setAttribute('d', 'M4.2 6.2L8 10l3.8-3.8');
  pathEl.setAttribute('stroke', 'currentColor');
  pathEl.setAttribute('stroke-width', '1.6');
  pathEl.setAttribute('stroke-linecap', 'round');
  pathEl.setAttribute('stroke-linejoin', 'round');

  svg.appendChild(pathEl);
  return svg;
}

function findCurrentFamilyInCatalog(catalog, selected) {
  const families = Array.isArray(catalog?.families) ? catalog.families : [];
  if (families.length === 0) return null;
  if (selected) {
    const byVal = families.find((f) =>
      f.variants.some(
        (v) =>
          v.value === selected.value &&
          (!selected.isOrchestrator || !selected.plannerValue || v.plannerValue === selected.plannerValue)
      )
    );
    if (byVal) return byVal;
    const byName = families.find((f) => f.baseName === selected.baseName);
    if (byName) return byName;
  }
  return families[0];
}

function renderModelPopoverPanel(
  container,
  {
    open = false,
    catalog = null,
    selected = null,
    studioPrefs = null,
    showHiddenModels = false,
    canWrite = false,
    modelBusy = false,
    onSelectModelOption = null,
    onToggleShowHiddenModels = null,
    onClose = null,
  } = {}
) {
  if (!container) return;
  clearNode(container);
  const families = Array.isArray(catalog?.families) ? catalog.families : [];
  if (!open || families.length === 0) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  const effectivePrefs = studioPrefs || catalog?.studioPrefs || {};
  const showDots = effectivePrefs.showModelDots !== false;
  const showEffortBar = effectivePrefs.showEffortBar !== false;
  const defaultTiers = effectivePrefs.defaultTierByFamily || {};

  const activeFam = findCurrentFamilyInCatalog(catalog, selected);
  const activePlanner = activeFam?.isOrchestrator
    ? extractOrchestratorPlanner(activeFam.baseName, selected?.plannerLabel || '')
    : '';
  const activeAccent = resolveModelAccent(activePlanner || activeFam?.baseName || selected?.baseName || '');
  if (container.style?.setProperty) {
    container.style.setProperty('--rc-model-accent', activeAccent);
  }

  const children = [
    el(
      'div',
      { className: 'rc-model-pop-head' },
      el('strong', { text: canWrite ? '切换模型与思考深度' : '模型与思考深度（只读预览）' }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm is-ghost',
        text: '关闭',
        onClick: (ev) => {
          ev?.stopPropagation?.();
          onClose?.();
        },
      })
    ),
  ];

  // Desktop-parity Accent-Tinted Segmented Effort Bar
  const effortVariants = Array.isArray(activeFam?.variants) ? activeFam.variants.filter((v) => v.effort) : [];
  if (showEffortBar && effortVariants.length > 1) {
    const seg = el('div', { className: 'rc-effort-seg' });
    for (const v of effortVariants) {
      const isActiveVar = Boolean(
        selected &&
          v.value === selected.value &&
          (!activeFam.isOrchestrator || !selected.plannerValue || v.plannerValue === selected.plannerValue)
      );
      seg.appendChild(
        el('button', {
          type: 'button',
          className: 'rc-effort-btn',
          'aria-pressed': isActiveVar ? 'true' : 'false',
          disabled: !canWrite || modelBusy,
          text: v.displayEffort || v.effort,
          onClick: (ev) => {
            ev?.stopPropagation?.();
            onSelectModelOption?.({
              model: v.value,
              plannerModel: v.plannerValue ?? null,
              customLabel: v.customLabel || '',
            });
          },
        })
      );
    }
    children.push(
      el('div', { className: 'rc-model-pop-section' }, el('div', { className: 'rc-model-sec-title', text: '思考深度 (Effort)' }), seg)
    );
  }

  const groupMeta = [
    { id: 'primary', label: '主力模型' },
    { id: 'orch', label: '编排器 (Orchestrator)' },
    { id: 'other', label: '其他模型' },
  ];

  let hiddenCount = 0;
  const visibleFamilies = families.filter((fam) => {
    const isFamActive = Boolean(activeFam && fam.baseName === activeFam.baseName);
    const hidden = isFamilyHiddenByPrefs(fam, effectivePrefs);
    if (hidden) hiddenCount += 1;
    return !hidden || showHiddenModels || isFamActive;
  });

  const listWrap = el('div', { className: 'rc-model-fam-list' });
  for (const gm of groupMeta) {
    const groupFams = visibleFamilies.filter((f) => f.group === gm.id);
    if (groupFams.length === 0) continue;
    listWrap.appendChild(el('div', { className: 'rc-model-sec-title', text: gm.label }));
    for (const fam of groupFams) {
      const isFamActive = Boolean(activeFam && fam.baseName === activeFam.baseName);
      const isOrchFam = Boolean(fam.isOrchestrator || gm.id === 'orch');
      const famPlanner = isOrchFam ? extractOrchestratorPlanner(fam.baseName, '') : '';
      const famLookupName = famPlanner || fam.baseName;
      const famAccent = resolveModelAccent(famLookupName);
      const prefTierKey = lookupDefaultTierKey(defaultTiers, famLookupName);
      const desiredEffKey = normalizeTierKey(selected?.effort || selected?.displayEffort || '');

      const targetVar =
        (prefTierKey &&
          fam.variants.find((v) => normalizeTierKey(v.effort || v.displayEffort) === prefTierKey)) ||
        (desiredEffKey &&
          fam.variants.find((v) => normalizeTierKey(v.effort || v.displayEffort) === desiredEffKey)) ||
        fam.variants.find((v) => normalizeTierKey(v.effort) === 'high') ||
        fam.variants.find((v) => normalizeTierKey(v.effort) === 'medium') ||
        fam.variants[0];

      const rawBadge =
        isFamActive && selected?.displayEffort ? selected.displayEffort : targetVar?.displayEffort || '';
      const badgeText = shortenEffortBadge(rawBadge);
      const displayName = isOrchFam && famPlanner ? famPlanner : fam.baseName;

      const rowBtn = el(
        'button',
        {
          type: 'button',
          className: 'rc-model-fam-btn',
          'data-selected': isFamActive ? 'true' : 'false',
          'data-is-orch': isOrchFam ? '1' : '0',
          disabled: !canWrite || modelBusy,
          onClick: (ev) => {
            ev?.stopPropagation?.();
            if (!targetVar) return;
            onSelectModelOption?.({
              model: targetVar.value,
              plannerModel: targetVar.plannerValue ?? null,
              customLabel: targetVar.customLabel || '',
            });
          },
        },
        el(
          'span',
          { className: 'rc-model-fam-main' },
          isOrchFam
            ? createOrchestratorPrismSvg()
            : showDots
              ? el('span', { className: 'rc-model-dot', 'aria-hidden': 'true' })
              : null,
          el('span', { className: 'rc-model-fam-name', text: displayName })
        ),
        badgeText
          ? el('span', {
              className: 'rc-model-row-effort',
              'data-active': isFamActive ? 'true' : 'false',
              text: badgeText,
            })
          : null
      );
      if (rowBtn.style?.setProperty) {
        rowBtn.style.setProperty('--rc-row-accent', famAccent);
      }
      listWrap.appendChild(rowBtn);
    }
  }

  if (hiddenCount > 0 && typeof onToggleShowHiddenModels === 'function') {
    listWrap.appendChild(
      el('button', {
        type: 'button',
        className: 'rc-model-hidden-toggle',
        text: showHiddenModels ? '收起已隐藏模型' : `显示已隐藏模型 (${hiddenCount})`,
        onClick: (ev) => {
          ev?.stopPropagation?.();
          onToggleShowHiddenModels();
        },
      })
    );
  }

  children.push(listWrap);
  appendNodes(container, ...children);
}

function formatQuotaShort(pool) {
  if (!pool || typeof pool !== 'object') return null;
  const h5 = pool.fiveHourRemainingPct;
  const wk = pool.weeklyRemainingPct;
  const hasH5 = h5 !== null && h5 !== undefined && Number.isFinite(Number(h5));
  const hasWk = wk !== null && wk !== undefined && Number.isFinite(Number(wk));
  if (!hasH5 && !hasWk) return null;
  const h5Pct = hasH5 ? Math.max(0, Math.min(100, Math.round(Number(h5)))) : null;
  const wkPct = hasWk ? Math.max(0, Math.min(100, Math.round(Number(wk)))) : null;
  const minPct = Math.min(h5Pct ?? 100, wkPct ?? 100);
  const tone = minPct <= 10 ? 'crit' : minPct <= 25 ? 'warn' : 'ok';
  return { h5Pct, wkPct, tone };
}

function renderContextPopoverPanel(
  container,
  {
    open = false,
    metrics = null,
    quota = null,
    canWrite = false,
    online = false,
    compactBusy = false,
    compactSupported = true,
    onCompact = null,
    onClose = null,
  } = {}
) {
  if (!container) return;
  clearNode(container);
  if (!open) {
    container.classList.add('rc-hidden');
    return;
  }
  container.classList.remove('rc-hidden');

  const hasMetrics = Boolean(metrics && metrics.ctxLimit > 0);
  const ctxPct = hasMetrics ? Math.max(0, Math.min(100, Math.round(Number(metrics.ctxPct || 0)))) : 0;
  const tone = !hasMetrics ? 'neutral' : ctxPct >= 90 ? 'crit' : ctxPct >= 75 ? 'warn' : 'ok';

  const head = el(
    'div',
    { className: 'rc-model-pop-head' },
    el('strong', { text: '上下文窗口' }),
    el('button', {
      type: 'button',
      className: 'rc-btn is-sm is-ghost',
      text: '关闭',
      onClick: (ev) => {
        ev?.stopPropagation?.();
        onClose?.();
      },
    })
  );

  const fillEl = el('div', { className: 'rc-ctx-meter-fill', 'data-tone': tone });
  if (fillEl.style) {
    fillEl.style.width = `${hasMetrics ? ctxPct : 0}%`;
  }

  const summary = el(
    'div',
    { className: 'rc-ctx-pop-summary' },
    el(
      'div',
      { className: 'rc-ctx-pop-top' },
      el('span', { className: 'rc-ctx-pop-pct', 'data-tone': tone, text: hasMetrics ? `${ctxPct}%` : '--%' }),
      el('span', { className: 'rc-ctx-pop-ratio', text: hasMetrics ? String(metrics.ctxRatioStr || '') : '暂无上下文计量数据' })
    ),
    el('div', { className: 'rc-meter-track' }, fillEl)
  );

  const kvRows = [];
  if (hasMetrics) {
    kvRows.push(
      el(
        'div',
        { className: 'rc-ctx-pop-kv' },
        el('span', { className: 'rc-ctx-pop-k', text: '本轮缓存命中' }),
        el('span', { className: 'rc-ctx-pop-v', text: `${Number(metrics.lastCacheRate || 0).toFixed(1)}%` })
      ),
      el(
        'div',
        { className: 'rc-ctx-pop-kv' },
        el('span', { className: 'rc-ctx-pop-k', text: '会话平均缓存' }),
        el('span', { className: 'rc-ctx-pop-v', text: `${Number(metrics.sessionCacheRate || 0).toFixed(1)}%` })
      )
    );
    if (Number(metrics.turns || 0) > 0 || Number(metrics.calls || 0) > 0) {
      kvRows.push(
        el(
          'div',
          { className: 'rc-ctx-pop-kv' },
          el('span', { className: 'rc-ctx-pop-k', text: '累计调用' }),
          el('span', { className: 'rc-ctx-pop-v', text: `${metrics.turns || 0} 轮 · ${metrics.calls || 0} 次` })
        )
      );
    }
    if (Number(metrics.ttft || 0) > 0) {
      const durLabel = metrics.useStream ? '首字延迟 (TTFT)' : '响应等待 (Hold)';
      kvRows.push(
        el(
          'div',
          { className: 'rc-ctx-pop-kv' },
          el('span', { className: 'rc-ctx-pop-k', text: durLabel }),
          el('span', { className: 'rc-ctx-pop-v', text: `${Number(metrics.ttft).toFixed(1)}s` })
        )
      );
    }
  }

  const gPool = formatQuotaShort(quota?.gemini);
  const cPool = formatQuotaShort(quota?.claude);
  if (gPool) {
    const gParts = [];
    if (gPool.h5Pct !== null) gParts.push(`5h ${gPool.h5Pct}%`);
    if (gPool.wkPct !== null) gParts.push(`周 ${gPool.wkPct}%`);
    kvRows.push(
      el(
        'div',
        { className: 'rc-ctx-pop-kv' },
        el('span', { className: 'rc-ctx-pop-k', text: 'Gemini 剩余限额' }),
        el('span', { className: 'rc-ctx-pop-v', text: gParts.join(' · ') })
      )
    );
  }
  if (cPool) {
    const cParts = [];
    if (cPool.h5Pct !== null) cParts.push(`5h ${cPool.h5Pct}%`);
    if (cPool.wkPct !== null) cParts.push(`周 ${cPool.wkPct}%`);
    kvRows.push(
      el(
        'div',
        { className: 'rc-ctx-pop-kv' },
        el('span', { className: 'rc-ctx-pop-k', text: 'Claude 剩余限额' }),
        el('span', { className: 'rc-ctx-pop-v', text: cParts.join(' · ') })
      )
    );
  }

  let actionsSection = null;
  if (canWrite) {
    const compactDisabled = !online || compactBusy || compactSupported === false;
    let hintText = '整理历史上下文以释放窗口空间';
    if (!online) hintText = '宿主离线，暂无法触发上下文压缩';
    else if (compactSupported === false) hintText = '当前宿主版本暂不支持远程触发 /compact';
    actionsSection = el(
      'div',
      { className: 'rc-ctx-pop-actions' },
      el('div', { className: 'rc-ctx-pop-hint', text: hintText }),
      el('button', {
        type: 'button',
        className: 'rc-btn is-sm rc-ctx-compact-btn',
        disabled: compactDisabled,
        text: compactBusy ? '正在压缩上下文…' : '压缩上下文 (/compact)',
        onClick: (ev) => {
          ev?.stopPropagation?.();
          onCompact?.();
        },
      })
    );
  }

  appendNodes(
    container,
    head,
    summary,
    kvRows.length > 0 ? el('div', { className: 'rc-ctx-pop-meta' }, ...kvRows) : null,
    actionsSection
  );
}

export function renderComposerFooterBar(
  refs,
  {
    catalog = null,
    studioPrefs = null,
    modelPopoverOpen = false,
    contextPopoverOpen = false,
    showHiddenModels = false,
    modelBusy = false,
    metrics = null,
    quota = null,
    canWrite = false,
    online = false,
    hasSelection = false,
    sendBusy = false,
    compactBusy = false,
    compactSupported = true,
    mediaCount = 0,
    onToggleModelPopover = null,
    onToggleContextPopover = null,
    onToggleShowHiddenModels = null,
    onSelectModelOption = null,
    onCloseModelPopover = null,
    onCloseContextPopover = null,
    onCompact = null,
    onPickImages = null,
    onScrollBottom = null,
  } = {}
) {
  const footer = refs?.composerFooter;
  if (!footer) return;
  clearNode(footer);

  const selected = catalog?.selected || null;
  const effectivePrefs = studioPrefs || catalog?.studioPrefs || {};
  if (refs.modelPopover) {
    renderModelPopoverPanel(refs.modelPopover, {
      open: modelPopoverOpen && online,
      catalog,
      selected,
      studioPrefs: effectivePrefs,
      showHiddenModels,
      canWrite,
      modelBusy,
      onSelectModelOption,
      onToggleShowHiddenModels,
      onClose: onCloseModelPopover,
    });
  }
  if (refs.contextPopover) {
    renderContextPopoverPanel(refs.contextPopover, {
      open: contextPopoverOpen && hasSelection,
      metrics,
      quota,
      canWrite,
      online,
      compactBusy,
      compactSupported,
      onCompact,
      onClose: onCloseContextPopover,
    });
  }

  const leftCluster = el('div', { className: 'rc-footer-left' });
  const rightCluster = el('div', { className: 'rc-footer-right' });

  // 1. Attach image button (compact "+" on mobile, full "+ 图片 (N/4)" on desktop)
  if (canWrite && hasSelection) {
    const attachNodes = [
      el('span', { className: 'rc-attach-plus', text: '+' }),
      el('span', { className: 'rc-attach-label', text: ' 图片' }),
    ];
    if (mediaCount > 0) {
      attachNodes.push(el('span', { className: 'rc-attach-count', text: ` (${mediaCount}/4)` }));
    }
    leftCluster.appendChild(
      el(
        'button',
        {
          type: 'button',
          className: 'rc-footer-pill rc-attach-btn',
          'data-has-media': mediaCount > 0 ? 'true' : 'false',
          disabled: !online || sendBusy || mediaCount >= 4,
          title: '上传图片或直接 Ctrl/Cmd+V 粘贴截图（最多 4 张）',
          onClick: () => onPickImages?.(),
        },
        ...attachNodes
      )
    );
  }

  // 2. Desktop-parity Model & Effort capsule
  const hasModels = Boolean(catalog && Array.isArray(catalog.families) && catalog.families.length > 0);
  const rawBaseName = selected?.baseName || (hasModels ? '选择模型' : '默认模型');
  const isOrch = Boolean(!modelBusy && (selected?.isOrchestrator || /^orchestrator/i.test(rawBaseName)));
  const plannerBase = isOrch ? extractOrchestratorPlanner(rawBaseName, selected?.plannerLabel || '') : '';
  const accentSource = plannerBase || rawBaseName;
  const accent = resolveModelAccent(accentSource);
  const showDots = effectivePrefs.showModelDots !== false;

  const modelLabelFull = modelBusy ? '切换中…' : isOrch && plannerBase ? 'Orchestrator' : rawBaseName;
  const modelLabelShort = modelBusy ? '切换中…' : isOrch ? '路由' : shortenModelName(rawBaseName);

  const effortLabelRaw = !modelBusy && selected?.displayEffort ? selected.displayEffort : '';
  const effortShort = shortenEffortBadge(effortLabelRaw);
  const defaultTierKey = lookupDefaultTierKey(effectivePrefs.defaultTierByFamily, accentSource);
  const currentTierKey = normalizeTierKey(selected?.effort || effortLabelRaw);
  const isDefaultTier = Boolean(defaultTierKey && currentTierKey && defaultTierKey === currentTierKey);
  const hideDefaultEff = Boolean(effectivePrefs.hideDefaultEffort && isDefaultTier);

  let effortFullText = '';
  let effortShortText = '';
  if (!modelBusy) {
    if (isOrch && plannerBase) {
      const pShort = shortenModelName(plannerBase);
      effortFullText = effortShort && !hideDefaultEff ? `${pShort} · ${effortShort}` : pShort;
      effortShortText = effortFullText;
    } else if (effortLabelRaw && !hideDefaultEff) {
      effortFullText = effortLabelRaw;
      effortShortText = effortShort;
    }
  }

  const modelDisabled = !online || !hasModels || modelBusy;
  const capsuleBtn = el(
    'button',
    {
      type: 'button',
      className: 'rc-footer-pill rc-model-capsule',
      'data-is-orch': isOrch ? '1' : '0',
      'data-has-effort': effortShortText ? '1' : '0',
      'aria-expanded': modelPopoverOpen ? 'true' : 'false',
      disabled: modelDisabled,
      title: canWrite
        ? `${rawBaseName}${effortLabelRaw ? ` · ${effortLabelRaw}` : ''}（点击切换模型与思考深度）`
        : `${rawBaseName}${effortLabelRaw ? ` · ${effortLabelRaw}` : ''}（只读模式）`,
      onClick: (ev) => {
        ev?.stopPropagation?.();
        onToggleModelPopover?.();
      },
    },
    isOrch
      ? createOrchestratorPrismSvg()
      : showDots
        ? el('span', { className: 'rc-model-dot', 'aria-hidden': 'true' })
        : null,
    el(
      'span',
      { className: 'rc-model-capsule-name' },
      el('span', { className: 'rc-model-name-full', text: modelLabelFull }),
      el('span', { className: 'rc-model-name-short', 'aria-hidden': 'true', text: modelLabelShort })
    ),
    effortShortText
      ? el(
          'span',
          { className: 'rc-model-effort-tag' },
          el('span', { className: 'rc-effort-full', text: effortFullText }),
          el('span', { className: 'rc-effort-short', 'aria-hidden': 'true', text: effortShortText })
        )
      : null,
    createChevronDownSvg()
  );
  if (capsuleBtn.style?.setProperty) {
    capsuleBtn.style.setProperty('--rc-model-accent', accent);
  }
  leftCluster.appendChild(capsuleBtn);

  // 3. Context Occupancy Ring (clicking opens secondary popover with usage details & /compact)
  if (hasSelection) {
    const hasMetrics = Boolean(metrics && metrics.ctxLimit > 0);
    const ctxPct = hasMetrics ? Math.round(Number(metrics.ctxPct || 0)) : 0;
    const tone = ctxPct >= 90 ? 'crit' : ctxPct >= 75 ? 'warn' : 'ok';
    const ctxTitle = hasMetrics
      ? `上下文 ${metrics.ctxRatioStr || ''} (${ctxPct}%) · 本轮缓存 ${Number(metrics.lastCacheRate || 0).toFixed(1)}%（点击查看详情与 /compact）`
      : '查看上下文窗口与 /compact';

    leftCluster.appendChild(
      el(
        'button',
        {
          type: 'button',
          className: 'rc-footer-pill rc-ctx-pill',
          'data-tone': hasMetrics ? tone : 'neutral',
          'aria-expanded': contextPopoverOpen ? 'true' : 'false',
          title: ctxTitle,
          onClick: (ev) => {
            ev?.stopPropagation?.();
            onToggleContextPopover?.();
          },
        },
        createSvgContextRing(ctxPct, hasMetrics ? tone : 'neutral'),
        el('span', { text: compactBusy ? '压缩中…' : hasMetrics ? `${ctxPct}%` : '--%' }),
        createChevronDownSvg()
      )
    );
  }

  // 4. Quota micro-pill (replaces noisy streaming timer; falls back to tok/s when quota unavailable)
  const preferClaude = /claude|opus|sonnet|haiku/i.test(accentSource);
  const claudeQuota = formatQuotaShort(quota?.claude);
  const geminiQuota = formatQuotaShort(quota?.gemini);
  const activeQuota = preferClaude ? claudeQuota || geminiQuota : geminiQuota || claudeQuota;
  const activePoolTag = activeQuota
    ? (activeQuota === claudeQuota ? 'C' : 'G')
    : '';
  const activePoolName = activeQuota
    ? (activeQuota === claudeQuota ? 'Claude' : 'Gemini')
    : '';

  if (activeQuota) {
    const primaryText =
      activeQuota.h5Pct !== null
        ? `${activePoolTag} 5h ${activeQuota.h5Pct}%`
        : `${activePoolTag} 周 ${activeQuota.wkPct}%`;
    const weeklyExtra =
      activeQuota.h5Pct !== null && activeQuota.wkPct !== null
        ? ` · 周 ${activeQuota.wkPct}%`
        : '';
    const qTitle = `${activePoolName} 剩余限额：${activeQuota.h5Pct !== null ? `5h ${activeQuota.h5Pct}%` : ''}${activeQuota.h5Pct !== null && activeQuota.wkPct !== null ? ' · ' : ''}${activeQuota.wkPct !== null ? `周 ${activeQuota.wkPct}%` : ''}（点击查看详情）`;
    leftCluster.appendChild(
      el(
        'button',
        {
          type: 'button',
          className: 'rc-footer-pill rc-quota-pill',
          'data-tone': activeQuota.tone,
          title: qTitle,
          onClick: (ev) => {
            ev?.stopPropagation?.();
            onToggleContextPopover?.();
          },
        },
        el('span', { className: 'rc-quota-primary', text: primaryText }),
        weeklyExtra ? el('span', { className: 'rc-quota-weekly', text: weeklyExtra }) : null
      )
    );
  } else if (metrics && (Number(metrics.displayTps) > 0 || Number(metrics.ttft) > 0)) {
    const hasTps = Number(metrics.displayTps) > 0;
    const tpsText = hasTps ? `${Math.round(Number(metrics.displayTps))} tok/s` : '';
    const durLabel = metrics.useStream ? 'TTFT' : 'Hold';
    const durText = Number(metrics.ttft) > 0 ? `${durLabel} ${Number(metrics.ttft).toFixed(1)}s` : '';
    if (tpsText || durText) {
      const mTitle = `累计 ${metrics.turns || 0} 轮 / ${metrics.calls || 0} 次调用 · 会话缓存 ${Number(metrics.sessionCacheRate || 0).toFixed(1)}%`;
      leftCluster.appendChild(
        el(
          'span',
          {
            className: 'rc-footer-pill rc-metrics-pill',
            'data-has-tps': hasTps ? 'true' : 'false',
            title: mTitle,
          },
          tpsText ? el('span', { className: 'rc-metrics-tps', text: tpsText }) : null,
          durText
            ? el('span', {
                className: 'rc-metrics-ttft',
                text: tpsText ? ` · ${durText}` : durText,
              })
            : null
        )
      );
    }
  }

  appendNodes(footer, leftCluster, rightCluster);
}
