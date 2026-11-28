/**
 * AGY Studio Remote Control — Phase 2 Integration & Security Test Suite
 * Covers: per-cascade single-writer lock & desktop resume suppression, studio-bridge,
 * end-to-end Gateway -> Bridge -> Tap silent resume, /compact, Opus proposal dismiss,
 * and static invariants.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GW_DIR = path.join(REPO, 'remote', 'gateway');
const PWA_DIR = path.join(REPO, 'remote', 'pwa');

const configMod = await import(pathToFileURL(path.join(GW_DIR, 'config.mjs')).href);

function collectCssFilesRecursive(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...collectCssFilesRecursive(abs));
    else if (ent.isFile() && ent.name.endsWith('.css')) out.push(abs);
  }
  return out;
}
const serverMod = await import(pathToFileURL(path.join(GW_DIR, 'server.mjs')).href);
const lockMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote', 'cascade-lock.mjs')).href);
const studioBridgeMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote', 'studio-bridge.mjs')).href);
const opusService = await import(pathToFileURL(path.join(REPO, 'studio', 'daemon', 'opus-gate-service.mjs')).href);
const acService = await import(pathToFileURL(path.join(REPO, 'studio', 'daemon', 'auto-compact-service.mjs')).href);

function writeInterruptedConvDb(convDir, cid, { lastIdx = 4, stepType = 15, status = 8 } = {}) {
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, `${cid}.db`);
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, error_details BLOB, metadata BLOB, step_payload BLOB);'
  );
  const stmt = db.prepare(
    'INSERT INTO steps (idx, step_type, status, error_details, metadata, step_payload) VALUES (?, ?, ?, ?, ?, ?);'
  );
  stmt.run(0, 14, 3, Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0));
  stmt.run(lastIdx, stepType, status, Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0));
  db.close();
}

async function signHello(privateKey, { nonce, deviceId, lastSeq = 0, lastEpoch = '' }) {
  const payload = `maga-remote/1:hello:${nonce}:${deviceId}:${lastSeq ?? 0}:${lastEpoch || ''}`;
  const sigBuf = await crypto.webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return Buffer.from(sigBuf).toString('base64url');
}

function makeMaskedClientFrame(opcode, payloadBuf = Buffer.alloc(0)) {
  const mask = crypto.randomBytes(4);
  const len = payloadBuf.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len <= 0xffff) {
    header = Buffer.from([0x80 | opcode, 0x80 | 126, (len >>> 8) & 0xff, len & 0xff]);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = payloadBuf[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function rawWsUpgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/ws',
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        ...headers,
      },
    });
    req.on('upgrade', (res, socket, head) => resolve({ status: res.statusCode, socket, head }));
    req.on('error', reject);
    req.end();
  });
}

function readServerFrames(socket, initialBuf = Buffer.alloc(0)) {
  let buf = Buffer.from(initialBuf);
  const queue = [];
  let waiter = null;

  const pump = () => {
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const len7 = b1 & 0x7f;
      let off = 2;
      let len = len7;
      if (len7 === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len7 === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      const frame = { opcode: b0 & 0x0f, payload };
      if (waiter) {
        const w = waiter;
        waiter = null;
        w(frame);
      } else {
        queue.push(frame);
      }
    }
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  pump();

  return {
    nextFrame(timeoutMs = 5000) {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          waiter = null;
          reject(new Error('ws_read_timeout'));
        }, timeoutMs);
        waiter = (f) => {
          clearTimeout(t);
          resolve(f);
        };
      });
    },
  };
}

test('Phase 2 cascade-lock enforces single writer per cascade and suppresses desktop getResumeState during cooldown', async () => {
  lockMod.resetCascadeWriteLocksForTest();
  const cid1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const cid2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const { handleProjectRpcRequest } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'overview-skills.mjs')).href);

  try {
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });

    const p1 = lockMod.withCascadeWriteLock(cid1, 'writer-1', async () => {
      await gate;
      return 'done-1';
    }, { markCooldownOnSuccess: true });

    await assert.rejects(
      () => lockMod.withCascadeWriteLock(cid1, 'writer-2', async () => 'should-fail'),
      (err) => err?.code === 'cascade_write_busy'
    );

    const p2 = await lockMod.withCascadeWriteLock(cid2, 'other-cascade', async () => 'ok-2');
    assert.equal(p2, 'ok-2');

    // Active lock suppresses desktop getResumeState
    const duringActive = await handleProjectRpcRequest(
      JSON.stringify({ reqId: 'rpc-1', token: 'tok-1', action: 'getResumeState', payload: { cascadeId: cid1 } }),
      { rpcToken: 'tok-1', hostConfirmed: true }
    );
    assert.equal(duringActive.result.ok, true);
    assert.equal(duringActive.result.interrupted, false);
    assert.equal(duringActive.result.active, true);
    assert.equal(duringActive.result.reason, 'remote_write_active');

    releaseFirst();
    assert.equal(await p1, 'done-1');
    assert.equal(lockMod.isCascadeWriteActive(cid1), false);
    assert.equal(lockMod.isCascadeWriteActiveOrRecent(cid1), true, '3s cooldown should hold after write');

    // Cooldown window still suppresses desktop getResumeState
    const duringCooldown = await handleProjectRpcRequest(
      JSON.stringify({ reqId: 'rpc-2', token: 'tok-1', action: 'getResumeState', payload: { cascadeId: cid1 } }),
      { rpcToken: 'tok-1', hostConfirmed: true }
    );
    assert.equal(duringCooldown.result.reason, 'remote_write_active');
    assert.equal(duringCooldown.result.interrupted, false);
  } finally {
    lockMod.resetCascadeWriteLocksForTest();
  }
});

test('Phase 2 studio-bridge aggregates resumeState, sanitized overview & Opus Gate proposal dismissal', async () => {
  lockMod.resetCascadeWriteLocksForTest();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p2br-'));
  try {
    const convDir = path.join(tmpRoot, 'conversations');
    const stateDir = path.join(tmpRoot, 'state');
    const nativeProjectsDir = path.join(tmpRoot, 'projects');
    const convWtDir = path.join(tmpRoot, 'conv-worktrees');
    const projDir = path.join(tmpRoot, 'demo-repo');
    const proposalsDir = path.join(stateDir, 'opus-gate-proposals');
    const requestsDir = path.join(stateDir, 'auto-compact-requests');
    const quotaStateFile = path.join(stateDir, 'quota-state.json');

    fs.mkdirSync(nativeProjectsDir, { recursive: true });
    fs.mkdirSync(convWtDir, { recursive: true });
    fs.mkdirSync(projDir, { recursive: true });

    const cid = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
    writeInterruptedConvDb(convDir, cid, { lastIdx: 6, stepType: 15, status: 8 });

    // Interrupted DB state & suppression flags
    assert.equal(studioBridgeMod.getRemoteResumeState('bad-id').error, 'invalid_cascade_id');
    assert.equal(studioBridgeMod.getRemoteResumeState(cid, { liveBusy: true }).interrupted, false);
    assert.equal(studioBridgeMod.getRemoteResumeState(cid, { liveWaiting: true }).reason, 'waiting_user');
    const rs = studioBridgeMod.getRemoteResumeState(cid, { conversationsDir: convDir });
    assert.equal(rs.ok, true);
    assert.equal(rs.interrupted, true);
    assert.equal(rs.lastIdx, 6);
    assert.equal(rs.reason, 'aborted');

    // Fixtures for Studio Overview
    fs.writeFileSync(
      path.join(nativeProjectsDir, 'proj-demo.json'),
      JSON.stringify({ id: 'proj-demo', name: 'Demo Repo', folderUris: [`file://${projDir}`] })
    );
    fs.writeFileSync(
      path.join(convWtDir, `${cid}.json`),
      JSON.stringify({ worktreePath: path.join(tmpRoot, 'MAGA-wt', 'remote'), branch: 'feat/remote-control', repoRoot: projDir, updatedAt: Date.now() })
    );
    opusService.saveQuotaState(
      {
        tierName: 'Pro',
        claude: { fiveHourRemainingPct: 82, weeklyRemainingPct: 91, fiveHourResetSec: 1795784590, weeklyResetSec: 1796266576 },
        gemini: { fiveHourRemainingPct: 100, weeklyRemainingPct: 100, fiveHourResetSec: 1795784511, weeklyResetSec: 1796281311 },
      },
      { quotaStateFile }
    );
    const nowTs = Date.now();
    opusService.writeOpusGateProposal(
      cid,
      { kind: 'risk', reason: 'High-risk auth change', diffHash: 'abc123def456', recommendedTier: 'high', ts: nowTs },
      { proposalsDir }
    );
    acService.writeAutoCompactRequest(
      cid,
      { requestId: 'ac-1', reason: 'context_high', ctxPct: 92, ts: nowTs },
      { requestsDir }
    );

    const d = new Date(nowTs);
    const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const overview = await studioBridgeMod.collectStudioOverview(
      { cascadeId: cid },
      {
        authorizedDirs: [projDir],
        nativeProjectsDir,
        convWtDir,
        now: nowTs,
        quotaOpts: { quotaStateFile },
        opusOpts: { proposalsDir, quotaStateFile },
        compactOpts: { requestsDir },
        listRepoWorktreesAsync: async () => ({
          ok: true,
          worktrees: [
            { realPath: projDir, branch: 'main', isMain: true },
            { realPath: path.join(tmpRoot, 'MAGA-wt', 'remote'), branch: 'feat/remote-control', isMain: false },
          ],
        }),
        collectUsageStatsAsync: async () => ({
          ok: true,
          days: [{ date: todayStr, requests: 5, uncached: 1200, cacheRead: 8000, cacheWrite: 500, output: 300 }],
        }),
      }
    );

    assert.equal(overview.ok, true);
    assert.equal(overview.projects.length, 1);
    assert.equal(overview.projects[0].name, 'Demo Repo');
    assert.equal(overview.projects[0].worktreeCount, 2);
    assert.equal(overview.worktreeByCid[cid].branch, 'feat/remote-control');
    assert.equal(overview.worktreeByCid[cid].projectId, 'proj-demo');
    assert.equal(overview.quota.claude.fiveHourRemainingPct, 82);
    assert.equal(overview.quota.gemini.fiveHourResetSec, 1795784511);
    assert.equal(overview.quota.gemini.weeklyResetSec, 1796281311);
    assert.equal(overview.todayUsage.totalTokens, 10_000);
    assert.equal(overview.activeCascade.opusGate.proposal.id, 'abc123def456');
    assert.equal(overview.activeCascade.autoCompact.pending.ctxPct, 92);

    const dismissed = studioBridgeMod.handleRemoteOpusDismiss(
      { cascadeId: cid, proposalId: 'abc123def456' },
      { opusOpts: { proposalsDir } }
    );
    assert.equal(dismissed.ok, true);
    assert.equal(dismissed.matched, true);
    assert.equal(opusService.getOpusGateStatus({ cascadeId: cid }, { proposalsDir, quotaStateFile }).proposal, null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    lockMod.resetCascadeWriteLocksForTest();
  }
});

test('Phase 2 End-to-End (Gateway + Bridge + Tap): studio.overview, convo.resume, convo.compact & opus.dismiss', async () => {
  lockMod.resetCascadeWriteLocksForTest();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p2e2e-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  const stateDir = path.join(tmpRoot, 'state');
  const convDir = path.join(tmpRoot, 'conversations');
  const sockPath = configMod.resolveSockPath(tmpRoot);
  const bootToken = 'phase2-boot-token-0123456789abcd';
  const bridgeMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs')).href);
  const { attachedTargets } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'env.mjs')).href);
  const { createRemoteTapModule } = await import(pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'remote-tap.mjs')).href);
  const prevTargets = Array.from(attachedTargets.entries());
  const openSockets = [];
  let gw = null;

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://127.0.0.1:60000/c/dddddddd-dddd-4ddd-8ddd-ddddddddddd4',
  });
  const keys = ['window', 'document'];
  const prevGlobals = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  let tap = null;

  try {
    const cid = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
    const otherCid = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5';
    writeInterruptedConvDb(convDir, cid, { lastIdx: 4, stepType: 15, status: 8 });
    opusService.writeOpusGateProposal(
      cid,
      { kind: 'plan', reason: 'Plan ready', diffHash: 'planhash0001', ts: Date.now() },
      { proposalsDir: path.join(stateDir, 'opus-gate-proposals') }
    );

    globalThis.window = dom.window;
    globalThis.document = dom.window.document;

    let currentPreset = 3; // TURBO
    let hasDraft = false;
    let cidStatus = 1;
    let cidWaitingSteps = [];
    const sentMessages = [];
    const compactCalls = [];
    dom.window.__agClaudeUxBridge = {
      async triggerConversationCompact(opts) {
        compactCalls.push(opts);
        if (hasDraft) return false;
        return true;
      },
    };
    const mockStore = {
      subscribe: () => () => {},
      getState: () => ({
        userStatus: { permissionSettings: { globalPreset: currentPreset } },
        trajectorySummaries: {
          summaries: {
            [cid]: { summary: 'Interrupted Task', status: cidStatus, waitingSteps: cidWaitingSteps },
            [otherCid]: { summary: 'Background Chat', status: 1, waitingSteps: [] },
          },
        },
      }),
    };
    const mockLsClient = {
      sendUserCascadeMessage: async (arg) => sentMessages.push(arg),
      handleCascadeUserInteraction: async () => {},
      cancelCascadeInvocation: async () => {},
      createAgentStateProviderForConvo: () => ({ getState: () => null, onDidChange: () => ({ dispose: () => {} }), dispose: () => {} }),
      getCascadeTrajectory: async () => ({ trajectory: { steps: [] } }),
    };
    dom.window.document.getElementById('root').__reactContainer$p2 = {
      memoizedProps: { store: mockStore, lsClient: mockLsClient },
      child: null,
      sibling: null,
    };

    tap = createRemoteTapModule({ state: { disposed: false } });
    const tapApi = dom.window.__agRemoteTap;
    assert.equal(tapApi.getCapabilities().capabilities.compact, true);

    attachedTargets.clear();
    attachedTargets.set('p2-host', {
      id: 'p2-host',
      type: 'page',
      hostConfirmed: true,
      trustedContextId: 1,
      ws: { readyState: 1 },
      async send(method, params) {
        if (method === 'Runtime.evaluate') {
          const val = await dom.window.eval(String(params.expression || 'null'));
          return { result: { result: { value: val } } };
        }
        return {};
      },
    });

    await bridgeMod.initRemoteBridge({
      env: {
        ANTI_CLAUDE_STATE_DIR: stateDir,
        MAGA_REMOTE_STATE_DIR: remoteDir,
        MAGA_REMOTE_SOCK_PATH: sockPath,
        MAGA_REMOTE_UDS_TOKEN: bootToken,
        MAGA_REMOTE_CONV_DIR: convDir,
      },
      gatewayScript: path.join(tmpRoot, 'missing-gw.mjs'),
    });

    gw = await serverMod.createGatewayServer({
      remoteDir,
      sockPath,
      port: 0,
      writePid: false,
      udsWriteToken: bootToken,
    });

    const enrollAndConnect = async (role, name) => {
      configMod.writePairing(
        { code: `P2_${name}`, expiresAt: Date.now() + 60_000, role, gatewayFingerprint: gw.gatewayFingerprint },
        { remoteDir }
      );
      const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
      const pr = await (
        await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: `P2_${name}`, deviceName: name, publicKeyJwk, turboAcknowledged: true }),
        })
      ).json();
      assert.equal(pr.ok, true);
      const ch = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
      const sig = await signHello(kp.privateKey, { nonce: ch.nonce, deviceId: pr.deviceId, lastSeq: 0, lastEpoch: '' });
      const ws = await rawWsUpgrade(gw.port);
      openSockets.push(ws.socket);
      const reader = readServerFrames(ws.socket, ws.head);
      ws.socket.write(
        makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
          type: 'hello', protocol: 'maga-remote/1', deviceId: pr.deviceId, nonce: ch.nonce, signature: sig, lastSeq: 0, lastEpoch: '',
        })))
      );
      const welcome = JSON.parse((await reader.nextFrame()).payload.toString('utf8'));
      assert.equal(welcome.type, 'welcome');
      return { ws, reader };
    };

    const callRpc = async (c, reqId, method, params) => {
      c.ws.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId, method, params }))));
      return JSON.parse((await c.reader.nextFrame()).payload.toString('utf8'));
    };

    const cObs = await enrollAndConnect('observe', 'ObsP2');
    const cSteer = await enrollAndConnect('steer', 'SteerP2');

    // Observe can read studio.overview & convo.resumeState, blocked from writes
    const ovObs = await callRpc(cObs, 'o-1', 'studio.overview', { cascadeId: cid });
    assert.equal(ovObs.ok, true);
    assert.equal(ovObs.result.activeCascade.opusGate.proposal.id, 'planhash0001');

    const rsObs = await callRpc(cObs, 'o-2', 'convo.resumeState', { cascadeId: cid });
    assert.equal(rsObs.ok, true);
    assert.equal(rsObs.result.interrupted, true);
    assert.equal(rsObs.result.lastIdx, 4);

    assert.equal(
      (await callRpc(cObs, 'o-3', 'convo.resume', { cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-obs-res-1', turboWriteConfirmed: true })).error,
      'forbidden_role_observe'
    );
    assert.equal(
      (await callRpc(cObs, 'o-4', 'convo.compact', { cascadeId: cid, idempotencyKey: 'k-obs-cmp-1' })).error,
      'forbidden_role_observe'
    );
    assert.equal(
      (await callRpc(cObs, 'o-5', 'opus.dismiss', { cascadeId: cid, proposalId: 'planhash0001', idempotencyKey: 'k-obs-dis-1' })).error,
      'forbidden_role_observe'
    );

    // Steer: TURBO fails closed without ack
    assert.equal(
      (await callRpc(cSteer, 's-1', 'convo.resume', { cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-noack', turboWriteConfirmed: false })).error,
      'turbo_write_confirmation_required'
    );

    // Stale expectedLastIdx fails with resume_state_changed
    assert.equal(
      (await callRpc(cSteer, 's-2', 'convo.resume', { cascadeId: cid, expectedLastIdx: 99, idempotencyKey: 'k-st-res-stale', turboWriteConfirmed: true })).error,
      'resume_state_changed'
    );

    // Per-cascade lock contention returns cascade_write_busy (not cached), and retry after release succeeds
    let relLock;
    const holdPromise = lockMod.withCascadeWriteLock(cid, 'desktop-writer', () => new Promise((r) => { relLock = r; }));
    const busyRes = await callRpc(cSteer, 's-3', 'convo.resume', {
      cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-busy', turboWriteConfirmed: true,
    });
    assert.equal(busyRes.ok, false);
    assert.equal(busyRes.error, 'cascade_write_busy');
    relLock();
    await holdPromise;

    const okRes = await callRpc(cSteer, 's-4', 'convo.resume', {
      cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-busy', turboWriteConfirmed: true,
    });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.result.resumedFromIdx, 4);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0].items[0].chunk.value.startsWith(studioBridgeMod.SILENT_RESUME_SENTINEL));

    // Cooldown immediately after convo.resume suppresses convo.resumeState
    const afterCooldownRs = await callRpc(cSteer, 's-5', 'convo.resumeState', { cascadeId: cid });
    assert.equal(afterCooldownRs.result.interrupted, false);
    assert.equal(afterCooldownRs.result.reason, 'remote_write_active');

    // convo.compact now submits native SlashCommandScopeItem directly via lsClient RPC:
    // works for background conversations & ignores desktop draft, while still rejecting running/waiting cascades.
    const sentBeforeCompact = sentMessages.length;
    const cmpBgOk = await callRpc(cSteer, 's-6', 'convo.compact', {
      cascadeId: otherCid,
      idempotencyKey: 'k-cmp-bg-rpc',
    });
    assert.equal(cmpBgOk.ok, true);
    assert.equal(cmpBgOk.result.mode, 'rpc');
    assert.equal(sentMessages.length, sentBeforeCompact + 1);
    assert.equal(sentMessages.at(-1).cascadeId, otherCid);
    assert.equal(sentMessages.at(-1).items[0].chunk.value.scopeItem.case, 'slashCommand');
    assert.equal(sentMessages.at(-1).items[0].chunk.value.scopeItem.value.info.name, 'compact');

    // Rejects compact when cascade is currently RUNNING
    cidStatus = 2;
    assert.equal(
      (await callRpc(cSteer, 's-7', 'convo.compact', { cascadeId: cid, idempotencyKey: 'k-cmp-running' })).error,
      'compact_rejected_or_busy'
    );
    cidStatus = 1;

    // Succeeds on active cascade via native RPC even while desktop composer holds a draft
    hasDraft = true;
    const cmpOk = await callRpc(cSteer, 's-8', 'convo.compact', { cascadeId: cid, idempotencyKey: 'k-cmp-ok-1' });
    assert.equal(cmpOk.ok, true);
    assert.equal(cmpOk.result.mode, 'rpc');
    assert.equal(compactCalls.length, 0, 'native RPC compact should not touch desktop DOM composer');
    hasDraft = false;

    // opus.dismiss via Gateway -> Bridge -> opus-gate-service.mjs
    // First test idempotency payloadHash binds `ts` too
    const disMismatch = await callRpc(cSteer, 's-9a', 'opus.dismiss', {
      cascadeId: cid, proposalId: 'planhash0001', ts: 123456, idempotencyKey: 'k-opus-dis-ts',
    });
    assert.equal(disMismatch.ok, true);
    assert.equal(disMismatch.result.matched, false);
    const disConflict = await callRpc(cSteer, 's-9b', 'opus.dismiss', {
      cascadeId: cid, proposalId: 'planhash0001', ts: 999999, idempotencyKey: 'k-opus-dis-ts',
    });
    assert.equal(disConflict.ok, false);
    assert.equal(disConflict.error, 'idempotency_key_conflict');

    const disOk = await callRpc(cSteer, 's-9', 'opus.dismiss', {
      cascadeId: cid, proposalId: 'planhash0001', idempotencyKey: 'k-opus-dis-1',
    });
    assert.equal(disOk.ok, true);
    assert.equal(disOk.result.matched, true);
    const ovAfterDis = await callRpc(cSteer, 's-10', 'studio.overview', { cascadeId: cid });
    assert.equal(ovAfterDis.result.activeCascade.opusGate.proposal, null);

    // P1-1 regression: convo.resume rejects during 3s cooldown and when live host is RUNNING or has waitingSteps
    assert.equal(
      (await callRpc(cSteer, 's-11', 'convo.resume', {
        cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-cool', turboWriteConfirmed: true,
      })).error,
      'resume_state_changed'
    );
    lockMod.resetCascadeWriteLocksForTest();
    cidStatus = 2; // RUNNING
    assert.equal(
      (await callRpc(cSteer, 's-12', 'convo.resume', {
        cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-live-run', turboWriteConfirmed: true,
      })).error,
      'resume_state_changed'
    );
    cidStatus = 1;
    cidWaitingSteps = [{ stepIndex: 4, case: 'permission' }];
    assert.equal(
      (await callRpc(cSteer, 's-13', 'convo.resume', {
        cascadeId: cid, expectedLastIdx: 4, idempotencyKey: 'k-st-res-live-wait', turboWriteConfirmed: true,
      })).error,
      'resume_state_changed'
    );
    cidWaitingSteps = [];
  } finally {
    for (const s of openSockets) {
      try { s.destroy(); } catch {}
    }
    await gw?.close().catch(() => {});
    tap?.dispose();
    dom.window.close();
    for (const [k, desc] of prevGlobals.entries()) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    attachedTargets.clear();
    for (const [k, v] of prevTargets) attachedTargets.set(k, v);
    await bridgeMod.shutdownRemoteBridge().catch(() => {});
    lockMod.resetCascadeWriteLocksForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 2 Carbon P1 regressions: strict opus CAS, projectResources/hashed projId & parallel studio overview + explicit UDS timeouts', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p2reg-'));
  try {
    const cid = 'ffffffff-ffff-4fff-8fff-fffffffffff6';
    const proposalsDir = path.join(tmpRoot, 'opus-gate-proposals');
    const nativeProjectsDir = path.join(tmpRoot, 'projects');
    const projKnown = path.join(tmpRoot, 'secret-user-path', 'known-repo');
    const projUnmatched = path.join(tmpRoot, 'secret-user-path', 'unmatched-repo');
    fs.mkdirSync(nativeProjectsDir, { recursive: true });
    fs.mkdirSync(projKnown, { recursive: true });
    fs.mkdirSync(projUnmatched, { recursive: true });

    // Strict CAS checks in studio-bridge + opus-gate-service
    opusService.writeOpusGateProposal(
      cid,
      { kind: 'risk', reason: 'A'.repeat(400), diffHash: 'hashA111', ts: 10001 },
      { proposalsDir }
    );
    assert.equal(
      studioBridgeMod.handleRemoteOpusDismiss({ cascadeId: cid, proposalId: 'active' }, { opusOpts: { proposalsDir } }).matched,
      false,
      '"active" must not bypass CAS on hashed/timestamped proposal'
    );
    assert.equal(
      studioBridgeMod.handleRemoteOpusDismiss({ cascadeId: cid, proposalId: 'ts-99999' }, { opusOpts: { proposalsDir } }).matched,
      false,
      'mismatched ts-<n> must not dismiss'
    );
    // Empty-hash debug proposal must not be dismissed by stale hash
    opusService.writeOpusGateProposal(
      cid,
      { kind: 'debug', reason: 'Error burst', diffHash: '', ts: 20002 },
      { proposalsDir }
    );
    assert.equal(
      studioBridgeMod.handleRemoteOpusDismiss({ cascadeId: cid, proposalId: 'hashA111' }, { opusOpts: { proposalsDir } }).matched,
      false,
      'stale hash must not dismiss empty-hash debug proposal'
    );
    assert.equal(
      studioBridgeMod.handleRemoteOpusDismiss({ cascadeId: cid, proposalId: 'ts-20002' }, { opusOpts: { proposalsDir } }).matched,
      true
    );

    // projectResources extraction & hashed fallback projId + parallel usage stats
    fs.writeFileSync(
      path.join(nativeProjectsDir, 'p-res.json'),
      JSON.stringify({
        id: 'proj-from-resources',
        name: 'Resources Repo',
        projectResources: { resources: [{ workspaceFolderAbsoluteUri: `file://${projKnown}` }] },
      })
    );
    let wtStarted = false;
    let usageStarted = false;
    let bothConcurrent = false;
    let relWt;
    let relUsage;
    const overviewPromise = studioBridgeMod.collectStudioOverview(
      {},
      {
        authorizedDirs: [projKnown, projUnmatched],
        nativeProjectsDir,
        listRepoWorktreesAsync: () =>
          new Promise((resolve) => {
            wtStarted = true;
            if (usageStarted) bothConcurrent = true;
            const done = () => resolve({ ok: true, worktrees: [] });
            if (relWt) done();
            else relWt = done;
          }),
        collectUsageStatsAsync: () =>
          new Promise((resolve) => {
            usageStarted = true;
            if (wtStarted) bothConcurrent = true;
            const done = () => resolve({ ok: true, days: [] });
            if (relUsage) done();
            else relUsage = done;
          }),
      }
    );
    await new Promise((r) => setTimeout(r, 20));
    relWt?.();
    relUsage?.();
    const overview = await overviewPromise;
    assert.equal(bothConcurrent, true, 'collectUsageStatsAsync must run concurrently with listRepoWorktreesAsync');
    assert.equal(overview.projects[0].id, 'proj-from-resources');
    assert.match(overview.projects[1].id, /^proj-[0-9a-f]{12}$/);
    assert.equal(overview.projects[1].id.includes('secret-user-path'), false);

    // ws-server.mjs passes explicit UDS timeouts >= studio-bridge budgets
    const wsServerSrc = fs.readFileSync(path.join(GW_DIR, 'ws-server.mjs'), 'utf8');
    assert.match(wsServerSrc, /request\(\s*'convo\.resumeState'[\s\S]*?timeoutMs:\s*6500/);
    assert.match(wsServerSrc, /request\(\s*'studio\.overview'[\s\S]*?timeoutMs:\s*8500/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 2 static invariants: 7 gateway files, <2000 lines, Zero-XSS across all PWA modules & zero :has()', () => {
  const gwFiles = fs.readdirSync(GW_DIR).filter((f) => f.endsWith('.mjs'));
  assert.equal(gwFiles.length, 7, 'remote/gateway/*.mjs must remain strictly 7 files');

  const filesToCheck = [
    path.join(REPO, 'core', 'daemon', 'remote', 'cascade-lock.mjs'),
    path.join(REPO, 'core', 'daemon', 'remote', 'studio-bridge.mjs'),
    path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs'),
    path.join(REPO, 'user', 'src', 'modules', 'remote-tap.mjs'),
    path.join(GW_DIR, 'ws-server.mjs'),
    path.join(PWA_DIR, 'src', 'studio-panel.mjs'),
    path.join(PWA_DIR, 'src', 'overview-panel.mjs'),
    path.join(PWA_DIR, 'src', 'composer-bar.mjs'),
    path.join(PWA_DIR, 'src', 'app.mjs'),
    path.join(PWA_DIR, 'src', 'ws-client.mjs'),
  ];
  for (const abs of filesToCheck) {
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    const src = fs.readFileSync(abs, 'utf8');
    assert.ok(src.split('\n').length < 2000, `${path.relative(REPO, abs)} must stay < 2000 lines`);
  }

  const pwaSrcFiles = fs.readdirSync(path.join(PWA_DIR, 'src')).filter((f) => f.endsWith('.mjs'));
  assert.ok(pwaSrcFiles.length > 0);
  for (const fname of pwaSrcFiles) {
    const abs = path.join(PWA_DIR, 'src', fname);
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    const src = fs.readFileSync(abs, 'utf8');
    assert.ok(src.split('\n').length < 2000, `remote/pwa/src/${fname} must stay < 2000 lines`);
    assert.equal(
      /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(src),
      false,
      `PWA module ${fname} must not contain XSS sinks`
    );
  }
  const pwaCssFiles = collectCssFilesRecursive(path.join(PWA_DIR, 'src'));
  assert.ok(pwaCssFiles.length >= 2, 'expected root styles.css plus modular desktop stylesheets');
  for (const cssAbs of pwaCssFiles) {
    const cssText = fs.readFileSync(cssAbs, 'utf8');
    const rel = path.relative(REPO, cssAbs);
    if (path.basename(cssAbs) !== 'styles.css') {
      assert.ok(cssText.split('\n').length < 2000, `${rel} must stay < 2000 lines`);
    }
    assert.equal(cssText.includes(':has('), false, `${rel} must not contain :has(`);
    assert.equal(cssText.includes('height: 100dvh'), false, `${rel} must not contain height: 100dvh`);
  }

  const appSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'app.mjs'), 'utf8');
  assert.match(appSrc, /workspaceRefs\s*=\s*\{\s*topbar,/);
});

test('Phase 2 PWA shell regressions: Markdown Zero-XSS & stale IDLE stream suppression', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = dom.window.document;

  try {
    const timelineMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'timeline-view.mjs')).href);
    const mdNode = timelineMod.renderSafeMarkdown([
      '### 总结',
      '- **重点**：查看 [app.mjs](file:///Users/demo/app.mjs#L10) 与 [Docs](https://example.com/docs)',
      '- XSS: [bad](javascript:alert(1)) <script>alert(2)</script> `inline()`',
      '```js',
      'const x = 1;',
      '```',
    ].join('\n'));

    assert.equal(mdNode.querySelector('script'), null, 'Zero-XSS: never create <script> elements');
    assert.ok(mdNode.querySelector('.rc-md-h[data-level="3"]'));
    assert.equal(mdNode.querySelector('.rc-md-file')?.textContent, 'app.mjs');
    const extLink = mdNode.querySelector('a.rc-md-link');
    assert.equal(extLink?.getAttribute('href'), 'https://example.com/docs');
    assert.equal(extLink?.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(mdNode.querySelector('a[href^="javascript:"]'), null, 'javascript: links must be blocked');
    assert.equal(mdNode.querySelector('code.rc-md-code')?.textContent, 'inline()');
    assert.equal(mdNode.querySelector('pre.rc-pre')?.textContent, 'const x = 1;');

    // IDLE conversation must NOT render orange .rc-stream-card even if stale stream entry exists
    const cid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const doc = dom.window.document;
    const refs = {
      detailTitle: doc.createElement('h2'),
      detailSub: doc.createElement('div'),
      timeline: doc.createElement('div'),
    };
    const state = {
      selectedId: cid,
      identity: { role: 'observe' },
      hostAttached: true,
      wsStatus: 'connected',
      conversations: [{ id: cid, title: 'Completed Chat', status: 'IDLE', waitingSteps: [] }],
      snapshots: new Map([
        [cid, { cascadeId: cid, status: 'IDLE', steps: [{ idx: 1, type: 'PLANNER_RESPONSE', status: 'DONE', text: 'Done' }], waitingSteps: [] }],
      ]),
      streams: new Map([[cid, { stepIdx: 1, text: 'Stale leftover text', thinkingText: '', status: 'DONE' }]]),
      studioOverview: null,
      snapshotLoading: false,
      snapshotError: '',
      approvingHash: '',
    };
    timelineMod.renderDetailTimeline({ state, refs, onSelectConversation: () => {}, onApprove: () => {} });
    assert.equal(refs.timeline.querySelector('.rc-stream-card'), null, 'IDLE snapshot must suppress .rc-stream-card');

    // RUNNING conversation DOES render .rc-stream-card
    state.snapshots.get(cid).status = 'RUNNING';
    state.streams.get(cid).status = 'RUNNING';
    timelineMod.renderDetailTimeline({ state, refs, onSelectConversation: () => {}, onApprove: () => {} });
    assert.ok(refs.timeline.querySelector('.rc-stream-card'), 'RUNNING snapshot should render .rc-stream-card');

    // No literal "null" text in detailSub when wtMeta.branch is absent
    assert.equal(refs.detailSub.textContent.includes('null'), false, 'detailSub must not contain literal "null"');

    // Nested inline Markdown inside **bold**
    const nestedMd = timelineMod.renderSafeMarkdown('回归测试（**隔离工作树 `8d1b3f0` 内查看 [sw.js](file:///tmp/sw.js)**）');
    const strongEl = nestedMd.querySelector('strong');
    assert.ok(strongEl, 'expected <strong> element for bold span');
    assert.equal(strongEl.querySelector('code.rc-md-code')?.textContent, '8d1b3f0');
    assert.equal(strongEl.querySelector('code.rc-md-file')?.textContent, 'sw.js');
    assert.equal(strongEl.textContent.includes('`'), false, 'nested inline code must not leave raw backticks inside <strong>');

    // renderOpusGateBanner & renderResumeBanner must not emit literal "null"
    const studioPanelMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'studio-panel.mjs')).href);
    const opusContainer = doc.createElement('div');
    studioPanelMod.renderOpusGateBanner(opusContainer, {
      opusGate: { proposal: { id: 'p-1', kind: 'plan', recommendedTier: 'high', summary: 'Plan finalized' } },
      canWrite: false,
    });
    assert.equal(opusContainer.textContent.includes('null'), false, 'Opus Gate banner must not contain literal "null"');

    const resumeContainer = doc.createElement('div');
    studioPanelMod.renderResumeBanner(resumeContainer, {
      resumeState: { interrupted: true, active: false, lastIdx: 7, reason: 'interrupted' },
      canWrite: true,
      online: true,
      needTurboConfirm: false,
    });
    assert.equal(resumeContainer.textContent.includes('null'), false, 'Resume banner must not contain literal "null"');
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    dom.window.close();
  }
});

test('Phase 2 Dual-Form UI regressions: layout mode, Overview panel, code copy & step data-role', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = dom.window.document;

  try {
    const helpersMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'ui-helpers.mjs')).href);
    const overviewMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'overview-panel.mjs')).href);
    const timelineMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'timeline-view.mjs')).href);

    // 1. resolveLayoutMode & formatResetCountdown (relative durations + Unix epoch sec/ms)
    assert.equal(helpersMod.resolveLayoutMode('auto', 1280), 'desktop');
    assert.equal(helpersMod.resolveLayoutMode('auto', 390), 'mobile');
    assert.equal(helpersMod.resolveLayoutMode('desktop', 390), 'desktop');
    assert.equal(helpersMod.resolveLayoutMode('mobile', 1440), 'mobile');
    assert.equal(helpersMod.formatResetCountdown(2700), '45m');
    assert.equal(helpersMod.formatResetCountdown(12000), '3h 20m');
    assert.equal(helpersMod.formatResetCountdown(0), '');
    const fixedNowMs = 1_795_783_509_000;
    const fixedNowSec = Math.floor(fixedNowMs / 1000);
    assert.equal(helpersMod.formatResetCountdown(fixedNowSec + 1080, fixedNowMs), '18m');
    assert.equal(helpersMod.formatResetCountdown(fixedNowSec + 5 * 86400 + 3600, fixedNowMs), '5d 1h');
    assert.equal(helpersMod.formatResetCountdown((fixedNowSec + 7200) * 1000, fixedNowMs), '2h');
    assert.equal(helpersMod.formatResetCountdown(fixedNowSec - 10, fixedNowMs), '');

    // 2. renderOverviewPanel (must use CSSOM style.width, never setAttribute('style', ...) blocked by strict CSP)
    const ovRoot = dom.window.document.createElement('aside');
    let filteredPid = '';
    const origSetAttr = dom.window.Element.prototype.setAttribute;
    let inlineStyleAttrCalls = 0;
    dom.window.Element.prototype.setAttribute = function patchedSetAttr(name, val) {
      if (String(name).toLowerCase() === 'style') inlineStyleAttrCalls += 1;
      return origSetAttr.call(this, name, val);
    };
    try {
      overviewMod.renderOverviewPanel(ovRoot, {
        overview: {
          quota: {
            tierName: 'Ultra',
            claude: { fiveHourRemainingPct: 92, weeklyRemainingPct: 79, fiveHourResetSec: 3600, weeklyResetSec: 172800 },
            gemini: { fiveHourRemainingPct: 80, weeklyRemainingPct: 90, fiveHourResetSec: 1800, weeklyResetSec: 86400 },
          },
          todayUsage: {
            date: '2026-11-26',
            requests: 120,
            totalTokens: 1_500_000,
            uncached: 150_000,
            cacheRead: 850_000,
            output: 500_000,
          },
          projects: [
            { id: 'proj-maga', name: 'MAGA', shortPath: '~/Developer/MAGA', worktrees: [{ branch: 'main', isMain: true }] },
          ],
          worktreeByCid: {
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1': { branch: 'feat/remote-dual-ui', repoName: 'MAGA', projectId: 'proj-maga' },
          },
          activeCascade: {
            cascadeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            opusGate: { proposal: { id: 'p-1' } },
            autoCompact: { pending: null },
          },
        },
        selectedConvo: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', title: 'Dual UI Test', status: 'IDLE', stepCount: 12 },
        snapshot: { cascadeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', status: 'IDLE', source: 'cdp', steps: [{ idx: 1 }] },
        selectedProjectId: '',
        onSelectProject: (pid) => {
          filteredPid = pid;
        },
      });
    } finally {
      dom.window.Element.prototype.setAttribute = origSetAttr;
    }
    assert.equal(inlineStyleAttrCalls, 0, 'renderOverviewPanel must never call setAttribute("style", ...) under strict CSP');
    const meterFills = Array.from(ovRoot.querySelectorAll('.rc-meter-fill'));
    assert.equal(meterFills.length, 4);
    assert.deepEqual(
      meterFills.map((n) => n.style.width),
      ['92%', '79%', '80%', '90%']
    );
    assert.deepEqual(
      Array.from(ovRoot.querySelectorAll('.rc-usage-seg')).map((n) => n.style.width),
      ['57%', '10%', '33%']
    );
    assert.match(ovRoot.textContent, /80% · 30m/);
    assert.match(ovRoot.textContent, /1\.5M tok/);
    assert.match(ovRoot.textContent, /缓存 85%/);
    assert.match(ovRoot.textContent, /feat\/remote-dual-ui/);
    assert.equal(ovRoot.textContent.includes('null'), false, 'Overview panel must never emit literal "null"');
    const projBtn = Array.from(ovRoot.querySelectorAll('button')).find((b) => b.textContent === '筛选');
    assert.ok(projBtn, 'expected project filter button in Overview panel');
    projBtn.click();
    assert.equal(filteredPid, 'proj-maga');

    // 3. Fenced code block wrapper with copy button + untouched pre.rc-pre textContent
    const codeMd = timelineMod.renderSafeMarkdown('```ts\nconst answer = 42;\n```');
    assert.ok(codeMd.querySelector('.rc-code-block'));
    assert.equal(codeMd.querySelector('.rc-code-head .rc-code-lang')?.textContent, 'ts');
    assert.ok(codeMd.querySelector('.rc-code-head .rc-code-copy'));
    assert.equal(codeMd.querySelector('pre.rc-pre')?.textContent, 'const answer = 42;');

    // 4. renderStepCard data-role attribute
    const userCard = timelineMod.renderStepCard({ idx: 1, type: 'USER_INPUT', status: 'DONE', text: 'Hi' });
    const botCard = timelineMod.renderStepCard({ idx: 2, type: 'PLANNER_RESPONSE', status: 'DONE', text: 'Hello' });
    const toolCard = timelineMod.renderStepCard({ idx: 3, type: 'GENERIC', status: 'DONE', toolCalls: [] });
    assert.equal(userCard.getAttribute('data-role'), 'user');
    assert.equal(botCard.getAttribute('data-role'), 'assistant');
    assert.equal(toolCard.getAttribute('data-role'), 'tool');

    // 5. Dual-UI polish regressions: Overview sync on host_status/onStatus, auto-refresh & read-only dock CSS
    const appSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'app.mjs'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'styles.css'), 'utf8');
    assert.match(appSrc, /if\s*\(kind\s*===\s*'host_status'\)[\s\S]*?renderStudioPanels\(\)/);
    assert.match(appSrc, /if\s*\(!wasAttached\s*&&\s*state\.hostAttached\)\s*\{\s*refreshAllData\(\);/);
    assert.match(appSrc, /onStatus:[\s\S]*?renderStudioPanels\(\)/);
    assert.ok(cssSrc.includes('.rc-composer-card[data-writable="false"]'));
    assert.ok(cssSrc.includes('.rc-group-subagent'));
    assert.ok(cssSrc.includes('.rc-app[data-layout-mode="mobile"][data-mobile-view="detail"] .rc-topbar'));
    assert.ok(cssSrc.includes('.rc-readonly-banner[data-writable="true"]'));
    assert.ok(cssSrc.includes('.rc-app[data-layout-mode="mobile"] .rc-footer-left'));
    assert.equal(cssSrc.includes(':has('), false);

    // 6. Mobile overflow menu Pure-DOM rendering & callbacks
    const studioPanelMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'studio-panel.mjs')).href);
    const menuEl = dom.window.document.createElement('div');
    let menuActions = [];
    studioPanelMod.renderMobileMoreMenu(menuEl, {
      open: true,
      hostLine: 'CDP 在线 (cdp)',
      role: 'steer',
      presetLabel: 'Review-Driven',
      layoutLabel: '视图: 自动',
      onCycleLayout: () => menuActions.push('layout'),
      onOpenOverview: () => menuActions.push('overview'),
      onRefreshAll: () => menuActions.push('refresh'),
      onUnpair: () => menuActions.push('unpair'),
    });
    assert.equal(menuEl.classList.contains('rc-hidden'), false);
    assert.match(menuEl.textContent, /CDP 在线 \(cdp\) · STEER/);
    for (const btn of menuEl.querySelectorAll('.rc-more-item')) btn.click();
    assert.deepEqual(menuActions, ['layout', 'overview', 'refresh', 'unpair']);
    studioPanelMod.renderMobileMoreMenu(menuEl, { open: false });
    assert.equal(menuEl.classList.contains('rc-hidden'), true);
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    dom.window.close();
  }
});

test('Phase 2 Composer Footer V2: models.list/select, convo.send image attachments, overview metrics & composer-bar DOM', async () => {
  lockMod.resetCascadeWriteLocksForTest();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-footerv2-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  const stateDir = path.join(tmpRoot, 'state');
  const convDir = path.join(tmpRoot, 'conversations');
  const sockPath = configMod.resolveSockPath(tmpRoot);
  const bootToken = 'footer-v2-boot-token-0123456789abc';
  const bridgeMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs')).href);
  const { attachedTargets } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'env.mjs')).href);
  const { createRemoteTapModule } = await import(pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'remote-tap.mjs')).href);
  const prevTargets = Array.from(attachedTargets.entries());
  const openSockets = [];
  let gw = null;

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://127.0.0.1:60000/c/11111111-1111-4111-8111-111111111111',
  });
  const keys = ['window', 'document'];
  const prevGlobals = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  let tap = null;

  try {
    const cid = '11111111-1111-4111-8111-111111111111';
    writeInterruptedConvDb(convDir, cid, { lastIdx: 2, stepType: 15, status: 3 });

    // 1. studio-bridge attaches sanitized metrics on activeCascade
    const ovWithMetrics = await studioBridgeMod.collectStudioOverview(
      { cascadeId: cid },
      {
        authorizedDirs: [],
        nativeProjectsDir: path.join(tmpRoot, 'no-projects'),
        convWtDir: path.join(tmpRoot, 'no-wt'),
        quotaOpts: { quotaStateFile: path.join(stateDir, 'quota-state.json') },
        opusOpts: { proposalsDir: path.join(stateDir, 'opus'), quotaStateFile: path.join(stateDir, 'quota-state.json') },
        compactOpts: { requestsDir: path.join(stateDir, 'compact') },
        listRepoWorktreesAsync: async () => ({ ok: true, worktrees: [] }),
        collectUsageStatsAsync: async () => ({ ok: true, days: [] }),
        parseConversationMetrics: (targetCid) => ({
          cascadeId: targetCid,
          hasData: true,
          metrics: {
            ctxPct: 64,
            ctxRatioStr: '164k / 256k',
            ctx: 164000,
            ctxLimit: 256000,
            ctxLimitStr: '256k',
            ctxClass: 'ag-ctx-ok',
            displayTps: 92.4,
            useStream: true,
            ttft: 1.3,
            totDur: 2.9,
            outTok: 268,
            lastCacheRate: 91.2,
            sessionCacheRate: 87.5,
          },
          stats: { turns: 4, calls: 9 },
        }),
      }
    );
    assert.equal(ovWithMetrics.activeCascade.metrics.ctxPct, 64);
    assert.equal(ovWithMetrics.activeCascade.metrics.ctxRatioStr, '164k / 256k');
    assert.equal(ovWithMetrics.activeCascade.metrics.turns, 4);

    // 2. End-to-End models.list, models.select & convo.send with image attachments
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;

    let modelSelectionState = {
      default: { model: 101 },
      byConversation: {},
      orchestratorByConversation: {},
    };
    const dispatched = [];
    const sentMessages = [];
    const mockStore = {
      subscribe: () => () => {},
      dispatch: (act) => {
        dispatched.push(act);
        if (act?.type === 'modelSelection/modelPicked') {
          const targetCid = act.payload?.cascadeId || act.payload?.conversationId || '';
          const entry = {
            model: act.payload.model,
            ...(act.payload.customLabel ? { customLabel: act.payload.customLabel } : {}),
          };
          if (targetCid) {
            modelSelectionState = {
              ...modelSelectionState,
              byConversation: { ...modelSelectionState.byConversation, [targetCid]: entry },
            };
          } else {
            modelSelectionState = { ...modelSelectionState, default: entry };
          }
        }
      },
      getState: () => ({
        userStatus: {
          permissionSettings: { globalPreset: 2 }, // REVIEW (no TURBO ack needed)
          cascadeModelConfigData: {
            clientModelConfigs: [
              { label: 'Gemini 4 Carbon (High)', modelId: 'gemini-4-carbon', modelOrAlias: { choice: { value: 101 } } },
              { label: 'Gemini 4 Carbon (Medium)', modelId: 'gemini-4-carbon', modelOrAlias: { choice: { value: 102 } } },
              { label: 'Claude Opus 5.5 (High)', modelId: 'claude-opus-5-5', modelOrAlias: { choice: { value: 201 } } },
              { label: 'Disabled Model (High)', modelId: 'disabled-m', disabled: true, modelOrAlias: { choice: { value: 999 } } },
            ],
          },
        },
        modelSelection: modelSelectionState,
        trajectorySummaries: {
          summaries: { [cid]: { summary: 'Footer V2 Chat', status: 1, waitingSteps: [] } },
        },
      }),
    };
    const mockLsClient = {
      sendUserCascadeMessage: async (arg) => sentMessages.push(arg),
      handleCascadeUserInteraction: async () => {},
      cancelCascadeInvocation: async () => {},
      createAgentStateProviderForConvo: () => ({ getState: () => null, onDidChange: () => ({ dispose: () => {} }), dispose: () => {} }),
      getCascadeTrajectory: async () => ({ trajectory: { steps: [] } }),
    };
    dom.window.document.getElementById('root').__reactContainer$fv2 = {
      memoizedProps: { store: mockStore, lsClient: mockLsClient },
      child: null,
      sibling: null,
    };

    tap = createRemoteTapModule({ state: { disposed: false } });
    const caps = dom.window.__agRemoteTap.getCapabilities().capabilities;
    assert.equal(caps.modelSelect, true);
    assert.equal(caps.imageAttachments, true);

    attachedTargets.clear();
    attachedTargets.set('fv2-host', {
      id: 'fv2-host',
      type: 'page',
      hostConfirmed: true,
      trustedContextId: 1,
      ws: { readyState: 1 },
      async send(method, params) {
        if (method === 'Runtime.evaluate') {
          const val = await dom.window.eval(String(params.expression || 'null'));
          return { result: { result: { value: val } } };
        }
        return {};
      },
    });

    await bridgeMod.initRemoteBridge({
      env: {
        ANTI_CLAUDE_STATE_DIR: stateDir,
        MAGA_REMOTE_STATE_DIR: remoteDir,
        MAGA_REMOTE_SOCK_PATH: sockPath,
        MAGA_REMOTE_UDS_TOKEN: bootToken,
        MAGA_REMOTE_CONV_DIR: convDir,
      },
      gatewayScript: path.join(tmpRoot, 'missing-gw.mjs'),
    });

    gw = await serverMod.createGatewayServer({
      remoteDir,
      sockPath,
      port: 0,
      writePid: false,
      udsWriteToken: bootToken,
    });

    const enrollAndConnect = async (role, name) => {
      configMod.writePairing(
        { code: `FV2_${name}`, expiresAt: Date.now() + 60_000, role, gatewayFingerprint: gw.gatewayFingerprint },
        { remoteDir }
      );
      const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
      const pr = await (
        await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: `FV2_${name}`, deviceName: name, publicKeyJwk, turboAcknowledged: true }),
        })
      ).json();
      const ch = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
      const sig = await signHello(kp.privateKey, { nonce: ch.nonce, deviceId: pr.deviceId, lastSeq: 0, lastEpoch: '' });
      const ws = await rawWsUpgrade(gw.port);
      openSockets.push(ws.socket);
      const reader = readServerFrames(ws.socket, ws.head);
      ws.socket.write(
        makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
          type: 'hello', protocol: 'maga-remote/1', deviceId: pr.deviceId, nonce: ch.nonce, signature: sig, lastSeq: 0, lastEpoch: '',
        })))
      );
      const welcome = JSON.parse((await reader.nextFrame()).payload.toString('utf8'));
      assert.equal(welcome.type, 'welcome');
      return { ws, reader };
    };

    const callRpc = async (c, reqId, method, params) => {
      c.ws.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId, method, params }))));
      return JSON.parse((await c.reader.nextFrame()).payload.toString('utf8'));
    };

    const cObs = await enrollAndConnect('observe', 'ObsFV2');
    const cSteer = await enrollAndConnect('steer', 'SteerFV2');

    // Pre-auth frame cap (32KB) closes oversized unauthenticated frames
    const rawUnauth = await rawWsUpgrade(gw.port);
    rawUnauth.socket.on('error', () => {});
    openSockets.push(rawUnauth.socket);
    const unauthReader = readServerFrames(rawUnauth.socket, rawUnauth.head);
    rawUnauth.socket.write(makeMaskedClientFrame(0x1, Buffer.alloc(40 * 1024, 0x41)));
    const closeFrame = await unauthReader.nextFrame();
    assert.equal(closeFrame.opcode, 0x8);

    // Observe can read models.list, disabled models excluded, blocked from models.select
    const mObs = await callRpc(cObs, 'm-1', 'models.list', { cascadeId: cid });
    assert.equal(mObs.ok, true);
    assert.equal(mObs.result.selected.value, 101);
    assert.equal(mObs.result.families.some((f) => /Disabled Model/.test(f.baseName)), false);
    const mSelObs = await callRpc(cObs, 'm-2', 'models.select', {
      cascadeId: cid, model: 102, idempotencyKey: 'k-obs-mod-1',
    });
    assert.equal(mSelObs.ok, false);
    assert.equal(mSelObs.error, 'forbidden_role_observe');

    // Steer can select model & persist into Redux modelSelection
    const mSelOk = await callRpc(cSteer, 'm-3', 'models.select', {
      cascadeId: cid, model: 102, idempotencyKey: 'k-st-mod-1',
    });
    assert.equal(mSelOk.ok, true);
    assert.equal(mSelOk.result.selected.value, 102);
    assert.equal(dispatched.some((a) => a.type === 'modelSelection/modelPicked' && a.payload?.model === 102), true);
    const mListAfter = await callRpc(cSteer, 'm-4', 'models.list', { cascadeId: cid });
    assert.equal(mListAfter.result.selected.value, 102);

    const mSelMissing = await callRpc(cSteer, 'm-5', 'models.select', {
      cascadeId: cid, model: 999999, idempotencyKey: 'k-st-mod-bad',
    });
    assert.equal(mSelMissing.ok, false);
    assert.equal(mSelMissing.error, 'model_not_found');

    // convo.send with image-only attachment (1x1 PNG)
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const imgSendRes = await callRpc(cSteer, 'img-1', 'convo.send', {
      cascadeId: cid,
      text: '',
      media: [{ name: 'shot.png', mimeType: 'image/png', dataBase64: pngB64 }],
      idempotencyKey: 'k-st-img-1',
    });
    assert.equal(imgSendRes.ok, true);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].items.length, 0);
    assert.equal(sentMessages[0].media.length, 1);
    assert.equal(sentMessages[0].media[0].$typeName, 'exa.codeium_common_pb.Media');
    assert.equal(sentMessages[0].media[0].payload.case, 'inlineData');
    assert.ok(sentMessages[0].media[0].payload.value instanceof Uint8Array);
    assert.ok(sentMessages[0].media[0].payload.value.length > 0);

    // Reject disallowed MIME & oversized base64
    const badMimeRes = await callRpc(cSteer, 'img-2', 'convo.send', {
      cascadeId: cid,
      text: 'bad svg',
      media: [{ name: 'bad.svg', mimeType: 'image/svg+xml', dataBase64: pngB64 }],
      idempotencyKey: 'k-st-img-badmime',
    });
    assert.equal(badMimeRes.ok, false);
    assert.equal(badMimeRes.error, 'unsupported_media_mime');

    const bigImgRes = await callRpc(cSteer, 'img-3', 'convo.send', {
      cascadeId: cid,
      text: 'too big',
      media: [{ name: 'big.png', mimeType: 'image/png', dataBase64: 'A'.repeat(625_000) }],
      idempotencyKey: 'k-st-img-big',
    });
    assert.equal(bigImgRes.ok, false);
    assert.equal(bigImgRes.error, 'invalid_media_data');

    // 2b. convo.send encodes /compact & /plan as official SlashCommandScopeItem chunks, keeps paths as plain text, and retains cache if composer unmounts
    const slashInputBox = dom.window.document.createElement('div');
    slashInputBox.id = 'antigravity.agentSidePanelInputBox';
    const compactInfo = { $typeName: 'exa.codeium_common_pb.SlashCommandInfo', name: 'compact', type: 1 };
    const planInfo = { $typeName: 'exa.codeium_common_pb.SlashCommandInfo', name: 'plan', type: 2 };
    slashInputBox.__reactFiber$slash = {
      memoizedProps: {
        handleSubmit: () => {},
        slashCommandItems: [
          { title: 'compact', info: compactInfo },
          { title: 'plan', info: planInfo },
        ],
      },
      return: null,
    };
    dom.window.document.body.appendChild(slashInputBox);

    const slashCompactRes = await callRpc(cSteer, 'sl-1', 'convo.send', {
      cascadeId: cid,
      text: '/compact',
      idempotencyKey: 'k-sl-compact-1',
    });
    assert.equal(slashCompactRes.ok, true);
    assert.equal(slashCompactRes.result.slashCommand, 'compact');
    const compactSent = sentMessages.at(-1);
    assert.equal(compactSent.items.length, 2);
    assert.equal(compactSent.items[0].chunk.case, 'item');
    assert.equal(compactSent.items[0].chunk.value.scopeItem.case, 'slashCommand');
    assert.deepEqual(compactSent.items[0].chunk.value.scopeItem.value.info, compactInfo);
    assert.equal(compactSent.items[1].chunk.case, 'text');
    assert.equal(compactSent.items[1].chunk.value, ' ');

    // Remove input box to verify cachedSlashCommands still encodes /plan with trailing prompt
    slashInputBox.remove();
    const slashPlanRes = await callRpc(cSteer, 'sl-2', 'convo.send', {
      cascadeId: cid,
      text: '/plan 设计方案',
      idempotencyKey: 'k-sl-plan-1',
    });
    assert.equal(slashPlanRes.ok, true);
    assert.equal(slashPlanRes.result.slashCommand, 'plan');
    const planSent = sentMessages.at(-1);
    assert.equal(planSent.items[0].chunk.value.scopeItem.value.info.name, 'plan');
    assert.equal(planSent.items[1].chunk.value, ' 设计方案');

    // Unix paths like /Users/demo/app.mjs must remain plain text
    const pathSendRes = await callRpc(cSteer, 'sl-3', 'convo.send', {
      cascadeId: cid,
      text: '/Users/demo/app.mjs',
      idempotencyKey: 'k-sl-path-1',
    });
    assert.equal(pathSendRes.ok, true);
    assert.equal(pathSendRes.result.slashCommand, undefined);
    assert.deepEqual(sentMessages.at(-1).items, [{ chunk: { case: 'text', value: '/Users/demo/app.mjs' } }]);

    // 3. composer-bar.mjs pure-DOM & Media Preview Strip XSS-safe tests
    const composerBarMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'composer-bar.mjs')).href);
    const doc = dom.window.document;
    const stripEl = doc.createElement('div');
    composerBarMod.renderMediaPreviewStrip(stripEl, [
      { id: '1', name: 'ok.png', sizeBytes: 4096, previewUrl: `data:image/png;base64,${pngB64}` },
      { id: '2', name: 'evil.png', sizeBytes: 100, previewUrl: 'javascript:alert(1)' },
    ]);
    assert.equal(stripEl.querySelectorAll('.rc-media-chip').length, 1, 'unsafe previewUrl must be filtered');

    const refs = {
      modelPopover: doc.createElement('div'),
      contextPopover: doc.createElement('div'),
      composerFooter: doc.createElement('div'),
    };
    let selectedPayload = null;
    let ctxToggleCount = 0;
    let compactTriggered = 0;
    composerBarMod.renderComposerFooterBar(refs, {
      catalog: {
        selected: { baseName: 'Gemini 4 Carbon', effort: 'High', displayEffort: 'High', value: 101 },
        families: [
          {
            baseName: 'Gemini 4 Carbon',
            group: 'primary',
            isOrchestrator: false,
            variants: [
              { effort: 'High', displayEffort: 'High', label: 'Gemini 4 Carbon (High)', value: 101 },
              { effort: 'Medium', displayEffort: 'Medium', label: 'Gemini 4 Carbon (Medium)', value: 102 },
            ],
          },
        ],
      },
      modelPopoverOpen: true,
      contextPopoverOpen: false,
      metrics: { ctxPct: 78, ctxRatioStr: '200k / 256k', ctxLimit: 256000, displayTps: 88.2, useStream: true, ttft: 1.2, lastCacheRate: 90, sessionCacheRate: 88, turns: 2, calls: 4 },
      isStreaming: false,
      canWrite: true,
      online: true,
      hasSelection: true,
      mediaCount: 1,
      onSelectModelOption: (p) => { selectedPayload = p; },
      onToggleContextPopover: () => { ctxToggleCount += 1; },
      onCompact: () => { compactTriggered += 1; },
    });
    assert.equal(refs.composerFooter.textContent.includes('null'), false);
    assert.equal(refs.modelPopover.textContent.includes('null'), false);
    assert.equal(refs.composerFooter.textContent.includes('/compact'), false, '/compact must be tucked inside context popover to prevent mobile misclicks');
    assert.match(refs.composerFooter.textContent, /\+ 图片 \(1\/4\)/);
    assert.match(refs.composerFooter.textContent, /Gemini 4 Carbon/);
    assert.match(refs.composerFooter.textContent, /78%/);
    assert.match(refs.composerFooter.textContent, /88 tok\/s · TTFT 1\.2s/);
    assert.equal(refs.composerFooter.querySelector('.rc-ctx-ring')?.getAttribute('data-tone'), 'warn');
    assert.equal(refs.contextPopover.classList.contains('rc-hidden'), true);
    const ctxPillBtn = refs.composerFooter.querySelector('button.rc-ctx-pill');
    assert.ok(ctxPillBtn, 'context ring pill must be an interactive button');
    ctxPillBtn.click();
    assert.equal(ctxToggleCount, 1);

    // Open secondary context popover -> shows usage details & /compact button
    composerBarMod.renderComposerFooterBar(refs, {
      catalog: null,
      modelPopoverOpen: false,
      contextPopoverOpen: true,
      metrics: { ctxPct: 78, ctxRatioStr: '200k / 256k', ctxLimit: 256000, lastCacheRate: 90, sessionCacheRate: 88, turns: 2, calls: 4 },
      canWrite: true,
      online: true,
      hasSelection: true,
      onCompact: () => { compactTriggered += 1; },
    });
    assert.equal(refs.contextPopover.classList.contains('rc-hidden'), false);
    assert.match(refs.contextPopover.textContent, /200k \/ 256k/);
    assert.match(refs.contextPopover.textContent, /90\.0%/);
    const compactBtn = refs.contextPopover.querySelector('.rc-ctx-compact-btn');
    assert.ok(compactBtn, '/compact button must live inside context popover');
    compactBtn.click();
    assert.equal(compactTriggered, 1);

    // Read-only mode can still view context popover stats without /compact write button
    composerBarMod.renderComposerFooterBar(refs, {
      catalog: null,
      contextPopoverOpen: true,
      metrics: { ctxPct: 42, ctxRatioStr: '108k / 256k', ctxLimit: 256000, lastCacheRate: 85, sessionCacheRate: 80, turns: 1, calls: 2 },
      canWrite: false,
      online: true,
      hasSelection: true,
    });
    assert.equal(refs.contextPopover.classList.contains('rc-hidden'), false);
    assert.equal(refs.contextPopover.querySelector('.rc-ctx-compact-btn'), null, 'observe role must not see /compact write button');

    // Re-render model popover open to verify effort click still works
    composerBarMod.renderComposerFooterBar(refs, {
      catalog: {
        selected: { baseName: 'Gemini 4 Carbon', effort: 'High', displayEffort: 'High', value: 101 },
        families: [
          {
            baseName: 'Gemini 4 Carbon',
            group: 'primary',
            isOrchestrator: false,
            variants: [
              { effort: 'High', displayEffort: 'High', label: 'Gemini 4 Carbon (High)', value: 101 },
              { effort: 'Medium', displayEffort: 'Medium', label: 'Gemini 4 Carbon (Medium)', value: 102 },
            ],
          },
        ],
      },
      modelPopoverOpen: true,
      contextPopoverOpen: false,
      canWrite: true,
      online: true,
      hasSelection: true,
      onSelectModelOption: (p) => { selectedPayload = p; },
    });
    const medBtn = Array.from(refs.modelPopover.querySelectorAll('.rc-effort-btn')).find((b) => b.textContent === 'Medium');
    assert.ok(medBtn);
    medBtn.click();
    assert.equal(selectedPayload?.model, 102);

    // Quota micro-pill replaces streaming timer in footer and shows pool remaining % + weekly details
    composerBarMod.renderComposerFooterBar(refs, {
      catalog: { selected: { baseName: 'Gemini 4 Carbon', effort: 'High', displayEffort: 'High', value: 101 }, families: [] },
      modelPopoverOpen: false,
      quota: {
        gemini: { fiveHourRemainingPct: 92, weeklyRemainingPct: 84 },
        claude: { fiveHourRemainingPct: 68, weeklyRemainingPct: 55 },
      },
      canWrite: true,
      online: true,
      hasSelection: true,
    });
    assert.match(refs.composerFooter.textContent, /G 5h 92%/);
    assert.match(refs.composerFooter.textContent, /周 84%/);
    assert.doesNotMatch(refs.composerFooter.textContent, /生成中/);

    // Clicking .rc-model-capsule detaches target via clearNode(footer) but must NOT auto-close during document bubble
    const cardHost = doc.createElement('div');
    cardHost.appendChild(refs.modelPopover);
    cardHost.appendChild(refs.composerFooter);
    doc.body.appendChild(cardHost);

    let popOpen = false;
    const renderPopTest = () => {
      composerBarMod.renderComposerFooterBar(refs, {
        catalog: {
          selected: { baseName: 'Gemini 4 Carbon', effort: 'High', displayEffort: 'High', value: 101 },
          families: [
            {
              baseName: 'Gemini 4 Carbon',
              group: 'primary',
              isOrchestrator: false,
              variants: [{ effort: 'High', displayEffort: 'High', label: 'Gemini 4 Carbon (High)', value: 101 }],
            },
          ],
        },
        modelPopoverOpen: popOpen,
        canWrite: false, // Read-only preview must also open popover
        online: true,
        hasSelection: true,
        onToggleModelPopover: () => {
          popOpen = !popOpen;
          renderPopTest();
        },
      });
    };
    const onOutsideClick = (ev) => {
      if (!popOpen) return;
      const p = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
      if (p.includes(cardHost) || cardHost.contains(ev.target)) return;
      popOpen = false;
      renderPopTest();
    };
    doc.addEventListener('click', onOutsideClick);
    try {
      renderPopTest();
      const capsuleBtn = refs.composerFooter.querySelector('.rc-model-capsule');
      assert.ok(capsuleBtn);
      assert.equal(capsuleBtn.disabled, false, 'read-only user should still inspect available models');
      capsuleBtn.click();
      assert.equal(popOpen, true, 'popover must stay open after click despite footer DOM re-render');
      assert.equal(refs.modelPopover.classList.contains('rc-hidden'), false);
      doc.body.click();
      assert.equal(popOpen, false, 'outside click must dismiss popover');
    } finally {
      doc.removeEventListener('click', onOutsideClick);
      cardHost.remove();
    }
  } finally {
    for (const s of openSockets) {
      try { s.destroy(); } catch {}
    }
    await gw?.close().catch(() => {});
    tap?.dispose();
    dom.window.close();
    for (const [k, desc] of prevGlobals.entries()) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
    attachedTargets.clear();
    for (const [k, v] of prevTargets) attachedTargets.set(k, v);
    await bridgeMod.shutdownRemoteBridge().catch(() => {});
    lockMod.resetCascadeWriteLocksForTest();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Remote stability & cache busting: versioned PWA assets, no-store headers, app-level ping alive, deltas.health & fresh page-load cursor', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-stab-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  const distOut = path.join(tmpRoot, 'dist');
  const openSockets = [];
  let gw = null;

  try {
    // 1. buildRemotePwa injects shared 8-hex buildHash into index.html & sw.js
    const buildMod = await import(pathToFileURL(path.join(REPO, 'studio', 'build.mjs')).href);
    const built = await buildMod.buildRemotePwa({ outDir: distOut, allowPrebuilt: false });
    assert.equal(built.ok, true);
    assert.match(built.buildHash, /^[0-9a-f]{8}$/);
    const builtHtml = fs.readFileSync(path.join(distOut, 'index.html'), 'utf8');
    const builtSw = fs.readFileSync(path.join(distOut, 'sw.js'), 'utf8');
    assert.ok(builtHtml.includes(`/styles.css?v=${built.buildHash}`), 'index.html must version styles.css');
    assert.ok(builtHtml.includes(`/app.js?v=${built.buildHash}`), 'index.html must version app.js');
    assert.ok(builtSw.includes(`maga-remote-shell-${built.buildHash}`), 'sw.js CACHE_NAME must match buildHash');
    assert.ok(
      builtSw.includes("const PRECACHE_PATHS = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest'];"),
      'sw.js must precache offline shell CSS/JS'
    );

    const appSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'app.mjs'), 'utf8');
    const ccMatch = appSrc.match(/addEventListener\('controllerchange',[\s\S]{0,400}/);
    assert.ok(ccMatch, 'app.mjs must register controllerchange listener');
    for (const guardKey of ['state.pairingCode', 'state.pairingBusy', 'state.sendBusy', 'state.draftText', 'state.draftMedia']) {
      assert.ok(ccMatch[0].includes(guardKey), `controllerchange must guard ${guardKey}`);
    }

    // 2. Gateway sets anti-cache headers on all static assets, resets ping timeout on app-level ping, uses fresh probe on pairing, and includes health in deltas replay
    const tapListeners = new Set();
    const bridgeHealthParams = [];
    const mockUds = {
      onTap(fn) {
        tapListeners.add(fn);
        return () => tapListeners.delete(fn);
      },
      onConnect() {
        return () => {};
      },
      async request(method, params) {
        if (method === 'bridge.health') {
          bridgeHealthParams.push(params || {});
          return { ok: true, hostAttached: true, globalPreset: 2, capabilities: { reduxSummaries: true, sendMessage: true } };
        }
        if (method === 'convo.list') {
          return { source: 'cdp', globalPreset: 2, conversations: [{ id: '11111111-1111-4111-8111-111111111111', title: 'Live' }] };
        }
        return { ok: true };
      },
      close() {},
    };

    gw = await serverMod.createGatewayServer({
      remoteDir,
      pwaDistDir: distOut,
      udsClient: mockUds,
      port: 0,
      writePid: false,
      pingIntervalMs: 35,
    });

    for (const assetPath of ['/', '/app.js?v=' + built.buildHash, '/styles.css?v=' + built.buildHash, '/sw.js']) {
      const res = await fetch(`http://127.0.0.1:${gw.port}${assetPath}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate', `${assetPath} must prevent CDN/browser cache`);
      assert.equal(res.headers.get('pragma'), 'no-cache');
    }

    const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
    configMod.writePairing(
      { code: 'STAB01', expiresAt: Date.now() + 60_000, role: 'steer', gatewayFingerprint: gw.gatewayFingerprint },
      { remoteDir }
    );
    const pairRes = await (
      await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'STAB01', deviceName: 'StabTest', publicKeyJwk, turboAcknowledged: true }),
      })
    ).json();
    assert.equal(pairRes.ok, true);
    assert.ok(
      bridgeHealthParams.some((p) => p?.fresh === true),
      'pairing must bypass bridge capability cache with fresh: true'
    );

    const readAppMsg = async (reader, expectType) => {
      for (let i = 0; i < 16; i += 1) {
        const frm = await reader.nextFrame();
        if (frm.opcode !== 0x1) continue;
        const parsed = JSON.parse(frm.payload.toString('utf8'));
        if (expectType === 'pong') {
          if (parsed?.type === 'pong') return parsed;
          continue;
        }
        if (parsed?.type === 'ping' || parsed?.type === 'pong') continue;
        if (!expectType || parsed?.type === expectType) return parsed;
      }
      throw new Error(`expected_frame_${expectType || 'app'}`);
    };

    const ch1 = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
    const sig1 = await signHello(kp.privateKey, { nonce: ch1.nonce, deviceId: pairRes.deviceId, lastSeq: 0, lastEpoch: '' });
    const ws1 = await rawWsUpgrade(gw.port);
    openSockets.push(ws1.socket);
    const r1 = readServerFrames(ws1.socket, ws1.head);
    ws1.socket.write(
      makeMaskedClientFrame(
        0x1,
        Buffer.from(
          JSON.stringify({
            type: 'hello',
            protocol: 'maga-remote/1',
            deviceId: pairRes.deviceId,
            nonce: ch1.nonce,
            signature: sig1,
            lastSeq: 0,
            lastEpoch: '',
          })
        )
      )
    );
    const welcomeMsg = await readAppMsg(r1, 'welcome');
    assert.equal(welcomeMsg.type, 'welcome');
    assert.equal(welcomeMsg.conversations.length, 1);

    // Respond only with application-level JSON pong/ping over 5 server ping cycles (> 3x pingIntervalMs): must NOT close!
    let closedEarly = false;
    ws1.socket.once('close', () => { closedEarly = true; });
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 38));
      ws1.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'ping', ts: Date.now() }))));
    }
    assert.equal(closedEarly, false, 'app-level ping activity must reset server heartbeat watchdog');

    // Non-numeric ping.ts coerces to finite numeric pong.ts
    ws1.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'ping', ts: 'bad-ts' }))));
    const coercedPong = await readAppMsg(r1, 'pong');
    assert.equal(typeof coercedPong.ts, 'number');
    assert.equal(Number.isFinite(coercedPong.ts), true);

    for (const fn of tapListeners) {
      fn({ kind: 'summaries', ts: Date.now(), data: { source: 'cdp', upserts: [] } });
      fn({ kind: 'summaries', ts: Date.now(), data: { source: 'cdp', upserts: [] } });
    }
    ws1.socket.destroy();

    // Replay reconnect receives deltas.health
    const ch2 = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
    const sig2 = await signHello(kp.privateKey, { nonce: ch2.nonce, deviceId: pairRes.deviceId, lastSeq: 1, lastEpoch: gw.epoch });
    const ws2 = await rawWsUpgrade(gw.port);
    openSockets.push(ws2.socket);
    const r2 = readServerFrames(ws2.socket, ws2.head);
    ws2.socket.write(
      makeMaskedClientFrame(
        0x1,
        Buffer.from(
          JSON.stringify({
            type: 'hello',
            protocol: 'maga-remote/1',
            deviceId: pairRes.deviceId,
            nonce: ch2.nonce,
            signature: sig2,
            lastSeq: 1,
            lastEpoch: gw.epoch,
          })
        )
      )
    );
    const deltasMsg = await readAppMsg(r2, 'deltas');
    assert.equal(deltasMsg.type, 'deltas');
    assert.equal(deltasMsg.items.map((x) => x.seq).at(-1), 2);
    assert.equal(deltasMsg.health?.hostAttached, true);
    ws2.socket.destroy();

    // 3. ws-client.mjs: fresh page-load cursor, single in-flight connect() on wake burst, and connected=true before deltas.onHealth
    const sentHellos = [];
    const sentRequests = [];
    let challengeFetchCount = 0;
    let onHealthError = null;
    const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const origDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const origFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
    const origWs = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    const origLs = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const listeners = new Map();
    const docListeners = new Map();
    let activeClient = null;
    try {
      globalThis.localStorage = {
        getItem: () => JSON.stringify({ lastSeq: 999, lastEpoch: 'stale-epoch-123' }),
        setItem: () => {},
      };
      globalThis.window = {
        location: { protocol: 'https:', host: 'remote.example.com' },
        addEventListener: (ev, fn) => listeners.set(ev, fn),
        removeEventListener: (ev) => listeners.delete(ev),
      };
      globalThis.document = {
        visibilityState: 'visible',
        addEventListener: (ev, fn) => docListeners.set(ev, fn),
        removeEventListener: (ev) => docListeners.delete(ev),
      };
      globalThis.fetch = async () => {
        challengeFetchCount += 1;
        await new Promise((r) => setTimeout(r, 25));
        return { ok: true, json: async () => ({ nonce: `nonce-fresh-${challengeFetchCount}` }) };
      };
      class MockWs {
        static OPEN = 1;
        static CONNECTING = 0;
        static CLOSING = 2;
        static CLOSED = 3;
        constructor() {
          this.readyState = 1;
          this._handlers = new Map();
          setTimeout(() => this._handlers.get('open')?.(), 0);
        }
        addEventListener(ev, fn) {
          this._handlers.set(ev, fn);
        }
        send(raw) {
          const parsed = JSON.parse(raw);
          if (parsed.type === 'hello') {
            sentHellos.push(parsed);
            setTimeout(() => {
              this._handlers.get('message')?.({
                data: JSON.stringify({
                  type: 'deltas',
                  seq: 1,
                  epoch: 'ep-mock-1',
                  health: { hostAttached: true, globalPreset: 2 },
                  items: [],
                }),
              });
            }, 0);
          } else if (parsed.type === 'req') {
            sentRequests.push(parsed);
          }
        }
        close() {
          this.readyState = 3;
        }
      }
      globalThis.WebSocket = MockWs;
      const wsClientMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'ws-client.mjs')).href);
      activeClient = wsClientMod.createRemoteWsClient(
        { deviceId: pairRes.deviceId, privateKey: kp.privateKey },
        {
          onHealth: () => {
            activeClient?.refreshList(false).catch((err) => {
              onHealthError = err;
            });
          },
        }
      );
      // Simultaneous wake events while /api/auth/challenge fetch is in flight must coalesce into 1 connect attempt
      listeners.get('focus')?.();
      listeners.get('online')?.();
      listeners.get('pageshow')?.();
      docListeners.get('visibilitychange')?.();
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(challengeFetchCount, 1, 'concurrent wake events must share single in-flight connect()');
      assert.equal(sentHellos.length, 1);
      assert.equal(sentHellos[0].lastSeq, 0, 'fresh page load must always send lastSeq=0 to get full welcome');
      assert.equal(sentHellos[0].lastEpoch, '', 'fresh page load must always send empty lastEpoch');
      assert.equal(onHealthError, null, 'deltas.onHealth must see connected=true without ws_not_connected');
      assert.ok(
        sentRequests.some((r) => r.method === 'convo.list'),
        'deltas.onHealth refreshList call must dispatch convo.list RPC'
      );
    } finally {
      activeClient?.dispose();
      const restore = (k, desc) => {
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      };
      restore('window', origWindow);
      restore('document', origDoc);
      restore('fetch', origFetch);
      restore('WebSocket', origWs);
      restore('localStorage', origLs);
    }
  } finally {
    for (const s of openSockets) {
      try { s.destroy(); } catch {}
    }
    await gw?.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Remote Desktop Parity: synced studioPrefs, elemental model capsule/picker filtering & streamlined timeline', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-parity-'));
  const studioPrefsFile = path.join(tmpRoot, 'studio-prefs.json');
  fs.writeFileSync(
    studioPrefsFile,
    JSON.stringify({
      customizeModelList: true,
      hiddenModels: ['Gemini 4 Argon', 'GPT-OSS 120B (Medium)'],
      defaultTierByFamily: {
        'Gemini 4 Carbon': 'high',
        'Gemini 4 Neon': 'high',
        'Gemini 4 Hydrogen': 'xhigh',
      },
      showModelDots: true,
      hideDefaultEffort: true,
      showEffortBar: true,
      hideThinkingProse: true,
    }),
    'utf8'
  );

  const studioBridgeMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote', 'studio-bridge.mjs')).href);
  const composerBarMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'composer-bar.mjs')).href);
  const timelineMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'timeline-view.mjs')).href);
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');

  try {
    // 1. Daemon readRemoteStudioPrefs exposes sanitized desktop prefs
    const prefs = studioBridgeMod.readRemoteStudioPrefs({ studioPrefsFile });
    assert.equal(prefs.customizeModelList, true);
    assert.deepEqual(prefs.hiddenModels, ['Gemini 4 Argon', 'GPT-OSS 120B (Medium)']);
    assert.equal(prefs.defaultTierByFamily['Gemini 4 Hydrogen'], 'xhigh');
    assert.equal(prefs.hideDefaultEffort, true);
    assert.equal(prefs.hideThinkingProse, true);

    Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
    const doc = dom.window.document;

    // 2. Desktop-parity model capsule & popover
    const refs = {
      modelPopover: doc.createElement('div'),
      composerFooter: doc.createElement('div'),
    };
    const catalog = {
      selected: {
        baseName: 'Orchestrator · Gemini 4 Neon',
        effort: 'High',
        displayEffort: 'High',
        value: 201,
        isOrchestrator: true,
        plannerValue: 10,
        plannerLabel: 'Gemini 4 Neon (High)',
      },
      families: [
        {
          baseName: 'Gemini 4 Carbon',
          group: 'primary',
          isOrchestrator: false,
          variants: [
            { effort: 'High', displayEffort: 'High', label: 'Gemini 4 Carbon (High)', value: 101 },
            { effort: 'Medium', displayEffort: 'Medium', label: 'Gemini 4 Carbon (Medium)', value: 102 },
          ],
        },
        {
          baseName: 'Gemini 4 Argon',
          group: 'primary',
          isOrchestrator: false,
          variants: [{ effort: 'High', displayEffort: 'High', label: 'Gemini 4 Argon (High)', value: 103 }],
        },
        {
          baseName: 'Gemini 4 Hydrogen',
          group: 'primary',
          isOrchestrator: false,
          variants: [
            { effort: 'High', displayEffort: 'High', label: 'Gemini 4 Hydrogen (High)', value: 104 },
            { effort: 'Extra High', displayEffort: 'Extra High', label: 'Gemini 4 Hydrogen (Extra High)', value: 105 },
          ],
        },
        {
          baseName: 'GPT-OSS 120B',
          group: 'other',
          isOrchestrator: false,
          variants: [{ effort: 'Medium', displayEffort: 'Medium', label: 'GPT-OSS 120B (Medium)', value: 106 }],
        },
        {
          baseName: 'Orchestrator · Gemini 4 Neon',
          group: 'orch',
          isOrchestrator: true,
          variants: [
            { effort: 'Low', displayEffort: 'Low', label: 'Gemini 4 Neon (Low)', value: 201, plannerValue: 9 },
            { effort: 'High', displayEffort: 'High', label: 'Gemini 4 Neon (High)', value: 201, plannerValue: 10 },
          ],
        },
      ],
    };

    let picked = null;
    let toggledHidden = false;
    composerBarMod.renderComposerFooterBar(refs, {
      catalog,
      studioPrefs: prefs,
      modelPopoverOpen: true,
      showHiddenModels: false,
      canWrite: true,
      online: true,
      hasSelection: true,
      onSelectModelOption: (p) => { picked = p; },
      onToggleShowHiddenModels: () => { toggledHidden = true; },
    });

    const capsule = refs.composerFooter.querySelector('.rc-model-capsule');
    assert.ok(capsule);
    assert.equal(capsule.getAttribute('data-is-orch'), '1');
    assert.equal(capsule.style.getPropertyValue('--rc-model-accent'), '#e14d67', 'Orchestrator Neon must resolve Neon accent');
    assert.ok(capsule.querySelector('.rc-model-orch-icon'), 'Orchestrator capsule must render prism SVG');
    assert.equal(capsule.querySelector('.rc-model-name-short')?.textContent, '路由');
    // hideDefaultEffort=true hides default High on Neon while keeping planner short name
    assert.equal(capsule.querySelector('.rc-effort-short')?.textContent, 'Neon');

    // Hidden models (Argon + GPT-OSS 120B) must be filtered out by default, with reveal toggle present
    const famButtons = Array.from(refs.modelPopover.querySelectorAll('.rc-model-fam-btn'));
    const famTexts = famButtons.map((b) => b.querySelector('.rc-model-fam-name')?.textContent);
    assert.equal(famTexts.includes('Gemini 4 Argon'), false, 'hidden Argon must be omitted');
    assert.equal(famTexts.includes('GPT-OSS 120B'), false, 'hidden GPT-OSS 120B (Medium) must match baseName');
    assert.ok(famTexts.includes('Gemini 4 Hydrogen'));
    const revealBtn = refs.modelPopover.querySelector('.rc-model-hidden-toggle');
    assert.ok(revealBtn && revealBtn.textContent.includes('(2)'));
    revealBtn.click();
    assert.equal(toggledHidden, true);

    // Clicking Hydrogen must pick defaultTierByFamily xhigh (value 105) instead of High (104)
    const hydroBtn = famButtons.find((b) => b.querySelector('.rc-model-fam-name')?.textContent === 'Gemini 4 Hydrogen');
    assert.ok(hydroBtn);
    hydroBtn.click();
    assert.equal(picked?.model, 105, 'clicking family must honor desktop defaultTierByFamily (xhigh)');

    // Regular model at default tier with hideDefaultEffort=true omits effort tag and shows colored dot
    composerBarMod.renderComposerFooterBar(refs, {
      catalog: { ...catalog, selected: { baseName: 'Gemini 4 Carbon', effort: 'High', displayEffort: 'High', value: 101 } },
      studioPrefs: prefs,
      modelPopoverOpen: false,
      canWrite: true,
      online: true,
      hasSelection: true,
    });
    const carbonCap = refs.composerFooter.querySelector('.rc-model-capsule');
    assert.equal(carbonCap.style.getPropertyValue('--rc-model-accent'), '#c78c3c');
    assert.ok(carbonCap.querySelector('.rc-model-dot'));
    assert.equal(carbonCap.querySelector('.rc-model-effort-tag'), null, 'default effort tag must hide when hideDefaultEffort=true');

    // 3. Streamlined output timeline: TOOL_CALL role, SYSTEM_MESSAGE suppression, activity grouping, hideThinkingProse & checkpoint
    const toolCallCard = timelineMod.renderStepCard({ idx: 5, type: 'TOOL_CALL', status: 'DONE', text: 'ls -la', toolCalls: [] });
    assert.equal(toolCallCard.getAttribute('data-role'), 'tool');

    const cid = '22222222-2222-4222-8222-222222222222';
    const tlRefs = {
      detailTitle: doc.createElement('div'),
      detailSub: doc.createElement('div'),
      timeline: doc.createElement('div'),
    };
    const tlState = {
      selectedId: cid,
      identity: { role: 'steer' },
      hostAttached: true,
      wsStatus: 'connected',
      conversations: [{ id: cid, title: 'Parity Chat', status: 'IDLE', waitingSteps: [] }],
      snapshots: new Map([
        [
          cid,
          {
            cascadeId: cid,
            status: 'IDLE',
            steps: [
              { idx: 1, type: 'USER_INPUT', status: 'DONE', text: '优化一下远程页面' },
              { idx: 2, type: 'PLANNER_RESPONSE', status: 'DONE', text: '', thinking: 'Hidden reasoning', toolCalls: [] },
              { idx: 3, type: 'GENERIC', status: 'DONE', toolCalls: [{ name: 'viewFile', args: '{"Path":"/a/b.mjs"}' }] },
              { idx: 4, type: 'SYSTEM_MESSAGE', status: 'DONE', text: 'Reminder: work efficiently. In this turn...' },
              { idx: 5, type: 'TOOL_CALL', status: 'DONE', text: 'npm test', toolCalls: [{ name: 'runCommand', args: '{"CommandLine":"npm test"}' }] },
              { idx: 6, type: 'CHECKPOINT', status: 'DONE', text: '' },
              { idx: 7, type: 'PLANNER_RESPONSE', status: 'DONE', text: '已经全部优化完成。', thinking: 'Final internal thought' },
            ],
            waitingSteps: [],
          },
        ],
      ]),
      streams: new Map(),
      studioOverview: { studioPrefs: prefs },
      modelCatalog: null,
      snapshotLoading: false,
      snapshotError: '',
      approvingHash: '',
    };

    timelineMod.renderDetailTimeline({ state: tlState, refs: tlRefs, onSelectConversation: () => {}, onApprove: () => {} });
    assert.equal(tlRefs.timeline.textContent.includes('Reminder: work efficiently'), false, 'internal SYSTEM_MESSAGE must be suppressed');
    assert.equal(tlRefs.timeline.textContent.includes('Final internal thought'), false, 'hideThinkingProse=true must hide thinking prose');
    const groups = tlRefs.timeline.querySelectorAll('.rc-activity-group');
    assert.equal(groups.length, 1, 'consecutive tools bridged by skipped SYSTEM_MESSAGE must collapse into 1 group');
    assert.match(groups[0].querySelector('.rc-activity-summary')?.textContent || '', /已执行 2 项操作 · 读取、命令/);
    assert.ok(tlRefs.timeline.querySelector('.rc-checkpoint-divider'), 'CHECKPOINT must render compact divider');
    assert.ok(tlRefs.timeline.textContent.includes('已经全部优化完成。'));

    // Chat bubble separation: compact user/assistant cards omit empty .rc-step-head and place timestamps in .rc-step-foot
    const compactUserWithTime = timelineMod.renderStepCard(
      { idx: 10, type: 'USER_INPUT', status: 'DONE', text: '直接部署', createdAt: '2026-11-27T03:08:52+08:00' },
      { compact: true }
    );
    assert.equal(compactUserWithTime.querySelector('.rc-step-head'), null, 'compact user bubble must not render empty top header');
    assert.ok(compactUserWithTime.querySelector('.rc-step-foot .rc-step-time'), 'compact user bubble must place timestamp in bottom footer');
    const compactBotWithTime = timelineMod.renderStepCard(
      { idx: 11, type: 'PLANNER_RESPONSE', status: 'DONE', text: '已完成。', createdAt: '2026-11-27T03:09:10+08:00' },
      { compact: true }
    );
    assert.equal(compactBotWithTime.querySelector('.rc-step-head'), null, 'compact assistant bubble must not render empty top header');
    assert.ok(compactBotWithTime.querySelector('.rc-step-foot .rc-step-time'), 'compact assistant bubble must place timestamp in bottom footer');
    const compactUserNoTime = timelineMod.renderStepCard(
      { idx: 12, type: 'USER_INPUT', status: 'DONE', text: '无时间戳' },
      { compact: true }
    );
    assert.equal(compactUserNoTime.querySelector('.rc-step-foot'), null, 'compact DONE bubble without timestamp should omit footer');

    const chatCss = fs.readFileSync(path.join(PWA_DIR, 'src', 'styles.css'), 'utf8');
    assert.ok(chatCss.includes('--rc-chat-bg:') && chatCss.includes('--rc-assistant-bubble:') && chatCss.includes('--rc-user-bubble:'));
    assert.ok(chatCss.includes('align-self: flex-end;') && chatCss.includes('align-self: flex-start;'));
    assert.equal(chatCss.includes(':has('), false, 'styles.css must never contain :has(');

    // With hideThinkingProse=false, thinking disclosure appears
    tlState.studioOverview = { studioPrefs: { ...prefs, hideThinkingProse: false } };
    timelineMod.renderDetailTimeline({ state: tlState, refs: tlRefs, onSelectConversation: () => {}, onApprove: () => {} });
    assert.equal(tlRefs.timeline.textContent.includes('Final internal thought'), true, 'hideThinkingProse=false must expose thinking prose');
  } finally {
    dom.window.close();
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Remote Mobile Polish V2: stale worktree branch cleanup, Markdown tables, assistant copy, mobile tok/s pill, PWA icons, alerts & convo.create', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-polish2-'));
  const projDir = path.join(tmpRoot, 'repo');
  const nativeProjectsDir = path.join(tmpRoot, 'projects');
  const convWtDir = path.join(tmpRoot, 'conv-wt');
  const distOut = path.join(tmpRoot, 'dist');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(nativeProjectsDir, { recursive: true });
  fs.mkdirSync(convWtDir, { recursive: true });

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });

  try {
    // 1. Deleted worktree clears stale branch badge while preserving repo/project metadata
    const liveCid = '33333333-3333-4333-8333-333333333331';
    const staleCid = '33333333-3333-4333-8333-333333333332';
    fs.writeFileSync(
      path.join(nativeProjectsDir, 'proj-maga.json'),
      JSON.stringify({ id: 'proj-maga', name: 'MAGA', folderUris: [`file://${projDir}`] })
    );
    fs.writeFileSync(
      path.join(convWtDir, `${liveCid}.json`),
      JSON.stringify({ worktreePath: path.join(tmpRoot, 'MAGA-wt', 'active-wt'), branch: 'feat/old-name', repoRoot: projDir, updatedAt: Date.now() })
    );
    fs.writeFileSync(
      path.join(convWtDir, `${staleCid}.json`),
      JSON.stringify({ worktreePath: path.join(tmpRoot, 'MAGA-wt', 'deleted-wt'), branch: 'feat/deleted-branch', repoRoot: projDir, updatedAt: Date.now() })
    );
    const ov = await studioBridgeMod.collectStudioOverview(
      {},
      {
        authorizedDirs: [projDir],
        nativeProjectsDir,
        convWtDir,
        listRepoWorktreesAsync: async () => ({
          ok: true,
          worktrees: [
            { realPath: projDir, branch: 'main', isMain: true },
            { realPath: path.join(tmpRoot, 'MAGA-wt', 'active-wt'), branch: 'feat/live-branch', isMain: false },
          ],
        }),
        collectUsageStatsAsync: async () => ({ ok: true, days: [] }),
      }
    );
    assert.equal(ov.worktreeByCid[liveCid].branch, 'feat/live-branch', 'active worktree must reflect live branch');
    assert.equal(ov.worktreeByCid[staleCid].branch, '', 'deleted worktree must clear stale branch badge');
    assert.equal(ov.worktreeByCid[staleCid].projectId, 'proj-maga', 'deleted worktree must keep project association');

    // 2. Markdown tables, italic/strikethrough, and one-tap assistant reply copy button
    const timelineMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'timeline-view.mjs')).href);
    const mdEl = timelineMod.renderSafeMarkdown(
      '结果如下：*斜体* 与 ~~废弃~~\n\n| 指标 | 状态 | 耗时 |\n| :--- | :---: | ---: |\n| 构建 | **通过** | `1.2s` |\n| 测试 | 208/208 | 14.5s |'
    );
    assert.ok(mdEl.querySelector('em')?.textContent === '斜体');
    assert.ok(mdEl.querySelector('del.rc-md-del')?.textContent === '废弃');
    const tbl = mdEl.querySelector('.rc-md-table-wrap table.rc-md-table');
    assert.ok(tbl, 'Markdown table must render inside scrollable wrapper');
    assert.equal(tbl.querySelectorAll('thead th').length, 3);
    assert.equal(tbl.querySelectorAll('tbody tr').length, 2);
    assert.equal(tbl.querySelectorAll('thead th')[1].getAttribute('data-align'), 'center');
    assert.equal(tbl.querySelectorAll('thead th')[2].getAttribute('data-align'), 'right');

    const botBubble = timelineMod.renderStepCard(
      { idx: 9, type: 'PLANNER_RESPONSE', status: 'DONE', text: '整条回复内容', createdAt: '2026-11-27T09:00:00+08:00' },
      { compact: true }
    );
    assert.ok(botBubble.querySelector('.rc-step-foot button.rc-step-copy'), 'compact assistant bubble must include one-tap copy button');

    // 3. Mobile tok/s-only metrics pill + TTFT inside context popover
    const composerBarMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'composer-bar.mjs')).href);
    const doc = dom.window.document;
    const refs = {
      modelPopover: doc.createElement('div'),
      contextPopover: doc.createElement('div'),
      composerFooter: doc.createElement('div'),
    };
    composerBarMod.renderComposerFooterBar(refs, {
      catalog: null,
      contextPopoverOpen: true,
      metrics: { ctxPct: 33, ctxRatioStr: '85k / 256k', ctxLimit: 256000, displayTps: 144.4, useStream: true, ttft: 4.0, lastCacheRate: 92, sessionCacheRate: 89, turns: 3, calls: 6 },
      canWrite: true,
      online: true,
      hasSelection: true,
    });
    assert.equal(refs.composerFooter.querySelector('.rc-metrics-tps')?.textContent, '144 tok/s');
    assert.equal(refs.composerFooter.querySelector('.rc-metrics-ttft')?.textContent, ' · TTFT 4.0s');
    assert.match(refs.contextPopover.textContent, /首字延迟 \(TTFT\)/);
    assert.match(refs.contextPopover.textContent, /4\.0s/);
    const cssSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'styles.css'), 'utf8');
    assert.ok(cssSrc.includes('.rc-app[data-layout-mode="mobile"] .rc-metrics-ttft'));
    assert.equal(cssSrc.includes(':has('), false);

    // 4. Mobile enhancements: TURBO collapsible bar, New Chat modal, Alert Manager
    const mobileEnhMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'mobile-enhancements.mjs')).href);
    const turboLabel = doc.createElement('label');
    const turboCb = doc.createElement('input');
    const turboSpan = doc.createElement('span');
    mobileEnhMod.syncTurboConfirmBar(turboLabel, turboCb, turboSpan, {
      writable: true,
      needTurboConfirm: true,
      confirmed: true,
      busy: false,
    });
    assert.equal(turboLabel.getAttribute('data-confirmed'), 'true');
    assert.match(turboSpan.textContent, /已确认/);

    const modalHost = doc.createElement('div');
    doc.body.appendChild(modalHost);
    let newChatSubmitted = 0;
    let promptDraft = '排查登录问题';
    mobileEnhMod.renderNewChatModal(modalHost, {
      open: true,
      projects: [{ id: 'proj-maga', name: 'MAGA' }],
      selectedProjectId: 'proj-maga',
      promptText: promptDraft,
      needTurboConfirm: true,
      turboConfirmed: true,
      online: true,
      onPromptChange: (val) => { promptDraft = val; },
      onSubmit: () => { newChatSubmitted += 1; },
    });
    assert.equal(modalHost.classList.contains('rc-hidden'), false);
    const firstTextarea = modalHost.querySelector('.rc-modal-textarea');
    const firstSelect = modalHost.querySelector('.rc-select');
    assert.ok(firstTextarea && firstSelect);
    firstTextarea.focus();
    assert.equal(doc.activeElement, firstTextarea);
    // Repeated background re-renders (e.g. 1s stream tick / WS delta calling syncComposerControls)
    // must patch in-place without recreating textarea or stealing focus/dismissing mobile keyboard
    mobileEnhMod.renderNewChatModal(modalHost, {
      open: true,
      projects: [{ id: 'proj-maga', name: 'MAGA' }],
      selectedProjectId: 'proj-maga',
      promptText: promptDraft,
      needTurboConfirm: true,
      turboConfirmed: true,
      online: true,
      onPromptChange: (val) => { promptDraft = val; },
      onSubmit: () => { newChatSubmitted += 1; },
    });
    assert.equal(modalHost.querySelector('.rc-modal-textarea'), firstTextarea, 'textarea node must stay mounted across re-renders');
    assert.equal(modalHost.querySelector('.rc-select'), firstSelect, 'select node must stay mounted across re-renders');
    assert.equal(doc.activeElement, firstTextarea, 'textarea focus must survive background re-renders');
    const submitBtn = modalHost.querySelector('.rc-new-chat-submit');
    assert.ok(submitBtn && submitBtn.disabled === false);
    submitBtn.click();
    assert.equal(newChatSubmitted, 1);
    mobileEnhMod.renderNewChatModal(modalHost, { open: false });
    assert.equal(modalHost.classList.contains('rc-hidden'), true);
    assert.equal(modalHost.childNodes.length, 0);

    const alerts = mobileEnhMod.createAlertManager({ baseTitle: 'AGY Test' });
    // First call seeds baseline
    const seedRes = alerts.observeConversations([{ id: liveCid, title: 'Build Task', status: 'RUNNING', waitingSteps: [] }]);
    assert.equal(seedRes.completed.length, 0);
    // Transition RUNNING -> IDLE emits completion
    const doneRes = alerts.observeConversations([{ id: liveCid, title: 'Build Task', status: 'IDLE', waitingSteps: [] }]);
    assert.equal(doneRes.completed.length, 1);
    // New waiting step emits approval alert
    const waitRes = alerts.observeConversations([{ id: liveCid, title: 'Build Task', status: 'WAITING_FOR_USER', waitingSteps: [{ stepIndex: 1 }] }]);
    assert.equal(waitRes.approvals.length, 1);

    // 5. PWA build copies real PNG icons & manifest points to /icon-192.png & /icon-512.png
    const buildMod = await import(pathToFileURL(path.join(REPO, 'studio', 'build.mjs')).href);
    const built = await buildMod.buildRemotePwa({ outDir: distOut, allowPrebuilt: false });
    assert.equal(built.ok, true);
    for (const icon of ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
      assert.ok(fs.existsSync(path.join(distOut, icon)), `${icon} must exist in built dist`);
      assert.ok(built.files[icon] > 500, `${icon} must be non-empty PNG`);
    }
    const manifestJson = JSON.parse(fs.readFileSync(path.join(distOut, 'manifest.webmanifest'), 'utf8'));
    assert.deepEqual(
      manifestJson.icons.map((i) => i.src),
      ['/icon-192.png', '/icon-512.png']
    );

    // 6. Real boot smoke test: evaluate compiled dist/app.js in JSDOM to catch any boot-time ReferenceError / blank screen
    const bootHtml = fs.readFileSync(path.join(distOut, 'index.html'), 'utf8');
    const bootJs = fs.readFileSync(path.join(distOut, 'app.js'), 'utf8');
    const bootDom = new JSDOM(bootHtml, { url: 'http://127.0.0.1/', runScripts: 'outside-only' });
    const bootErrors = [];
    bootDom.window.addEventListener('error', (ev) => bootErrors.push(String(ev.error || ev.message)));
    bootDom.window.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, hostAttached: false, globalPreset: 2 }),
    });
    try {
      bootDom.window.eval(bootJs);
      await new Promise((r) => setTimeout(r, 30));
      assert.deepEqual(bootErrors, [], 'compiled dist/app.js must boot cleanly with zero uncaught errors');
      assert.ok(
        (bootDom.window.document.getElementById('app')?.children?.length || 0) > 0,
        'compiled dist/app.js must mount UI into #app (no blank page)'
      );
    } finally {
      bootDom.window.close();
    }

    // 7. Android back-gesture History API controller: detail -> popstate returns to list; open popover closes first without leaving detail
    const navState = {
      mobileView: 'list',
      selectedId: liveCid,
      modelPopoverOpen: false,
      contextPopoverOpen: false,
      moreMenuOpen: false,
      newChatOpen: false,
      newChatBusy: false,
    };
    let navListCount = 0;
    let overlayCloseCount = 0;
    const histCtrl = mobileEnhMod.createMobileHistoryController({
      state: navState,
      getLayoutMode: () => 'mobile',
      onNavigateToList: () => {
        navState.mobileView = 'list';
        navListCount += 1;
      },
      onNavigateToDetail: () => {
        navState.mobileView = 'detail';
      },
      onCloseOverlays: () => {
        navState.modelPopoverOpen = false;
        overlayCloseCount += 1;
      },
      onCloseModal: () => {
        navState.newChatOpen = false;
      },
    });
    histCtrl.bind();
    navState.mobileView = 'detail';
    histCtrl.enterDetail(liveCid);
    assert.equal(dom.window.history.state?.rcView, 'detail');
    assert.equal(dom.window.history.state?.cid, liveCid);
    // Back gesture while popover is open closes popover and keeps detail active
    navState.modelPopoverOpen = true;
    histCtrl.handlePopState({ state: { rcView: 'list' } });
    assert.equal(overlayCloseCount, 1);
    assert.equal(navState.modelPopoverOpen, false);
    assert.equal(navState.mobileView, 'detail');
    // Second back gesture returns to conversation list instead of exiting PWA
    histCtrl.handlePopState({ state: { rcView: 'list' } });
    assert.equal(navListCount, 1);
    assert.equal(navState.mobileView, 'list');

    // 8. Standalone PWA viewport height sync & edge-to-edge gesture bar theme alignment
    assert.equal(cssSrc.includes('height: 100dvh'), false, 'styles.css must avoid 100dvh which clips bottom dock in Android standalone WebAPK');
    assert.ok(cssSrc.includes('height: var(--rc-app-h, 100%)'), 'styles.css must bind .rc-app height to --rc-app-h');
    assert.ok(cssSrc.includes('color-scheme: light dark'), 'styles.css must declare color-scheme: light dark for Android edge-to-edge gesture bar');
    assert.ok(bootHtml.includes('interactive-widget=resizes-content'), 'index.html must enable interactive-widget=resizes-content');
    assert.ok(bootHtml.includes('name="color-scheme" content="light dark"'), 'index.html must declare color-scheme meta');
    assert.equal(manifestJson.background_color, '#ffffff', 'manifest background_color should match light default to avoid black gesture bar');
    assert.equal(manifestJson.theme_color, '#ffffff', 'manifest theme_color should match light default to avoid black gesture bar');
    const unbindVp = mobileEnhMod.bindViewportHeightSync();
    assert.match(doc.documentElement.style.getPropertyValue('--rc-app-h'), /^\d+px$/);
    const liveThemeMeta = doc.getElementById('rc-theme-color-live');
    assert.ok(liveThemeMeta && /^#(ffffff|212120)$/i.test(liveThemeMeta.getAttribute('content') || ''), 'bindViewportHeightSync must sync live theme-color meta');
    unbindVp();

    // 9. Footer quota pill adapts to Claude model & Opus Gate banner includes both Review + Dismiss buttons
    const composerMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'composer-bar.mjs')).href);
    const studioPanelMod2 = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'studio-panel.mjs')).href);
    const quotaFooter = doc.createElement('div');
    const quotaPop = doc.createElement('div');
    const quotaCtxPop = doc.createElement('div');
    composerMod.renderComposerFooterBar(
      { composerFooter: quotaFooter, modelPopover: quotaPop, contextPopover: quotaCtxPop },
      {
        catalog: { families: [], selected: { baseName: 'Claude Opus 5.5', effort: 'High', displayEffort: 'High', value: 201 } },
        contextPopoverOpen: true,
        quota: {
          claude: { fiveHourRemainingPct: 22, weeklyRemainingPct: 48 },
          gemini: { fiveHourRemainingPct: 96, weeklyRemainingPct: 90 },
        },
        canWrite: true,
        online: true,
        hasSelection: true,
      }
    );
    assert.match(quotaFooter.textContent, /C 5h 22%/);
    assert.equal(quotaFooter.querySelector('.rc-quota-pill')?.getAttribute('data-tone'), 'warn');
    assert.match(quotaCtxPop.textContent, /Claude 剩余限额/);
    assert.match(quotaCtxPop.textContent, /Gemini 剩余限额/);

    const opusHost = doc.createElement('div');
    let reviewTriggered = null;
    let dismissTriggered = null;
    studioPanelMod2.renderOpusGateBanner(opusHost, {
      opusGate: { proposal: { id: 'p-risk-1', kind: 'risk', recommendedTier: 'high', summary: 'Pre-merge high-risk changes' } },
      canWrite: true,
      online: true,
      reviewerModel: 'carbon',
      onReview: (p, m) => { reviewTriggered = { id: p.id, model: m }; },
      onDismiss: (p) => { dismissTriggered = p.id; },
    });
    const revBtn = opusHost.querySelector('.rc-opus-review-btn');
    const disBtn = opusHost.querySelector('.rc-opus-dismiss-btn');
    assert.ok(revBtn && disBtn, 'Opus Gate banner must expose both Review and Dismiss buttons');
    assert.match(revBtn.textContent, /发起 Carbon 审查/);
    revBtn.click();
    disBtn.click();
    assert.deepEqual(reviewTriggered, { id: 'p-risk-1', model: 'carbon' });
    assert.equal(dismissTriggered, 'p-risk-1');

    // 10. Interactive askQuestion waiting card: renders single/multi options, recommended badge, write-in & submits structured answers
    const diskFallbackMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote', 'disk-fallback.mjs')).href);
    const askQuestions = [
      {
        question: '选择实现路线？',
        isMultiSelect: false,
        options: [
          { id: '1', text: '(Recommended) 轻量 Kotlin APK' },
          { id: '2', text: '全原生 Compose' },
        ],
      },
      {
        question: '附加能力？',
        isMultiSelect: true,
        options: [
          { id: '1', text: '原生通知' },
          { id: '2', text: '分享传图' },
        ],
      },
    ];
    const normalizedAsk = diskFallbackMod.normalizeWaitingStepsWithSha(liveCid, [
      {
        stepIndex: 9,
        toolName: 'ask_question',
        action: 'askQuestion',
        commandLine: '',
        trajectoryId: 'traj-ask-1',
        interactionCase: 'askQuestion',
        questions: askQuestions,
      },
    ]);
    assert.equal(normalizedAsk.length, 1);
    assert.match(normalizedAsk[0].waitingStepHash, /^[0-9a-f]{16}$/);
    assert.equal(normalizedAsk[0].questions.length, 2);

    let capturedAskDecision = null;
    let capturedAskExtra = null;
    const askCards = timelineMod.renderWaitingCards(normalizedAsk, {
      canWrite: true,
      hostAttached: true,
      onApprove: (w, dec, extra) => {
        capturedAskDecision = dec;
        capturedAskExtra = extra;
      },
    });
    assert.equal(askCards.length, 1);
    const askCard = askCards[0];
    assert.ok(askCard.classList.contains('rc-ask-card'));
    assert.match(askCard.textContent, /推荐/);
    const askSubmit = askCard.querySelector('.rc-ask-submit');
    assert.equal(askSubmit.disabled, true, 'submit starts disabled before any selection');
    const qBlocks = askCard.querySelectorAll('.rc-ask-q');
    assert.equal(qBlocks.length, 2);
    qBlocks[0].querySelector('[data-option-id="1"]').click();
    qBlocks[1].querySelector('[data-option-id="1"]').click();
    qBlocks[1].querySelector('[data-option-id="2"]').click();
    assert.equal(askSubmit.disabled, false);
    askSubmit.click();
    assert.equal(capturedAskDecision, 'answer_question');
    assert.deepEqual(capturedAskExtra, {
      answers: [
        { selectedOptionIds: ['1'], writeInResponse: '', skipped: false },
        { selectedOptionIds: ['1', '2'], writeInResponse: '', skipped: false },
      ],
    });

    // 11. Native Android shell bridge: insets, back gesture, shared images, focus conversation & native alerts
    const nativeBridgeMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'native-bridge.mjs')).href);
    const nativeNotifs = [];
    const nativeVibs = [];
    let nativeSettingsOpened = 0;
    let nativeWebReadyCalls = 0;
    let nativeResumed = 0;
    let nativeNetworkEvents = [];
    dom.window.__agyNative = {
      isNative: () => true,
      notify: (title, body, tag, category, cascadeId) => nativeNotifs.push({ title, body, tag, category, cascadeId }),
      vibrate: (patternJson) => nativeVibs.push(patternJson),
      requestNotificationPermission: () => {},
      openNativeSettings: () => { nativeSettingsOpened += 1; },
      onWebReady: () => { nativeWebReadyCalls += 1; },
    };
    const bridgeState = {
      mobileView: 'detail',
      modelPopoverOpen: true,
      contextPopoverOpen: false,
      moreMenuOpen: false,
      newChatOpen: false,
      newChatBusy: false,
      draftMedia: [],
      draftIdempotencyKey: '',
      actionError: '',
    };
    let bridgeFocusedCid = '';
    let bridgeListNavs = 0;
    const unbindNative = nativeBridgeMod.bindNativeAndroidBridge({
      state: bridgeState,
      canSteer: () => true,
      createIdempotencyKey: () => 'key-share-1',
      uuidRe: /^[0-9a-f-]{36}$/i,
      selectConversation: (id) => { bridgeFocusedCid = id; },
      syncComposerControls: () => {},
      setActionNotice: () => {},
      onCloseOverlays: () => { bridgeState.modelPopoverOpen = false; },
      onCloseModal: () => { bridgeState.newChatOpen = false; },
      onNavigateToList: () => { bridgeState.mobileView = 'list'; bridgeListNavs += 1; },
      onNativeResume: () => { nativeResumed += 1; },
      onNativeNetworkChange: (info) => nativeNetworkEvents.push(info),
    });
    assert.equal(nativeWebReadyCalls, 1, 'bindNativeAndroidBridge signals onWebReady to Android host');
    assert.equal(dom.window.__agyNativeResume(), true);
    assert.equal(nativeResumed, 1);
    assert.equal(dom.window.__agyNativeNetworkChange({ online: true, transport: 'cellular+vpn' }), true);
    assert.deepEqual(nativeNetworkEvents[0], { online: true, transport: 'cellular+vpn' });
    dom.window.__agyApplyNativeInsets({ top: 34, bottom: 24, left: 0, right: 0 });
    assert.equal(doc.documentElement.style.getPropertyValue('--rc-inset-top'), '34px');
    assert.equal(doc.documentElement.style.getPropertyValue('--rc-inset-bottom'), '24px');
    assert.equal(dom.window.__agyNativeBack(), true, 'first back closes open popover');
    assert.equal(bridgeState.modelPopoverOpen, false);
    assert.equal(dom.window.__agyNativeBack(), true, 'second back returns to list');
    assert.equal(bridgeListNavs, 1);
    assert.equal(dom.window.__agyNativeBack(), false, 'third back on list delegates exit to Android');
    assert.equal(dom.window.__agyFocusConversation(liveCid), true);
    assert.equal(bridgeFocusedCid, liveCid);
    const receivedCount = dom.window.__agyReceiveSharedMedia([
      { name: 'shot.jpg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
    ]);
    assert.equal(receivedCount, 1);
    assert.equal(bridgeState.draftMedia.length, 1);
    assert.equal(bridgeState.draftMedia[0].previewUrl, 'data:image/jpeg;base64,/9j/4AAQSkZJRg==');
    assert.equal(bridgeState.draftMedia[0].dataBase64, '/9j/4AAQSkZJRg==');
    const nativeAlerts = mobileEnhMod.createAlertManager({ baseTitle: 'AGY Native' });
    nativeAlerts.observeConversations([{ id: liveCid, title: 'Build APK', status: 'RUNNING', waitingSteps: [] }]);
    nativeAlerts.observeConversations([{ id: liveCid, title: 'Build APK', status: 'WAITING_FOR_USER', waitingSteps: [{ stepIndex: 1 }] }]);
    assert.equal(nativeNotifs.length, 1);
    assert.equal(nativeNotifs[0].category, 'approval');
    assert.equal(nativeNotifs[0].cascadeId, liveCid);
    assert.ok(nativeVibs.length >= 1);
    nativeBridgeMod.openNativeSettingsDialog();
    assert.equal(nativeSettingsOpened, 1);
    unbindNative();
    delete dom.window.__agyNative;

    // 12. Stability & Daily UX: bare URL auto-linkify, draft persistence, slash bar, connection notice & CF auth_expired
    const mdNode = timelineMod.renderSafeMarkdown(
      '下载链接：https://drive.google.com/file/d/1OOctBJrkguxO_nEepLNG/view?usp=drivesdk，详见 (https://example.com/a_(b))，代码 `https://code.ignored.test` 不转链接。'
    );
    const links = Array.from(mdNode.querySelectorAll('a.rc-md-link'));
    assert.equal(links.length, 2, 'auto-linkifies bare URLs while skipping inline code');
    assert.equal(links[0].getAttribute('href'), 'https://drive.google.com/file/d/1OOctBJrkguxO_nEepLNG/view?usp=drivesdk');
    assert.equal(links[1].getAttribute('href'), 'https://example.com/a_(b)');
    assert.equal(links[0].getAttribute('target'), '_blank');

    mobileEnhMod.saveConversationDraft(liveCid, '继续排查重连问题');
    assert.equal(mobileEnhMod.loadConversationDraft(liveCid), '继续排查重连问题');
    mobileEnhMod.saveConversationDraft(liveCid, '');
    assert.equal(mobileEnhMod.loadConversationDraft(liveCid), '');

    const slashHost = doc.createElement('div');
    let pickedSlash = '';
    mobileEnhMod.renderSlashCommandBar(slashHost, {
      draftText: '/co',
      writable: true,
      online: true,
      onPick: (cmd) => { pickedSlash = cmd; },
    });
    assert.equal(slashHost.classList.contains('rc-hidden'), false);
    const slashBtn = slashHost.querySelector('.rc-slash-chip');
    assert.ok(slashBtn);
    slashBtn.click();
    assert.equal(pickedSlash, '/compact');

    const noticeHost = doc.createElement('div');
    let reloginTriggered = 0;
    let reconnectTriggered = 0;
    mobileEnhMod.renderConnectionNoticeBar(noticeHost, {
      state: { wsStatus: 'auth_expired', wsDetail: 'CF expired', hostAttached: false },
      onRelogin: () => { reloginTriggered += 1; },
      onReconnect: () => { reconnectTriggered += 1; },
    });
    assert.equal(noticeHost.classList.contains('rc-hidden'), false);
    assert.equal(noticeHost.getAttribute('data-tone'), 'danger');
    noticeHost.querySelector('button').click();
    assert.equal(reloginTriggered, 1);

    mobileEnhMod.renderConnectionNoticeBar(noticeHost, {
      state: { wsStatus: 'offline', wsDetail: '网络断开', hostAttached: false },
      onReconnect: () => { reconnectTriggered += 1; },
    });
    assert.equal(noticeHost.getAttribute('data-tone'), 'warn');
    noticeHost.querySelector('button').click();
    assert.equal(reconnectTriggered, 1);

    // WS client detects Cloudflare Access redirect (opaqueredirect) -> auth_expired
    const wsClientMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'ws-client.mjs')).href);
    const origFetch = globalThis.fetch;
    const statuses = [];
    let clientUnderTest = null;
    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 0,
        type: 'opaqueredirect',
        redirected: true,
        url: 'https://team.cloudflareaccess.com/cdn-cgi/access/login',
        headers: { get: () => 'text/html' },
        json: async () => null,
      });
      clientUnderTest = wsClientMod.createRemoteWsClient(
        { deviceId: 'dev-cf-test', privateKey: {} },
        { onStatus: (st, det) => statuses.push({ st, det }) }
      );
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(statuses.some((s) => s.st === 'auth_expired'), 'opaqueredirect triggers auth_expired status');
      clientUnderTest.handleNetworkChange({ online: false, transport: 'none' });
      assert.ok(statuses.some((s) => s.st === 'offline'), 'handleNetworkChange(online=false) emits offline');
    } finally {
      clientUnderTest?.dispose();
      globalThis.fetch = origFetch;
    }

    // createOpusGateActions.triggerReview sends prompt string as 2nd positional arg to sendMessage
    const studioPanelMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'studio-panel.mjs')).href);
    const opusSendCalls = [];
    const opusDismissCalls = [];
    const opusState = {
      selectedId: liveCid,
      globalPreset: 2,
      turboWriteConfirmed: false,
      opusDismissBusy: false,
      actionError: '',
      actionNotice: '',
    };
    const opusActions = mobileEnhMod.createOpusGateActions({
      state: opusState,
      getWsClient: () => ({
        sendMessage: async (cid, text, opts) => opusSendCalls.push({ cid, text, opts }),
        dismissOpusProposal: async (cid, id, opts) => opusDismissCalls.push({ cid, id, opts }),
      }),
      canSteer: () => true,
      requiresTurboAck: () => false,
      createIdempotencyKey: () => 'opus-rev-key-1',
      buildPrompt: studioPanelMod.buildOpusReviewPrompt,
      setActionNotice: (msg) => { opusState.actionNotice = msg; },
      syncComposerControls: () => {},
      refreshStudioOverview: () => {},
      refreshAllData: () => {},
    });
    await opusActions.triggerReview({ id: 'prop-merge-1', kind: 'stop', reason: 'Pre-merge review', ts: 12345 }, 'carbon');
    assert.equal(opusSendCalls.length, 1);
    assert.equal(opusSendCalls[0].cid, liveCid);
    assert.equal(typeof opusSendCalls[0].text, 'string');
    assert.match(opusSendCalls[0].text, /gemini-4-carbon-high/);
    assert.equal(opusSendCalls[0].opts.idempotencyKey, 'opus-rev-key-1');
    assert.equal(opusDismissCalls.length, 1);
  } finally {
    dom.window.close();
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Android OTA Gateway Endpoints & Native Keep-Alive / Update Bridge', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-ota-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  const distDir = path.join(tmpRoot, 'dist');
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });

  let gw = null;
  try {
    const mockUds = {
      onTap: () => () => {},
      onConnect: () => () => {},
      request: async (method) => (method === 'bridge.health' ? { ok: true, hostAttached: true, globalPreset: 2 } : { ok: true }),
      close: () => {},
    };
    gw = await serverMod.createGatewayServer({
      remoteDir,
      pwaDistDir: distDir,
      udsClient: mockUds,
      port: 0,
      writePid: false,
    });
    const baseUrl = `http://127.0.0.1:${gw.port}`;

    // 1. Absent metadata/APK -> available: false and 404
    const missMeta = await (await fetch(`${baseUrl}/api/android/latest`)).json();
    assert.deepEqual(missMeta, { ok: true, available: false });
    const missApk = await fetch(`${baseUrl}/api/android/apk`);
    assert.equal(missApk.status, 404);
    const badMethod = await fetch(`${baseUrl}/api/android/latest`, { method: 'POST' });
    assert.equal(badMethod.status, 405);

    // 2. Valid APK + android-latest.json -> serves metadata, HEAD headers, and exact APK bytes
    const fakeApkBytes = Buffer.from('PK\x03\x04-fake-signed-android-apk-payload-1.4.0');
    const apkSha = crypto.createHash('sha256').update(fakeApkBytes).digest('hex');
    const apkPath = path.join(remoteDir, 'AGY-Studio-Remote.apk');
    const metaPath = path.join(remoteDir, 'android-latest.json');
    fs.writeFileSync(apkPath, fakeApkBytes);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        schema: 1,
        versionCode: 10400,
        versionName: '1.4.0',
        filename: 'AGY-Studio-Remote.apk',
        bytes: fakeApkBytes.length,
        sha256: apkSha,
        builtAt: '2026-11-27T14:40:00.000Z',
      })
    );

    const latestRes = await (await fetch(`${baseUrl}/api/android/latest`)).json();
    assert.equal(latestRes.ok, true);
    assert.equal(latestRes.available, true);
    assert.equal(latestRes.versionCode, 10400);
    assert.equal(latestRes.versionName, '1.4.0');
    assert.equal(latestRes.bytes, fakeApkBytes.length);
    assert.equal(latestRes.sha256, apkSha);
    assert.equal(latestRes.downloadPath, '/api/android/apk');

    const headRes = await fetch(`${baseUrl}/api/android/apk`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-type'), 'application/vnd.android.package-archive');
    assert.equal(headRes.headers.get('x-apk-sha256'), apkSha);

    const dlRes = await fetch(`${baseUrl}/api/android/apk`);
    assert.equal(dlRes.status, 200);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    assert.equal(Buffer.compare(dlBuf, fakeApkBytes), 0);

    // 3. Size mismatch or symlink must fail closed
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ versionCode: 10400, versionName: '1.4.0', bytes: fakeApkBytes.length + 10, sha256: apkSha })
    );
    const mismatchRes = await (await fetch(`${baseUrl}/api/android/latest`)).json();
    assert.deepEqual(mismatchRes, { ok: true, available: false });
    assert.equal((await fetch(`${baseUrl}/api/android/apk`)).status, 404);

    // 4. PWA Native Bridge keep-alive & update helpers + deduplicated notice status + More menu
    let keepAliveFlag = false;
    const statusUpdates = [];
    const updateChecks = [];
    dom.window.__agyNative = {
      isNative: () => true,
      getAppVersion: () => '1.4.0',
      isKeepAliveEnabled: () => keepAliveFlag,
      setKeepAliveEnabled: (v) => { keepAliveFlag = Boolean(v); return keepAliveFlag; },
      updateKeepAliveStatus: (txt) => statusUpdates.push(txt),
      checkForUpdate: (silent) => updateChecks.push(Boolean(silent)),
      openNativeSettings: () => {},
    };

    const nativeBridgeMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'native-bridge.mjs')).href);
    const mobileEnhMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'mobile-enhancements.mjs')).href);
    const studioPanelMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'studio-panel.mjs')).href);

    assert.equal(nativeBridgeMod.getNativeAppVersion(), '1.4.0');
    assert.equal(nativeBridgeMod.isNativeKeepAliveEnabled(), false);

    // Status emitted while keep-alive is OFF must not poison dedup once toggled ON
    const noticeHost = dom.window.document.createElement('div');
    const connState = { wsStatus: 'connected', wsRttMs: 28, hostAttached: true, conversations: [] };
    mobileEnhMod.renderConnectionNoticeBar(noticeHost, { state: connState });
    assert.equal(statusUpdates.length, 0, 'does not emit keep-alive status while service disabled');

    assert.equal(nativeBridgeMod.setNativeKeepAliveEnabled(true), true);
    assert.equal(nativeBridgeMod.isNativeKeepAliveEnabled(), true);
    nativeBridgeMod.checkNativeAppUpdate(false);
    assert.deepEqual(updateChecks, [false]);

    mobileEnhMod.renderConnectionNoticeBar(noticeHost, { state: connState });
    mobileEnhMod.renderConnectionNoticeBar(noticeHost, { state: connState });
    assert.equal(statusUpdates.length, 1, 'identical keep-alive status must be deduplicated while enabled');
    assert.match(statusUpdates[0], /已连接.*28ms/);

    mobileEnhMod.renderConnectionNoticeBar(noticeHost, {
      state: {
        wsStatus: 'connected',
        wsRttMs: 28,
        hostAttached: true,
        conversations: [{ id: 'c1', waitingSteps: [{ stepIndex: 1 }, { stepIndex: 2 }] }],
      },
    });
    assert.equal(statusUpdates.length, 2);
    assert.match(statusUpdates[1], /2 项待审批/);

    const menuEl = dom.window.document.createElement('div');
    const notices = [];
    const menuCtrl = mobileEnhMod.createMoreMenuController({
      state: {
        moreMenuOpen: true,
        wsStatus: 'connected',
        wsRttMs: 28,
        hostAttached: true,
        source: 'cdp',
        identity: { role: 'steer' },
        globalPreset: 2,
        layoutPref: 'auto',
      },
      getMenuEl: () => menuEl,
      getWsClient: () => null,
      renderMenu: studioPanelMod.renderMobileMoreMenu,
      formatPresetBadge: () => ({ label: 'REVIEW (2)' }),
      layoutButtonLabel: () => '视图: 自动',
      alertManager: { getAlertLabel: () => '提醒：开', toggleAlerts: () => true },
      setActionNotice: (msg) => notices.push(msg),
      writeLayoutPref: () => {},
      applyLayoutAttrs: () => {},
      renderSidebarList: () => {},
      renderStudioPanels: () => {},
      refreshAllData: () => {},
      handleUnpairDevice: () => {},
    });
    menuCtrl.render();
    let btns = Array.from(menuEl.querySelectorAll('button.rc-more-item'));
    const kaBtn = btns.find((b) => /后台常驻监听：已开启/.test(b.textContent || ''));
    const updBtn = btns.find((b) => /检查 App 更新 \(v1\.4\.0\)/.test(b.textContent || ''));
    assert.ok(kaBtn, 'more menu must show keep-alive toggle inside native APK');
    assert.ok(updBtn, 'more menu must show check-update button with current version');
    kaBtn.click();
    assert.equal(keepAliveFlag, false);

    // If Android FGS start is blocked (setKeepAliveEnabled returns false), show block notice and stay disabled
    dom.window.__agyNative.setKeepAliveEnabled = () => {
      keepAliveFlag = false;
      return false;
    };
    btns = Array.from(menuEl.querySelectorAll('button.rc-more-item'));
    const kaOffBtn = btns.find((b) => /后台常驻监听：已关闭/.test(b.textContent || ''));
    assert.ok(kaOffBtn);
    kaOffBtn.click();
    assert.match(notices[notices.length - 1], /系统当前限制开启后台常驻监听/);

    // Turning back on pushes current status immediately
    dom.window.__agyNative.setKeepAliveEnabled = (v) => {
      keepAliveFlag = Boolean(v);
      return keepAliveFlag;
    };
    Array.from(menuEl.querySelectorAll('button.rc-more-item')).find((b) => /后台常驻监听/.test(b.textContent || '')).click();
    assert.equal(statusUpdates.length, 3);
    assert.match(statusUpdates[2], /已连接.*28ms/);

    updBtn.click();
    assert.deepEqual(updateChecks, [false, false]);
    delete dom.window.__agyNative;
  } finally {
    await gw?.close().catch(() => {});
    dom.window.close();
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 2 modularization: workspace-shell DOM builder and convo-actions guards', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://127.0.0.1/',
  });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });

  try {
    const shellMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'workspace-shell.mjs')).href);
    const actionsMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'convo-actions.mjs')).href);

    const rootEl = dom.window.document.getElementById('app');
    const selectedProjects = [];
    const switchedTabs = [];
    const state = {
      layoutPref: 'auto',
      searchQuery: '',
      draftText: '',
      draftMedia: [],
      draftIdempotencyKey: 'k-init',
      turboWriteConfirmed: false,
      globalPreset: 3, // TURBO -> requires ack
      identity: { role: 'steer' },
      selectedId: '11111111-1111-4111-8111-111111111111',
      selectedProjectId: '',
      cancelConfirmArmedCid: '',
      sendBusy: false,
      cancelBusy: false,
      approvingHash: '',
      actionError: '',
      actionNotice: '',
      pendingApproveKeys: new Map(),
      pendingResumeKeys: new Map(),
      studioOverview: {
        projects: [
          { id: 'proj-a', name: 'RepoA' },
          { id: 'proj-b', name: 'RepoB' },
        ],
      },
    };

    const refs = shellMod.createWorkspaceShellDom({
      rootEl,
      state,
      layoutButtonLabel: (p) => `视图: ${p}`,
      handlers: {
        onSwitchMobileTab: (tab) => switchedTabs.push(tab),
      },
    });
    assert.ok(rootEl.contains(refs.topbar));
    assert.ok(rootEl.contains(refs.composerCard));
    assert.ok(rootEl.contains(refs.timeline));
    assert.ok(rootEl.contains(refs.mobileNav));
    assert.ok(rootEl.contains(refs.sidebarProjects));
    refs.navOverviewBtn.click();
    assert.deepEqual(switchedTabs, ['overview']);

    shellMod.renderSidebarProjectsBar(refs, state, {
      onSelectProject: (pid) => {
        selectedProjects.push(pid);
        state.selectedProjectId = pid;
      },
    });
    assert.equal(refs.sidebarProjects.classList.contains('rc-hidden'), false);
    const chips = Array.from(refs.sidebarProjects.querySelectorAll('button.rc-chip'));
    assert.equal(chips.length, 3);
    chips[1].click();
    assert.deepEqual(selectedProjects, ['proj-a']);
    shellMod.renderSidebarProjectsBar(refs, state, {
      onSelectProject: (pid) => selectedProjects.push(pid),
    });
    Array.from(refs.sidebarProjects.querySelectorAll('button.rc-chip'))[1].click();
    assert.deepEqual(selectedProjects, ['proj-a', '']);

    // Convo actions: TURBO ack guard, 2-tap cancel + resetCancelConfirm, approve key reuse & mismatch clear
    const sentPayloads = [];
    const canceledPayloads = [];
    const approveCalls = [];
    let approveShouldFail = 'transient_error';
    const notices = [];
    let refreshCount = 0;

    const mockWs = {
      async sendMessage(cid, text, opts) {
        sentPayloads.push({ cid, text, opts });
        return { ok: true };
      },
      async cancelConversation(cid, opts) {
        canceledPayloads.push({ cid, opts });
        return { ok: true };
      },
      async approveWaitingStep(cid, payload) {
        approveCalls.push({ cid, payload });
        if (approveShouldFail) {
          const err = new Error(approveShouldFail);
          err.code = approveShouldFail;
          throw err;
        }
        return { ok: true };
      },
    };

    let keySeq = 0;
    const actions = actionsMod.createConvoActionHandlers({
      state,
      getWsClient: () => mockWs,
      canSteer: () => true,
      createIdempotencyKey: () => `k-${++keySeq}`,
      setActionNotice: (msg) => notices.push(msg),
      syncComposerControls: () => {},
      renderDetailTimeline: () => {},
      fetchAndRenderSnapshot: () => {},
      refreshAllData: () => {
        refreshCount += 1;
      },
    });

    // 1. handleSendDraft blocks on unconfirmed TURBO
    state.draftText = 'hello world';
    state.turboWriteConfirmed = false;
    await actions.handleSendDraft();
    assert.equal(sentPayloads.length, 0);
    assert.match(state.actionError, /TURBO/);

    // Confirmed TURBO sends and clears draft
    state.turboWriteConfirmed = true;
    await actions.handleSendDraft();
    assert.equal(sentPayloads.length, 1);
    assert.equal(sentPayloads[0].text, 'hello world');
    assert.equal(sentPayloads[0].opts.turboWriteConfirmed, true);
    assert.equal(state.draftText, '');

    // 2. handleCancelConvo 2-tap arm -> resetCancelConfirm -> arm -> confirm
    await actions.handleCancelConvo();
    assert.equal(state.cancelConfirmArmedCid, state.selectedId);
    assert.equal(canceledPayloads.length, 0);
    actions.resetCancelConfirm();
    assert.equal(state.cancelConfirmArmedCid, '');

    await actions.handleCancelConvo();
    assert.equal(state.cancelConfirmArmedCid, state.selectedId);
    await actions.handleCancelConvo();
    assert.equal(canceledPayloads.length, 1);
    assert.equal(state.cancelConfirmArmedCid, '');

    // 3. handleApproveStep reuses idempotency key on transient error, clears on waiting_step_mismatch
    const step = { stepIndex: 7, waitingStepHash: 'hash-7' };
    await actions.handleApproveStep(step, 'allow_once');
    await actions.handleApproveStep(step, 'allow_once');
    assert.equal(approveCalls.length, 2);
    assert.equal(
      approveCalls[0].payload.idempotencyKey,
      approveCalls[1].payload.idempotencyKey,
      'transient failure must reuse same idempotencyKey on retry'
    );

    approveShouldFail = 'waiting_step_mismatch';
    const beforeRefresh = refreshCount;
    await actions.handleApproveStep(step, 'allow_once');
    assert.equal(approveCalls.length, 3);
    assert.equal(refreshCount, beforeRefresh + 1);

    approveShouldFail = null;
    await actions.handleApproveStep(step, 'allow_once');
    assert.equal(approveCalls.length, 4);
    assert.notEqual(
      approveCalls[3].payload.idempotencyKey,
      approveCalls[2].payload.idempotencyKey,
      'after waiting_step_mismatch cleared key, next attempt allocates a fresh idempotencyKey'
    );
    assert.match(notices[notices.length - 1], /Allow Once/);
  } finally {
    dom.window.close();
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
  }
});

test('Phase 2 v1.4.1 state-sync: resume/draft cleanup, per-cid approval locks, native keep-alive sync & streaming banners', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });

  try {
    const actionsMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'convo-actions.mjs')).href);
    const nativeBridgeMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'native-bridge.mjs')).href);
    const mobileEnhMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'mobile-enhancements.mjs')).href);

    const cidA = '11111111-1111-4111-8111-111111111111';
    const cidB = '22222222-2222-4222-8222-222222222222';
    const state = {
      selectedId: cidA,
      globalPreset: 2,
      draftText: 'first message',
      draftMedia: [],
      draftIdempotencyKey: 'k-init',
      turboWriteConfirmed: false,
      resumeState: { cascadeId: cidA, interrupted: true, active: false, lastIdx: 4, reason: 'interrupted' },
      snapshots: new Map([[cidA, { status: 'IDLE', resumeState: { cascadeId: cidA, interrupted: true, active: false, lastIdx: 4 } }]]),
      pendingApproveKeys: new Map(),
      pendingResumeKeys: new Map(),
      approvingByCid: new Map(),
      approvingHash: '',
      cancelConfirmArmedCid: '',
      sendBusy: false,
      resumeBusy: false,
      actionError: '',
      actionNotice: '',
    };

    let releaseFirstSend;
    let releaseFirstApprove;
    const approveStarted = [];
    const mockWs = {
      async sendMessage() {
        await new Promise((r) => {
          releaseFirstSend = r;
        });
        return { ok: true };
      },
      async resumeConversation() {
        return { ok: true };
      },
      async approveWaitingStep(cid) {
        approveStarted.push(cid);
        if (cid === cidA) {
          await new Promise((r) => {
            releaseFirstApprove = r;
          });
        }
        return { ok: true };
      },
    };

    let keySeq = 0;
    const actions = actionsMod.createConvoActionHandlers({
      state,
      getWsClient: () => mockWs,
      canSteer: () => true,
      createIdempotencyKey: () => `k-sync-${++keySeq}`,
      setActionNotice: (msg) => {
        state.actionNotice = msg;
      },
      syncComposerControls: () => {},
      renderDetailTimeline: () => {},
      fetchAndRenderSnapshot: () => {},
      refreshAllData: () => {},
    });

    // 1. handleResumeConvo clears BOTH state.resumeState AND cached snapshot.resumeState
    await actions.handleResumeConvo(state.resumeState);
    assert.equal(state.resumeState, null);
    assert.equal(state.snapshots.get(cidA)?.resumeState, null);

    // 2. handleSendDraft preserves newly typed in-flight text in localStorage instead of overwriting with ''
    const sendPromise = actions.handleSendDraft();
    state.draftText = 'typed while sending';
    releaseFirstSend();
    await sendPromise;
    assert.equal(state.draftText, 'typed while sending');
    assert.equal(mobileEnhMod.loadConversationDraft(cidA), 'typed while sending');

    // 3. Per-conversation approvingByCid lock: in-flight approval on cidA must NOT block cidB
    const pAppA = actions.handleApproveStep({ stepIndex: 1, waitingStepHash: 'h-a' }, 'allow_once');
    assert.equal(state.approvingByCid.get(cidA), 'h-a');
    state.selectedId = cidB;
    await actions.handleApproveStep({ stepIndex: 2, waitingStepHash: 'h-b' }, 'allow_once');
    assert.deepEqual(approveStarted, [cidA, cidB]);
    assert.equal(state.approvingByCid.has(cidB), false);
    assert.equal(state.approvingByCid.has(cidA), true);
    releaseFirstApprove();
    await pAppA;
    assert.equal(state.approvingByCid.has(cidA), false);

    // 4. Native keep-alive stop callback resets PWA dedup cache & fires onNativeKeepAliveChanged
    let keepAliveEnabled = true;
    const sentStatus = [];
    const kaChangedEvents = [];
    dom.window.__agyNative = {
      isNative: () => true,
      isKeepAliveEnabled: () => keepAliveEnabled,
      updateKeepAliveStatus: (txt) => sentStatus.push(txt),
    };
    const cleanupNative = nativeBridgeMod.bindNativeAndroidBridge({
      onNativeKeepAliveChanged: (val) => kaChangedEvents.push(val),
    });
    assert.equal(nativeBridgeMod.updateNativeKeepAliveStatus('已连接 · 20ms'), true);
    assert.equal(nativeBridgeMod.updateNativeKeepAliveStatus('已连接 · 20ms'), false, 'dedup skips identical text');
    keepAliveEnabled = false;
    assert.equal(dom.window.__agyNativeKeepAliveChanged(false), true);
    assert.deepEqual(kaChangedEvents, [false]);
    keepAliveEnabled = true;
    assert.equal(
      nativeBridgeMod.updateNativeKeepAliveStatus('已连接 · 20ms'),
      true,
      'after __agyNativeKeepAliveChanged cleared cache, status re-emits when re-enabled'
    );
    cleanupNative();
    delete dom.window.__agyNative;

    // 5. app.mjs streaming banner suppression, finish overview force, applySnapshot clearing, role/epoch hooks
    const appSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'app.mjs'), 'utf8');
    assert.match(appSrc, /const isStreaming =[\s\S]*?renderResumeBanner\([\s\S]*?isStreaming \? null : getEffectiveResumeState/);
    assert.match(appSrc, /const activeOpusGate =\s*!isStreaming\s*&&/);
    assert.match(appSrc, /scheduleSelectedSnapshotRefresh\(\{\s*forceOverview:\s*isFinished\s*\}\)/);
    assert.match(appSrc, /state\.resumeState\s*=\s*snap\.resumeState\s*\?\?\s*null;/);
    assert.match(appSrc, /onWelcome:\s*\(msg\)\s*=>\s*\{\s*state\.streams\.clear\(\);/);
    assert.match(appSrc, /onRoleChanged:\s*\(nextRole\)\s*=>/);
    assert.match(appSrc, /onEpochReset:\s*\(\)\s*=>\s*refreshAllData\(\)/);
  } finally {
    dom.window.close();
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
  }
});

test('Phase 2 v1.4.1 live role promotion push (ws-server -> ws-client) and epoch reset callback', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-rolepush-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  const distDir = path.join(tmpRoot, 'dist');
  fs.mkdirSync(remoteDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body></body></html>');

  let gw = null;
  const openSockets = [];
  const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const origDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const origFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const origWs = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const origLs = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let activeClient = null;

  try {
    const mockUds = {
      onTap: () => () => {},
      onConnect: () => () => {},
      request: async (method) => {
        if (method === 'bridge.health') {
          return { ok: true, hostAttached: true, globalPreset: 2, capabilities: { sendMessage: true } };
        }
        if (method === 'convo.list') return { source: 'cdp', globalPreset: 2, conversations: [] };
        return { ok: true };
      },
      close: () => {},
    };
    gw = await serverMod.createGatewayServer({
      remoteDir,
      pwaDistDir: distDir,
      udsClient: mockUds,
      port: 0,
      writePid: false,
      revocationCheckMs: 30,
    });

    const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
    configMod.writePairing(
      { code: 'PROMO1', expiresAt: Date.now() + 60_000, role: 'observe', gatewayFingerprint: gw.gatewayFingerprint },
      { remoteDir }
    );
    const pairRes = await (
      await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'PROMO1', deviceName: 'ObsPhone', publicKeyJwk, turboAcknowledged: true }),
      })
    ).json();
    assert.equal(pairRes.ok, true);
    assert.equal(pairRes.role, 'observe');

    const ch = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
    const sig = await signHello(kp.privateKey, { nonce: ch.nonce, deviceId: pairRes.deviceId, lastSeq: 0, lastEpoch: '' });
    const ws = await rawWsUpgrade(gw.port);
    openSockets.push(ws.socket);
    const reader = readServerFrames(ws.socket, ws.head);
    ws.socket.write(
      makeMaskedClientFrame(
        0x1,
        Buffer.from(
          JSON.stringify({
            type: 'hello',
            protocol: 'maga-remote/1',
            deviceId: pairRes.deviceId,
            nonce: ch.nonce,
            signature: sig,
            lastSeq: 0,
            lastEpoch: '',
          })
        )
      )
    );
    const welcome = JSON.parse((await reader.nextFrame()).payload.toString('utf8'));
    assert.equal(welcome.type, 'welcome');
    assert.equal(welcome.deviceRole, 'observe');

    // Promote device from observe -> steer on disk while socket stays connected
    let closedByServer = false;
    ws.socket.once('close', () => {
      closedByServer = true;
    });
    const devs = configMod.readDevices({ remoteDir });
    configMod.writeDevices(
      devs.map((d) => (d.deviceId === pairRes.deviceId ? { ...d, role: 'steer' } : d)),
      { remoteDir }
    );

    const roleMsg = JSON.parse((await reader.nextFrame()).payload.toString('utf8'));
    assert.equal(roleMsg.type, 'role_changed');
    assert.equal(roleMsg.role, 'steer');
    assert.equal(closedByServer, false, 'role promotion must keep existing WebSocket connected');
    ws.socket.destroy();

    // Verify ws-client.mjs dispatches onRoleChanged & onEpochReset
    const rolesSeen = [];
    const epochsSeen = [];
    globalThis.localStorage = { getItem: () => null, setItem: () => {} };
    globalThis.window = { location: { protocol: 'https:', host: 'remote.example.com' }, addEventListener: () => {}, removeEventListener: () => {} };
    globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ nonce: 'mock-n1' }) });
    let sockRef = null;
    globalThis.WebSocket = class {
      static OPEN = 1;
      static CONNECTING = 0;
      constructor() {
        this.readyState = 1;
        this._h = new Map();
        sockRef = this;
        setTimeout(() => this._h.get('open')?.(), 0);
      }
      addEventListener(ev, fn) {
        this._h.set(ev, fn);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
      emitJson(obj) {
        this._h.get('message')?.({ data: JSON.stringify(obj) });
      }
    };
    const wsClientMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'ws-client.mjs')).href);
    activeClient = wsClientMod.createRemoteWsClient(
      { deviceId: pairRes.deviceId, privateKey: kp.privateKey },
      {
        onRoleChanged: (r) => rolesSeen.push(r),
        onEpochReset: (ep) => epochsSeen.push(ep),
      }
    );
    await new Promise((r) => setTimeout(r, 30));
    sockRef.emitJson({ type: 'welcome', epoch: 'ep-1', seq: 1, health: { hostAttached: true }, conversations: [] });
    sockRef.emitJson({ type: 'role_changed', role: 'steer' });
    sockRef.emitJson({ type: 'delta', epoch: 'ep-2', seq: 1, kind: 'summaries', data: { upserts: [] } });
    sockRef.emitJson({ type: 'deltas', epoch: 'ep-3', seq: 1, items: [] });
    assert.deepEqual(rolesSeen, ['steer']);
    assert.deepEqual(epochsSeen, ['ep-2', 'ep-3']);
  } finally {
    activeClient?.dispose();
    const restore = (k, desc) => {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    };
    restore('window', origWindow);
    restore('document', origDoc);
    restore('fetch', origFetch);
    restore('WebSocket', origWs);
    restore('localStorage', origLs);
    for (const s of openSockets) s.destroy();
    await gw?.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Remote Desktop Workbench UI: CSS bundle/invariants, pane clamp, theme switch, overview dots, git scope & error collapse', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-workbench-'));
  const distOut = path.join(tmpRoot, 'dist');
  const { buildRemotePwa } = await import(pathToFileURL(path.join(REPO, 'studio', 'build.mjs')).href);
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://127.0.0.1/' });
  const prevDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevWin = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true });

  try {
    // 1. buildRemotePwa bundles @import "./styles/desktop-workbench.css" and enforces zero :has() / 100dvh
    await buildRemotePwa({ outDir: distOut });
    const bundledCss = fs.readFileSync(path.join(distOut, 'styles.css'), 'utf8');
    assert.ok(bundledCss.includes('--rc-sidebar-w') && bundledCss.includes('.rc-pane-resizer'));
    assert.ok(bundledCss.includes(':root[data-theme=light]') && bundledCss.includes(':root[data-theme=dark]'));
    assert.ok(bundledCss.includes('height: var(--rc-app-h, 100%)') && bundledCss.includes('color-scheme: light dark'));
    assert.equal(bundledCss.includes(':has('), false);
    assert.equal(bundledCss.includes('height: 100dvh'), false);

    // 2. Joint pane width clamp respects viewportWidth - otherPaneWidth - 480
    const uiHelpersMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'ui-helpers.mjs')).href);
    assert.equal(uiHelpersMod.getDefaultPaneWidth('sidebar', 1080), 236);
    assert.equal(uiHelpersMod.getDefaultPaneWidth('overview', 1600), 316);
    const clamped1080 = uiHelpersMod.clampPaneWidth('sidebar', 420, {
      viewportWidth: 1080,
      otherPaneWidth: 264,
      otherCollapsed: false,
    });
    assert.equal(clamped1080.max, 336);
    assert.equal(clamped1080.value, 336);
    const collapsedOther = uiHelpersMod.clampPaneWidth('sidebar', 420, {
      viewportWidth: 1080,
      otherPaneWidth: 264,
      otherCollapsed: true,
    });
    assert.equal(collapsedOther.value, 420);

    // 3. Theme switch updates data-theme & live theme-color meta
    const mobileEnhMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'mobile-enhancements.mjs')).href);
    const doc = dom.window.document;
    mobileEnhMod.applyThemePref('dark');
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(doc.getElementById('rc-theme-color-live')?.getAttribute('content'), '#212120');
    mobileEnhMod.applyThemePref('light');
    assert.equal(doc.documentElement.getAttribute('data-theme'), 'light');
    assert.equal(doc.getElementById('rc-theme-color-live')?.getAttribute('content'), '#ffffff');
    mobileEnhMod.applyThemePref('auto');
    assert.equal(doc.documentElement.hasAttribute('data-theme'), false);

    // 4. Overview panel renders legend dots & usage col track cleanly without setAttribute('style')
    const overviewMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'overview-panel.mjs')).href);
    const overviewSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'overview-panel.mjs'), 'utf8');
    assert.equal(overviewSrc.includes("setAttribute('style'"), false);
    const ovHost = doc.createElement('div');
    overviewMod.renderOverviewPanel(ovHost, {
      usageRange: '7d',
      onChangeUsageRange: () => {},
      overview: {
        todayUsage: { totalTokens: 1000, requests: 2, cacheRead: 700, uncached: 200, output: 100 },
        usageDays: [
          { date: '2026-11-27', totalTokens: 400, requests: 1, cacheRead: 250, uncached: 100, output: 50 },
          { date: '2026-11-28', totalTokens: 1000, requests: 2, cacheRead: 700, uncached: 200, output: 100 },
        ],
        projects: [{ id: 'p-1', name: 'MAGA', shortPath: '~/Developer/MAGA', isGitRepo: true, worktrees: [] }],
        worktreeByCid: {},
      },
    });
    assert.equal(ovHost.querySelectorAll('.rc-ov-legend-dot').length, 3);
    assert.equal(ovHost.querySelectorAll('.rc-usage-col-track .rc-usage-col-bar').length, 2);

    // 5. Composer bar omits duplicate desktop 回到底部 button
    const composerSrc = fs.readFileSync(path.join(PWA_DIR, 'src', 'composer-bar.mjs'), 'utf8');
    assert.equal(composerSrc.includes('回到底部'), false);

    // 6. Viewer drawer: unique repoName fallback, ambiguous repoName safety, cleaned worktree projectId, explicit repo switch, & gitError safety
    const viewerMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'viewer-drawer.mjs')).href);
    const scopeBaseState = {
      selectedId: 'cid-cleaned',
      selectedProjectId: '',
      viewer: viewerMod.createInitialViewerState(),
      studioOverview: {
        projects: [
          { id: 'proj-unique', name: 'UniqueRepo' },
          { id: 'proj-dup-1', name: 'SharedName' },
          { id: 'proj-dup-2', name: 'SharedName' },
        ],
        worktreeByCid: {
          'cid-cleaned': { branch: '', repoName: 'UniqueRepo', projectId: 'proj-unique' },
          'cid-ambig': { branch: '', repoName: 'SharedName', projectId: '' },
        },
      },
    };
    const cleanedScope = viewerMod.resolveGitScopeFromState(scopeBaseState, { cascadeId: 'cid-cleaned' });
    assert.equal(cleanedScope.projectId, 'proj-unique');
    assert.equal(cleanedScope.cascadeId, '');

    const ambigScope = viewerMod.resolveGitScopeFromState(
      { ...scopeBaseState, selectedId: 'cid-ambig' },
      { cascadeId: 'cid-ambig' }
    );
    assert.equal(ambigScope.projectId, '');

    const explicitSwitchScope = viewerMod.resolveGitScopeFromState(
      { ...scopeBaseState, viewer: { ...scopeBaseState.viewer, open: true, cascadeId: 'cid-cleaned' } },
      { projectId: 'proj-dup-2', cascadeId: '' }
    );
    assert.equal(explicitSwitchScope.projectId, 'proj-dup-2');
    assert.equal(explicitSwitchScope.cascadeId, '');

    const commitDrillScope = viewerMod.resolveGitScopeFromState({
      ...scopeBaseState,
      viewer: { ...scopeBaseState.viewer, open: true, projectId: 'proj-dup-2', cascadeId: '' },
    });
    assert.equal(commitDrillScope.projectId, 'proj-dup-2');
    assert.equal(commitDrillScope.cascadeId, '');

    const drawerHost = doc.createElement('div');
    viewerMod.renderViewerDrawer(drawerHost, {
      viewer: {
        ...viewerMod.createInitialViewerState(),
        open: true,
        tab: 'git',
        gitError: '该项目目录未在桌面端授权列表中',
        gitStatus: { branch: 'stale-branch', dirtyCount: 1, dirtyFiles: [{ path: 'stale.txt', status: 'M' }] },
      },
      projects: [{ id: 'proj-unique', name: 'UniqueRepo', shortPath: '~/UniqueRepo' }],
    });
    assert.ok(drawerHost.querySelector('.rc-error-banner'));
    assert.equal(drawerHost.textContent.includes('stale.txt'), false, 'gitError must not render stale gitStatus');

    const switcherHost = doc.createElement('div');
    viewerMod.renderViewerDrawer(switcherHost, {
      viewer: {
        ...viewerMod.createInitialViewerState(),
        open: true,
        tab: 'git',
        projectId: 'proj-unique',
        gitStatus: { branch: 'main', dirtyCount: 0, dirtyFiles: [], recentCommits: [], repoName: 'UniqueRepo', shortPath: '~/UniqueRepo' },
      },
      projects: [
        { id: 'proj-unique', name: 'UniqueRepo', shortPath: '~/UniqueRepo' },
        { id: 'proj-dup-1', name: 'SharedName', shortPath: '~/SharedName' },
      ],
      onSelectProjectGit: () => {},
    });
    assert.equal(switcherHost.querySelectorAll('select.rc-viewer-proj-select option').length, 2);

    // 7. Timeline view: consecutive errors collapse, compact empty error tag, and empty !cid shortcut card
    const timelineMod = await import(pathToFileURL(path.join(PWA_DIR, 'src', 'timeline-view.mjs')).href);
    const tlHost = doc.createElement('div');
    const tlTitle = doc.createElement('h2');
    const tlSub = doc.createElement('div');
    timelineMod.renderDetailTimeline({
      state: { selectedId: null, conversations: [], snapshots: new Map(), streams: new Map() },
      refs: { timeline: tlHost, detailTitle: tlTitle, detailSub: tlSub },
    });
    assert.ok(tlHost.querySelector('.rc-empty-card'));
    assert.equal(tlHost.querySelectorAll('.rc-empty-shortcuts .rc-kbd').length, 3);

    const groupedCid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee9';
    timelineMod.renderDetailTimeline({
      state: {
        selectedId: groupedCid,
        identity: { role: 'observe' },
        conversations: [{ id: groupedCid, title: 'Error Group Test', status: 'IDLE' }],
        snapshots: new Map([
          [
            groupedCid,
            {
              steps: [
                { idx: 1, type: 'ERROR_MESSAGE', status: 'ERROR', text: 'err one' },
                { idx: 2, type: 'ERROR_MESSAGE', status: 'ERROR', text: 'err two' },
                { idx: 3, type: 'USER_INPUT', status: 'DONE', text: 'retry' },
                { idx: 4, type: 'ERROR_MESSAGE', status: 'ERROR', text: '' },
              ],
            },
          ],
        ]),
        streams: new Map(),
      },
      refs: { timeline: tlHost, detailTitle: tlTitle, detailSub: tlSub },
    });
    assert.equal(tlHost.querySelectorAll('details.rc-error-group').length, 1);
    assert.ok(tlHost.querySelector('.rc-step[data-role="error"][data-empty="true"]'));
  } finally {
    if (prevDoc) Object.defineProperty(globalThis, 'document', prevDoc);
    else delete globalThis.document;
    if (prevWin) Object.defineProperty(globalThis, 'window', prevWin);
    else delete globalThis.window;
    dom.window.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
