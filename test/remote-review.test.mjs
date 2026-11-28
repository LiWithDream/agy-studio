/**
 * AGY Studio Remote Control — Phase 0 & Phase 1 Security, Artifact Reader, Git Diff & UX Tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');

function runGit(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'AGY Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'AGY Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    },
  }).trim();
}

test('artifacts-bridge: lists/reads Markdown artifacts safely, blocks traversal/symlinks/non-md, truncates at cap', async () => {
  const mod = await import(pathToFileURL(path.join(REPO, 'core/daemon/remote/artifacts-bridge.mjs')).href);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-art-'));
  try {
    const brainDir = path.join(tmpRoot, 'brain');
    const cid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const convoDir = path.join(brainDir, cid);
    const outsideDir = path.join(tmpRoot, 'outside');
    fs.mkdirSync(convoDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });

    fs.writeFileSync(path.join(convoDir, 'implementation_plan.md'), '# Next Phase Plan\n\nBody text.\n', 'utf8');
    fs.writeFileSync(path.join(convoDir, 'walkthrough.md'), '# Walkthrough\n\nAll green.\n', 'utf8');
    fs.writeFileSync(path.join(convoDir, 'notes.txt'), 'not markdown', 'utf8');
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), '# SECRET\nleaked\n', 'utf8');
    try {
      fs.symlinkSync(path.join(outsideDir, 'secret.md'), path.join(convoDir, 'escape.md'));
    } catch {}

    const listRes = mod.listConversationArtifacts(cid, { brainDir });
    assert.equal(listRes.ok, true);
    assert.deepEqual(
      listRes.artifacts.map((a) => a.name),
      ['implementation_plan.md', 'walkthrough.md']
    );
    assert.equal(listRes.artifacts[0].kind, 'plan');
    assert.equal(listRes.artifacts[0].title, 'Next Phase Plan');
    assert.equal(listRes.artifacts[1].kind, 'walkthrough');

    const readOk = mod.readConversationArtifact(cid, 'implementation_plan.md', { brainDir });
    assert.equal(readOk.ok, true);
    assert.equal(readOk.truncated, false);
    assert.match(readOk.content, /Next Phase Plan/);

    // Truncation enforcement
    fs.writeFileSync(path.join(convoDir, 'big.md'), `# Big\n${'x'.repeat(2048)}`, 'utf8');
    const readTrunc = mod.readConversationArtifact(cid, 'big.md', { brainDir, maxBytes: 256 });
    assert.equal(readTrunc.truncated, true);
    assert.equal(Buffer.byteLength(readTrunc.content, 'utf8'), 256);

    // Traversal, non-md, symlink, invalid cid
    assert.throws(() => mod.readConversationArtifact(cid, '../outside/secret.md', { brainDir }), /invalid_artifact_name/);
    assert.throws(() => mod.readConversationArtifact(cid, 'notes.txt', { brainDir }), /invalid_artifact_name/);
    assert.throws(() => mod.readConversationArtifact('not-a-uuid', 'implementation_plan.md', { brainDir }), /invalid_cascade_id/);
    if (fs.existsSync(path.join(convoDir, 'escape.md'))) {
      assert.throws(() => mod.readConversationArtifact(cid, 'escape.md', { brainDir }), /artifact_path_forbidden/);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('git-bridge: enforces repo secret denylist, git flag injection defense, deleted-file ENOENT ancestor check & commit rename filtering', async () => {
  const mod = await import(pathToFileURL(path.join(REPO, 'core/daemon/remote/git-bridge.mjs')).href);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-gitb-'));
  try {
    // 1. Sensitive path classifier unit checks
    for (const bad of [
      '.env',
      '.env.local',
      'config/.env.production',
      'certs/server.pem',
      'tls/private.key',
      'android/release.keystore',
      'foo/my_secret_config.json',
      'credentials.yaml',
      '.npmrc',
      '.netrc',
      '.pypirc',
      '.git-credentials',
      'id_rsa',
      'id_ed25519.pub',
      'notify.json',
      'local.properties',
      '.aws/config',
    ]) {
      assert.equal(mod.isSensitiveRepoPath(bad), true, `expected sensitive: ${bad}`);
    }
    for (const ok of ['src/app.mjs', 'src/token-counter.mjs', 'README.md', 'package.json']) {
      assert.equal(mod.isSensitiveRepoPath(ok), false, `expected non-sensitive: ${ok}`);
    }

    // 2. Real local git repo tests
    const repoDir = path.join(tmpRoot, 'demo-repo');
    const nativeProjectsDir = path.join(tmpRoot, 'native-projects');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(nativeProjectsDir, { recursive: true });
    fs.writeFileSync(
      path.join(nativeProjectsDir, 'proj-demo.json'),
      JSON.stringify({ id: 'proj-demo', name: 'Demo Repo', folderUris: [pathToFileURL(repoDir).href] }),
      'utf8'
    );

    runGit(repoDir, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(repoDir, 'app.mjs'), 'export const v = 1;\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, 'gone.mjs'), 'export const old = true;\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.env'), 'API_KEY=super-secret-value\n', 'utf8');
    runGit(repoDir, ['add', 'app.mjs', 'gone.mjs', '.env']);
    runGit(repoDir, ['commit', '-m', 'init']);

    // Commit 2: rename .env -> harmless.txt + edit app.mjs
    runGit(repoDir, ['mv', '.env', 'harmless.txt']);
    fs.writeFileSync(path.join(repoDir, 'app.mjs'), 'export const v = 2;\n', 'utf8');
    runGit(repoDir, ['add', 'app.mjs']);
    runGit(repoDir, ['commit', '-m', 'rename env and bump app']);
    const renameCommit = runGit(repoDir, ['rev-parse', 'HEAD']);

    // Working tree: modify app.mjs, delete gone.mjs, add untracked new.mjs & .env.local
    fs.writeFileSync(path.join(repoDir, 'app.mjs'), 'export const v = 3;\n', 'utf8');
    fs.rmSync(path.join(repoDir, 'gone.mjs'));
    fs.writeFileSync(path.join(repoDir, 'new.mjs'), 'export const added = 42;\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.env.local'), 'TOKEN=dont-leak\n', 'utf8');

    const opts = { nativeProjectsDir, authorizedDirs: [repoDir] };
    const status = await mod.getRemoteProjectGitStatus({ projectId: 'proj-demo' }, opts);
    assert.equal(status.ok, true);
    assert.equal(status.branch, 'main');
    const envEntry = status.dirtyFiles.find((f) => f.path === '.env.local');
    assert.equal(envEntry?.sensitive, true);
    assert.ok(status.dirtyFiles.find((f) => f.path === 'app.mjs'));
    assert.ok(status.dirtyFiles.find((f) => f.path === 'gone.mjs' && f.status === 'D'));

    // Working tree diff for normal, deleted (ENOENT), and untracked files
    const diffApp = await mod.getRemoteGitDiff({ projectId: 'proj-demo', filePath: 'app.mjs' }, opts);
    assert.equal(diffApp.ok, true);
    assert.match(diffApp.diff, /-export const v = 2;/);
    assert.match(diffApp.diff, /\+export const v = 3;/);

    const diffDeleted = await mod.getRemoteGitDiff({ projectId: 'proj-demo', filePath: 'gone.mjs' }, opts);
    assert.equal(diffDeleted.ok, true);
    assert.match(diffDeleted.diff, /-export const old = true;/);

    const diffNew = await mod.getRemoteGitDiff({ projectId: 'proj-demo', filePath: 'new.mjs' }, opts);
    assert.equal(diffNew.ok, true);
    assert.match(diffNew.diff, /\+export const added = 42;/);

    // Block sensitive file, flag injection, traversal, bad commit hash
    await assert.rejects(
      () => mod.getRemoteGitDiff({ projectId: 'proj-demo', filePath: '.env.local' }, opts),
      /sensitive_file_blocked/
    );
    await assert.rejects(
      () => mod.getRemoteGitDiff({ projectId: 'proj-demo', filePath: '--output=/tmp/pwn' }, opts),
      /invalid_file_path/
    );
    await assert.rejects(
      () => mod.getRemoteGitDiff({ projectId: 'proj-demo', filePath: '../outside.txt' }, opts),
      /invalid_file_path/
    );
    await assert.rejects(
      () => mod.getRemoteGitDiff({ projectId: 'proj-demo', commitHash: '--output=/tmp/pwn' }, opts),
      /invalid_commit_hash/
    );

    // Commit file list strips sensitive rename (.env -> harmless.txt) and blocks diffing it!
    const commitList = await mod.getRemoteGitDiff({ projectId: 'proj-demo', commitHash: renameCommit }, opts);
    assert.equal(commitList.mode, 'commit_files');
    const renamedEntry = commitList.files.find((f) => f.path === 'harmless.txt');
    assert.equal(renamedEntry?.sensitive, true, 'rename from .env must be marked sensitive');
    await assert.rejects(
      () => mod.getRemoteGitDiff({ projectId: 'proj-demo', commitHash: renameCommit, filePath: 'harmless.txt' }, opts),
      /sensitive_file_blocked/
    );

    // Normal file inside the same commit IS readable
    const commitAppDiff = await mod.getRemoteGitDiff(
      { projectId: 'proj-demo', commitHash: renameCommit, filePath: 'app.mjs' },
      opts
    );
    assert.equal(commitAppDiff.ok, true);
    assert.match(commitAppDiff.diff, /\+export const v = 2;/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 0 helpers & PWA search/slashCommands: cold-start compact fallback, dynamic skills & branch/project search', async () => {
  const helpers = await import(pathToFileURL(path.join(REPO, 'user/src/modules/remote-tap-helpers.mjs')).href);
  const uiHelpers = await import(pathToFileURL(path.join(REPO, 'remote/pwa/src/ui-helpers.mjs')).href);

  // Cold-start /compact without mounted composer slashCommandItems still encodes canonical SlashCommandScopeItem
  const builtCompact = helpers.buildMessageItemsWithSlashCommands('/compact', []);
  assert.equal(builtCompact.matchedSlash, 'compact');
  assert.equal(builtCompact.items[0].chunk.value.scopeItem.case, 'slashCommand');
  assert.equal(builtCompact.items[0].chunk.value.scopeItem.value.info.name, 'compact');

  // Dynamic skills sanitization
  const cmds = helpers.sanitizeSlashCommands([
    { info: { name: 'compact', type: 1 } },
    { info: { name: 'release-review', type: 2, description: 'Run pre-release review & audit' } },
    { info: { name: '../bad', type: 2 } },
  ]);
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].trailingSpace, false);
  assert.equal(cmds[1].cmd, '/release-review');
  assert.equal(cmds[1].kind, 'skill');
  assert.equal(cmds[1].trailingSpace, true);

  // Branch & project name search in filterConversations
  const filteredByBranch = uiHelpers.filterConversations({
    conversations: [
      { id: 'c-1', title: 'Alpha Chat', summary: '', status: 'IDLE', lastModifiedTime: 200 },
      { id: 'c-2', title: 'Beta Chat', summary: '', status: 'IDLE', lastModifiedTime: 100 },
    ],
    searchQuery: 'feat/remote-phase0',
    filter: 'all',
    includeSubagents: false,
    selectedProjectId: '',
    studioOverview: {
      projects: [{ id: 'p-1', name: 'AGY Studio' }],
      worktreeByCid: { 'c-2': { branch: 'feat/remote-phase0', repoName: 'MAGA', projectId: 'p-1' } },
    },
  });
  assert.deepEqual(
    filteredByBranch.map((c) => c.id),
    ['c-2']
  );

  // Legacy DOM fallback when lsClient lacks sendUserCascadeMessage still preserves requireEmptyDraft: true
  const tapMod = await import(pathToFileURL(path.join(REPO, 'user/src/modules/remote-tap.mjs')).href);
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  const domCalls = [];
  const cid = '11111111-2222-4333-8444-555555555555';
  const otherCid = '22222222-2222-4333-8444-555555555555';
  try {
    globalThis.window = {
      location: { pathname: `/c/${cid}` },
      __agClaudeUxBridge: {
        triggerConversationCompact: async (arg) => {
          domCalls.push(arg);
          return true;
        },
      },
    };
    globalThis.document = {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    const tap = tapMod.createRemoteTapModule({ state: { disposed: false }, hooks: {} });
    const bgRes = await globalThis.window.__agRemoteTap.invoke('convo.compact', { cascadeId: otherCid });
    assert.equal(bgRes.error, 'compact_requires_active_pane');
    const actRes = await globalThis.window.__agRemoteTap.invoke('convo.compact', { cascadeId: cid });
    assert.equal(actRes.ok, true);
    assert.equal(actRes.mode, 'dom');
    assert.deepEqual(domCalls, [{ expectedCid: cid, requireEmptyDraft: true }]);
    tap.dispose();
  } finally {
    globalThis.window = prevWin;
    globalThis.document = prevDoc;
  }
});

test('git-bridge: preserves mixed-case shortPath/repoName, authorizes live linked worktrees, and falls back deleted worktreePath to authorized repoRoot', async () => {
  const mod = await import(pathToFileURL(path.join(REPO, 'core/daemon/remote/git-bridge.mjs')).href);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-gitb-wt-'));
  try {
    const repoDir = path.join(tmpRoot, 'MixedCaseRepo');
    const wtBase = path.join(tmpRoot, 'MixedCaseRepo-wt');
    const activeWtDir = path.join(wtBase, 'feat-live');
    const deletedWtDir = path.join(wtBase, 'feat-cleaned');
    const outsideRepoDir = path.join(tmpRoot, 'UnauthorizedOutsideRepo');
    const nativeProjectsDir = path.join(tmpRoot, 'native-projects');
    const convWtDir = path.join(tmpRoot, 'conv-wt');

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(wtBase, { recursive: true });
    fs.mkdirSync(outsideRepoDir, { recursive: true });
    fs.mkdirSync(nativeProjectsDir, { recursive: true });
    fs.mkdirSync(convWtDir, { recursive: true });

    runGit(repoDir, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# MixedCaseRepo\n', 'utf8');
    runGit(repoDir, ['add', 'README.md']);
    runGit(repoDir, ['commit', '-m', 'init']);
    runGit(repoDir, ['worktree', 'add', '-b', 'feat/live', activeWtDir]);

    runGit(outsideRepoDir, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(outsideRepoDir, 'secret.txt'), 'nope\n', 'utf8');
    runGit(outsideRepoDir, ['add', 'secret.txt']);
    runGit(outsideRepoDir, ['commit', '-m', 'outside init']);

    fs.writeFileSync(
      path.join(nativeProjectsDir, 'proj-mixed.json'),
      JSON.stringify({ id: 'proj-mixed', name: 'MixedCaseRepo', folderUris: [pathToFileURL(repoDir).href] }),
      'utf8'
    );

    const activeWtCid = 'aaaaaaaa-1111-4111-8111-111111111111';
    const deletedWtCid = 'bbbbbbbb-2222-4222-8222-222222222222';
    const unauthCid = 'cccccccc-3333-4333-8333-333333333333';

    fs.writeFileSync(
      path.join(convWtDir, `${activeWtCid}.json`),
      JSON.stringify({ worktreePath: activeWtDir, repoRoot: repoDir, branch: 'feat/live' }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(convWtDir, `${deletedWtCid}.json`),
      JSON.stringify({ worktreePath: deletedWtDir, repoRoot: repoDir, branch: 'feat/cleaned' }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(convWtDir, `${unauthCid}.json`),
      JSON.stringify({ worktreePath: path.join(wtBase, 'gone-unauth'), repoRoot: outsideRepoDir, branch: 'feat/unauth' }),
      'utf8'
    );

    const opts = { nativeProjectsDir, authorizedDirs: [repoDir], convWtDir };

    // 1. Live linked worktree resolves without needing explicit authorizedWorktreeRoots override
    const liveStatus = await mod.getRemoteProjectGitStatus({ cascadeId: activeWtCid }, opts);
    assert.equal(liveStatus.ok, true);
    assert.equal(liveStatus.branch, 'feat/live');
    assert.equal(liveStatus.repoName, 'MixedCaseRepo');
    assert.ok(
      liveStatus.shortPath.includes('MixedCaseRepo'),
      `expected mixed-case shortPath, got: ${liveStatus.shortPath}`
    );

    // 2. Deleted worktree falls back to authorized repoRoot and preserves mixed case
    const cleanedStatus = await mod.getRemoteProjectGitStatus({ cascadeId: deletedWtCid }, opts);
    assert.equal(cleanedStatus.ok, true);
    assert.equal(cleanedStatus.branch, 'main');
    assert.equal(cleanedStatus.repoName, 'MixedCaseRepo');
    assert.ok(cleanedStatus.shortPath.endsWith('MixedCaseRepo'));

    // 3. Deleted worktree pointing to unauthorized repoRoot still enforces auth root boundary
    await assert.rejects(
      () => mod.getRemoteProjectGitStatus({ cascadeId: unauthCid }, opts),
      /project_not_authorized/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
