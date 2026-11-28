/**
 * AGY Studio Remote PWA — Conversation Timeline, Step Cards & Waiting Step Cards
 * Strict invariant: NEVER use unsafe HTML injection APIs; build DOM with createElement + textContent only.
 */
import {
  appendNodes,
  clearNode,
  copyTextWithFeedback,
  el,
  findConversationMeta,
  formatTime,
  isRunningStatus,
  normalizeRunStatus,
  normalizeStepStatus,
} from './ui-helpers.mjs';

const BARE_URL_RE = /https?:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uffef]+/gi;

function trimTrailingUrlPunct(rawUrl) {
  let url = String(rawUrl || '');
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (/[.,;:!?。，；：！？》】」』]/.test(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')' && (url.match(/\(/g)?.length || 0) < (url.match(/\)/g)?.length || 0)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ']' && (url.match(/\[/g)?.length || 0) < (url.match(/\]/g)?.length || 0)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

function appendPlainTextWithLinks(parent, text) {
  if (!text) return;
  BARE_URL_RE.lastIndex = 0;
  let lastIdx = 0;
  let m;
  while ((m = BARE_URL_RE.exec(text)) !== null) {
    const raw = m[0];
    const cleanUrl = trimTrailingUrlPunct(raw);
    if (!cleanUrl || cleanUrl.length < 10) continue;
    if (m.index > lastIdx) {
      parent.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
    }
    parent.appendChild(
      el('a', {
        className: 'rc-md-link',
        href: cleanUrl,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: cleanUrl,
      })
    );
    const trailing = raw.slice(cleanUrl.length);
    if (trailing) {
      parent.appendChild(document.createTextNode(trailing));
    }
    lastIdx = m.index + raw.length;
  }
  if (lastIdx < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

function extractBrainArtifactFromFileUrl(href) {
  const m = /^file:\/\/.*\/brain\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([A-Za-z0-9._-]{1,128}\.md)(?:#.*)?$/i.exec(
    String(href || '')
  );
  if (!m) return null;
  return { cascadeId: m[1], fileName: m[2] };
}

function appendInlineMarkdown(parent, line, depth = 0, mdOpts = null) {
  const tokenRe = /\[([^\]\n]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/g;
  let lastIdx = 0;
  let match;
  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index > lastIdx) {
      appendPlainTextWithLinks(parent, line.slice(lastIdx, match.index));
    }
    if (match[1] !== undefined && match[2] !== undefined) {
      const label = match[1];
      const href = match[2];
      if (/^https?:\/\//i.test(href)) {
        parent.appendChild(
          el('a', {
            className: 'rc-md-link',
            href,
            target: '_blank',
            rel: 'noopener noreferrer',
            text: label,
          })
        );
      } else if (/^file:\/\//i.test(href)) {
        const artifactRef = mdOpts?.onOpenArtifact ? extractBrainArtifactFromFileUrl(href) : null;
        if (artifactRef) {
          parent.appendChild(
            el('button', {
              type: 'button',
              className: 'rc-md-artifact-link',
              title: `查看文档 ${artifactRef.fileName}`,
              text: `📄 ${label}`,
              onClick: () => mdOpts.onOpenArtifact(artifactRef.cascadeId, artifactRef.fileName),
            })
          );
        } else {
          parent.appendChild(el('code', { className: 'rc-md-file', text: label }));
        }
      } else {
        parent.appendChild(document.createTextNode(match[0]));
      }
    } else if (match[3] !== undefined) {
      parent.appendChild(el('code', { className: 'rc-md-code', text: match[3] }));
    } else if (match[4] !== undefined) {
      const strong = el('strong');
      if (depth < 2) {
        appendInlineMarkdown(strong, match[4], depth + 1, mdOpts);
      } else {
        strong.textContent = match[4];
      }
      parent.appendChild(strong);
    } else if (match[5] !== undefined) {
      const del = el('del', { className: 'rc-md-del' });
      if (depth < 2) {
        appendInlineMarkdown(del, match[5], depth + 1, mdOpts);
      } else {
        del.textContent = match[5];
      }
      parent.appendChild(del);
    } else if (match[6] !== undefined) {
      const em = el('em');
      if (depth < 2) {
        appendInlineMarkdown(em, match[6], depth + 1, mdOpts);
      } else {
        em.textContent = match[6];
      }
      parent.appendChild(em);
    }
    lastIdx = tokenRe.lastIndex;
  }
  if (lastIdx < line.length) {
    appendPlainTextWithLinks(parent, line.slice(lastIdx));
  }
}

function parseTableCells(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || !trimmed.includes('|')) return null;
  let inner = trimmed;
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|') && !inner.endsWith('\\|')) inner = inner.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let idx = 0; idx < inner.length; idx++) {
    if (inner[idx] === '\\' && inner[idx + 1] === '|') {
      cur += '|';
      idx += 1;
    } else if (inner[idx] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += inner[idx];
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseTableAlignments(line) {
  const cells = parseTableCells(line);
  if (!cells || cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const clean = cell.replace(/\s+/g, '');
    if (!/^:?-{3,}:?$/.test(clean)) return null;
    if (clean.startsWith(':') && clean.endsWith(':')) aligns.push('center');
    else if (clean.endsWith(':')) aligns.push('right');
    else aligns.push('left');
  }
  return aligns;
}

export function renderSafeMarkdown(text, mdOpts = null) {
  const root = el('div', { className: 'rc-md' });
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  let i = 0;
  let paraLines = [];

  const flushParagraph = () => {
    if (paraLines.length === 0) return;
    const p = el('p', { className: 'rc-md-p' });
    paraLines.forEach((ln, idx) => {
      if (idx > 0) p.appendChild(document.createElement('br'));
      appendInlineMarkdown(p, ln, 0, mdOpts);
    });
    root.appendChild(p);
    paraLines = [];
  };

  while (i < lines.length) {
    const line = lines[i];
    const fenceStart = /^\s*```([^\s`]*)\s*$/.exec(line);
    if (fenceStart) {
      flushParagraph();
      const lang = (fenceStart[1] || '').trim();
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      const codeText = codeLines.join('\n');
      const copyBtn = el('button', {
        type: 'button',
        className: 'rc-code-copy',
        text: '复制',
        onClick: () => copyTextWithFeedback(copyBtn, codeText),
      });
      root.appendChild(
        el(
          'div',
          { className: 'rc-code-block' },
          el(
            'div',
            { className: 'rc-code-head' },
            el('span', { className: 'rc-code-lang', text: lang || 'code' }),
            copyBtn
          ),
          el('pre', { className: 'rc-pre', text: codeText })
        )
      );
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      flushParagraph();
      root.appendChild(el('hr', { className: 'rc-md-hr' }));
      i += 1;
      continue;
    }

    const hdrMatch = /^\s*(#{1,4})\s+(.+)$/.exec(line);
    if (hdrMatch) {
      flushParagraph();
      const lvl = Math.min(4, hdrMatch[1].length);
      const h = el('div', { className: 'rc-md-h', 'data-level': String(lvl) });
      appendInlineMarkdown(h, hdrMatch[2]);
      root.appendChild(h);
      i += 1;
      continue;
    }

    const quoteMatch = /^\s*>\s?(.*)$/.exec(line);
    if (quoteMatch) {
      flushParagraph();
      const q = el('div', { className: 'rc-md-quote' });
      appendInlineMarkdown(q, quoteMatch[1]);
      root.appendChild(q);
      i += 1;
      continue;
    }

    const listMatch = /^(\s*)(?:([-*])|(\d+\.))\s+(.+)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      const depth = Math.min(2, Math.floor((listMatch[1] || '').length / 2));
      const marker = listMatch[3] || '•';
      const bodyEl = el('div', { className: 'rc-md-li-body' });
      appendInlineMarkdown(bodyEl, listMatch[4]);
      root.appendChild(
        el(
          'div',
          { className: 'rc-md-li', 'data-depth': String(depth) },
          el('span', { className: 'rc-md-li-marker', text: marker }),
          bodyEl
        )
      );
      i += 1;
      continue;
    }

    if (i + 1 < lines.length && line.includes('|') && lines[i + 1].includes('-')) {
      const headerCells = parseTableCells(line);
      const aligns = parseTableAlignments(lines[i + 1]);
      if (headerCells && aligns && headerCells.length >= 2 && headerCells.length === aligns.length) {
        flushParagraph();
        const theadRow = el('tr');
        headerCells.forEach((cellText, colIdx) => {
          const th = el('th', { 'data-align': aligns[colIdx] });
          appendInlineMarkdown(th, cellText);
          theadRow.appendChild(th);
        });
        const tbody = el('tbody');
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const rowCells = parseTableCells(lines[i]);
          if (!rowCells || rowCells.length === 0) break;
          const tr = el('tr');
          for (let colIdx = 0; colIdx < aligns.length; colIdx++) {
            const td = el('td', { 'data-align': aligns[colIdx] });
            appendInlineMarkdown(td, rowCells[colIdx] ?? '');
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i += 1;
        }
        root.appendChild(
          el(
            'div',
            { className: 'rc-md-table-wrap' },
            el('table', { className: 'rc-md-table' }, el('thead', {}, theadRow), tbody)
          )
        );
        continue;
      }
    }

    paraLines.push(line);
    i += 1;
  }
  flushParagraph();
  return root;
}

const SILENT_RESUME_SENTINEL = '\u2063\u200B\u2063';

const TOOL_CATEGORY_LABELS = [
  [/^(?:read_file|view_file|viewFile|view_file_outline|view_code_item|read_resource)$/i, '读取'],
  [/^(?:edit_file|write_file|write_to_file|replace_file_content|multi_replace_file_content)$/i, '编辑'],
  [/^(?:run_command|runCommand|command_status|send_command_input|manage_task)$/i, '命令'],
  [/^(?:grep|grep_search|find_by_name|list_dir|list_resources)$/i, '搜索'],
  [/^(?:search_web|read_url_content|search_marketplace)$/i, '联网'],
  [/^(?:update_steps|update_focus)$/i, '进度'],
  [/^(?:read_board|post_message|swarm|swarm_wait|invoke_subagent|send_message)$/i, '协作'],
];

function humanizeToolCategory(toolName) {
  const clean = String(toolName || '').trim();
  if (!clean) return '操作';
  for (const [re, label] of TOOL_CATEGORY_LABELS) {
    if (re.test(clean)) return label;
  }
  return clean;
}

function extractToolPreview(tc, fallbackText = '') {
  const direct = String(fallbackText || '').trim();
  if (direct) return direct.split('\n')[0].slice(0, 72);
  const rawArgs = tc?.args ?? tc?.arguments ?? tc?.argumentsJson ?? '';
  if (!rawArgs) return '';
  let parsed = null;
  if (typeof rawArgs === 'string') {
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      return rawArgs.trim().split('\n')[0].slice(0, 72);
    }
  } else if (typeof rawArgs === 'object') {
    parsed = rawArgs;
  }
  if (parsed && typeof parsed === 'object') {
    const candidate =
      parsed.toolSummary ||
      parsed.CommandLine ||
      parsed.commandLine ||
      parsed.command ||
      parsed.Path ||
      parsed.path ||
      parsed.AbsolutePath ||
      parsed.TargetFile ||
      parsed.Query ||
      parsed.query ||
      parsed.focus ||
      '';
    if (typeof candidate === 'string' && candidate.trim()) {
      const line = candidate.trim().split('\n')[0];
      if (line.startsWith('/')) {
        const parts = line.split('/').filter(Boolean);
        return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : line;
      }
      return line.slice(0, 72);
    }
  }
  return '';
}

function isInternalSystemStep(step) {
  const t = String(step?.type || '');
  return t === 'SYSTEM_MESSAGE' || t === '101';
}

function isActivityStep(step) {
  const t = String(step?.type || '');
  if (t === 'TOOL_CALL' || t === 'GENERIC' || t === '132') {
    return !step?.error || (Array.isArray(step?.toolCalls) && step.toolCalls.length > 0);
  }
  if (t === 'PLANNER_RESPONSE' || t === '15') {
    const hasVisibleText = Boolean(String(step?.text || '').trim());
    return !hasVisibleText && !step?.error;
  }
  return false;
}

function buildToolDetailsRow(tc, fallbackText = '') {
  const name = tc?.name || tc?.toolName || 'tool';
  const rawArgs = tc?.args ?? tc?.arguments ?? tc?.argumentsJson ?? '';
  const argsText =
    typeof rawArgs === 'string' ? rawArgs : rawArgs ? JSON.stringify(rawArgs, null, 2) : '';
  const outText =
    typeof tc?.output === 'string' ? tc.output : tc?.output ? JSON.stringify(tc.output, null, 2) : '';
  const preview = extractToolPreview(tc, fallbackText);

  const summary = el(
    'summary',
    { className: 'rc-tool-row-sum' },
    el('span', { className: 'rc-tool-row-name', text: name }),
    preview ? el('span', { className: 'rc-tool-row-preview', text: preview }) : null
  );

  const bodyNodes = [];
  if (argsText) bodyNodes.push(el('pre', { className: 'rc-pre', text: argsText }));
  if (outText) bodyNodes.push(el('pre', { className: 'rc-pre', text: outText }));

  return el(
    'details',
    { className: 'rc-tool-row' },
    summary,
    bodyNodes.length > 0
      ? el('div', { className: 'rc-details-body' }, ...bodyNodes)
      : el('div', { className: 'rc-details-body' }, el('span', { className: 'rc-convo-meta', text: '无更多参数输出' }))
  );
}

function renderActivityGroup(stepsBatch, { hideThinkingProse = true } = {}) {
  const tools = [];
  const thinkingList = [];
  for (const step of stepsBatch) {
    if (!step) continue;
    const stepTools = Array.isArray(step.toolCalls) ? step.toolCalls : [];
    if (stepTools.length > 0) {
      for (const tc of stepTools) {
        tools.push({ tc, fallbackText: stepTools.length === 1 ? step.text || '' : '' });
      }
    } else if ((step.type === 'TOOL_CALL' || step.type === 'GENERIC' || step.type === '132') && step.text) {
      tools.push({ tc: { name: 'runCommand', args: step.text }, fallbackText: step.text });
    }
    if (!hideThinkingProse && step.thinking && String(step.thinking).trim()) {
      thinkingList.push(String(step.thinking).trim());
    }
  }

  if (tools.length === 0 && thinkingList.length === 0) {
    return null;
  }

  let summaryText = '';
  if (tools.length > 0) {
    const cats = [];
    const seen = new Set();
    for (const item of tools) {
      const cat = humanizeToolCategory(item.tc?.name || item.tc?.toolName);
      if (!seen.has(cat)) {
        seen.add(cat);
        cats.push(cat);
      }
    }
    if (tools.length === 1) {
      const preview = extractToolPreview(tools[0].tc, tools[0].fallbackText);
      summaryText = preview ? `已执行 ${cats[0]} · ${preview}` : `已执行 1 项操作 · ${cats[0]}`;
    } else {
      const catSummary = cats.slice(0, 3).join('、') + (cats.length > 3 ? ' 等' : '');
      summaryText = `已执行 ${tools.length} 项操作 · ${catSummary}`;
    }
  } else {
    const totalChars = thinkingList.reduce((acc, s) => acc + s.length, 0);
    summaryText = `思考过程 (${totalChars} 字)`;
  }

  const body = el('div', { className: 'rc-activity-body' });
  for (const t of thinkingList) {
    body.appendChild(el('pre', { className: 'rc-pre rc-activity-thinking', text: t }));
  }
  for (const item of tools) {
    body.appendChild(buildToolDetailsRow(item.tc, item.fallbackText));
  }

  return el(
    'details',
    { className: 'rc-activity-group' },
    el('summary', { className: 'rc-activity-summary', text: summaryText }),
    body
  );
}

export function renderStepCard(step, { hideThinkingProse = false, compact = false, onOpenArtifact = null } = {}) {
  const typeStr = String(step.type || 'STEP');
  const statusInfo = normalizeStepStatus(step.status);

  let roleLabel = typeStr;
  let roleAttr = 'system';
  if (typeStr === 'USER_INPUT' || typeStr === '14') {
    roleLabel = '用户';
    roleAttr = 'user';
  } else if (typeStr === 'PLANNER_RESPONSE' || typeStr === '15') {
    roleLabel = '助手';
    roleAttr = 'assistant';
  } else if (typeStr === 'TOOL_CALL' || typeStr === 'GENERIC' || typeStr === '132') {
    roleLabel = '工具调用';
    roleAttr = 'tool';
  } else if (typeStr === 'ERROR_MESSAGE' || typeStr === '17') {
    roleLabel = '错误';
    roleAttr = 'error';
  } else if (typeStr === 'CHECKPOINT' || typeStr === '23') {
    roleLabel = '上下文已压缩';
    roleAttr = 'checkpoint';
  } else if (typeStr === 'SYSTEM_MESSAGE' || typeStr === '101') {
    roleLabel = '系统';
    roleAttr = 'system';
  }

  if (roleAttr === 'checkpoint' && compact) {
    return el(
      'div',
      { className: 'rc-checkpoint-divider', 'data-type': typeStr, 'data-role': 'checkpoint' },
      el('span', { className: 'rc-checkpoint-label', text: '上下文已压缩 (/compact)' })
    );
  }

  if (roleAttr === 'user' && compact && String(step.text || '').startsWith(SILENT_RESUME_SENTINEL)) {
    return el(
      'div',
      { className: 'rc-checkpoint-divider', 'data-type': typeStr, 'data-role': 'user' },
      el('span', { className: 'rc-checkpoint-label', text: '已触发静默续跑' })
    );
  }

  const isDoneStep = statusInfo.label === 'DONE';
  const hasVisibleErrorBody = Boolean(
    String(step.text || '').trim() ||
      step.error ||
      (step.thinking && !hideThinkingProse) ||
      (Array.isArray(step.toolCalls) && step.toolCalls.length > 0) ||
      step.mediaCount > 0
  );
  const isCompactEmptyError = compact && roleAttr === 'error' && !hasVisibleErrorBody;
  const card = el('article', {
    className: 'rc-step',
    'data-type': typeStr,
    'data-role': roleAttr,
    ...(compact ? { 'data-compact': 'true' } : {}),
    ...(isCompactEmptyError ? { 'data-empty': 'true' } : {}),
  });

  const useCompactChatBubble = compact && (roleAttr === 'user' || roleAttr === 'assistant');

  if (!useCompactChatBubble) {
    card.appendChild(
      el(
        'div',
        { className: 'rc-step-head' },
        el('span', { className: 'rc-step-role', text: `${roleLabel} #${step.idx ?? '?'}` }),
        el(
          'div',
          { className: 'rc-dock-group' },
          step.createdAt ? el('span', { className: 'rc-step-time', text: formatTime(step.createdAt) }) : null,
          !isDoneStep || !compact
            ? el('span', {
                className: `rc-pill rc-step-status-pill${isDoneStep ? ' is-done' : ''}`,
                'data-tone': statusInfo.tone,
                text: statusInfo.label,
              })
            : null
        )
      )
    );
  }

  if (step.thinking && !hideThinkingProse) {
    const thinkingText = String(step.thinking);
    card.appendChild(
      el(
        'details',
        { className: compact ? 'rc-activity-group' : 'rc-details' },
        el('summary', {
          className: compact ? 'rc-activity-summary' : undefined,
          text: compact ? `思考过程 (${thinkingText.length} 字)` : `Thinking 思考过程 (${thinkingText.length} 字符，点击展开)`,
        }),
        el(
          'div',
          { className: compact ? 'rc-activity-body' : 'rc-details-body' },
          el('pre', { className: 'rc-pre', text: thinkingText })
        )
      )
    );
  }

  if (compact && roleAttr === 'assistant' && Array.isArray(step.toolCalls) && step.toolCalls.length > 0) {
    const inlineGroup = renderActivityGroup([{ ...step, thinking: '' }], { hideThinkingProse: true });
    if (inlineGroup) card.appendChild(inlineGroup);
  }

  if (step.mediaCount > 0) {
    const namesHint = Array.isArray(step.mediaNames) && step.mediaNames.length > 0 ? step.mediaNames.join(', ') : '';
    card.appendChild(
      el('div', {
        className: 'rc-step-media-badge',
        ...(namesHint ? { title: namesHint } : {}),
        text: `🖼 附带 ${step.mediaCount} 张图片`,
      })
    );
  }

  if (step.text) {
    card.appendChild(renderSafeMarkdown(String(step.text), onOpenArtifact ? { onOpenArtifact } : null));
  }

  if ((!compact || roleAttr !== 'assistant') && Array.isArray(step.toolCalls) && step.toolCalls.length > 0) {
    for (const tc of step.toolCalls) {
      card.appendChild(buildToolDetailsRow(tc));
    }
  }

  if (step.error) {
    const errText = typeof step.error === 'string' ? step.error : JSON.stringify(step.error, null, 2);
    card.appendChild(el('pre', { className: 'rc-pre', text: errText }));
  }

  const showAssistantCopy =
    useCompactChatBubble && roleAttr === 'assistant' && Boolean(String(step.text || '').trim());
  if (useCompactChatBubble && (step.createdAt || !isDoneStep || showAssistantCopy)) {
    const copyReplyBtn = showAssistantCopy
      ? el('button', {
          type: 'button',
          className: 'rc-step-copy',
          title: '复制整条回复',
          text: '复制',
          onClick: () => copyTextWithFeedback(copyReplyBtn, String(step.text)),
        })
      : null;
    card.appendChild(
      el(
        'div',
        { className: 'rc-step-foot' },
        copyReplyBtn,
        !isDoneStep
          ? el('span', {
              className: 'rc-pill rc-step-status-pill',
              'data-tone': statusInfo.tone,
              text: statusInfo.label,
            })
          : null,
        step.createdAt ? el('span', { className: 'rc-step-time', text: formatTime(step.createdAt) }) : null
      )
    );
  }

  return card;
}

const askQuestionDrafts = new Map(); // key -> Array<{ selectedIds: Set<string>, writeIn: string }>

function getAskQuestionDraft(draftKey, count) {
  let arr = askQuestionDrafts.get(draftKey);
  if (!Array.isArray(arr) || arr.length !== count) {
    arr = Array.from({ length: count }, () => ({ selectedIds: new Set(), writeIn: '' }));
    askQuestionDrafts.set(draftKey, arr);
    if (askQuestionDrafts.size > 24) {
      const oldest = askQuestionDrafts.keys().next().value;
      if (oldest !== undefined) askQuestionDrafts.delete(oldest);
    }
  }
  return arr;
}

function renderAskQuestionCard(w, { canWrite = false, hostAttached = false, isBusy = false, onApprove = null } = {}) {
  const hash = String(w.waitingStepHash || '');
  const questions = Array.isArray(w.questions) ? w.questions : [];
  const draftKey = hash || `step:${w.stepIndex ?? 0}:${questions.length}`;
  const draft = getAskQuestionDraft(draftKey, questions.length);
  const interactive = Boolean(canWrite && hostAttached && !isBusy && hash);

  const buildAnswersPayload = () =>
    questions.map((q, idx) => {
      const d = draft[idx] || { selectedIds: new Set(), writeIn: '' };
      const selIds = Array.from(d.selectedIds);
      const writeIn = !q.isMultiSelect && selIds.length > 0 ? '' : String(d.writeIn || '').trim();
      const skipped = selIds.length === 0 && !writeIn;
      return {
        selectedOptionIds: skipped ? [] : selIds,
        writeInResponse: skipped ? '' : writeIn,
        skipped,
      };
    });

  const hasAnyAnswer = () =>
    draft.some((d) => (d.selectedIds && d.selectedIds.size > 0) || Boolean(String(d.writeIn || '').trim()));

  const submitBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm is-primary rc-ask-submit',
    disabled: !interactive || !hasAnyAnswer(),
    text: isBusy ? '提交中…' : '提交回答',
    onClick: () => {
      if (!interactive || !hasAnyAnswer()) return;
      onApprove?.(w, 'answer_question', { answers: buildAnswersPayload() });
    },
  });

  const cancelBtn = el('button', {
    type: 'button',
    className: 'rc-btn is-sm',
    disabled: !interactive,
    text: '取消',
    onClick: () => {
      if (!interactive) return;
      onApprove?.(w, 'cancel_question');
    },
  });

  const syncSubmitState = () => {
    submitBtn.disabled = !interactive || !hasAnyAnswer();
  };

  const questionNodes = questions.map((q, qIdx) => {
    const qDraft = draft[qIdx];
    const optButtons = [];
    const writeInInput = el('input', {
      type: 'text',
      className: 'rc-ask-writein',
      placeholder: '其他（输入自定义回答…）',
      value: qDraft.writeIn || '',
      disabled: !interactive,
      onInput: (ev) => {
        const val = String(ev.target.value || '');
        qDraft.writeIn = val;
        if (!q.isMultiSelect && val.trim()) {
          qDraft.selectedIds.clear();
          for (const b of optButtons) {
            b.classList.remove('is-selected');
            b.setAttribute('aria-pressed', 'false');
          }
        }
        syncSubmitState();
      },
    });

    const opts = Array.isArray(q.options) ? q.options : [];
    for (const opt of opts) {
      const optId = String(opt.id || '');
      const rawText = String(opt.text || '');
      const isRec = /^\(Recommended\)\s*/i.test(rawText);
      const displayText = isRec ? rawText.replace(/^\(Recommended\)\s*/i, '') : rawText;
      const selected = qDraft.selectedIds.has(optId);
      const btn = el(
        'button',
        {
          type: 'button',
          className: `rc-ask-option${selected ? ' is-selected' : ''}`,
          'data-option-id': optId,
          'aria-pressed': selected ? 'true' : 'false',
          disabled: !interactive,
          onClick: () => {
            if (!interactive) return;
            if (q.isMultiSelect) {
              if (qDraft.selectedIds.has(optId)) qDraft.selectedIds.delete(optId);
              else qDraft.selectedIds.add(optId);
              const nowSel = qDraft.selectedIds.has(optId);
              btn.classList.toggle('is-selected', nowSel);
              btn.setAttribute('aria-pressed', nowSel ? 'true' : 'false');
            } else {
              qDraft.selectedIds.clear();
              qDraft.selectedIds.add(optId);
              qDraft.writeIn = '';
              writeInInput.value = '';
              for (const b of optButtons) {
                const match = b === btn;
                b.classList.toggle('is-selected', match);
                b.setAttribute('aria-pressed', match ? 'true' : 'false');
              }
            }
            syncSubmitState();
          },
        },
        el('span', { className: `rc-ask-indicator${q.isMultiSelect ? ' is-multi' : ''}` }),
        el(
          'span',
          { className: 'rc-ask-option-text' },
          isRec ? el('span', { className: 'rc-ask-rec-badge', text: '推荐' }) : null,
          displayText
        )
      );
      optButtons.push(btn);
    }

    return el(
      'div',
      { className: 'rc-ask-q' },
      el(
        'div',
        { className: 'rc-ask-q-head' },
        el('span', { className: 'rc-ask-q-title', text: `${questions.length > 1 ? `${qIdx + 1}. ` : ''}${q.question}` }),
        el('span', {
          className: 'rc-pill',
          'data-tone': q.isMultiSelect ? 'info' : 'neutral',
          text: q.isMultiSelect ? '多选' : '单选',
        })
      ),
      el('div', { className: 'rc-ask-options' }, ...optButtons),
      writeInInput
    );
  });

  let footerEl;
  if (!canWrite) {
    footerEl = el('div', {
      className: 'rc-convo-meta',
      text: '只读观察模式 (observe)：如需直接在手机端选择提交，请在 Mac 桌面端将此设备升为协作 (steer)。',
    });
  } else if (!hostAttached) {
    footerEl = el('div', { className: 'rc-convo-meta', text: '宿主离线，暂无法提交回答' });
  } else {
    footerEl = el('div', { className: 'rc-waiting-actions' }, submitBtn, cancelBtn);
  }

  return el(
    'div',
    { className: 'rc-waiting-card rc-ask-card', 'data-waiting-hash': hash },
    el(
      'div',
      { className: 'rc-waiting-head' },
      el('span', { text: `❓ 请选择方案（${questions.length} 题）` }),
      el('span', { className: 'rc-pill', 'data-tone': 'info', text: `step #${w.stepIndex ?? '?'}` })
    ),
    ...questionNodes,
    footerEl
  );
}

