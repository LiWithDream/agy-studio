/**
 * AGY Studio Remote Control — Read-Only Disk Fallback (SQLite + Transcript Tail + Byte Budget)
 * Pure leaf module; safe when no Electron/CDP host window is attached.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, HOME, STATE_DIR, UUID_RE, readJsonOrFallback } from '../env.mjs';
import { isPathInsideDir } from '../projects.mjs';
import {
  ensureRemoteDir as ensureSharedRemoteDir,
  getRemotePaths as getSharedRemotePaths,
} from '../../../remote/shared/fs-paths.mjs';

export const DEFAULT_REMOTE_CONFIG = Object.freeze({
  enabled: false,
  port: 18791,
  transport: 'loopback',
  allowedHosts: ['127.0.0.1'],
  allowedOrigins: [],
  cfAccessTeamDomain: '',
  cfAccessAud: '',
  tailscaleAllowedUsers: [],
  allowLocalPairingWithoutEdge: true
});

export const MAX_SNAPSHOT_STEPS = 200;
export const MAX_SNAPSHOT_BYTES = Math.floor(1.5 * 1024 * 1024);
export const MAX_TRANSCRIPT_TAIL_BYTES = 512 * 1024;
export const MAX_FIELD_CHARS = 16384;

export function resolveRemotePaths(env = process.env) {
  const effectiveEnv = env?.ANTI_CLAUDE_STATE_DIR ? env : { ...env, ANTI_CLAUDE_STATE_DIR: STATE_DIR };
  const { remoteDir, configFile, sockPath } = getSharedRemotePaths(null, null, { env: effectiveEnv });
  return { remoteDir, configFile, sockPath };
}

export function ensureRemoteDir(remoteDir) {
  return ensureSharedRemoteDir(remoteDir, 0o700);
}

export function truncateText(val, max = MAX_FIELD_CHARS) {
  const s = String(val ?? '');
  if (s.length <= max) return s;
  const prefix = '…(truncated)\n';
  const keep = Math.max(256, max - prefix.length);
  return `${prefix}${s.slice(-keep)}`;
}

export function normalizeGlobalPresetValue(raw) {
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

export function readDiskGlobalPreset(configPath = path.join(HOME, '.gemini', 'config', 'config.json')) {
  const cfg = readJsonOrFallback(configPath, null);
  const us = cfg && typeof cfg === 'object' ? cfg.userSettings || cfg : null;
  if (!us || typeof us !== 'object') return null;
  const raw = us.globalPreset ?? us.permissionPreset ?? null;
  return normalizeGlobalPresetValue(raw);
}

export function computeWaitingStepHash(cascadeId, step) {
  const stepIndex = Number(step?.stepIndex ?? 0);
  const trajectoryId = String(step?.trajectoryId || '');
  const interactionCase = String(step?.interactionCase || '');
  const toolName = String(step?.toolName || '');
  const action = String(step?.action || '');
  const commandLine = String(step?.commandLine || '');
  return crypto
    .createHash('sha256')
    .update(`${cascadeId}|${trajectoryId}|${stepIndex}|${interactionCase}|${toolName}|${action}|${commandLine}`)
    .digest('hex')
    .slice(0, 16);
}

export function normalizeWaitingStepsWithSha(cascadeId, list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.map((w) => {
    const item = {
      stepIndex: Number(w?.stepIndex ?? 0),
      waitingStepHash: computeWaitingStepHash(cascadeId, w),
      toolName: String(w?.toolName || ''),
      action: String(w?.action || ''),
      commandLine: String(w?.commandLine || ''),
      trajectoryId: String(w?.trajectoryId || ''),
      interactionCase: String(w?.interactionCase || '')
    };
    if (Array.isArray(w?.questions) && w.questions.length > 0) {
      item.questions = w.questions;
    }
    return item;
  });
}

function parsePbMap(buf) {
  const bytes = buf instanceof Uint8Array ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : Buffer.alloc(0);
  const fields = new Map();
  let i = 0;
  const readVarint = () => {
    let val = 0n;
    let shift = 0n;
    const start = i;
    while (i < bytes.length && i - start < 10) {
      const b = bytes[i++];
      val |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return Number(val);
      shift += 7n;
    }
    return 0;
  };
  while (i < bytes.length) {
    const tag = readVarint();
    if (!tag) break;
    const fn = tag >>> 3;
    const wt = tag & 7;
    if (fn === 0) break;
    if (!fields.has(fn)) fields.set(fn, []);
    if (wt === 0) {
      fields.get(fn).push(readVarint());
    } else if (wt === 2) {
      const len = readVarint();
      if (len < 0 || i + len > bytes.length) break;
      fields.get(fn).push(bytes.subarray(i, i + len));
      i += len;
    } else if (wt === 5) {
      if (i + 4 > bytes.length) break;
      fields.get(fn).push(bytes.subarray(i, i + 4));
      i += 4;
    } else if (wt === 1) {
      if (i + 8 > bytes.length) break;
      fields.get(fn).push(bytes.subarray(i, i + 8));
      i += 8;
    } else {
      break;
    }
  }
  return fields;
}

function asUtf8(val) {
  if (!(val instanceof Uint8Array)) return '';
  return Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('utf8');
}

function decodeProtoTimestamp(buf) {
  if (!(buf instanceof Uint8Array)) return '';
  const m = parsePbMap(buf);
  const sec = m.get(1)?.[0];
  const ns = m.get(2)?.[0] || 0;
  if (!Number.isFinite(sec) || sec <= 0) return '';
  return new Date(sec * 1000 + Math.floor(ns / 1e6)).toISOString();
}

function openReadOnlySqlite(dbPath) {
  if (!DatabaseSync) return null;
  const walSt = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false });
  const hasActiveWal = Boolean(walSt && walSt.size > 0);
  let location = dbPath;
  if (!hasActiveWal) {
    location = pathToFileURL(dbPath);
    location.searchParams.set('immutable', '1');
  }
  const db = new DatabaseSync(location, { readOnly: true, timeout: 150 });
  if (hasActiveWal) {
    try {
      db.exec('PRAGMA busy_timeout = 150');
    } catch {}
  }
  return db;
}

function normalizeDiskDatetime(raw) {
  const s = String(raw || '').trim();
  if (!s || s.startsWith('0001-01-01')) return '';
  const isoCandidate = s.includes('T') ? s : s.replace(' ', 'T');
  const d = new Date(isoCandidate);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function mapDiskSummaryStatus(row) {
  if (Number(row?.killed) === 1) return 'KILLED';
  const raw = String(row?.status || '');
  if (Number(row?.not_fully_idle) === 1 || /RUNNING|IN_PROGRESS|ACTIVE/i.test(raw)) return 'RUNNING';
  if (/CANCEL/i.test(raw)) return 'CANCELED';
  if (/ERROR/i.test(raw)) return 'ERROR';
  return 'IDLE';
}

function mapDiskStepType(stepType, txType = '') {
  if (stepType === 14) return 'USER_INPUT';
  if (stepType === 15) return 'PLANNER_RESPONSE';
  if (stepType === 17) return 'ERROR_MESSAGE';
  if (stepType === 23) return 'CHECKPOINT';
  if (stepType === 101) return 'SYSTEM_MESSAGE';
  if (stepType === 132) return 'TOOL_CALL';
  return txType || 'GENERIC';
}

function mapDiskStepStatus(status, txStatus = '') {
  switch (status) {
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
      return txStatus || 'IDLE';
  }
}

export function readConversationListFromDisk({
  includeSubagents = false,
  antigravityDir = path.join(HOME, '.gemini', 'antigravity'),
  agConfigPath = path.join(HOME, '.gemini', 'config', 'config.json')
} = {}) {
  const globalPreset = readDiskGlobalPreset(agConfigPath);
  if (!DatabaseSync) {
    return { source: 'disk', globalPreset, conversations: [] };
  }
  const sumDbPath = path.join(antigravityDir, 'conversation_summaries.db');
  if (!isPathInsideDir(antigravityDir, sumDbPath) || !fs.existsSync(sumDbPath)) {
    return { source: 'disk', globalPreset, conversations: [] };
  }

  let db = null;
  try {
    db = openReadOnlySqlite(sumDbPath);
    if (!db) return { source: 'disk', globalPreset, conversations: [] };
    const rows = db
      .prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time, status, project_id, agent_name, parent_conversation_id, not_fully_idle, killed
         FROM conversation_summaries
         ORDER BY last_modified_time DESC
         LIMIT 250`
      )
      .all();
    const conversations = [];
    for (const row of rows) {
      const id = String(row.conversation_id || '');
      if (!UUID_RE.test(id)) continue;
      const parentConversationId = String(row.parent_conversation_id || '');
      if (!includeSubagents && parentConversationId) continue;
      const title = String(row.title || row.preview || id).trim();
      conversations.push({
        id,
        title,
        summary: String(row.preview || row.title || '').trim(),
        status: mapDiskSummaryStatus(row),
        stepCount: Number(row.step_count || 0),
        lastModifiedTime: normalizeDiskDatetime(row.last_modified_time),
        projectId: String(row.project_id || ''),
        parentConversationId,
        waitingSteps: []
      });
    }
    return { source: 'disk', globalPreset, conversations };
  } catch {
    return { source: 'disk', globalPreset, conversations: [] };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

function readTranscriptTailMap(transcriptPath, maxTailBytes = MAX_TRANSCRIPT_TAIL_BYTES) {
  const map = new Map();
  let st = null;
  try {
    st = fs.statSync(transcriptPath, { throwIfNoEntry: false });
  } catch {}
  if (!st || !st.isFile() || st.size === 0) return map;

  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const readSize = Math.min(st.size, maxTailBytes);
    const offset = st.size - readSize;
    const buf = Buffer.allocUnsafe(readSize);
    let totalRead = 0;
    while (totalRead < readSize) {
      const n = fs.readSync(fd, buf, totalRead, readSize - totalRead, offset + totalRead);
      if (n <= 0) break;
      totalRead += n;
    }
    let raw = buf.subarray(0, totalRead).toString('utf8');
    if (offset > 0) {
      const firstNl = raw.indexOf('\n');
      raw = firstNl !== -1 ? raw.slice(firstNl + 1) : '';
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (Number.isInteger(obj?.step_index)) {
          map.set(obj.step_index, obj);
        }
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return map;
}

function decodeProtoStepFields(row) {
  const metaMap = row.metadata ? parsePbMap(row.metadata) : new Map();
  const payloadMap = row.step_payload ? parsePbMap(row.step_payload) : new Map();
  const createdAt = decodeProtoTimestamp(metaMap.get(1)?.[0]);
  let text = '';
  let thinking = '';
  const toolCalls = [];

  if (row.step_type === 14) {
    const f19 = payloadMap.get(19)?.[0];
    if (f19 instanceof Uint8Array) {
      const m19 = parsePbMap(f19);
      const userResp = asUtf8(m19.get(2)?.[0]);
      if (userResp) {
        text = userResp;
      } else {
        const parts = [];
        for (const itemBuf of m19.get(12) || []) {
          const itemMap = parsePbMap(itemBuf);
          const txt = asUtf8(itemMap.get(1)?.[0]);
          if (txt) parts.push(txt);
        }
        text = parts.join('');
      }
    }
  } else if (row.step_type === 15) {
    const f20 = payloadMap.get(20)?.[0];
    if (f20 instanceof Uint8Array) {
      const m20 = parsePbMap(f20);
      text = asUtf8(m20.get(8)?.[0]) || asUtf8(m20.get(1)?.[0]);
      thinking = asUtf8(m20.get(3)?.[0]);
      for (const tcBuf of m20.get(7) || []) {
        const tcMap = parsePbMap(tcBuf);
        const name = asUtf8(tcMap.get(2)?.[0]);
        if (!name) continue;
        toolCalls.push({
          id: asUtf8(tcMap.get(1)?.[0]),
          name: name.includes(':') ? name.split(':').pop() : name,
          args: truncateText(asUtf8(tcMap.get(3)?.[0]), 4096)
        });
      }
    }
  } else if (row.step_type === 132) {
    const tcBuf = metaMap.get(4)?.[0];
    const tcMap = tcBuf instanceof Uint8Array ? parsePbMap(tcBuf) : new Map();
    const rawName = asUtf8(tcMap.get(2)?.[0]);
    const f140 = payloadMap.get(140)?.[0];
    const m140 = f140 instanceof Uint8Array ? parsePbMap(f140) : new Map();
    const outBuf = m140.get(2)?.[0];
    const mOut = outBuf instanceof Uint8Array ? parsePbMap(outBuf) : new Map();
    const output = asUtf8(mOut.get(1)?.[0]) || asUtf8(mOut.get(3)?.[0]);
    if (rawName || output) {
      toolCalls.push({
        id: asUtf8(tcMap.get(1)?.[0]),
        name: rawName.includes(':') ? rawName.split(':').pop() : rawName || 'tool',
        args: truncateText(asUtf8(tcMap.get(3)?.[0]), 4096),
        output: truncateText(output, 8192)
      });
    }
  } else if (row.step_type === 17) {
    const f24 = payloadMap.get(24)?.[0];
    if (f24 instanceof Uint8Array) {
      const m24 = parsePbMap(f24);
      const f3 = m24.get(3)?.[0];
      if (f3 instanceof Uint8Array) {
        const m3 = parsePbMap(f3);
        text = asUtf8(m3.get(2)?.[0]) || asUtf8(m3.get(1)?.[0]) || asUtf8(m3.get(3)?.[0]);
      }
      if (!text) {
        text = asUtf8(m24.get(2)?.[0]) || asUtf8(m24.get(1)?.[0]);
      }
    }
    if (!text) text = asUtf8(row.error_details);
  }

  let error = null;
  if (row.error_details && row.error_details.length > 0) {
    const errMap = parsePbMap(row.error_details);
    const msg = asUtf8(errMap.get(1)?.[0]) || asUtf8(errMap.get(2)?.[0]) || asUtf8(row.error_details);
    if (msg) error = { message: truncateText(msg, 2048) };
  }
  if (!error && text && row.step_type === 17) {
    error = { message: truncateText(text, 2048) };
  }

  return { createdAt, text, thinking, toolCalls, error };
}

function normalizeTranscriptToolCalls(rawList) {
  if (!Array.isArray(rawList)) return [];
  return rawList.map((tc) => ({
    id: String(tc?.id || ''),
    name: String(tc?.name || 'tool'),
    args: truncateText(typeof tc?.args === 'string' ? tc.args : JSON.stringify(tc?.args ?? {}), 4096)
  }));
}

export function applySnapshotByteBudget(snapshot, maxBytes = MAX_SNAPSHOT_BYTES) {
  if (!snapshot || !Array.isArray(snapshot.steps)) return snapshot;
  const out = {
    ...snapshot,
    streamingText: snapshot.streamingText ? truncateText(snapshot.streamingText, 64 * 1024) : ''
  };
  const steps = out.steps.map((s) => ({
    ...s,
    toolCalls: Array.isArray(s.toolCalls) ? s.toolCalls.map((tc) => ({ ...tc })) : []
  }));
  out.steps = steps;
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') <= maxBytes) return out;

  const recentPreserve = 10;
  const trimOlderEnd = Math.max(0, steps.length - recentPreserve);
  for (let i = 0; i < trimOlderEnd; i++) {
    const s = steps[i];
    if (s.thinking) s.thinking = '';
    for (const tc of s.toolCalls) {
      if (tc.output && tc.output.length > 512) tc.output = truncateText(tc.output, 512);
      if (tc.args && tc.args.length > 512) tc.args = truncateText(tc.args, 512);
    }
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') <= maxBytes) return out;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (i < steps.length - 1 && s.thinking) s.thinking = '';
    if (i < trimOlderEnd && s.text && s.text.length > 1024) s.text = truncateText(s.text, 1024);
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') <= maxBytes) return out;

  while (steps.length > 1 && Buffer.byteLength(JSON.stringify(out), 'utf8') > maxBytes) {
    steps.shift();
    out.hasMore = true;
  }
  if (out.hasMore && steps.length > 0) {
    out.nextBeforeIdx = steps[0].idx;
  }
  return out;
}

export function readConversationSnapshotFromDisk(
  cascadeId,
  { antigravityDir = path.join(HOME, '.gemini', 'antigravity'), beforeIdx = null } = {}
) {
  if (!UUID_RE.test(String(cascadeId || ''))) {
    return { ok: false, error: 'invalid_cascade_id' };
  }
  const hasBefore = Number.isInteger(beforeIdx) && beforeIdx >= 0;
  const convDir = path.join(antigravityDir, 'conversations');
  const brainDir = path.join(antigravityDir, 'brain');
  const dbPath = path.join(convDir, `${cascadeId}.db`);
  const transcriptPath = path.join(brainDir, cascadeId, '.system_generated', 'logs', 'transcript.jsonl');
  const safeDb = isPathInsideDir(convDir, dbPath) && fs.existsSync(dbPath);
  const safeTx = isPathInsideDir(brainDir, transcriptPath) && fs.existsSync(transcriptPath);
  const txMap = safeTx ? readTranscriptTailMap(transcriptPath) : new Map();

  let steps = [];
  let status = 'IDLE';
  let hasMore = false;

  if (safeDb && DatabaseSync) {
    let db = null;
    try {
      db = openReadOnlySqlite(dbPath);
      if (db) {
        const rows = hasBefore
          ? db
              .prepare(
                'SELECT idx, step_type, status, metadata, error_details, step_payload FROM steps WHERE idx < ? ORDER BY idx DESC LIMIT ?'
              )
              .all(beforeIdx, MAX_SNAPSHOT_STEPS + 1)
          : db
              .prepare(
                'SELECT idx, step_type, status, metadata, error_details, step_payload FROM steps ORDER BY idx DESC LIMIT ?'
              )
              .all(MAX_SNAPSHOT_STEPS + 1);
        hasMore = rows.length > MAX_SNAPSHOT_STEPS;
        const slice = (hasMore ? rows.slice(0, MAX_SNAPSHOT_STEPS) : rows).reverse();
        steps = slice.map((row) => {
          const tx = txMap.get(row.idx);
          const pb = decodeProtoStepFields(row);
          const normStatus = mapDiskStepStatus(row.status, tx?.status);
          const useTx = Boolean(tx && (normStatus === 'DONE' || pb.text === ''));
          const text = useTx && typeof tx.content === 'string' ? tx.content : pb.text || (typeof tx?.content === 'string' ? tx.content : '');
          const thinking =
            useTx && typeof tx.thinking === 'string' ? tx.thinking : pb.thinking || (typeof tx?.thinking === 'string' ? tx.thinking : '');
          const toolCalls =
            Array.isArray(tx?.tool_calls) && tx.tool_calls.length > 0
              ? normalizeTranscriptToolCalls(tx.tool_calls)
              : pb.toolCalls;
          return {
            idx: Number(row.idx),
            type: mapDiskStepType(row.step_type, tx?.type),
            status: normStatus,
            createdAt: tx?.created_at || pb.createdAt || '',
            text: truncateText(text),
            thinking: truncateText(thinking),
            toolCalls,
            error: pb.error
          };
        });
      }
    } catch {
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  if (steps.length === 0 && txMap.size > 0) {
    let entries = Array.from(txMap.values()).sort((a, b) => a.step_index - b.step_index);
    if (hasBefore) entries = entries.filter((tx) => tx.step_index < beforeIdx);
    hasMore = entries.length > MAX_SNAPSHOT_STEPS;
    const slice = hasMore ? entries.slice(-MAX_SNAPSHOT_STEPS) : entries;
    steps = slice.map((tx) => ({
      idx: Number(tx.step_index),
      type: String(tx.type || 'GENERIC'),
      status: String(tx.status || 'DONE'),
      createdAt: String(tx.created_at || ''),
      text: truncateText(tx.content || ''),
      thinking: truncateText(tx.thinking || ''),
      toolCalls: normalizeTranscriptToolCalls(tx.tool_calls),
      error: null
    }));
  }

  const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
  if (lastStep && (lastStep.status === 'RUNNING' || lastStep.status === 'PENDING')) {
    status = 'RUNNING';
  }

  return applySnapshotByteBudget({
    cascadeId,
    source: 'disk',
    status,
    steps,
    hasMore,
    nextBeforeIdx: hasMore && steps.length > 0 ? steps[0].idx : null,
    waitingSteps: [],
    streamingText: ''
  });
}
