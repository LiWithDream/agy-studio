import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');

function withDomGlobals(dom, fn) {
  const keys = [
    'window',
    'document',
    'location',
    'navigator',
    'localStorage',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'CustomEvent',
    'Event',
    'MouseEvent',
    'KeyboardEvent',
  ];
  const prev = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  for (const k of keys) {
    const v = dom.window[k];
    if (v !== undefined) {
      const val =
        typeof v === 'function' && (k === 'requestAnimationFrame' || k === 'cancelAnimationFrame')
          ? v.bind(dom.window)
          : v;
      Object.defineProperty(globalThis, k, {
        value: val,
        configurable: true,
        writable: true,
      });
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of keys) {
        const desc = prev.get(k);
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      }
      dom.window.close();
    });
}

function encodeVarint(num) {
  let n = Math.max(0, Math.floor(num));
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n & 0x7f);
  return Buffer.from(out);
}

function encodeBytesField(fieldNo, buf) {
  const payload = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'utf8');
  return Buffer.concat([encodeVarint(fieldNo * 8 + 2), encodeVarint(payload.length), payload]);
}

function encodeToolMetadata(toolName, argsObj) {
  const tc = Buffer.concat([
    encodeBytesField(2, toolName),
    ...(argsObj ? [encodeBytesField(3, JSON.stringify(argsObj))] : []),
  ]);
  return encodeBytesField(4, tc);
}

function encodeToolStepPayload(toolName, argsObj) {
  const tc = Buffer.concat([
    encodeBytesField(2, toolName),
    ...(argsObj ? [encodeBytesField(3, JSON.stringify(argsObj))] : []),
  ]);
  return encodeBytesField(5, encodeBytesField(4, tc));
}

