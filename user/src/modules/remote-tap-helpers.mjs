/**
 * Pure normalization, proto-encoding & sanitization helpers for Remote Tap.
 * Zero DOM access, zero MutationObserver, zero side effects.
 */
export const MAX_FIELD_CHARS = 16384;
export const MAX_SLASH_COMMANDS = 64;

export const CANONICAL_COMPACT_SLASH_INFO = Object.freeze({
  $typeName: 'exa.codeium_common_pb.SlashCommandInfo',
  name: 'compact',
  modelFacingText: '',
  type: 1,
  icon: 'collapse_all',
  displayName: '',
  logo: '',
});

export const DEFAULT_SLASH_COMMANDS = Object.freeze([
  { name: 'compact', cmd: '/compact', desc: '压缩上下文', kind: 'builtin', trailingSpace: false },
  { name: 'plan', cmd: '/plan', desc: '先规划再执行', kind: 'builtin', trailingSpace: true },
  { name: 'goal', cmd: '/goal', desc: '设定长任务目标', kind: 'builtin', trailingSpace: true },
  { name: 'grill-me', cmd: '/grill-me', desc: '深度追问需求边界', kind: 'builtin', trailingSpace: true },
  { name: 'boost', cmd: '/boost', desc: '深度思考与严密验证', kind: 'builtin', trailingSpace: true },
  { name: 'teamwork', cmd: '/teamwork', desc: '多代理协同推进', kind: 'builtin', trailingSpace: true },
  { name: 'schedule', cmd: '/schedule', desc: '定时或循环任务', kind: 'builtin', trailingSpace: true },
  { name: 'learn', cmd: '/learn', desc: '沉淀规则或经验', kind: 'builtin', trailingSpace: true },
]);

const NO_TRAILING_SPACE_CMDS = new Set(['compact', 'clear', 'help']);

export function truncateStr(val, max = MAX_FIELD_CHARS) {
  const s = String(val ?? '');
  if (s.length <= max) return s;
  const prefix = '…(truncated)\n';
  const keep = Math.max(256, max - prefix.length);
  return `${prefix}${s.slice(-keep)}`;
}

