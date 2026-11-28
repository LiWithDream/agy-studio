/**
 * AGY Studio Remote Control — Sandboxed Read-Only Project Git Status & Diff Bridge
 * Strictly resolves repositories via authorized projectId or cascadeId worktree bindings.
 * Blocks sensitive repo files (.env*, *.pem, *.key, *secret*, *credential*, rc dotfiles, etc.),
 * git flag injection (--output=), textconv execution, symlink escapes, and oversized diffs.
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NATIVE_PROJECTS_DIR, UUID_RE, readJsonOrFallback } from '../env.mjs';
import { parseNumstatPerFile, parseNumstatZ } from '../git-exec.mjs';
import { isPathInsideDir, isSensitiveSourcePath } from '../projects.mjs';
import {
  collectAuthorizedWorktreeRootsAsync,
  extractNativeProjectFolderUris,
  getAuthorizedProjectDirs,
  getRealPathPreserveCase,
  loadConversationWorktreeMap,
  normalizeRealPath,
} from '../worktrees.mjs';

export const MAX_DIFF_BYTES = 64 * 1024;
export const MAX_DIRTY_FILES = 60;
export const MAX_COMMIT_FILES = 80;
export const MAX_RECENT_COMMITS = 8;

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const PROJECT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const SENSITIVE_BASENAME_RE =
  /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|id_ecdsa(?:\..*)?|notify\.json|devices\.json|local\.properties)$/i;
const SENSITIVE_EXT_RE = /\.(?:pem|key|p12|pfx|kdbx|jks|keystore)$/i;
const SENSITIVE_WORD_RE = /(?:secret|credential)/i;
const SENSITIVE_DIR_SEG_RE = /^(?:\.?secrets?|\.?credentials?|\.aws|\.ssh|\.gnupg)$/i;

export function isSensitiveRepoPath(relPath, absCandidate = '') {
  const norm = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!norm) return true;
  const segs = norm.split('/').filter(Boolean);
  if (segs.length === 0) return true;
  const base = segs[segs.length - 1];
  if (SENSITIVE_BASENAME_RE.test(base) || SENSITIVE_EXT_RE.test(base) || SENSITIVE_WORD_RE.test(base)) {
    return true;
  }
  for (const seg of segs.slice(0, -1)) {
    if (SENSITIVE_DIR_SEG_RE.test(seg)) return true;
  }
  if (absCandidate && isSensitiveSourcePath(absCandidate)) {
    return true;
  }
  return false;
}

function formatShortPath(absPath) {
  const s = String(absPath || '').trim();
  if (!s) return '';
  const home = os.homedir();
  if (home && (s === home || s.startsWith(`${home}${path.sep}`))) {
    return s === home ? '~' : `~${s.slice(home.length)}`;
  }
  return s;
}

function decodeFolderPath(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^file:\/\//i.test(s)) {
    try {
      let p = decodeURIComponent(new URL(s).pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      return p;
    } catch {
      return '';
    }
  }
  return s;
}

function execSafeGitAsync(absDir, args, { timeoutMs = 2500, maxBuffer = 512 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', absDir, '-c', 'core.fsmonitor=false', ...args],
      {
        timeout: timeoutMs,
        maxBuffer,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout) => {
        if (err) resolve(null);
        else resolve(String(stdout || ''));
      }
    );
  });
}

function buildAuthorizedProjectMap(opts = {}) {
  const nativeProjectsDir = opts.nativeProjectsDir || NATIVE_PROJECTS_DIR;
  const authorizedDirs = Array.isArray(opts.authorizedDirs)
    ? opts.authorizedDirs
    : getAuthorizedProjectDirs({ nativeProjectsDir });

  const nativeMetaByNorm = new Map();
  try {
    const entries = fs.readdirSync(nativeProjectsDir, { withFileTypes: true });
    for (const ent of entries) {
      if ((!ent.isFile() && !ent.isSymbolicLink()) || !ent.name.endsWith('.json')) continue;
      const rec = readJsonOrFallback(path.join(nativeProjectsDir, ent.name), null);
      if (!rec || typeof rec !== 'object') continue;
      const id = String(rec.id || ent.name.slice(0, -'.json'.length)).trim();
      const name = String(rec.name || rec.title || '').trim();
      const folders = extractNativeProjectFolderUris(rec);
      for (const rawFolder of folders) {
        const fsPath = decodeFolderPath(rawFolder);
        if (!fsPath) continue;
        const norm = normalizeRealPath(fsPath);
        if (!nativeMetaByNorm.has(norm)) {
          nativeMetaByNorm.set(norm, { id, name: name || path.basename(fsPath) || id });
        }
      }
    }
  } catch {}

  const byId = new Map();
  const normRoots = new Set();
  for (const dirPath of authorizedDirs) {
    const norm = normalizeRealPath(dirPath);
    if (!norm) continue;
    normRoots.add(norm);
    const meta = nativeMetaByNorm.get(norm) || null;
    const fallbackId = `proj-${crypto
      .createHash('sha256')
      .update(norm || String(dirPath || ''), 'utf8')
      .digest('hex')
      .slice(0, 12)}`;
    const id = meta?.id || fallbackId;
    const name = meta?.name || path.basename(norm) || 'Project';
    if (!byId.has(id)) {
      byId.set(id, { id, name, realPath: norm });
    }
  }
  return { byId, normRoots, authorizedDirs };
}

async function resolveAuthorizedRepoRoot({ projectId = '', cascadeId = '' } = {}, opts = {}) {
  const pid = typeof projectId === 'string' ? projectId.trim() : '';
  const cid = typeof cascadeId === 'string' ? cascadeId.trim() : '';
  if (pid && !PROJECT_ID_RE.test(pid)) {
    throw Object.assign(new Error('invalid_project_id'), { code: 'invalid_project_id' });
  }
  if (cid && !UUID_RE.test(cid)) {
    throw Object.assign(new Error('invalid_cascade_id'), { code: 'invalid_cascade_id' });
  }
  if (!pid && !cid) {
    throw Object.assign(new Error('project_or_cascade_required'), { code: 'project_or_cascade_required' });
  }

  const { byId, normRoots, authorizedDirs } = buildAuthorizedProjectMap(opts);

  let targetDir = '';
  let repoName = '';
  let resolvedProjectId = pid;

  const isExistingDir = (dirPath) => {
    if (!dirPath) return false;
    try {
      return fs.statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  };

  if (cid) {
    const convMap = loadConversationWorktreeMap(opts.convWtDir ? { convWtDir: opts.convWtDir } : undefined);
    const rec = convMap.entries?.[cid] || null;
    if (rec && typeof rec === 'object') {
      const wtCand = String(rec.worktreePath || '').trim();
      const rootCand = String(rec.repoRoot || '').trim();
      const candidate = isExistingDir(wtCand) ? wtCand : isExistingDir(rootCand) ? rootCand : '';
      if (candidate) {
        targetDir = candidate;
        repoName = path.basename(rootCand || candidate);
      }
    }
  }

  if (!targetDir && pid) {
    const hit = byId.get(pid);
    if (hit) {
      targetDir = hit.realPath;
      repoName = hit.name;
    }
  }

  if (!targetDir) {
    throw Object.assign(new Error('project_not_found'), { code: 'project_not_found' });
  }

  let realTarget = '';
  try {
    const st = fs.statSync(targetDir);
    if (!st.isDirectory()) {
      throw Object.assign(new Error('project_not_found'), { code: 'project_not_found' });
    }
    realTarget = normalizeRealPath(targetDir);
  } catch (err) {
    if (err?.code === 'project_not_found') throw err;
    throw Object.assign(new Error('project_not_found'), { code: 'project_not_found' });
  }

  // Authorize targetDir: must match an authorized project dir or one of its git worktrees.
  let authorized = normRoots.has(realTarget);
  if (!authorized) {
    for (const root of normRoots) {
      if (isPathInsideDir(root, realTarget)) {
        authorized = true;
        break;
      }
    }
  }
  if (!authorized) {
    const rawWtRoots = Array.isArray(opts.authorizedWorktreeRoots)
      ? opts.authorizedWorktreeRoots
      : await collectAuthorizedWorktreeRootsAsync('', {
          nativeProjectsDir: opts.nativeProjectsDir || NATIVE_PROJECTS_DIR,
          authorizedDirs,
        });
    const wtRoots = rawWtRoots.map((r) => normalizeRealPath(r));
    authorized = wtRoots.some((wt) => wt && (wt === realTarget || isPathInsideDir(wt, realTarget)));
  }
  if (!authorized) {
    throw Object.assign(new Error('project_not_authorized'), { code: 'project_not_authorized' });
  }

  const gitExec = opts.execSafeGitAsync || execSafeGitAsync;
  const topOut = await gitExec(realTarget, ['rev-parse', '--show-toplevel']);
  if (!topOut || !topOut.trim()) {
    throw Object.assign(new Error('not_a_git_repo'), { code: 'not_a_git_repo' });
  }
  const topTrimmed = topOut.trim();
  const repoRootReal = normalizeRealPath(topTrimmed);
  const displayRepoRoot = getRealPathPreserveCase(topTrimmed);
  // Ensure rev-parse --show-toplevel did not escape outside the authorized root/worktree
  const topAuthorized =
    repoRootReal === realTarget ||
    normRoots.has(repoRootReal) ||
    Array.from(normRoots).some((r) => isPathInsideDir(r, repoRootReal));
  if (!topAuthorized) {
    throw Object.assign(new Error('project_not_authorized'), { code: 'project_not_authorized' });
  }

  if (!resolvedProjectId) {
    for (const [id, meta] of byId.entries()) {
      if (meta.realPath === repoRootReal) {
        resolvedProjectId = id;
        if (!repoName) repoName = meta.name;
        break;
      }
    }
  }

  return {
    repoRootReal,
    projectId: resolvedProjectId,
    repoName: repoName || path.basename(displayRepoRoot || repoRootReal),
    shortPath: formatShortPath(displayRepoRoot || repoRootReal),
    gitExec,
  };
}

export function validateSafeRepoFilePath(repoRootReal, rawFilePath) {
  if (typeof rawFilePath !== 'string') {
    throw Object.assign(new Error('invalid_file_path'), { code: 'invalid_file_path' });
  }
  const trimmed = rawFilePath.trim();
  if (
    !trimmed ||
    trimmed.length > 512 ||
    trimmed.includes('\0') ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\') ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    throw Object.assign(new Error('invalid_file_path'), { code: 'invalid_file_path' });
  }
  const normRel = trimmed.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const segs = normRel.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) {
    throw Object.assign(new Error('invalid_file_path'), { code: 'invalid_file_path' });
  }

  const absCandidate = path.resolve(repoRootReal, normRel);
  if (!isPathInsideDir(repoRootReal, absCandidate)) {
    throw Object.assign(new Error('file_path_forbidden'), { code: 'file_path_forbidden' });
  }
  if (isSensitiveRepoPath(normRel, absCandidate)) {
    throw Object.assign(new Error('sensitive_file_blocked'), { code: 'sensitive_file_blocked' });
  }

  // Symlink & realpath containment check; handle deleted files (ENOENT) by verifying nearest existing ancestor
  let existsOnDisk = false;
  try {
    const lst = fs.lstatSync(absCandidate);
    if (lst.isSymbolicLink() || !lst.isFile()) {
      throw Object.assign(new Error('file_path_forbidden'), { code: 'file_path_forbidden' });
    }
    const realFile = fs.realpathSync(absCandidate);
    if (!isPathInsideDir(repoRootReal, realFile)) {
      throw Object.assign(new Error('file_path_forbidden'), { code: 'file_path_forbidden' });
    }
    existsOnDisk = true;
  } catch (err) {
    if (err?.code === 'file_path_forbidden' || err?.code === 'sensitive_file_blocked') throw err;
    if (err?.code !== 'ENOENT') {
      throw Object.assign(new Error('file_path_forbidden'), { code: 'file_path_forbidden' });
    }
    // Walk upward to verify nearest existing ancestor is inside repoRootReal (blocks symlinked parent dirs)
    let cur = path.dirname(absCandidate);
    while (cur && cur !== path.dirname(cur)) {
      try {
        const st = fs.lstatSync(cur);
        if (st.isSymbolicLink()) {
          throw Object.assign(new Error('file_path_forbidden'), { code: 'file_path_forbidden' });
        }
        const realCur = fs.realpathSync(cur);
        if (realCur !== repoRootReal && !isPathInsideDir(repoRootReal, realCur)) {
          throw Object.assign(new Error('file_path_forbidden'), { code: 'file_path_forbidden' });
        }
        break;
      } catch (ancErr) {
        if (ancErr?.code === 'file_path_forbidden') throw ancErr;
        if (ancErr?.code !== 'ENOENT') {
          throw Object.assign(new Error('file_path_forbidden'), { code: 'file_path_forbidden' });
        }
        if (cur === repoRootReal) break;
        cur = path.dirname(cur);
      }
    }
  }

  return { normRel, absCandidate, existsOnDisk };
}

function parsePorcelainWithRenames(porcelainZ, numstatMap, repoRootReal) {
  const files = [];
  if (!porcelainZ) return files;
  const entries = String(porcelainZ).split('\0');
  for (let i = 0; i < entries.length && files.length < MAX_DIRTY_FILES; i += 1) {
    const rec = entries[i];
    if (!rec || rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const filePath = rec.slice(3);
    if (!filePath) continue;
    let oldPath = '';
    if (xy.includes('R') || xy.includes('C')) {
      oldPath = entries[i + 1] || '';
      i += 1;
    }
    let status = 'M';
    if (xy === '??') status = '?';
    else if (xy.includes('D')) status = 'D';
    else if (xy.includes('A')) status = 'A';
    else if (xy.includes('R')) status = 'R';

    const absNew = path.resolve(repoRootReal, filePath);
    const absOld = oldPath ? path.resolve(repoRootReal, oldPath) : '';
    const sensitive =
      isSensitiveRepoPath(filePath, absNew) || (oldPath ? isSensitiveRepoPath(oldPath, absOld) : false);
    const stat = !sensitive ? numstatMap.get(filePath) || { added: 0, deleted: 0 } : { added: 0, deleted: 0 };
    files.push({
      path: filePath,
      ...(oldPath && !sensitive ? { oldPath } : {}),
      status,
      added: stat.added,
      deleted: stat.deleted,
      ...(sensitive ? { sensitive: true } : {}),
    });
  }
  return files;
}

function parseCommitNameStatusZ(rawZ, numstatMap, repoRootReal) {
  const files = [];
  if (!rawZ) return files;
  const parts = String(rawZ).split('\0');
  for (let i = 0; i < parts.length && files.length < MAX_COMMIT_FILES; i += 1) {
    const codeRaw = parts[i];
    if (!codeRaw) continue;
    const code = codeRaw.trim();
    const isRename = code.startsWith('R') || code.startsWith('C');
    const pathA = parts[i + 1] || '';
    const pathB = isRename ? parts[i + 2] || '' : '';
    i += isRename ? 2 : 1;
    const finalPath = isRename ? pathB : pathA;
    const oldPath = isRename ? pathA : '';
    if (!finalPath) continue;

    const absNew = path.resolve(repoRootReal, finalPath);
    const absOld = oldPath ? path.resolve(repoRootReal, oldPath) : '';
    const sensitive =
      isSensitiveRepoPath(finalPath, absNew) || (oldPath ? isSensitiveRepoPath(oldPath, absOld) : false);
    const stat = !sensitive ? numstatMap.get(finalPath) || { added: 0, deleted: 0 } : { added: 0, deleted: 0 };
    files.push({
      path: finalPath,
      ...(oldPath && !sensitive ? { oldPath } : {}),
      status: code[0] || 'M',
      added: stat.added,
      deleted: stat.deleted,
      ...(sensitive ? { sensitive: true } : {}),
    });
  }
  return files;
}

function truncateDiffText(raw, maxBytes = MAX_DIFF_BYTES) {
  const text = String(raw || '');
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) {
    return { diff: text, truncated: false, bytes: buf.length };
  }
  return {
    diff: buf.subarray(0, maxBytes).toString('utf8'),
    truncated: true,
    bytes: buf.length,
  };
}

function formatUntrackedFileDiff(normRel, absPath, maxBytes = MAX_DIFF_BYTES) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { diff: '', truncated: false, bytes: 0 };
    const toRead = Math.min(st.size, maxBytes + 1);
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const n = fs.readSync(fd, buf, offset, toRead - offset, offset);
      if (n <= 0) break;
      offset += n;
    }
    // Detect binary NUL byte
    const sample = buf.subarray(0, Math.min(offset, 4096));
    if (sample.includes(0)) {
      return {
        diff: `--- /dev/null\n+++ b/${normRel}\nBinary file (${st.size} bytes)\n`,
        truncated: false,
        bytes: st.size,
      };
    }
    const truncated = offset > maxBytes || st.size > maxBytes;
    const rawStr = buf.subarray(0, Math.min(offset, maxBytes)).toString('utf8');
    const lines = rawStr.split(/\r?\n/);
    const body = lines.map((l) => `+${l}`).join('\n');
    const header = `--- /dev/null\n+++ b/${normRel}\n@@ -0,0 +1,${lines.length} @@\n`;
    const full = `${header}${body}\n`;
    const res = truncateDiffText(full, maxBytes);
    return { diff: res.diff, truncated: truncated || res.truncated, bytes: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

export async function getRemoteProjectGitStatus(params = {}, opts = {}) {
  const ctx = await resolveAuthorizedRepoRoot(params, opts);
  const { repoRootReal, gitExec } = ctx;

  const [branchOut, aheadOut, porcelainZ, numstatHeadZ, numstatCachedZ, logOut] = await Promise.all([
    gitExec(repoRootReal, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitExec(repoRootReal, ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    gitExec(repoRootReal, ['status', '--porcelain=v1', '-z']),
    gitExec(repoRootReal, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', 'HEAD']),
    gitExec(repoRootReal, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--numstat', '-z']),
    gitExec(repoRootReal, ['log', `-n${MAX_RECENT_COMMITS}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI']),
  ]);

  const branch = String(branchOut || '').trim() || 'HEAD';
  let behind = 0;
  let ahead = 0;
  if (aheadOut) {
    const parts = aheadOut.trim().split(/\s+/);
    if (parts.length === 2) {
      behind = Number.parseInt(parts[0], 10) || 0;
      ahead = Number.parseInt(parts[1], 10) || 0;
    }
  }

  const numstatMap = parseNumstatPerFile(numstatHeadZ || numstatCachedZ || '');
  const dirtyFiles = parsePorcelainWithRenames(porcelainZ || '', numstatMap, repoRootReal);
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const f of dirtyFiles) {
    if (!f.sensitive) {
      totalAdded += f.added;
      totalDeleted += f.deleted;
    }
  }

  const commits = [];
  if (logOut) {
    for (const line of logOut.trim().split(/\r?\n/)) {
      if (!line) continue;
      const [hash, shortHash, subject, author, date] = line.split('\x1f');
      if (!hash || !COMMIT_HASH_RE.test(hash)) continue;
      commits.push({
        hash,
        shortHash: shortHash || hash.slice(0, 7),
        subject: String(subject || '').slice(0, 140),
        author: String(author || '').slice(0, 64),
        date: String(date || ''),
      });
    }
  }

  return {
    ok: true,
    projectId: ctx.projectId,
    repoName: ctx.repoName,
    shortPath: ctx.shortPath,
    branch,
    ahead,
    behind,
    dirtyCount: dirtyFiles.length,
    added: totalAdded,
    deleted: totalDeleted,
    dirtyFiles,
    commits,
  };
}

export async function getRemoteGitDiff(params = {}, opts = {}) {
  const ctx = await resolveAuthorizedRepoRoot(params, opts);
  const { repoRootReal, gitExec } = ctx;

  const commitHash = typeof params?.commitHash === 'string' ? params.commitHash.trim() : '';
  const rawFilePath = typeof params?.filePath === 'string' ? params.filePath.trim() : '';

  if (commitHash) {
    if (!COMMIT_HASH_RE.test(commitHash)) {
      throw Object.assign(new Error('invalid_commit_hash'), { code: 'invalid_commit_hash' });
    }
    const verifiedHash = await gitExec(repoRootReal, ['rev-parse', '--verify', `${commitHash}^{commit}`]);
    if (!verifiedHash || !COMMIT_HASH_RE.test(verifiedHash.trim())) {
      throw Object.assign(new Error('commit_not_found'), { code: 'commit_not_found' });
    }
    const fullHash = verifiedHash.trim();

    const [metaOut, nameStatusZ, numstatZ] = await Promise.all([
      gitExec(repoRootReal, ['show', '-s', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI', fullHash]),
      gitExec(repoRootReal, [
        'diff-tree',
        '-M',
        '--root',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-z',
        '--no-ext-diff',
        '--no-textconv',
        fullHash,
      ]),
      gitExec(repoRootReal, [
        'diff-tree',
        '-M',
        '--root',
        '--no-commit-id',
        '--numstat',
        '-r',
        '-z',
        '--no-ext-diff',
        '--no-textconv',
        fullHash,
      ]),
    ]);

    const numstatMap = new Map();
    for (const ent of parseNumstatZ(numstatZ || '')) {
      numstatMap.set(ent.path, { added: ent.added, deleted: ent.deleted });
    }
    const commitFiles = parseCommitNameStatusZ(nameStatusZ || '', numstatMap, repoRootReal);
    const [hash, shortHash, subject, author, date] = String(metaOut || '').trim().split('\x1f');

    // Commit-level summary without filePath: return sanitized file list only (never dump whole commit diff)
    if (!rawFilePath) {
      return {
        ok: true,
        mode: 'commit_files',
        projectId: ctx.projectId,
        repoName: ctx.repoName,
        commit: {
          hash: hash || fullHash,
          shortHash: shortHash || fullHash.slice(0, 7),
          subject: String(subject || '').slice(0, 140),
          author: String(author || '').slice(0, 64),
          date: String(date || ''),
        },
        files: commitFiles,
      };
    }

    // Per-file commit diff: validate path AND verify rename oldPath is not sensitive
    const safeFile = validateSafeRepoFilePath(repoRootReal, rawFilePath);
    const matchedCommitEntry = commitFiles.find((f) => f.path === safeFile.normRel);
    if (matchedCommitEntry?.sensitive) {
      throw Object.assign(new Error('sensitive_file_blocked'), { code: 'sensitive_file_blocked' });
    }
    const rawDiff = await gitExec(
      repoRootReal,
      ['show', '--format=', '--no-ext-diff', '--no-textconv', '-U3', fullHash, '--', safeFile.normRel],
      { maxBuffer: 512 * 1024 }
    );
    const { diff, truncated, bytes } = truncateDiffText(rawDiff || '', opts.maxDiffBytes || MAX_DIFF_BYTES);
    return {
      ok: true,
      mode: 'commit_file_diff',
      projectId: ctx.projectId,
      repoName: ctx.repoName,
      commitHash: fullHash,
      filePath: safeFile.normRel,
      diff,
      truncated,
      bytes,
    };
  }

  // Working tree diff requires a single validated filePath
  const safeFile = validateSafeRepoFilePath(repoRootReal, rawFilePath);
  const rawDiff = await gitExec(
    repoRootReal,
    ['diff', '--no-ext-diff', '--no-textconv', '-U3', 'HEAD', '--', safeFile.normRel],
    { maxBuffer: 512 * 1024 }
  );

  if (rawDiff && rawDiff.trim()) {
    const { diff, truncated, bytes } = truncateDiffText(rawDiff, opts.maxDiffBytes || MAX_DIFF_BYTES);
    return {
      ok: true,
      mode: 'worktree_diff',
      projectId: ctx.projectId,
      repoName: ctx.repoName,
      filePath: safeFile.normRel,
      diff,
      truncated,
      bytes,
    };
  }

  // Fallback for staged-only or untracked new files
  const stagedDiff = await gitExec(
    repoRootReal,
    ['diff', '--no-ext-diff', '--no-textconv', '--cached', '-U3', '--', safeFile.normRel],
    { maxBuffer: 512 * 1024 }
  );
  if (stagedDiff && stagedDiff.trim()) {
    const { diff, truncated, bytes } = truncateDiffText(stagedDiff, opts.maxDiffBytes || MAX_DIFF_BYTES);
    return {
      ok: true,
      mode: 'worktree_diff',
      projectId: ctx.projectId,
      repoName: ctx.repoName,
      filePath: safeFile.normRel,
      diff,
      truncated,
      bytes,
    };
  }

  if (safeFile.existsOnDisk) {
    const statusOut = await gitExec(repoRootReal, ['status', '--porcelain=v1', '--', safeFile.normRel]);
    if (statusOut && statusOut.trim().startsWith('??')) {
      const untracked = formatUntrackedFileDiff(safeFile.normRel, safeFile.absCandidate, opts.maxDiffBytes || MAX_DIFF_BYTES);
      return {
        ok: true,
        mode: 'worktree_diff',
        projectId: ctx.projectId,
        repoName: ctx.repoName,
        filePath: safeFile.normRel,
        diff: untracked.diff,
        truncated: untracked.truncated,
        bytes: untracked.bytes,
      };
    }
  }

  return {
    ok: true,
    mode: 'worktree_diff',
    projectId: ctx.projectId,
    repoName: ctx.repoName,
    filePath: safeFile.normRel,
    diff: '',
    truncated: false,
    bytes: 0,
  };
}