test('daemon bg-task-status classifies schedule, redacted command, subagent, priority, cache invalidation & fallback', async () => {
  const {
    collectBackgroundTaskStates,
    inspectConversationBgState,
    redactCommandPreview,
    resetBackgroundTaskStatusCache,
  } = await import(pathToFileURL(path.join(REPO, 'studio', 'daemon', 'bg-task-status.mjs')).href);

  // Command secret redaction & truncation
  assert.equal(
    redactCommandPreview('API_KEY=secret123 Bearer ghp_abcdef npm test'),
    'API_KEY=[REDACTED] Bearer [REDACTED] npm test'
  );
  assert.ok(redactCommandPreview('echo ' + 'a'.repeat(80)).length <= 48);

  // Null SQLite or missing DB degrades cleanly to bg-wait
  resetBackgroundTaskStatusCache();
  const missingRes = inspectConversationBgState('11111111-1111-1111-1111-111111111111', {
    conversationsDir: path.join(os.tmpdir(), 'nonexistent-conv-dir-xyz'),
    DatabaseSyncImpl: null,
  });
  assert.equal(missingRes.kind, 'bg-wait');
  assert.equal(missingRes.degraded, true);

  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
  } catch {}
  if (!DatabaseSync) return;

  const tmpConvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-bg-status-'));
  try {
    const cidSched = 'aaaaaaaa-1111-2222-3333-444444444444';
    const cidCmd = 'bbbbbbbb-1111-2222-3333-444444444444';
    const cidSub = 'cccccccc-1111-2222-3333-444444444444';
    const cidMix = 'dddddddd-1111-2222-3333-444444444444';
    const cidIdle = 'eeeeeeee-1111-2222-3333-444444444444';

    const writeStepsDb = (cid, rows) => {
      const dbPath = path.join(tmpConvDir, `${cid}.db`);
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB)');
      db.exec('DELETE FROM steps');
      const stmt = db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)');
      for (const r of rows) {
        stmt.run(r.idx, r.stepType, r.status, r.metadata || null, r.stepPayload || null);
      }
      db.close();
      return dbPath;
    };

    // 1. Schedule Cron & Timer
    writeStepsDb(cidSched, [
      { idx: 1, stepType: 132, status: 2, metadata: encodeToolMetadata('schedule', { CronExpression: '*/15 * * * *' }) },
    ]);
    // 2. Command with secret redaction
    writeStepsDb(cidCmd, [
      { idx: 1, stepType: 132, status: 2, metadata: encodeToolMetadata('run_command', { CommandLine: 'API_KEY=secret123 npm run build' }) },
    ]);
    // 3. Subagent via step_type 127 & payload
    writeStepsDb(cidSub, [
      { idx: 1, stepType: 127, status: 2, metadata: null, stepPayload: encodeToolStepPayload('invoke_subagent', { Role: 'Code Reviewer' }) },
    ]);
    // 4. Multi-step priority: subagent > command > timer
    writeStepsDb(cidMix, [
      { idx: 1, stepType: 132, status: 2, metadata: encodeToolMetadata('schedule', { DurationSeconds: 180 }) },
      { idx: 2, stepType: 132, status: 2, metadata: encodeToolMetadata('run_command', { CommandLine: 'npm test' }) },
      { idx: 3, stepType: 132, status: 2, metadata: encodeToolMetadata('swarm_wait', {}) },
    ]);
    // 5. Done step only -> bg-wait fallback
    writeStepsDb(cidIdle, [
      { idx: 1, stepType: 132, status: 3, metadata: encodeToolMetadata('run_command', { CommandLine: 'ls' }) },
    ]);

    resetBackgroundTaskStatusCache();
    const batch = collectBackgroundTaskStates(
      { cascadeIds: [cidSched, cidCmd, cidSub, cidMix, cidIdle, '../bad-id', cidSched] },
      { conversationsDir: tmpConvDir, DatabaseSyncImpl: DatabaseSync }
    );
    assert.equal(batch.ok, true);
    assert.equal(batch.states['../bad-id'], undefined, 'unsafe IDs are rejected');
    assert.equal(batch.states[cidSched].kind, 'timer');
    assert.equal(batch.states[cidSched].detail, 'Cron: */15 * * * *');
    assert.equal(batch.states[cidCmd].kind, 'command');
    assert.equal(batch.states[cidCmd].detail, 'API_KEY=[REDACTED] npm run build');
    assert.equal(batch.states[cidSub].kind, 'subagent');
    assert.equal(batch.states[cidSub].detail, 'Code Reviewer');
    assert.equal(batch.states[cidMix].kind, 'subagent');
    assert.equal(batch.states[cidMix].count, 3);
    assert.equal(batch.states[cidIdle].kind, 'bg-wait');

    // Verify file-stamp cache hit & invalidation on DB mutation
    let openCount = 0;
    const CountingDb = function (loc, opts) {
      openCount += 1;
      return new DatabaseSync(loc, opts);
    };
    resetBackgroundTaskStatusCache();
    const first = inspectConversationBgState(cidSched, { conversationsDir: tmpConvDir, DatabaseSyncImpl: CountingDb });
    const second = inspectConversationBgState(cidSched, { conversationsDir: tmpConvDir, DatabaseSyncImpl: CountingDb });
    assert.equal(first.kind, 'timer');
    assert.equal(second.kind, 'timer');
    assert.equal(openCount, 1, 'identical file stamp hits cache without reopening SQLite');

    // Mutate DB (change schedule to DurationSeconds: 180 and bump mtime)
    const schedDbPath = writeStepsDb(cidSched, [
      { idx: 2, stepType: 132, status: 2, stepPayload: encodeToolStepPayload('schedule', { DurationSeconds: 180 }) },
    ]);
    const nowPlus = new Date(Date.now() + 5000);
    fs.utimesSync(schedDbPath, nowPlus, nowPlus);
    const updated = inspectConversationBgState(cidSched, { conversationsDir: tmpConvDir, DatabaseSyncImpl: CountingDb });
    assert.equal(openCount, 2, 'cache invalidates automatically on size/mtime change');
    assert.equal(updated.kind, 'timer');
    assert.equal(updated.detail, '3m');
  } finally {
    resetBackgroundTaskStatusCache();
    fs.rmSync(tmpConvDir, { recursive: true, force: true });
  }
});