export function toJsonSafe(val, depth = 0) {
  if (val === null || val === undefined) return val === undefined ? null : val;
  const t = typeof val;
  if (t === 'bigint') return Number.isSafeInteger(Number(val)) ? Number(val) : val.toString();
  if (t === 'string' || t === 'number' || t === 'boolean') return val;
  if (t === 'function' || t === 'symbol') return undefined;
  if (depth > 8) return null;
  if (Array.isArray(val)) {
    const out = [];
    for (let i = 0; i < val.length; i++) out.push(toJsonSafe(val[i], depth + 1));
    return out;
  }
  if (val instanceof Set) return Array.from(val).map((x) => toJsonSafe(x, depth + 1));
  if (val instanceof Map) {
    const obj = {};
    for (const [k, v] of val.entries()) obj[String(k)] = toJsonSafe(v, depth + 1);
    return obj;
  }
  const out = {};
  for (const k of Object.keys(val)) {
    if (k === '$typeName') continue;
    const cleaned = toJsonSafe(val[k], depth + 1);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return out;
}

export function toIsoTime(ts) {
  if (!ts) return '';
  if (typeof ts === 'string') return ts;
  if (typeof ts === 'number' || typeof ts === 'bigint') {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString();
  }
  if (ts.seconds !== undefined && ts.seconds !== null) {
    const sec = Number(ts.seconds);
    const ns = Number(ts.nanos || 0);
    if (!Number.isFinite(sec) || sec <= 0) return '';
    return new Date(sec * 1000 + Math.floor(ns / 1e6)).toISOString();
  }
  return '';
}

export function normalizeGlobalPreset(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return Number(s);
  if (/TURBO/i.test(s)) return 3;
  if (/REQUEST_REVIEW|REVIEW/i.test(s)) return 2;
  if (/AUTO|SAFE|DEFAULT/i.test(s)) return 1;
  if (/OFF|READ_ONLY|NONE/i.test(s)) return 0;
  return null;
}

export function normalizeSummaryStatus(sum) {
  if (!sum) return 'IDLE';
  if (sum.killed) return 'KILLED';
  if (Array.isArray(sum.waitingSteps) && sum.waitingSteps.length > 0) return 'WAITING';
  const s = sum.status;
  if (typeof s === 'string') {
    if (/RUNNING|IN_PROGRESS|ACTIVE/i.test(s)) return 'RUNNING';
    if (/CANCEL/i.test(s)) return 'CANCELED';
    if (/ERROR/i.test(s)) return 'ERROR';
    if (/WAIT/i.test(s)) return 'WAITING';
    return 'IDLE';
  }
  if (s === 2 || s === 3 || s === 4 || sum.notFullyIdle || sum.hasRunningSubagents) return 'RUNNING';
  return 'IDLE';
}

export function normalizeStepType(rawType, stepCase) {
  if (stepCase) {
    if (stepCase === 'userInput') return 'USER_INPUT';
    if (stepCase === 'plannerResponse') return 'PLANNER_RESPONSE';
    if (stepCase === 'errorMessage') return 'ERROR_MESSAGE';
    if (stepCase === 'systemMessage') return 'SYSTEM_MESSAGE';
    if (stepCase === 'checkpoint') return 'CHECKPOINT';
    if (stepCase === 'runCommand' || stepCase === 'generic') return 'TOOL_CALL';
  }
  if (rawType === 14) return 'USER_INPUT';
  if (rawType === 15) return 'PLANNER_RESPONSE';
  if (rawType === 17) return 'ERROR_MESSAGE';
  if (rawType === 23) return 'CHECKPOINT';
  if (rawType === 101) return 'SYSTEM_MESSAGE';
  if (rawType === 132) return 'TOOL_CALL';
  return typeof rawType === 'string' ? rawType : 'GENERIC';
}

export function normalizeStepStatus(rawStatus) {
  if (typeof rawStatus === 'string') return rawStatus.toUpperCase();
  switch (rawStatus) {
    case 1:
      return 'PENDING';
    case 2:
    case 8:
      return 'RUNNING';
    case 3:
      return 'DONE';
    case 4:
    case 7:
      return 'ERROR';
    case 5:
      return 'CLEARED';
    case 6:
      return 'CANCELED';
    default:
      return 'IDLE';
  }
}

export function normalizeAskQuestionList(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  const list = [];
  for (const q of rawQuestions) {
    if (!q || typeof q !== 'object') continue;
    const question = String(q.question || q.Question || '').trim();
    if (!question) continue;
    const isMultiSelect = Boolean(q.isMultiSelect || q.is_multi_select || q.IsMultiSelect);
    const rawOpts = Array.isArray(q.options) ? q.options : Array.isArray(q.Options) ? q.Options : [];
    const options = [];
    for (let idx = 0; idx < rawOpts.length; idx++) {
      const opt = rawOpts[idx];
      if (typeof opt === 'string') {
        if (opt.trim()) options.push({ id: String(idx + 1), text: opt });
      } else if (opt && typeof opt === 'object') {
        const text = String(opt.text || opt.Text || opt.id || opt.Id || '').trim();
        if (text) options.push({ id: String(opt.id || opt.Id || idx + 1), text });
      }
    }
    list.push({ question, isMultiSelect, options });
    if (list.length >= 12) break;
  }
  return list;
}

export function extractAskQuestionsFromStep(step) {
  if (!step || typeof step !== 'object') return [];
  const reqInt = step?.requestedInteraction?.interaction;
  if (reqInt?.case === 'askQuestion' && Array.isArray(reqInt.value?.questions)) {
    const parsed = normalizeAskQuestionList(reqInt.value.questions);
    if (parsed.length > 0) return parsed;
  }
  if (step?.step?.case === 'askQuestion' && Array.isArray(step.step.value?.questions)) {
    const parsed = normalizeAskQuestionList(step.step.value.questions);
    if (parsed.length > 0) return parsed;
  }
  const tc = step?.metadata?.toolCall || {};
  const rawTool = String(tc.name || step?.step?.case || '');
  const shortTool = rawTool.includes(':') ? rawTool.split(':').pop() : rawTool;
  const isAskTool = shortTool === 'ask_question' || shortTool === 'askQuestion' || reqInt?.case === 'askQuestion';
  if (!isAskTool) return [];
  const sources = [];
  if (typeof tc.argumentsJson === 'string' && tc.argumentsJson) sources.push(tc.argumentsJson);
  const args = step?.step?.value?.args;
  if (args && typeof args === 'object') {
    for (const k of ['questions', 'Questions', 'Arguments', 'ArgumentsJson']) {
      if (args[k] !== undefined) sources.push(args[k]);
    }
  }
  for (const src of sources) {
    try {
      const obj = typeof src === 'string' ? JSON.parse(src) : src;
      const arr = Array.isArray(obj) ? obj : Array.isArray(obj?.questions) ? obj.questions : null;
      const parsed = normalizeAskQuestionList(arr);
      if (parsed.length > 0) return parsed;
    } catch {}
  }
  return [];
}

export function normalizeWaitingSteps(cid, rawList) {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const out = [];
  for (let i = 0; i < rawList.length; i++) {
    const w = rawList[i];
    if (!w || typeof w !== 'object') continue;
    const step = w.step || w;
    const info = step?.metadata?.sourceTrajectoryStepInfo || {};
    const stepIndex = Number.isInteger(Number(w.stepIndex))
      ? Number(w.stepIndex)
      : Number.isInteger(Number(info.stepIndex))
        ? Number(info.stepIndex)
        : i;
    const trajectoryId = String(info.trajectoryId || '');
    const reqInt = step?.requestedInteraction?.interaction;
    const interactionCase = String(reqInt?.case || '');
    const permRes = reqInt?.value?.resource || null;
    const tc = step?.metadata?.toolCall || {};
    let argsObj = {};
    if (typeof tc.argumentsJson === 'string' && tc.argumentsJson) {
      try {
        argsObj = JSON.parse(tc.argumentsJson);
      } catch {}
    }
    const rawToolName = String(tc.name || step?.step?.case || '');
    const toolName = rawToolName.includes(':') ? rawToolName.split(':').pop() : rawToolName;
    const action = String(permRes?.action || step?.metadata?.toolAction || interactionCase || '');
    const commandLine = String(
      step?.step?.value?.commandLine ||
        reqInt?.value?.commandLine ||
        (action === 'command' ? permRes?.target : '') ||
        argsObj?.CommandLine ||
        argsObj?.command ||
        permRes?.target ||
        ''
    );
    const questions = extractAskQuestionsFromStep(step);
    const effectiveCase =
      interactionCase || (questions.length > 0 || toolName === 'ask_question' || toolName === 'askQuestion' ? 'askQuestion' : '');
    const item = {
      stepIndex,
      toolName,
      action,
      commandLine,
      trajectoryId,
      interactionCase: effectiveCase,
    };
    if (questions.length > 0) item.questions = questions;
    out.push(item);
  }
  return out;
}

export function normalizeSummaryItem(cid, sum) {
  const meta = sum.trajectoryMetadata || {};
  const title = String(sum.annotations?.title || sum.summary || cid).trim();
  const waitingSteps = normalizeWaitingSteps(cid, sum.waitingSteps);
  return {
    id: cid,
    title,
    summary: String(sum.summary || '').trim(),
    status: normalizeSummaryStatus(sum),
    stepCount: Number(sum.stepCount || 0),
    lastModifiedTime: toIsoTime(sum.lastModifiedTime),
    projectId: String(meta.projectId || sum.projectId || ''),
    parentConversationId: String(meta.parentConversationId || ''),
    waitingSteps,
  };
}

export function normalizeIndexKeys(idxCol) {
  if (!idxCol) return [];
  if (typeof idxCol.keys === 'function' && idxCol instanceof Set) return Array.from(idxCol);
  if (Array.isArray(idxCol)) return idxCol.slice();
  if (typeof idxCol === 'object') return Object.keys(idxCol).filter((k) => Boolean(idxCol[k]));
  return [];
}

export function normalizeByParent(byParent) {
  const out = {};
  if (!byParent || typeof byParent !== 'object') return out;
  for (const parentId of Object.keys(byParent)) {
    const rawChildren = byParent[parentId];
    if (!rawChildren) continue;
    if (Array.isArray(rawChildren)) out[parentId] = rawChildren.slice();
    else if (typeof rawChildren[Symbol.iterator] === 'function') out[parentId] = Array.from(rawChildren);
    else if (typeof rawChildren === 'object') out[parentId] = Object.keys(rawChildren);
  }
  return out;
}

export function computeSummarySig(item) {
  const wSig = item.waitingSteps
    .map((w) => `${w.trajectoryId}:${w.stepIndex}:${w.interactionCase}:${w.toolName}:${w.commandLine}`)
    .join(',');
  return `${item.status}|${item.stepCount}|${item.lastModifiedTime}|${item.title}|${item.parentConversationId}|${item.projectId}|${wSig}`;
}

export function extractStepRecord(s, idx) {
  const stepCase = s?.step?.case || '';
  const val = s?.step?.value || {};
  const type = normalizeStepType(s?.type, stepCase);
  const status = normalizeStepStatus(s?.status);
  const createdAt = toIsoTime(s?.metadata?.createdAt);
  let text = '';
  let thinking = '';
  const toolCalls = [];
  let mediaCount = 0;
  let mediaNames = null;

  if (stepCase === 'userInput' || type === 'USER_INPUT') {
    if (typeof val.userResponse === 'string' && val.userResponse) {
      text = val.userResponse;
    } else if (Array.isArray(val.items)) {
      text = val.items
        .filter((it) => it && it.chunk && it.chunk.case === 'text')
        .map((it) => it.chunk.value || '')
        .join('');
    }
    if (Array.isArray(val.media) && val.media.length > 0) {
      mediaCount = val.media.length;
      mediaNames = val.media
        .slice(0, 4)
        .map((m) => String(m?.description || m?.displayName || 'image').slice(0, 80));
    }
  } else if (stepCase === 'plannerResponse' || type === 'PLANNER_RESPONSE') {
    text = String(val.modifiedResponse || val.response || '');
    thinking = String(val.thinking || val.rawThinking || '');
    if (Array.isArray(val.toolCalls)) {
      for (const tc of val.toolCalls) {
        if (!tc) continue;
        const rawName = String(tc.name || '');
        toolCalls.push({
          id: String(tc.id || ''),
          name: rawName.includes(':') ? rawName.split(':').pop() : rawName,
          args: truncateStr(tc.argumentsJson || '', 4096),
        });
      }
    }
  } else if (stepCase === 'errorMessage' || type === 'ERROR_MESSAGE') {
    const errObj = val.error && typeof val.error === 'object' ? val.error : null;
    text = String(
      errObj?.userErrorMessage ||
        errObj?.shortError ||
        errObj?.fullError ||
        errObj?.message ||
        val.userMessage ||
        val.message ||
        s?.errorDetails?.message ||
        ''
    );
  } else if (stepCase === 'systemMessage' || type === 'SYSTEM_MESSAGE') {
    text = String(val.message || '');
  } else {
    const tc = s?.metadata?.toolCall || {};
    const rawName = String(tc.name || stepCase || '');
    const name = rawName.includes(':') ? rawName.split(':').pop() : rawName;
    const askQuestions = extractAskQuestionsFromStep(s);
    let outText =
      val?.combinedOutput?.full || val?.stdout || val?.result?.output || val?.result?.text || val?.commandLine || '';
    if (!outText && askQuestions.length > 0) {
      const completed = s?.completedInteraction?.interaction;
      const responses =
        completed?.case === 'askQuestion' && Array.isArray(completed.value?.responses)
          ? completed.value.responses
          : [];
      const lines = askQuestions.map((q, qIdx) => {
        const r = responses[qIdx];
        let ansText = '';
        if (r) {
          if (r.skipped) {
            ansText = '（已跳过）';
          } else {
            const selIds = Array.isArray(r.selectedOptionIds) ? r.selectedOptionIds.map(String) : [];
            const selLabels = selIds.map((id) => q.options.find((o) => o.id === id)?.text || id);
            if (r.writeInResponse) selLabels.push(String(r.writeInResponse));
            ansText = selLabels.join(' / ');
          }
        }
        return `${qIdx + 1}. ${q.question}${ansText ? `\n→ ${ansText}` : ''}`;
      });
      outText = lines.join('\n\n');
    }
    if (name || tc.id || outText) {
      toolCalls.push({
        id: String(tc.id || ''),
        name: name || 'tool',
        args: truncateStr(tc.argumentsJson || (val?.args ? JSON.stringify(toJsonSafe(val.args)) : ''), 4096),
        output: truncateStr(typeof outText === 'string' ? outText : JSON.stringify(toJsonSafe(outText)), 8192),
      });
    }
    if (typeof val?.commandLine === 'string' && val.commandLine) {
      text = val.commandLine;
    }
  }

  const fallbackErrObj =
    (stepCase === 'errorMessage' || type === 'ERROR_MESSAGE') && val.error && typeof val.error === 'object'
      ? val.error
      : null;
  const error = s?.errorDetails
    ? toJsonSafe(s.errorDetails)
    : fallbackErrObj
      ? toJsonSafe(fallbackErrObj)
      : text && (stepCase === 'errorMessage' || type === 'ERROR_MESSAGE')
        ? { message: truncateStr(text, 2048) }
        : null;
  return {
    idx,
    type,
    status,
    createdAt,
    text: truncateStr(text),
    thinking: truncateStr(thinking),
    toolCalls,
    ...(mediaCount > 0 ? { mediaCount, mediaNames } : {}),
    error,
  };
}

export async function computeWaitingStepHashAsync(cascadeId, step) {
  const stepIndex = Number(step?.stepIndex ?? 0);
  const trajectoryId = String(step?.trajectoryId || '');
  const interactionCase = String(step?.interactionCase || '');
  const toolName = String(step?.toolName || '');
  const action = String(step?.action || '');
  const commandLine = String(step?.commandLine || '');
  const raw = `${cascadeId}|${trajectoryId}|${stepIndex}|${interactionCase}|${toolName}|${action}|${commandLine}`;
  const subtle =
    (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) ||
    (typeof window !== 'undefined' && window.crypto?.subtle) ||
    null;
  if (!subtle || typeof TextEncoder === 'undefined') return '';
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export function isSafeNonTurboPreset(preset) {
  if (typeof preset === 'boolean' || preset === null || preset === undefined) return false;
  if (typeof preset === 'string' && !/^\d+$/.test(preset.trim())) return false;
  const n = Number(preset);
  return n === 1 || n === 2;
}

export function isTurboLikePreset(preset) {
  return !isSafeNonTurboPreset(preset);
}

export function sanitizeSlashCommands(rawList = []) {
  const defaultDescMap = new Map(DEFAULT_SLASH_COMMANDS.map((d) => [d.name, d.desc]));
  const out = [];
  const seen = new Set();
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const info = item.info && typeof item.info === 'object' ? item.info : item;
      const name = String(info.name || item.title || '').trim();
      if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const rawDesc = String(
        item.description || info.description || info.displayName || defaultDescMap.get(key) || ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      const numType = Number(info.type);
      const kind = numType === 1 || defaultDescMap.has(key) ? 'builtin' : 'skill';
      out.push({
        name,
        cmd: `/${name}`,
        desc: rawDesc || (kind === 'skill' ? '已安装技能' : '内置指令'),
        kind,
        trailingSpace: !NO_TRAILING_SPACE_CMDS.has(key),
      });
      if (out.length >= MAX_SLASH_COMMANDS) break;
    }
  }
  if (out.length === 0) {
    return DEFAULT_SLASH_COMMANDS.map((x) => ({ ...x }));
  }
  return out;
}

export function buildSlashCommandItems(slashInfo, rest = '', sep = ' ') {
  return [
    {
      $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
      chunk: {
        case: 'item',
        value: {
          $typeName: 'exa.codeium_common_pb.ContextScopeItem',
          scopeItem: {
            case: 'slashCommand',
            value: {
              $typeName: 'exa.codeium_common_pb.SlashCommandScopeItem',
              argumentValues: {},
              info: slashInfo,
            },
          },
        },
      },
    },
    {
      $typeName: 'exa.codeium_common_pb.TextOrScopeItem',
      chunk: {
        case: 'text',
        value: rest ? `${sep || ' '}${rest}` : ' ',
      },
    },
  ];
}

export function buildMessageItemsWithSlashCommands(text, slashList = []) {
  if (!text) return { items: [], matchedSlash: '' };
  const m = /^\s*\/([a-zA-Z0-9_-]{1,64})(?:(\s+)([\s\S]*))?$/.exec(text);
  if (m) {
    const wanted = m[1].toLowerCase();
    const sep = m[2] || '';
    const rest = m[3] || '';
    const list = Array.isArray(slashList) ? slashList : [];
    const slashDef = list.find((x) => {
      const name = String(x?.info?.name || x?.title || '').trim().toLowerCase();
      return name === wanted;
    });
    const resolvedInfo =
      slashDef && slashDef.info
        ? slashDef.info
        : wanted === 'compact'
          ? CANONICAL_COMPACT_SLASH_INFO
          : null;
    if (resolvedInfo) {
      const matchedName = String(resolvedInfo.name || m[1]);
      return {
        matchedSlash: matchedName,
        items: buildSlashCommandItems(resolvedInfo, rest, sep),
      };
    }
  }
  return {
    matchedSlash: '',
    items: [{ chunk: { case: 'text', value: text } }],
  };
}