export function renderWaitingCards(
  waitingSteps,
  { canWrite = false, hostAttached = false, busyHash = '', onApprove = null } = {}
) {
  if (!Array.isArray(waitingSteps) || waitingSteps.length === 0) return [];
  return waitingSteps.map((w) => {
    const hash = String(w.waitingStepHash || '');
    const isBusy = Boolean(busyHash && hash && busyHash === hash);
    if (w.interactionCase === 'askQuestion' && Array.isArray(w.questions) && w.questions.length > 0) {
      return renderAskQuestionCard(w, { canWrite, hostAttached, isBusy, onApprove });
    }
    const isPermission = !w.interactionCase || w.interactionCase === 'permission';

    let footerEl;
    if (!canWrite) {
      footerEl = el('div', {
        className: 'rc-convo-meta',
        text: `只读观察模式 (observe)：请在 Mac 桌面端点击 Allow Once / Deny，或在「AGY Studio 设置 → 远程控制」中一键升为协作 (steer) / 重新配对${hash ? ` · hash:${hash.slice(0, 8)}` : ''}`,
      });
    } else if (!isPermission) {
      footerEl = el('div', {
        className: 'rc-convo-meta',
        text: `该交互类型 (${w.interactionCase}) 暂请在桌面端完成${hash ? ` · hash:${hash.slice(0, 8)}` : ''}`,
      });
    } else if (!hostAttached) {
      footerEl = el(
        'div',
        { className: 'rc-waiting-actions' },
        el('button', { type: 'button', className: 'rc-btn is-sm is-primary', disabled: true, text: '仅本次允许 (Allow Once)' }),
        el('button', { type: 'button', className: 'rc-btn is-sm is-danger', disabled: true, text: '拒绝 (Deny)' }),
        el('span', { className: 'rc-convo-meta', text: '宿主离线，无法提交审批' })
      );
    } else {
      footerEl = el(
        'div',
        { className: 'rc-waiting-actions' },
        el('button', {
          type: 'button',
          className: 'rc-btn is-sm is-primary',
          disabled: isBusy || !hash,
          text: isBusy ? '提交中…' : '仅本次允许 (Allow Once)',
          onClick: () => onApprove?.(w, 'allow_once'),
        }),
        el('button', {
          type: 'button',
          className: 'rc-btn is-sm is-danger',
          disabled: isBusy || !hash,
          text: '拒绝 (Deny)',
          onClick: () => onApprove?.(w, 'deny'),
        }),
        hash ? el('span', { className: 'rc-mono', text: `hash:${hash.slice(0, 8)}` }) : null
      );
    }

    return el(
      'div',
      { className: 'rc-waiting-card' },
      el(
        'div',
        { className: 'rc-waiting-head' },
        el('span', { text: `⏳ 等待审批 · ${w.toolName || w.interactionCase || '操作确认'}` }),
        el('span', {
          className: 'rc-pill',
          'data-tone': 'warn',
          text: `step #${w.stepIndex ?? '?'}`,
        })
      ),
      w.commandLine ? el('pre', { className: 'rc-pre', text: String(w.commandLine) }) : null,
      w.action ? el('div', { className: 'rc-mono', text: `动作: ${w.action}` }) : null,
      footerEl
    );
  });
}