test('resolveSidebarProjectOrder prevents jumping during cooldown & supports fixed/name/usage/manual refresh', async () => {
  const { resolveSidebarProjectOrder } = await import(
    pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'sidebar-projects.mjs')).href
  );

  const mkProjs = (times) => [
    { id: 'p-a', name: 'Alpha', origIdx: 0, chats: [{ id: 'c-a', updatedAt: times.a }] },
    { id: 'p-b', name: 'Beta', origIdx: 1, chats: [{ id: 'c-b', updatedAt: times.b }] },
    { id: 'p-c', name: 'Gamma', origIdx: 2, chats: [{ id: 'c-c', updatedAt: times.c }] },
  ];

  // 1. Initial recent sort
  const r0 = resolveSidebarProjectOrder(mkProjs({ a: 100, b: 300, c: 200 }), null, {
    sortMode: 'recent',
    cooldownSec: 300,
    nowMs: 1_000_000,
  });
  assert.deepEqual(r0.orderedProjects.map((p) => p.id), ['p-b', 'p-c', 'p-a']);
  assert.equal(r0.didReorder, true);
  assert.equal(r0.hasPendingDrift, false);

  // 2. Background update inside cooldown -> order stays locked, drift flagged
  const r1 = resolveSidebarProjectOrder(mkProjs({ a: 500, b: 300, c: 200 }), r0.nextSnapshot, {
    sortMode: 'recent',
    cooldownSec: 300,
    nowMs: 1_060_000, // +60s < 300s
  });
  assert.deepEqual(r1.orderedProjects.map((p) => p.id), ['p-b', 'p-c', 'p-a']);
  assert.equal(r1.didReorder, false);
  assert.equal(r1.hasPendingDrift, true);

  // 3. Cooldown expired (>= 300s) -> reorders
  const r2 = resolveSidebarProjectOrder(mkProjs({ a: 500, b: 300, c: 200 }), r1.nextSnapshot, {
    sortMode: 'recent',
    cooldownSec: 300,
    nowMs: 1_300_000,
  });
  assert.deepEqual(r2.orderedProjects.map((p) => p.id), ['p-a', 'p-b', 'p-c']);
  assert.equal(r2.didReorder, true);
  assert.equal(r2.hasPendingDrift, false);

  // 4. Adding/removing project triggers immediate reorder even inside cooldown
  const withAdded = [
    ...mkProjs({ a: 500, b: 300, c: 600 }),
    { id: 'p-d', name: 'Delta', origIdx: 3, chats: [{ id: 'c-d', updatedAt: 700 }] },
  ];
  const rAdd = resolveSidebarProjectOrder(withAdded, r2.nextSnapshot, {
    sortMode: 'recent',
    cooldownSec: 300,
    nowMs: 1_310_000,
  });
  assert.deepEqual(rAdd.orderedProjects.map((p) => p.id), ['p-d', 'p-c', 'p-a', 'p-b']);
  assert.equal(rAdd.didReorder, true);

  // 5. Manual-only mode (`cooldownSec: 0`) never auto-reorders even after hours, only on forceRefresh
  const rManualInit = resolveSidebarProjectOrder(mkProjs({ a: 100, b: 300, c: 200 }), null, {
    sortMode: 'recent',
    cooldownSec: 0,
    nowMs: 2_000_000,
  });
  const rManualLater = resolveSidebarProjectOrder(mkProjs({ a: 999, b: 300, c: 200 }), rManualInit.nextSnapshot, {
    sortMode: 'recent',
    cooldownSec: 0,
    nowMs: 12_000_000, // +10,000s later
  });
  assert.deepEqual(rManualLater.orderedProjects.map((p) => p.id), ['p-b', 'p-c', 'p-a']);
  assert.equal(rManualLater.didReorder, false);
  assert.equal(rManualLater.hasPendingDrift, true);

  const rManualForced = resolveSidebarProjectOrder(mkProjs({ a: 999, b: 300, c: 200 }), rManualLater.nextSnapshot, {
    sortMode: 'recent',
    cooldownSec: 0,
    nowMs: 12_000_500,
    forceRefresh: true,
  });
  assert.deepEqual(rManualForced.orderedProjects.map((p) => p.id), ['p-a', 'p-b', 'p-c']);
  assert.equal(rManualForced.didReorder, true);

  // 6. Fixed, Name, Usage modes
  const rFixed = resolveSidebarProjectOrder(mkProjs({ a: 100, b: 300, c: 200 }), null, { sortMode: 'fixed' });
  assert.deepEqual(rFixed.orderedProjects.map((p) => p.id), ['p-a', 'p-b', 'p-c']);

  const reversedOrig = [
    { id: 'p-z', name: 'Zeta', origIdx: 0, chats: [] },
    { id: 'p-a', name: 'Alpha', origIdx: 1, chats: [] },
    { id: 'p-m', name: 'Mid', origIdx: 2, chats: [] },
  ];
  const rName = resolveSidebarProjectOrder(reversedOrig, null, { sortMode: 'name' });
  assert.deepEqual(rName.orderedProjects.map((p) => p.id), ['p-a', 'p-m', 'p-z']);

  const rUsage = resolveSidebarProjectOrder(reversedOrig, null, {
    sortMode: 'usage',
    usageByProject: {
      'p-z': { totalTokens: 500 },
      'p-a': { totalTokens: 12_000 },
      'p-m': { totalTokens: 45_000 },
    },
  });
  assert.deepEqual(rUsage.orderedProjects.map((p) => p.id), ['p-m', 'p-a', 'p-z']);
});

test('prefs-schema, studio-prefs & settings view handle sidebarProjectSortMode and cooldown', async () => {
  const { DEFAULT_STUDIO_PREFS, sanitizeSidebarSortCooldownSec, sanitizeStudioPrefs } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'shared', 'prefs-schema.mjs')).href
  );
  const { createStudioPrefsRuntime } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'modules', 'studio-prefs.mjs')).href
  );
  const { renderL2Workspace } = await import(
    pathToFileURL(path.join(REPO, 'studio', 'modules', 'settings', 'views.mjs')).href
  );

  assert.equal(DEFAULT_STUDIO_PREFS.sidebarProjectSortMode, 'recent');
  assert.equal(DEFAULT_STUDIO_PREFS.sidebarProjectSortCooldownSec, 300);
  assert.equal(sanitizeSidebarSortCooldownSec(0, 300), 0);
  assert.equal(sanitizeSidebarSortCooldownSec(60, 300), 60);
  assert.equal(sanitizeSidebarSortCooldownSec(999, 300), 300);

  const s1 = sanitizeStudioPrefs({ sidebarProjectSortMode: 'usage', sidebarProjectSortCooldownSec: 0 });
  assert.equal(s1.sidebarProjectSortMode, 'usage');
  assert.equal(s1.sidebarProjectSortCooldownSec, 0);

  const sBad = sanitizeStudioPrefs({ sidebarProjectSortMode: 'invalid', sidebarProjectSortCooldownSec: 42 });
  assert.equal(sBad.sidebarProjectSortMode, 'recent');
  assert.equal(sBad.sidebarProjectSortCooldownSec, 300);

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  await withDomGlobals(dom, async () => {
    const events = [];
    dom.window.addEventListener('agy:sidebar-cap-prefs-changed', () => events.push('changed'));
    const prefsRt = createStudioPrefsRuntime({});
    assert.equal(dom.window.document.documentElement.getAttribute('data-agy-sb-sort'), 'recent');
    assert.equal(dom.window.document.documentElement.getAttribute('data-agy-sb-sort-cd'), '300');

    const recentWsHtml = renderL2Workspace(prefsRt.get(), { modules: { claudeUxHideSidebarProjects: false } }, { state: {}, L: (_zh, en) => en });
    assert.match(recentWsHtml, /data-ms-seg-key="sidebarProjectSortMode"/);
    assert.match(recentWsHtml, /data-ms-seg-key="sidebarProjectSortCooldownSec"/);

    prefsRt.patch({ sidebarProjectSortMode: 'fixed', sidebarProjectSortCooldownSec: 60 }, { skipDaemon: true });
    assert.equal(dom.window.document.documentElement.getAttribute('data-agy-sb-sort'), 'fixed');
    assert.equal(dom.window.document.documentElement.getAttribute('data-agy-sb-sort-cd'), '60');
    assert.ok(events.includes('changed'));

    const fixedWsHtml = renderL2Workspace(prefsRt.get(), { modules: { claudeUxHideSidebarProjects: false } }, { state: {}, L: (_zh, en) => en });
    assert.match(fixedWsHtml, /data-ms-seg-key="sidebarProjectSortMode"/);
    assert.doesNotMatch(fixedWsHtml, /data-ms-seg-key="sidebarProjectSortCooldownSec"/);

    prefsRt.dispose();
  });
});