function isErrorStep(step) {
  const t = String(step?.type || '');
  return t === 'ERROR_MESSAGE' || t === '17';
}

function renderErrorGroup(errBatch, opts) {
  if (errBatch.length === 1) {
    return renderStepCard(errBatch[0], opts);
  }
  const firstIdx = errBatch[0]?.idx ?? '?';
  const lastIdx = errBatch[errBatch.length - 1]?.idx ?? '?';
  const body = el('div', { className: 'rc-error-group-body' });
  for (const s of errBatch) {
    body.appendChild(renderStepCard(s, opts));
  }
  return el(
    'details',
    { className: 'rc-error-group' },
    el(
      'summary',
      { className: 'rc-error-group-sum' },
      el('span', { text: `连续 ${errBatch.length} 次执行异常 (#${firstIdx}–#${lastIdx})` }),
      el('span', { className: 'rc-pill', 'data-tone': 'danger', text: `${errBatch.length} 项` })
    ),
    body
  );
}

export function renderDetailTimeline({
  state,
  refs,
  onSelectConversation,
  onApprove = null,
  onOpenArtifact = null,
  onOpenGitDiff = null,
}) {
  const cid = state.selectedId;
  const convo = findConversationMeta(state, cid);
  const snap = cid ? state.snapshots.get(cid) : null;
  const streamEntry = cid ? state.streams.get(cid) : null;
  const streamText =
    typeof streamEntry === 'string'
      ? streamEntry
      : streamEntry?.text ?? streamEntry?.streamingText ?? snap?.streamingText ?? '';
  const streamThinking = typeof streamEntry === 'object' && streamEntry ? streamEntry.thinkingText || '' : '';

  if (!cid) {
    refs.detailTitle.textContent = '请选择一个会话';
    clearNode(refs.detailSub);
    clearNode(refs.timeline);
    refs.timeline.appendChild(
      el(
        'div',
        { className: 'rc-empty rc-empty-card' },
        el('div', { className: 'rc-empty-title', text: 'AGY Studio Remote 工作台' }),
        el('div', { text: '从左侧选择一个会话以查看消息时间线、工具调用与实时流。' }),
        el(
          'div',
          { className: 'rc-empty-shortcuts rc-desktop-only' },
          el('span', { className: 'rc-kbd-hint' }, el('kbd', { className: 'rc-kbd', text: '⌘K' }), '搜索会话'),
          el('span', { className: 'rc-kbd-hint' }, el('kbd', { className: 'rc-kbd', text: '⌘B' }), '切换侧栏'),
          el('span', { className: 'rc-kbd-hint' }, el('kbd', { className: 'rc-kbd', text: '⌘.' }), '切换概览')
        )
      )
    );
    return;
  }

  refs.detailTitle.textContent = convo?.title || convo?.summary || cid;
  clearNode(refs.detailSub);
  const runInfo = normalizeRunStatus(snap?.status ?? convo?.status);
  const wtMeta = state.studioOverview?.worktreeByCid?.[cid] || null;
  appendNodes(
    refs.detailSub,
    el('span', { className: 'rc-pill', 'data-tone': runInfo.tone, text: runInfo.label }),
    el('span', { className: 'rc-mono rc-desktop-only', text: cid.slice(0, 13) }),
    wtMeta?.branch
      ? onOpenGitDiff
        ? el('button', {
            type: 'button',
            className: 'rc-pill rc-branch-pill is-clickable',
            'data-tone': 'info',
            title: '查看当前分支 Git 变更与 Diff',
            text: `⎇ ${wtMeta.branch}`,
            onClick: () => onOpenGitDiff({ cascadeId: cid, projectId: wtMeta?.projectId || '' }),
          })
        : el('span', { className: 'rc-pill rc-branch-pill', 'data-tone': 'info', text: `⎇ ${wtMeta.branch}` })
      : null,
    snap?.source ? el('span', { className: 'rc-desktop-only', text: `来源: ${snap.source}` }) : null
  );

  const wasNearBottom =
    refs.timeline.scrollHeight - refs.timeline.scrollTop - refs.timeline.clientHeight < 110;

  const activeEl = refs.timeline.ownerDocument?.activeElement || null;
  if (
    activeEl &&
    activeEl.classList?.contains('rc-ask-writein') &&
    refs.timeline.contains(activeEl) &&
    refs.timeline.getAttribute('data-rendered-cid') === cid
  ) {
    return;
  }
  refs.timeline.setAttribute('data-rendered-cid', cid);
  clearNode(refs.timeline);

  if (state.snapshotLoading && !snap) {
    refs.timeline.appendChild(el('div', { className: 'rc-empty', text: '正在加载会话快照…' }));
    return;
  }

  if (state.snapshotError && !snap) {
    refs.timeline.appendChild(el('div', { className: 'rc-error-banner', text: state.snapshotError }));
    return;
  }

  const role = state.identity?.role || 'observe';
  const canWrite = role === 'steer' || role === 'admin';
  const waiting = snap?.waitingSteps?.length ? snap.waitingSteps : convo?.waitingSteps || [];
  const subWaitingList = Array.isArray(convo?.waitingSubagents) ? convo.waitingSubagents : [];

  const studioPrefs = state.studioOverview?.studioPrefs || state.modelCatalog?.studioPrefs || {};
  const hideThinkingProse = studioPrefs.hideThinkingProse !== false;

  const steps = Array.isArray(snap?.steps) ? snap.steps : [];
  if (steps.length === 0 && !streamText && waiting.length === 0 && subWaitingList.length === 0) {
    refs.timeline.appendChild(el('div', { className: 'rc-empty', text: '该会话暂无可显示步骤。' }));
  } else {
    let activityBatch = [];
    let errorBatch = [];
    const flushActivity = () => {
      if (activityBatch.length === 0) return;
      const groupEl = renderActivityGroup(activityBatch, { hideThinkingProse });
      if (groupEl) refs.timeline.appendChild(groupEl);
      activityBatch = [];
    };
    const flushErrors = () => {
      if (errorBatch.length === 0) return;
      refs.timeline.appendChild(renderErrorGroup(errorBatch, { hideThinkingProse, compact: true, onOpenArtifact }));
      errorBatch = [];
    };

    for (const step of steps) {
      if (!step) continue;
      if (isInternalSystemStep(step)) {
        continue;
      }
      if (isActivityStep(step)) {
        flushErrors();
        activityBatch.push(step);
        continue;
      }
      if (isErrorStep(step)) {
        flushActivity();
        errorBatch.push(step);
        continue;
      }
      flushActivity();
      flushErrors();
      refs.timeline.appendChild(renderStepCard(step, { hideThinkingProse, compact: true, onOpenArtifact }));
    }
    flushActivity();
    flushErrors();
  }

  const streamStatusActive =
    typeof streamEntry === 'object' && streamEntry ? isRunningStatus(streamEntry.status) : false;
  const isLiveRunning = isRunningStatus(snap?.status ?? convo?.status) || streamStatusActive;
  let lastPlannerText = '';
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]?.type === 'PLANNER_RESPONSE' || steps[i]?.type === '15') {
      lastPlannerText = String(steps[i].text || '').trim();
      break;
    }
  }
  const duplicatesLastStep =
    Boolean(streamText) && Boolean(lastPlannerText) && String(streamText).trim() === lastPlannerText;
  const visibleStreamThinking = hideThinkingProse ? '' : streamThinking;

  if (isLiveRunning && (streamText || visibleStreamThinking) && !duplicatesLastStep) {
    refs.timeline.appendChild(
      el(
        'div',
        { className: 'rc-stream-card' },
        el(
          'div',
          { className: 'rc-stream-head' },
          el('span', { className: 'rc-pulse' }),
          el('span', { text: '实时生成流' })
        ),
        visibleStreamThinking
          ? el(
              'details',
              { className: 'rc-activity-group' },
              el('summary', { className: 'rc-activity-summary', text: `实时思考 (${visibleStreamThinking.length} 字)` }),
              el('div', { className: 'rc-activity-body' }, el('pre', { className: 'rc-pre', text: visibleStreamThinking }))
            )
          : null,
        streamText ? renderSafeMarkdown(String(streamText)) : null
      )
    );
  }

  for (const card of renderWaitingCards(waiting, {
    canWrite,
    hostAttached: Boolean(state.hostAttached && state.wsStatus === 'connected'),
    busyHash:
      (state.approvingByCid instanceof Map ? state.approvingByCid.get(cid) : '') || state.approvingHash || '',
    onApprove,
  })) {
    refs.timeline.appendChild(card);
  }

  for (const sub of subWaitingList) {
    if (!sub || !sub.id || !Array.isArray(sub.waitingSteps) || sub.waitingSteps.length === 0) continue;
    const firstW = sub.waitingSteps[0];
    refs.timeline.appendChild(
      el(
        'div',
        { className: 'rc-waiting-card' },
        el(
          'div',
          { className: 'rc-waiting-head' },
          el('span', { text: `⏳ 子代理等待审批 · ${sub.title || sub.summary || sub.id.slice(0, 8)}` }),
          el('span', { className: 'rc-pill', 'data-tone': 'warn', text: `${sub.waitingSteps.length} 项` })
        ),
        firstW?.commandLine ? el('pre', { className: 'rc-pre', text: String(firstW.commandLine) }) : null,
        el(
          'div',
          { className: 'rc-dock-group' },
          el('button', {
            type: 'button',
            className: 'rc-btn is-sm',
            text: '查看并实时跟踪该子代理',
            onClick: () => onSelectConversation(sub.id),
          })
        )
      )
    );
  }

  if (wasNearBottom) {
    refs.timeline.scrollTop = refs.timeline.scrollHeight;
  }
}