test('sidebar-status classifies all 5 running subkinds & client RPC only queries notFullyIdle candidates', async () => {
  const {
    classifyRunningSubkind,
    createBgTaskStatusClient,
    formatRunningStatusTooltip,
    pickDominantRunningSubkind,
    renderRunningGlyphHtml,
  } = await import(pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'sidebar-status.mjs')).href);

  // 1. Primary agent active -> orbit
  assert.deepEqual(classifyRunningSubkind('c1', { status: 2 }, {}, null), {
    subkind: 'orbit',
    detail: '',
    needsBgLookup: false,
  });

  // 2. Subagent active in Redux (hasRunningSubagents / hasActiveChildren / byParent)
  assert.equal(classifyRunningSubkind('c2', { status: 1, hasRunningSubagents: true }, {}, null).subkind, 'subagent');
  assert.equal(classifyRunningSubkind('c3', { status: 1, hasActiveChildren: true }, {}, null).subkind, 'subagent');
  assert.equal(
    classifyRunningSubkind(
      'c4',
      { status: 1, notFullyIdle: true },
      {
        trajectorySummaries: {
          indexes: { byParent: { c4: ['child-1'] } },
          summaries: { 'child-1': { status: 2 } },
        },
      },
      null
    ).subkind,
    'subagent'
  );

  // 3. notFullyIdle with SQLite results & fallback
  assert.equal(classifyRunningSubkind('c5', { status: 1, notFullyIdle: true }, {}, null).subkind, 'bg-wait');
  assert.equal(
    classifyRunningSubkind('c5', { status: 1, notFullyIdle: true }, {}, { kind: 'timer', detail: 'Cron: */5 * * * *' }).subkind,
    'timer'
  );
  assert.equal(
    classifyRunningSubkind('c5', { status: 1, notFullyIdle: true }, {}, { kind: 'command', detail: 'npm test' }).subkind,
    'command'
  );
  assert.equal(pickDominantRunningSubkind(['timer', 'command', 'subagent']), 'subagent');

  // 4. Glyphs & Tooltips
  assert.match(renderRunningGlyphHtml('orbit'), /ag-folder-orbit/);
  assert.match(renderRunningGlyphHtml('subagent'), /ag-run-ico-subagent.*<svg/s);
  assert.match(renderRunningGlyphHtml('timer'), /ag-run-ico-timer.*<svg/s);
  assert.match(renderRunningGlyphHtml('command'), /ag-run-ico-command.*<svg/s);
  assert.match(renderRunningGlyphHtml('bg-wait'), /ag-run-bg-dot/);
  assert.match(
    formatRunningStatusTooltip({ subkind: 'command', detail: 'npm test' }, (zh) => zh),
    /后台命令运行中 · npm test/
  );

  // 5. Client RPC only fires when candidates are non-empty
  let rpcCalls = 0;
  let updatedCount = 0;
  const client = createBgTaskStatusClient({
    onUpdated: () => {
      updatedCount += 1;
    },
    callRpc: async (_action, payload) => {
      rpcCalls += 1;
      assert.deepEqual(payload.cascadeIds, ['bg-1']);
      return { ok: true, states: { 'bg-1': { kind: 'timer', detail: '5m', toolName: 'schedule' } } };
    },
    ttlMs: 5000,
  });
  client.syncCandidates([]);
  assert.equal(rpcCalls, 0);
  client.syncCandidates([{ id: 'bg-1', sig: '10:2:1' }]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(rpcCalls, 1);
  assert.equal(updatedCount, 1);
  assert.equal(client.getCachedState('bg-1')?.kind, 'timer');
  client.dispose();
});

test('built user/custom.js enforces sidebar anti-jump sort controls and 5-state running icons across views', async () => {
  const customJsSrc = fs.readFileSync(path.join(REPO, 'user', 'custom.js'), 'utf8');
  const { JSDOM } = await import('jsdom');
  const nowSec = Math.floor(Date.now() / 1000);

  const cidOrbit = '11111111-1111-1111-1111-111111111111';
  const cidSub = '22222222-2222-2222-2222-222222222222';
  const cidCmd = '33333333-3333-3333-3333-333333333333';
  const cidTimer = '44444444-4444-4444-4444-444444444444';
  const cidBgWait = '55555555-5555-5555-5555-555555555555';

  const summaries = {
    [cidOrbit]: { annotations: { title: 'Main Agent' }, lastModifiedTime: { seconds: nowSec - 10 }, trajectoryMetadata: { projectId: 'p-zulu' }, status: 2 },
    [cidSub]: { annotations: { title: 'Subagent Task' }, lastModifiedTime: { seconds: nowSec - 60 }, trajectoryMetadata: { projectId: 'p-alpha' }, status: 1, hasRunningSubagents: true },
    [cidCmd]: { annotations: { title: 'Cmd Task' }, lastModifiedTime: { seconds: nowSec - 120 }, trajectoryMetadata: { projectId: 'p-beta' }, status: 1, notFullyIdle: true, backgroundTaskCount: 1 },
    [cidTimer]: { annotations: { title: 'Timer Task' }, lastModifiedTime: { seconds: nowSec - 180 }, trajectoryMetadata: { projectId: 'p-gamma' }, status: 1, notFullyIdle: true, backgroundTaskCount: 1 },
    [cidBgWait]: { annotations: { title: 'Generic Wait' }, lastModifiedTime: { seconds: nowSec - 240 }, trajectoryMetadata: { projectId: 'p-gamma' }, status: 1, notFullyIdle: true, backgroundTaskCount: 1 },
  };

  const dom = new JSDOM(
    `<!doctype html><html><body><div id="root">
      <div class="bg-sidebar">
        <button data-testid="automations-button">Automations</button>
        <a href="/customizations">Skills</a>
        <div class="sb-grand flex-1 overflow-y-auto flex flex-col">
          <div class="sb-parent w-full relative">
            <div data-testid="conversation-list-sidebar">
              <div class="w-full relative" style="height: 300px;">
                <div data-index="0" style="position: absolute; transform: translateY(0px);">
                  <div data-testid="section-header"><span>Projects</span><button data-testid="sidebar-add-project-button"></button></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div id="antigravity.agentSidePanelInputBox"><textarea></textarea></div>
    </div></body></html>`,
    { url: 'http://127.0.0.1/', pretendToBeVisual: true, runScripts: 'outside-only' }
  );

  await withDomGlobals(dom, async () => {
    const { window } = dom;
    const doc = window.document;
    const listeners = new Set();
    const storeState = {
      sidebarProjects: {
        projects: [
          { id: 'p-alpha', name: 'Alpha', folderUris: ['file:///tmp/alpha'], archived: false },
          { id: 'p-zulu', name: 'Zulu', folderUris: ['file:///tmp/zulu'], archived: false },
          { id: 'p-beta', name: 'Beta', folderUris: ['file:///tmp/beta'], archived: false },
          { id: 'p-gamma', name: 'Gamma', folderUris: ['file:///tmp/gamma'], archived: false },
        ],
      },
      trajectorySummaries: {
        summaries,
        indexes: { sidebar: Object.keys(summaries) },
      },
    };
    const store = {
      getState: () => storeState,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      dispatch: () => {},
    };
    const updatedTitles = [];
    doc.querySelector('[data-testid="conversation-list-sidebar"]').firstElementChild.__reactFiber$sb = {
      memoizedProps: {
        sidebarStore: store,
        sidebarRouter: { state: { location: { pathname: '/' } }, navigate: () => {} },
        sidebarActions: {
          updateConversationAnnotations: async (id, patch) => {
            updatedTitles.push({ id, patch });
            if (patch?.title && storeState.trajectorySummaries.summaries[id]) {
              storeState.trajectorySummaries.summaries[id].annotations.title = patch.title;
            }
          },
          deleteCascadeTrajectory: async () => {},
        },
      },
    };

    const rpcActions = [];
    window.__agProjectCall = async (action) => {
      rpcActions.push(action);
      if (action === 'getBackgroundTaskStates') {
        return {
          ok: true,
          states: {
            [cidCmd]: { kind: 'command', detail: 'npm test', toolName: 'run_command' },
            [cidTimer]: { kind: 'timer', detail: 'Cron: 0 * * * *', toolName: 'schedule' },
            [cidBgWait]: { kind: 'bg-wait', detail: '', toolName: '' },
          },
        };
      }
      if (action === 'getConvWorktreeMap') {
        return {
          ok: true,
          entries: {
            [cidCmd]: { cid: cidCmd, worktreePath: '/tmp/beta-wt/cmd', branch: 'feat/cmd-wt', repoRoot: '/tmp/beta', source: 'hook', updatedAt: Date.now() },
          },
        };
      }
      if (action === 'getUsageStats') {
        return {
          ok: true,
          byProject: {
            'p-alpha': { totalTokens: 1000 },
            'p-zulu': { totalTokens: 5000 },
            'p-beta': { totalTokens: 90000 },
            'p-gamma': { totalTokens: 200 },
          },
        };
      }
      return { ok: true };
    };

    const waitFor = async (cond, timeoutMs = 1500) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (cond()) return true;
        await new Promise((r) => setTimeout(r, 15));
      }
      return Boolean(cond());
    };

    const copiedTexts = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: async (text) => {
          copiedTexts.push(String(text));
        },
      },
      configurable: true,
    });

    window.ctx = { modules: { i18n: true, claudeUxHideSidebarProjects: false, claudeUxProjects: true }, onCleanup: () => {} };
    window.eval(customJsSrc);
    await waitFor(
      () => Boolean(doc.getElementById('ag-claude-sidebar-projects')?.querySelector(`[data-ag-sbp-id="${cidCmd}"] .ag-run-ico-command svg`))
    );

    const sbSec = doc.getElementById('ag-claude-sidebar-projects');
    assert.ok(sbSec);
    assert.ok(rpcActions.includes('getBackgroundTaskStates'));

    // 1. Initial `recent` order: p-zulu (now-10), p-alpha (now-60), p-beta (now-120), p-gamma (now-180)
    const getProjOrder = () =>
      Array.from(sbSec.querySelectorAll('.ag-sbp-proj-block')).map((el) => el.getAttribute('data-proj-id'));
    assert.deepEqual(getProjOrder(), ['p-zulu', 'p-alpha', 'p-beta', 'p-gamma']);

    // 2. Verify 5 distinct running glyphs, tooltips (with Worktree branch), and clean rows without inline `.ag-sbp-branch`
    assert.ok(sbSec.querySelector(`[data-ag-sbp-id="${cidOrbit}"] .ag-folder-orbit`));
    assert.ok(sbSec.querySelector(`[data-ag-sbp-id="${cidSub}"] .ag-run-ico-subagent svg`));
    assert.ok(sbSec.querySelector(`[data-ag-sbp-id="${cidCmd}"] .ag-run-ico-command svg`));
    assert.ok(sbSec.querySelector(`[data-ag-sbp-id="${cidTimer}"] .ag-run-ico-timer svg`));
    assert.ok(sbSec.querySelector(`[data-ag-sbp-id="${cidBgWait}"] .ag-run-bg-dot`));
    assert.match(sbSec.querySelector(`[data-ag-sbp-id="${cidCmd}"]`).getAttribute('title'), /后台命令运行中 · npm test/);
    assert.match(sbSec.querySelector(`[data-ag-sbp-id="${cidTimer}"]`).getAttribute('title'), /等待定时器 \/ Cron · Cron: 0 \* \* \* \*/);
    await waitFor(() => /Worktree:\s*feat\/cmd-wt/.test(sbSec.querySelector(`[data-ag-sbp-id="${cidCmd}"]`)?.getAttribute('title') || ''));
    assert.equal(sbSec.querySelector('.ag-sbp-branch'), null, 'sidebar rows omit distracting inline worktree branch badges');
    assert.match(sbSec.querySelector(`[data-ag-sbp-id="${cidCmd}"]`).getAttribute('title'), /Worktree:\s*feat\/cmd-wt/);

    // 2b. Verify `⋯` menu & contextmenu open #ag-recent-row-menu with data-maga-own="1", survive syncs, copy ID, close on resize, toggle, and support inline rename
    const cmdMenuBtn = sbSec.querySelector(`[data-ag-sbp-menu="${cidCmd}"]`);
    assert.ok(cmdMenuBtn);
    cmdMenuBtn.click();
    const rowMenu = doc.getElementById('ag-recent-row-menu');
    assert.ok(rowMenu, 'clicking ⋯ opens #ag-recent-row-menu');
    assert.equal(rowMenu.getAttribute('data-maga-own'), '1');
    const copyIdBtn = rowMenu.querySelector('[data-ag-rm-act="copy-id"]');
    assert.ok(copyIdBtn, 'row menu includes Copy Conversation ID item');
    assert.equal(copyIdBtn.disabled, false);
    assert.equal(copyIdBtn.getAttribute('title'), cidCmd);
    for (const fn of listeners) fn();
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(rowMenu.isConnected && doc.getElementById('ag-recent-row-menu') === rowMenu, 'row menu stays open across sidebar syncs');
    copyIdBtn.click();
    assert.equal(doc.getElementById('ag-recent-row-menu'), null, 'clicking Copy Conversation ID closes row menu');
    await waitFor(
      () =>
        copiedTexts.includes(cidCmd) &&
        doc.getElementById('ag-projects-float-toast')?.textContent === '已复制对话 ID'
    );
    assert.deepEqual(copiedTexts, [cidCmd]);

    cmdMenuBtn.click();
    assert.ok(doc.getElementById('ag-recent-row-menu'), 'clicking ⋯ reopens row menu');
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(doc.getElementById('ag-recent-row-menu'), null, 'window resize closes row menu via bound onRecentMenuResize');

    cmdMenuBtn.click();
    assert.ok(doc.getElementById('ag-recent-row-menu'), 'clicking ⋯ opens row menu before toggle close check');
    cmdMenuBtn.click();
    assert.equal(doc.getElementById('ag-recent-row-menu'), null, 'clicking ⋯ again closes row menu');

    const timerRow = sbSec.querySelector(`[data-ag-sbp-id="${cidTimer}"]`);
    timerRow.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 80, clientY: 120 }));
    const ctxMenu = doc.getElementById('ag-recent-row-menu');
    assert.ok(ctxMenu, 'right-click opens #ag-recent-row-menu');
    for (const fn of listeners) fn();
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(ctxMenu.isConnected, 'context menu stays open across sidebar syncs');

    ctxMenu.querySelector('[data-ag-rm-act="rename"]').click();
    assert.equal(doc.getElementById('ag-recent-row-menu'), null);
    const renameInput = sbSec.querySelector(`[data-ag-sbp-rename-input="${cidTimer}"]`);
    assert.ok(renameInput, 'clicking Rename renders inline input inside #ag-claude-sidebar-projects');
    renameInput.value = 'Timer Renamed';
    renameInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await waitFor(
      () =>
        updatedTitles.some((u) => u.id === cidTimer && u.patch?.title === 'Timer Renamed') &&
        sbSec.querySelector(`[data-ag-sbp-id="${cidTimer}"] .ag-sbp-title`)?.textContent === 'Timer Renamed'
    );

    // 3. Anti-jump check: background timer update on p-gamma within cooldown MUST NOT jump project order
    storeState.trajectorySummaries.summaries[cidTimer].lastModifiedTime = { seconds: nowSec };
    for (const fn of listeners) fn();
    await waitFor(() => sbSec.querySelector('[data-ag-sbp-sort-refresh]')?.getAttribute('data-stale') === '1');
    assert.deepEqual(getProjOrder(), ['p-zulu', 'p-alpha', 'p-beta', 'p-gamma'], 'project order stays locked inside cooldown');
    const refreshBtn = sbSec.querySelector('[data-ag-sbp-sort-refresh]');
    assert.equal(refreshBtn.getAttribute('data-stale'), '1', 'refresh icon indicates pending drift');

    // Manual refresh reorders immediately
    refreshBtn.click();
    await waitFor(() => getProjOrder()[0] === 'p-gamma');
    assert.deepEqual(getProjOrder(), ['p-gamma', 'p-zulu', 'p-alpha', 'p-beta']);

    // 4. Sort menu switches to `name`, `fixed`, and `usage`
    sbSec.querySelector('[data-ag-sbp-sort-toggle]').click();
    const sortMenu = doc.getElementById('ag-sbp-sort-menu');
    assert.ok(sortMenu);
    sortMenu.querySelector('[data-ag-sbp-sort-mode="name"]').click();
    await waitFor(() => getProjOrder()[0] === 'p-alpha');
    assert.deepEqual(getProjOrder(), ['p-alpha', 'p-beta', 'p-gamma', 'p-zulu']);

    sbSec.querySelector('[data-ag-sbp-sort-toggle]').click();
    doc.getElementById('ag-sbp-sort-menu').querySelector('[data-ag-sbp-sort-mode="usage"]').click();
    await waitFor(() => getProjOrder()[0] === 'p-beta');
    assert.ok(rpcActions.includes('getUsageStats'));
    assert.deepEqual(getProjOrder(), ['p-beta', 'p-zulu', 'p-alpha', 'p-gamma']);

    // 5. Projects Overview cards & Project Detail rows reflect differentiated running subkinds
    doc.getElementById('ag-claude-projects-nav-btn').click();
    await waitFor(() => Boolean(doc.getElementById('ag-claude-projects-view')?.querySelector('[data-ag-proj-id="p-alpha"]')));
    const ov = doc.getElementById('ag-claude-projects-view');
    const alphaCard = ov.querySelector('[data-ag-proj-id="p-alpha"]');
    const betaCard = ov.querySelector('[data-ag-proj-id="p-beta"]');
    const gammaCard = ov.querySelector('[data-ag-proj-id="p-gamma"]');
    assert.equal(alphaCard.getAttribute('data-status-subkind'), 'subagent');
    assert.ok(alphaCard.querySelector('.ag-proj-card-status .ag-run-ico-subagent svg'));
    assert.equal(betaCard.getAttribute('data-status-subkind'), 'command');
    assert.ok(betaCard.querySelector('.ag-proj-card-status .ag-run-ico-command svg'));
    assert.equal(gammaCard.getAttribute('data-status-subkind'), 'timer');
    assert.ok(gammaCard.querySelector('.ag-proj-card-status .ag-run-ico-timer svg'));

    // Enter Gamma detail view and verify both timer + bg-wait rows
    gammaCard.click();
    await waitFor(() => Boolean(ov.querySelector('.ag-pd-chat-status[data-subkind="timer"] .ag-run-ico-timer svg')));
    assert.ok(ov.querySelector('.ag-pd-chat-status[data-subkind="timer"] .ag-run-ico-timer svg'));
    assert.ok(ov.querySelector('.ag-pd-chat-status[data-subkind="bg-wait"] .ag-run-bg-dot'));

    window.__agClaudeUxDispose();
    assert.equal(doc.getElementById('ag-claude-sidebar-projects'), null);
    assert.equal(doc.getElementById('ag-sbp-sort-menu'), null);
  });
});
