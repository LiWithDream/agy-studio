/**
 * MAGA Remote Control — Hermetic Security, Gateway, Bridge, Tap & CLI Test Suite
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, fork, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GW_DIR = path.join(REPO, 'remote', 'gateway');
const PWA_DIR = path.join(REPO, 'remote', 'pwa');

const configMod = await import(pathToFileURL(path.join(GW_DIR, 'config.mjs')).href);
const transportMod = await import(pathToFileURL(path.join(GW_DIR, 'transport.mjs')).href);
const serverMod = await import(pathToFileURL(path.join(GW_DIR, 'server.mjs')).href);

function collectFiles(dir, { exts, skipDirs = [] } = {}) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skipDirs.includes(ent.name)) continue;
      out.push(...collectFiles(full, { exts, skipDirs }));
    } else if (!exts || exts.some((e) => ent.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
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

function createFakeUdsServer(
  sockPath,
  {
    globalPreset = 2,
    hostAttached = true,
    listDelayMs = 0,
    watchDelayMs = 0,
    writeDelayMs = 0,
    healthDelayMs = 0,
    expectedUdsToken = '',
    onListStart = null,
    onWrite = null,
  } = {}
) {
  const calls = [];
  const sockets = new Set();
  let curPreset = globalPreset;
  let curHealthDelayMs = healthDelayMs;
  let curWriteDelayMs = writeDelayMs;
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        calls.push(req);
        const reply = (result) => {
          if (!sock.destroyed && sock.writable) {
            try {
              sock.write(`${JSON.stringify({ id: req.id, ok: true, result })}\n`);
            } catch {}
          }
        };
        const replyError = (error) => {
          if (!sock.destroyed && sock.writable) {
            try {
              sock.write(`${JSON.stringify({ id: req.id, ok: false, error })}\n`);
            } catch {}
          }
        };
        if (req.method === 'bridge.health') {
          const sendHealth = () =>
            reply({
              ok: true,
              hostAttached,
              hostCount: hostAttached ? 1 : 0,
              capabilities: { reduxSummaries: true, agentStream: true, sendMessage: true, approval: true, cancel: true, diskRead: true },
              agVersion: '2.0.0',
              globalPreset: curPreset,
              tapActive: false,
              activeStreams: 0,
            });
          if (curHealthDelayMs > 0) setTimeout(sendHealth, curHealthDelayMs);
          else sendHealth();
        } else if (req.method === 'convo.list') {
          onListStart?.();
          setTimeout(() => {
            reply({
              source: 'cdp',
              globalPreset: curPreset,
              conversations: [
                { id: '11111111-1111-4111-8111-111111111111', title: 'Remote Task', status: 'IDLE', waitingSteps: [] },
              ],
            });
          }, listDelayMs);
        } else if (req.method === 'convo.snapshot') {
          reply({
            cascadeId: req.params.cascadeId,
            source: 'cdp',
            status: 'IDLE',
            steps: [{ idx: 0, type: 'USER_INPUT', status: 'DONE', text: 'hello' }],
            waitingSteps: [],
            streamingText: '',
          });
        } else if (req.method === 'convo.watch') {
          const delay = req.params.watch ? watchDelayMs : 0;
          setTimeout(() => {
            reply({ ok: true, watching: Boolean(req.params.watch), activeStreams: req.params.watch ? 1 : 0 });
          }, delay);
        } else if (req.method === 'tap.setActive') {
          reply({ ok: true, active: Boolean(req.params.active) });
        } else if (req.method === 'convo.send' || req.method === 'convo.approve' || req.method === 'convo.cancel') {
          if (expectedUdsToken && req.udsToken !== expectedUdsToken) {
            replyError('uds_unauthorized');
            continue;
          }
          setTimeout(async () => {
            try {
              const out = onWrite ? await onWrite(req) : { ok: true, cascadeId: req.params?.cascadeId };
              if (out && out.ok === false) replyError(out.error || 'write_failed');
              else reply(out || { ok: true, cascadeId: req.params?.cascadeId });
            } catch (err) {
              replyError(err?.code || err?.message || 'write_failed');
            }
          }, curWriteDelayMs);
        }
      }
    });
    sock.on('close', () => sockets.delete(sock));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      resolve({
        calls,
        setGlobalPreset(nextPreset) {
          curPreset = nextPreset;
        },
        setHealthDelayMs(ms) {
          curHealthDelayMs = ms;
        },
        setWriteDelayMs(ms) {
          curWriteDelayMs = ms;
        },
        destroySockets() {
          for (const s of sockets) {
            try {
              s.destroy();
            } catch {}
          }
        },
        pushTap(payload) {
          const line = `${JSON.stringify({ event: 'tap', payload })}\n`;
          for (const s of sockets) {
            if (!s.destroyed && s.writable) {
              try {
                s.write(line);
              } catch {}
            }
          }
        },
        close() {
          return new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          });
        },
      });
    });
  });
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
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

function makeMaskedClientFrame(opcode, payloadBuf = Buffer.alloc(0), fin = true) {
  const mask = crypto.randomBytes(4);
  const len = payloadBuf.length;
  let hdr;
  if (len < 126) {
    hdr = Buffer.allocUnsafe(2);
    hdr[0] = (fin ? 0x80 : 0x00) | opcode;
    hdr[1] = 0x80 | len;
  } else if (len <= 0xffff) {
    hdr = Buffer.allocUnsafe(4);
    hdr[0] = (fin ? 0x80 : 0x00) | opcode;
    hdr[1] = 0x80 | 126;
    hdr.writeUInt16BE(len, 2);
  } else {
    hdr = Buffer.allocUnsafe(10);
    hdr[0] = (fin ? 0x80 : 0x00) | opcode;
    hdr[1] = 0x80 | 127;
    hdr.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) masked[i] = payloadBuf[i] ^ mask[i & 3];
  return Buffer.concat([hdr, mask, masked]);
}

function readServerFrames(socket, head = Buffer.alloc(0)) {
  let buf = Buffer.from(head);
  const frames = [];
  const waiters = [];
  const pump = () => {
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) break;
        len = buf.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) break;
        len = Number(buf.readBigUInt64BE(off));
        off += 8;
      }
      if (buf.length < off + len) break;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      frames.push({ opcode, payload });
      while (waiters.length > 0 && frames.length > 0) {
        waiters.shift()(frames.shift());
      }
    }
  };
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  pump();
  return {
    nextFrame(timeoutMs = 2500) {
      if (frames.length > 0) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('frame_timeout')), timeoutMs);
        waiters.push((f) => {
          clearTimeout(t);
          resolve(f);
        });
      });
    },
  };
}

function udsRpcCall(sockPath, method, params = {}, udsToken = undefined) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: sockPath });
    sock.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`uds_rpc_timeout:${method}`));
    }, 3000);
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.once('connect', () => {
      const frame = { id: 'test-1', method, params };
      if (udsToken !== undefined) frame.udsToken = udsToken;
      sock.write(`${JSON.stringify(frame)}\n`);
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        const msg = JSON.parse(buf.slice(0, nl));
        sock.destroy();
        resolve(msg);
      }
    });
  });
}

test('Static security & MAGA architecture invariants for remote control modules', () => {
  const pwaSrcFiles = collectFiles(PWA_DIR, {
    exts: ['.html', '.js', '.mjs', '.css'],
    skipDirs: ['dist'],
  });
  assert.ok(pwaSrcFiles.length >= 6, 'expected PWA source files');
  for (const filePath of pwaSrcFiles) {
    const src = fs.readFileSync(filePath, 'utf8');
    assert.equal(
      /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(src),
      false,
      `Forbidden unsafe DOM HTML API found in ${path.relative(REPO, filePath)}`
    );
  }

  const pwaCssFiles = collectFiles(PWA_DIR, {
    exts: ['.css'],
    skipDirs: ['dist'],
  });
  assert.ok(pwaCssFiles.length >= 2, 'expected root styles.css and styles/ partials');
  for (const cssPath of pwaCssFiles) {
    const cssSrc = fs.readFileSync(cssPath, 'utf8');
    const rel = path.relative(REPO, cssPath);
    assert.equal(cssSrc.includes(':has('), false, `${rel} must have zero :has() selectors`);
    assert.equal(cssSrc.includes('height: 100dvh'), false, `${rel} must avoid height: 100dvh`);
  }

  assert.equal(
    transportMod.STRICT_CSP,
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  assert.equal(transportMod.STRICT_CSP.includes('ws:'), false);
  assert.equal(transportMod.STRICT_CSP.includes('wss:'), false);

  const gwFiles = collectFiles(GW_DIR, { exts: ['.mjs'] });
  assert.equal(gwFiles.length, 7, 'expected 7 gateway modules');
  const importRe = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  for (const filePath of gwFiles) {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    const src = fs.readFileSync(filePath, 'utf8');
    assert.ok(src.split('\n').length < 2000, `${path.relative(REPO, filePath)} must stay < 2000 lines`);
    importRe.lastIndex = 0;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('./') || spec === '../shared/fs-paths.mjs',
        `Third-party or unapproved import "${spec}" forbidden in ${path.relative(REPO, filePath)}`
      );
    }
  }

  const sharedFiles = collectFiles(path.join(REPO, 'remote', 'shared'), { exts: ['.mjs'] });
  assert.ok(sharedFiles.length >= 1, 'expected remote/shared/*.mjs modules');
  for (const filePath of sharedFiles) {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    const src = fs.readFileSync(filePath, 'utf8');
    assert.ok(src.split('\n').length < 2000, `${path.relative(REPO, filePath)} must stay < 2000 lines`);
    importRe.lastIndex = 0;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('./'),
        `Third-party or parent import "${spec}" forbidden in ${path.relative(REPO, filePath)}`
      );
    }
  }

  const pwaMjsFiles = collectFiles(path.join(PWA_DIR, 'src'), { exts: ['.mjs'] });
  assert.ok(pwaMjsFiles.length >= 3, 'expected PWA .mjs source modules');
  for (const filePath of pwaMjsFiles) {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
    const src = fs.readFileSync(filePath, 'utf8');
    assert.ok(src.split('\n').length < 2000, `${path.relative(REPO, filePath)} must stay < 2000 lines`);
  }

  const bridgeSubmodules = collectFiles(path.join(REPO, 'core', 'daemon', 'remote'), { exts: ['.mjs'] });
  assert.ok(bridgeSubmodules.length >= 2, 'expected core/daemon/remote/* submodules');

  for (const abs of [
    path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs'),
    path.join(REPO, 'studio', 'remote-cli.mjs'),
    ...bridgeSubmodules,
  ]) {
    const rel = path.relative(REPO, abs);
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    const src = fs.readFileSync(abs, 'utf8');
    assert.ok(src.split('\n').length < 2000, `${rel} must stay < 2000 lines`);
  }

  const userModDir = path.join(REPO, 'user', 'src', 'modules');
  const tapFiles = fs
    .readdirSync(userModDir)
    .filter((f) => f.startsWith('remote-tap') && f.endsWith('.mjs'))
    .sort();
  assert.ok(tapFiles.includes('remote-tap.mjs'), 'remote-tap.mjs must exist');
  for (const tf of tapFiles) {
    const absTap = path.join(userModDir, tf);
    execFileSync(process.execPath, ['--check', absTap], { stdio: 'pipe' });
    const tapSrc = fs.readFileSync(absTap, 'utf8');
    const tapCodeOnly = tapSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\bMutationObserver\b/.test(tapCodeOnly), false, `${tf} must never spawn MutationObserver`);
    assert.ok(tapSrc.split('\n').length < 2000, `${tf} must stay < 2000 lines`);
  }

  const daemonSrc = fs.readFileSync(path.join(REPO, 'core', 'daemon.mjs'), 'utf8');
  assert.ok(daemonSrc.split('\n').length < 350, 'core/daemon.mjs must stay < 350 lines');
});

test('Gateway enforces 127.0.0.1 bind, >95B UDS path fallback, Host/Origin checks, CSP, traversal defense & query-stripped audit', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-sec-'));
  let gw = null;
  try {
    const nonLoopbackDir = path.join(tmpRoot, 'non-loopback');
    await assert.rejects(
      () => serverMod.createGatewayServer({ remoteDir: nonLoopbackDir, host: '0.0.0.0', port: 0 }),
      /refusing_non_loopback_bind/
    );
    configMod.ensureRemoteDir(nonLoopbackDir);
    configMod.writeJsonAtomic(path.join(nonLoopbackDir, 'config.json'), { host: '0.0.0.0', port: 18791 });
    await assert.rejects(
      () => serverMod.createGatewayServer({ remoteDir: nonLoopbackDir, port: 0 }),
      /refusing_non_loopback_bind/
    );

    const longDir = path.join(tmpRoot, 'nested-' + 'x'.repeat(100));
    const degradedSock = configMod.resolveSockPath(longDir);
    if (process.platform === 'win32') {
      assert.ok(configMod.isWindowsNamedPipe(degradedSock));
      assert.ok(degradedSock.startsWith('\\\\.\\pipe\\maga-rem-'));
    } else {
      assert.ok(degradedSock.startsWith(os.tmpdir()));
      assert.ok(path.basename(degradedSock).startsWith('maga-rem-'));
      assert.ok(Buffer.byteLength(degradedSock, 'utf8') <= 95);
    }

    const remoteDir = path.join(tmpRoot, 'static');
    const distDir = path.join(tmpRoot, 'dist');
    const secretFile = path.join(tmpRoot, 'outside.txt');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(secretFile, 'SECRET_OUTSIDE_DIST');
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>OK</body></html>');
    let symlinkEscapeCreated = false;
    try {
      fs.symlinkSync(secretFile, path.join(distDir, 'escape.txt'));
      symlinkEscapeCreated = true;
    } catch (err) {
      if (process.platform !== 'win32' || err?.code !== 'EPERM') throw err;
    }

    gw = await serverMod.createGatewayServer({
      remoteDir,
      pwaDistDir: distDir,
      port: 0,
      writePid: true,
    });

    if (configMod.isPosixPermsEnforced()) {
      assert.equal(fs.statSync(remoteDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(gw.paths.identityFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(gw.paths.pidFile).mode & 0o777, 0o600);
      assert.equal(fs.statSync(gw.paths.auditFile).mode & 0o777, 0o600);
    }

    // gateway-identity.json holds persistent P-256 keypair, never exposed via /api/health
    const idDoc = JSON.parse(fs.readFileSync(gw.paths.identityFile, 'utf8'));
    assert.equal(idDoc.publicKeyJwk?.kty, 'EC');
    assert.equal(idDoc.privateKeyJwk?.kty, 'EC');

    const indexRes = await fetch(`http://127.0.0.1:${gw.port}/`);
    assert.equal(indexRes.status, 200);
    assert.equal(indexRes.headers.get('content-security-policy'), transportMod.STRICT_CSP);
    assert.equal(indexRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(indexRes.headers.get('referrer-policy'), 'no-referrer');

    const traversalStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: gw.port, path: '/%2e%2e/outside.txt' },
        (res) => resolve(res.statusCode)
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(traversalStatus, 403);

    if (symlinkEscapeCreated) {
      const symlinkRes = await fetch(`http://127.0.0.1:${gw.port}/escape.txt`);
      assert.equal(symlinkRes.status, 403);
    }

    const badHostStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: gw.port, path: '/api/health', headers: { Host: 'attacker.example' } },
        (res) => resolve(res.statusCode)
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(badHostStatus, 403);

    // Denied request with ?pair=SECRET must strip query string in audit.jsonl
    await fetch(`http://127.0.0.1:${gw.port}/?pair=SENSITIVE_PAIR_CODE`, {
      headers: { 'X-Forwarded-For': '9.9.9.9' },
    });
    const denyEvt = gw.audit.readTail(20).filter((e) => e.event === 'http_access_denied' && e.url).at(-1);
    assert.equal(denyEvt.url, '/');
    assert.equal(JSON.stringify(gw.audit.readTail(20)).includes('SENSITIVE_PAIR_CODE'), false);

    const badOrigin = await rawWsUpgrade(gw.port, { Origin: 'https://evil.example' });
    assert.equal(badOrigin.status, 403);
    const nullOrigin = await rawWsUpgrade(gw.port, { Origin: 'null' });
    assert.equal(nullOrigin.status, 403);
  } finally {
    await gw?.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Gateway enforces fail-closed edge authentication and rejects cloudflare-mtls or unknown transports', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-edge-'));
  const servers = [];
  try {
    // 1. Removed cloudflare-mtls and arbitrary unknown transports fail closed at both config & transport layers
    assert.throws(
      () => configMod.validateAndNormalizeConfig({ transport: 'cloudflare-mtls' }),
      /invalid_transport/
    );
    assert.throws(
      () => configMod.validateAndNormalizeConfig({ transport: 'custom-untrusted' }),
      /invalid_transport/
    );
    await assert.rejects(
      () =>
        serverMod.createGatewayServer({
          remoteDir: path.join(tmpRoot, 'mtls'),
          port: 0,
          writePid: false,
          config: { transport: 'cloudflare-mtls' },
        }),
      /invalid_transport/
    );
    const mtlsGuard = transportMod.createTransportGuard({
      config: { transport: 'cloudflare-mtls', allowedHosts: ['127.0.0.1'] },
    });
    const mtlsCheck = await mtlsGuard.verifyEdgeTransport({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-client-cert-fingerprint': 'aa'.repeat(32) },
    });
    assert.equal(mtlsCheck.ok, false);
    assert.equal(mtlsCheck.error, 'unsupported_transport');

    // 2. loopback rejects proxy headers
    const gwLoop = await serverMod.createGatewayServer({
      remoteDir: path.join(tmpRoot, 'loop'),
      port: 0,
      writePid: false,
    });
    servers.push(gwLoop);
    assert.equal((await fetch(`http://127.0.0.1:${gwLoop.port}/api/health`)).status, 200);
    assert.equal(
      (await fetch(`http://127.0.0.1:${gwLoop.port}/api/health`, { headers: { 'X-Forwarded-For': '1.2.3.4' } })).status,
      403
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${gwLoop.port}/api/health`, { headers: { 'CF-Connecting-IP': '1.2.3.4' } })).status,
      403
    );

    // 3. tailscale-serve
    const gwTs = await serverMod.createGatewayServer({
      remoteDir: path.join(tmpRoot, 'ts'),
      port: 0,
      writePid: false,
      config: { transport: 'tailscale-serve', tailscaleAllowedUsers: ['owner@example.com'] },
    });
    servers.push(gwTs);
    assert.equal((await fetch(`http://127.0.0.1:${gwTs.port}/api/health`)).status, 401);
    assert.equal(
      (await fetch(`http://127.0.0.1:${gwTs.port}/api/health`, { headers: { 'Tailscale-User-Login': 'intruder@example.com' } })).status,
      403
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${gwTs.port}/api/health`, { headers: { 'Tailscale-User-Login': 'Owner@Example.com' } })).status,
      200
    );

    // 4. cloudflare-access (RS256 JWKS)
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'cf-key-1', alg: 'RS256', use: 'sig' };
    const fakeNowMs = 1_700_000_000_000;
    const nowSec = Math.floor(fakeNowMs / 1000);
    const signJwt = (hdr, payload) => {
      const h = Buffer.from(JSON.stringify(hdr)).toString('base64url');
      const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url');
      return `${h}.${p}.${sig}`;
    };

    const gwCf = await serverMod.createGatewayServer({
      remoteDir: path.join(tmpRoot, 'cf'),
      port: 0,
      writePid: false,
      now: () => fakeNowMs,
      config: {
        transport: 'cloudflare-access',
        cfAccessTeamDomain: 'team.cloudflareaccess.com',
        cfAccessAud: 'aud-maga-1',
      },
      jwksFetcher: async () => ({ keys: [rsaJwk] }),
    });
    servers.push(gwCf);

    assert.equal((await fetch(`http://127.0.0.1:${gwCf.port}/api/health`)).status, 401);
    const goodJwt = signJwt(
      { alg: 'RS256', kid: 'cf-key-1' },
      { aud: ['aud-maga-1'], iss: 'https://team.cloudflareaccess.com', exp: nowSec + 120, nbf: nowSec - 5, email: 'owner@example.com' }
    );
    const badAudJwt = signJwt({ alg: 'RS256', kid: 'cf-key-1' }, { aud: ['wrong-aud'], exp: nowSec + 120 });
    const expiredJwt = signJwt({ alg: 'RS256', kid: 'cf-key-1' }, { aud: ['aud-maga-1'], exp: nowSec - 1 });
    assert.equal(
      (await fetch(`http://127.0.0.1:${gwCf.port}/api/health`, { headers: { 'Cf-Access-Jwt-Assertion': goodJwt } })).status,
      200
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${gwCf.port}/api/health`, { headers: { 'Cf-Access-Jwt-Assertion': badAudJwt } })).status,
      401
    );
    assert.equal(
      (await fetch(`http://127.0.0.1:${gwCf.port}/api/health`, { headers: { 'Cf-Access-Jwt-Assertion': expiredJwt } })).status,
      401
    );
  } finally {
    await Promise.allSettled(servers.map((s) => s.close()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Pairing TURBO fail-closed, 5-failure lockout, domain-separated hello, epoch/seq0 zero-race, stream non-ring, live revocation 4001 & watch leak guard', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-ws-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  const sockPath = configMod.resolveSockPath(tmpRoot);
  let udsServer = null;
  let gw = null;
  let gwRestarted = null;
  const openSockets = [];

  try {
    // 1. Fail-closed TURBO gate when UDS health is missing or globalPreset === null
    const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
    let clockMs = 1_700_000_000_000;

    const gwNoUds = await serverMod.createGatewayServer({
      remoteDir: path.join(tmpRoot, 'no-uds'),
      sockPath: configMod.resolveSockPath(path.join(tmpRoot, 'no-uds-missing')),
      port: 0,
      now: () => clockMs,
      writePid: false,
    });
    try {
      configMod.writePairing(
        { code: 'NO-UDS-CODE', role: 'observe', gatewayFingerprint: gwNoUds.gatewayFingerprint, createdAt: clockMs, expiresAt: clockMs + 60_000 },
        { remoteDir: gwNoUds.paths.remoteDir }
      );
      const noAck = await fetch(`http://127.0.0.1:${gwNoUds.port}/api/pair/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'NO-UDS-CODE', deviceName: 'Phone', publicKeyJwk, turboAcknowledged: false }),
      });
      assert.equal(noAck.status, 400);
      assert.equal((await noAck.json()).error, 'turbo_acknowledgement_required');
    } finally {
      await gwNoUds.close();
    }

    // 2. Full UDS + Gateway test with in-flight welcome buffering and delayed watch
    configMod.ensureRemoteDir(remoteDir);
    let emitDuringWelcome = true;
    udsServer = await createFakeUdsServer(sockPath, {
      globalPreset: 3,
      hostAttached: true,
      listDelayMs: 50,
      watchDelayMs: 60,
      onListStart: () => {
        if (!emitDuringWelcome) return;
        emitDuringWelcome = false;
        setTimeout(() => {
          udsServer.pushTap({ kind: 'summaries', ts: clockMs, data: { duringWelcome: true } });
        }, 15);
      },
    });

    gw = await serverMod.createGatewayServer({
      remoteDir,
      sockPath,
      port: 0,
      now: () => clockMs,
      helloTimeoutMs: 120,
      tapDeactivateDelayMs: 70,
      revocationCheckMs: 50,
    });

    configMod.writePairing(
      {
        code: 'ONCE-PAIR-CODE',
        role: 'steer',
        gatewayFingerprint: gw.gatewayFingerprint,
        createdAt: clockMs,
        expiresAt: clockMs + 60_000,
      },
      { remoteDir }
    );

    const noTurbo = await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ONCE-PAIR-CODE', deviceName: 'Phone', publicKeyJwk, turboAcknowledged: false }),
    });
    assert.equal(noTurbo.status, 400);

    const pairedRes = await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ONCE-PAIR-CODE', deviceName: 'Phone', publicKeyJwk, turboAcknowledged: true }),
    });
    assert.equal(pairedRes.status, 200);
    const paired = await pairedRes.json();
    assert.equal(paired.ok, true);
    assert.equal(fs.existsSync(gw.paths.pairingFile), false, 'pairing code consumed immediately');

    // Stale devices.json.lock (>5s) is automatically healed by withDevicesLock
    fs.writeFileSync(gw.paths.devicesLockFile, JSON.stringify({ pid: 999999, ts: Date.now() - 10_000 }));
    let lockCallbackRan = false;
    await configMod.withDevicesLock(() => {
      lockCallbackRan = true;
    }, { remoteDir, staleMs: 5000 });
    assert.equal(lockCallbackRan, true);
    assert.equal(fs.existsSync(gw.paths.devicesLockFile), false);

    // 5 consecutive auth failures trigger 60s lockout
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'BAD', deviceName: 'Phone', publicKeyJwk, turboAcknowledged: true }),
      });
      assert.equal(r.status, 401);
    }
    const locked = await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'BAD', deviceName: 'Phone', publicKeyJwk, turboAcknowledged: true }),
    });
    assert.equal(locked.status, 429);
    clockMs += 60_001;

    // Legacy unsigned/undomain-separated hello signature must fail
    const chBad = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
    const legacySig = Buffer.from(
      await crypto.webcrypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        kp.privateKey,
        new TextEncoder().encode(`${chBad.nonce}:${paired.deviceId}:0`)
      )
    ).toString('base64url');
    const wsBad = await rawWsUpgrade(gw.port, { Origin: `http://127.0.0.1:${gw.port}` });
    openSockets.push(wsBad.socket);
    const rBad = readServerFrames(wsBad.socket, wsBad.head);
    wsBad.socket.write(
      makeMaskedClientFrame(
        0x1,
        Buffer.from(
          JSON.stringify({
            type: 'hello',
            protocol: 'maga-remote/1',
            deviceId: paired.deviceId,
            nonce: chBad.nonce,
            signature: legacySig,
            lastSeq: 0,
            lastEpoch: '',
          })
        )
      )
    );
    assert.equal(JSON.parse((await rBad.nextFrame()).payload.toString('utf8')).error, 'invalid_signature');
    wsBad.socket.destroy();

    const devicesRawBeforeHello = fs.readFileSync(gw.paths.devicesFile, 'utf8');

    // Valid domain-separated hello + zero-race welcome(seq0) + buffered delta(seq=1)
    const ch1 = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
    const sig1 = await signHello(kp.privateKey, { nonce: ch1.nonce, deviceId: paired.deviceId, lastSeq: 0, lastEpoch: '' });
    const ws1 = await rawWsUpgrade(gw.port, { Origin: `http://127.0.0.1:${gw.port}` });
    openSockets.push(ws1.socket);
    assert.equal(ws1.status, 101);
    const r1 = readServerFrames(ws1.socket, ws1.head);

    ws1.socket.write(
      makeMaskedClientFrame(
        0x1,
        Buffer.from(
          JSON.stringify({
            type: 'hello',
            protocol: 'maga-remote/1',
            deviceId: paired.deviceId,
            nonce: ch1.nonce,
            signature: sig1,
            lastSeq: 0,
            lastEpoch: '',
          })
        )
      )
    );
    const welcome = JSON.parse((await r1.nextFrame()).payload.toString('utf8'));
    assert.equal(welcome.type, 'welcome');
    assert.equal(welcome.epoch, gw.epoch);
    assert.equal(welcome.seq, 0);
    assert.equal(welcome.conversations.length, 1);

    const bufferedDelta = JSON.parse((await r1.nextFrame()).payload.toString('utf8'));
    assert.equal(bufferedDelta.type, 'delta');
    assert.equal(bufferedDelta.seq, 1);
    assert.equal(bufferedDelta.data.duringWelcome, true);

    // hello writes device-last-seen.json and never overwrites devices.json
    assert.equal(fs.readFileSync(gw.paths.devicesFile, 'utf8'), devicesRawBeforeHello);
    assert.equal(fs.existsSync(gw.paths.deviceLastSeenFile), true);
    assert.ok(configMod.readDeviceLastSeen({ remoteDir })[paired.deviceId] > 0);

    // steer device without turboWriteConfirmed is blocked in TURBO preset
    const cid = '11111111-1111-4111-8111-111111111111';
    ws1.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId: 'w2', method: 'convo.send', params: { cascadeId: cid, text: 'hi', idempotencyKey: 'k-turbo-0001' } })))
    );
    const forbid = JSON.parse((await r1.nextFrame()).payload.toString('utf8'));
    assert.equal(forbid.ok, false);
    assert.equal(forbid.error, 'turbo_write_confirmation_required');

    // Incremental stream chunk delivered live without entering 512 replay ring
    udsServer.pushTap({
      kind: 'stream',
      ts: clockMs,
      data: { cascadeId: cid, stepIdx: 1, offset: 0, chunk: 'stream-part-1', reset: true },
    });
    const streamMsg = JSON.parse((await r1.nextFrame()).payload.toString('utf8'));
    assert.equal(streamMsg.type, 'delta');
    assert.equal(streamMsg.kind, 'stream');
    assert.equal(streamMsg.data.chunk, 'stream-part-1');
    assert.equal(streamMsg.seq, undefined);

    // Watch leak guard: send convo.watch(true) and disconnect while UDS request is in-flight (watchDelayMs=60)
    ws1.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId: 'w1', method: 'convo.watch', params: { cascadeId: cid, watch: true } })))
    );
    await new Promise((r) => setTimeout(r, 15));
    ws1.socket.destroy();
    await new Promise((r) => setTimeout(r, 130));
    assert.ok(udsServer.calls.some((c) => c.method === 'convo.watch' && c.params.cascadeId === cid && c.params.watch === false));
    assert.ok(udsServer.calls.some((c) => c.method === 'tap.setActive' && c.params.active === false));

    // Push 600 stream events + 1 summary event (seq=2); 600 streams MUST NOT evict summary seq=1 from 512 ring
    for (let i = 0; i < 600; i += 1) {
      udsServer.pushTap({ kind: 'stream', ts: clockMs + i, data: { cascadeId: cid, stepIdx: 1, offset: i, chunk: 'x', reset: false } });
    }
    udsServer.pushTap({ kind: 'summaries', ts: clockMs + 601, data: { n: 2 } });
    await new Promise((r) => setTimeout(r, 40));

    const ch2 = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
    const sig2 = await signHello(kp.privateKey, { nonce: ch2.nonce, deviceId: paired.deviceId, lastSeq: 1, lastEpoch: gw.epoch });
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
            deviceId: paired.deviceId,
            nonce: ch2.nonce,
            signature: sig2,
            lastSeq: 1,
            lastEpoch: gw.epoch,
          })
        )
      )
    );
    const deltas = JSON.parse((await r2.nextFrame()).payload.toString('utf8'));
    assert.equal(deltas.type, 'deltas');
    assert.equal(deltas.epoch, gw.epoch);
    assert.deepEqual(
      deltas.items.map((x) => x.seq),
      [2]
    );

    // Watch a conversation on ws2, then revoke device via devices.json -> live session kicked with Close 4001 + watch released!
    ws2.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId: 'w-live', method: 'convo.watch', params: { cascadeId: cid, watch: true } })))
    );
    assert.equal(JSON.parse((await r2.nextFrame()).payload.toString('utf8')).ok, true);

    const callsBeforeRevoke = udsServer.calls.length;
    await configMod.withDevicesLock(() => {
      const devs = configMod.readDevices({ remoteDir });
      devs[0].revokedAt = clockMs;
      configMod.writeDevices(devs, { remoteDir });
    }, { remoteDir });

    let kicked4001 = false;
    for (let i = 0; i < 6; i += 1) {
      const frm = await r2.nextFrame();
      if (frm.opcode === 0x8) {
        assert.equal(frm.payload.readUInt16BE(0), 4001);
        kicked4001 = true;
        break;
      }
    }
    assert.equal(kicked4001, true, 'connected client must be kicked with Close 4001 when revoked');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(
      udsServer.calls.slice(callsBeforeRevoke).some((c) => c.method === 'convo.watch' && c.params.cascadeId === cid && c.params.watch === false),
      'kicking revoked client releases active watch'
    );
    ws2.socket.destroy();

    // Un-revoke and restart gateway -> new epoch forces full welcome even when passing old lastSeq=1
    await configMod.withDevicesLock(() => {
      const devs = configMod.readDevices({ remoteDir });
      devs[0].revokedAt = null;
      configMod.writeDevices(devs, { remoteDir });
    }, { remoteDir });
    const oldEpoch = gw.epoch;
    await gw.close();
    gw = null;

    gwRestarted = await serverMod.createGatewayServer({
      remoteDir,
      sockPath,
      port: 0,
      now: () => clockMs,
      writePid: false,
    });
    assert.notEqual(gwRestarted.epoch, oldEpoch);

    const ch3 = await (await fetch(`http://127.0.0.1:${gwRestarted.port}/api/auth/challenge`)).json();
    const sig3 = await signHello(kp.privateKey, { nonce: ch3.nonce, deviceId: paired.deviceId, lastSeq: 1, lastEpoch: oldEpoch });
    const ws3 = await rawWsUpgrade(gwRestarted.port);
    openSockets.push(ws3.socket);
    const r3 = readServerFrames(ws3.socket, ws3.head);
    ws3.socket.write(
      makeMaskedClientFrame(
        0x1,
        Buffer.from(
          JSON.stringify({
            type: 'hello',
            protocol: 'maga-remote/1',
            deviceId: paired.deviceId,
            nonce: ch3.nonce,
            signature: sig3,
            lastSeq: 1,
            lastEpoch: oldEpoch,
          })
        )
      )
    );
    const restartWelcome = JSON.parse((await r3.nextFrame()).payload.toString('utf8'));
    assert.equal(restartWelcome.type, 'welcome', 'gateway restart with new epoch forces full welcome');
    assert.equal(restartWelcome.epoch, gwRestarted.epoch);
  } finally {
    for (const s of openSockets) {
      try {
        s.destroy();
      } catch {}
    }
    await gw?.close().catch(() => {});
    await gwRestarted?.close().catch(() => {});
    await udsServer?.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Gateway child process exits gracefully on IPC disconnect and cleans up gateway.pid', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-ipc-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  configMod.ensureRemoteDir(remoteDir);
  const freePort = await getFreePort();
  configMod.saveRemoteConfig({ enabled: true, port: freePort }, { remoteDir });

  const child = fork(path.join(GW_DIR, 'server.mjs'), [], {
    env: { ...process.env, MAGA_REMOTE_STATE_DIR: remoteDir, MAGA_REMOTE_SOCK_PATH: path.join(tmpRoot, 'missing.sock') },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  try {
    await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('fork_start_timeout')), 4000);
      child.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('maga_remote_gateway_listening')) {
          clearTimeout(t);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`gateway_exited_early_${code}`));
      });
    });

    const pidPath = path.join(remoteDir, 'gateway.pid');
    assert.equal(fs.existsSync(pidPath), true);

    const exitPromise = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    child.disconnect();
    const exitCode = await exitPromise;
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(pidPath), false, 'gateway.pid removed on IPC disconnect');
  } finally {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('remote-bridge enforces UUID whitelist, DESC LIMIT pagination, >1.5MB budget, transcript tailing, and daemon --once safety', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-bridge-'));
  const bridgeMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs')).href);
  const sockPath = configMod.resolveSockPath(tmpRoot);
  const remoteDir = path.join(tmpRoot, 'remote');

  try {
    await bridgeMod.initRemoteBridge({
      env: { MAGA_REMOTE_STATE_DIR: remoteDir, MAGA_REMOTE_SOCK_PATH: sockPath },
      gatewayScript: path.join(tmpRoot, 'nonexistent-gateway.mjs'),
    });

    const badSnap = await udsRpcCall(sockPath, 'convo.snapshot', { cascadeId: '../bad-id' });
    assert.equal(badSnap.ok, false);
    assert.equal(badSnap.error, 'invalid_cascade_id');

    const badWatch = await udsRpcCall(sockPath, 'convo.watch', { cascadeId: 'not-a-uuid', watch: true });
    assert.equal(badWatch.ok, false);
    assert.equal(badWatch.error, 'invalid_cascade_id');

    const badMethod = await udsRpcCall(sockPath, 'convo.unknownMethod', { cascadeId: '11111111-1111-4111-8111-111111111111' });
    assert.equal(badMethod.ok, false);
    assert.equal(badMethod.error, 'method_not_supported');

    await bridgeMod.shutdownRemoteBridge();

    // Disk read-only fallback: >200 steps + >600KB transcript + >1.5MB byte budget + beforeIdx pagination
    const agDir = path.join(tmpRoot, 'antigravity');
    const cid = '22222222-2222-4222-8222-222222222222';
    const convDir = path.join(agDir, 'conversations');
    const txDir = path.join(agDir, 'brain', cid, '.system_generated', 'logs');
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(txDir, { recursive: true });

    const agConfigPath = path.join(tmpRoot, 'ag-config.json');
    fs.writeFileSync(agConfigPath, JSON.stringify({ userSettings: { globalPreset: 2 } }));

    const sumDb = new DatabaseSync(path.join(agDir, 'conversation_summaries.db'));
    sumDb.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        step_count INTEGER,
        last_modified_time TEXT,
        status TEXT,
        project_id TEXT,
        agent_name TEXT,
        parent_conversation_id TEXT,
        not_fully_idle INTEGER,
        killed INTEGER
      );
    `);
    sumDb
      .prepare(`INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cid, 'Disk Paginated Convo', 'Preview text', 260, '2026-11-26T00:00:00.000Z', 'IDLE', 'proj-1', '', '', 0, 0);
    sumDb.close();

    const convDb = new DatabaseSync(path.join(convDir, `${cid}.db`));
    convDb.exec(`
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER,
        status INTEGER,
        metadata BLOB,
        error_details BLOB,
        step_payload BLOB
      );
    `);
    const insertStmt = convDb.prepare(`INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 260; i += 1) {
      insertStmt.run(i, i % 2 === 0 ? 14 : 15, 3, Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0));
    }
    convDb.close();

    // Write >600KB transcript.jsonl (> 512KB tail window) with massive thinking/content to test tailing + 1.5MB budget
    const txLines = [];
    for (let i = 0; i < 260; i += 1) {
      const pad = i < 60 ? 'OLD_'.repeat(600) : 'NEW_'.repeat(2500); // Newest 200 steps exceed 1.5MB before budget trimming
      txLines.push(
        JSON.stringify({
          step_index: i,
          type: i % 2 === 0 ? 'USER_INPUT' : 'PLANNER_RESPONSE',
          status: 'DONE',
          content: `step-${i}-${pad}`,
          thinking: `think-${i}-${'T'.repeat(2000)}`,
          created_at: '2026-11-26T00:00:01Z',
        })
      );
    }
    const txPayload = txLines.join('\n') + '\n';
    assert.ok(Buffer.byteLength(txPayload, 'utf8') > 600 * 1024);
    fs.writeFileSync(path.join(txDir, 'transcript.jsonl'), txPayload);

    const diskList = bridgeMod.readConversationListFromDisk({ antigravityDir: agDir, agConfigPath });
    assert.equal(diskList.source, 'disk');
    assert.equal(diskList.globalPreset, 2);
    assert.equal(diskList.conversations[0].id, cid);

    const page1 = bridgeMod.readConversationSnapshotFromDisk(cid, { antigravityDir: agDir });
    assert.equal(page1.source, 'disk');
    assert.equal(page1.hasMore, true);
    assert.ok(Number.isInteger(page1.nextBeforeIdx) && page1.nextBeforeIdx > 0);
    assert.equal(page1.steps.at(-1).idx, 259, 'DESC LIMIT returns latest steps up to 259');
    assert.ok(Buffer.byteLength(JSON.stringify(page1), 'utf8') <= Math.floor(1.5 * 1024 * 1024));

    const page2 = bridgeMod.readConversationSnapshotFromDisk(cid, { antigravityDir: agDir, beforeIdx: page1.nextBeforeIdx });
    assert.equal(page2.source, 'disk');
    assert.ok(page2.steps.length > 0);
    assert.ok(page2.steps.every((s) => s.idx < page1.nextBeforeIdx));

    const badDisk = bridgeMod.readConversationSnapshotFromDisk('../../etc/passwd', { antigravityDir: agDir });
    assert.equal(badDisk.ok, false);
    assert.equal(badDisk.error, 'invalid_cascade_id');

    // core/daemon.mjs --once exits cleanly without starting gateway or bridge.sock
    const onceStateDir = path.join(tmpRoot, 'daemon-once-state');
    const onceUserDir = path.join(tmpRoot, 'daemon-once-user');
    const onceRemoteDir = path.join(tmpRoot, 'daemon-once-remote');
    const onceSock = configMod.resolveSockPath(onceRemoteDir);
    configMod.ensureRemoteDir(onceRemoteDir);
    configMod.saveRemoteConfig({ enabled: true, port: 18995 }, { remoteDir: onceRemoteDir });

    const out = execFileSync(process.execPath, [path.join(REPO, 'core', 'daemon.mjs'), '--once', '--user-dir', onceUserDir], {
      encoding: 'utf8',
      timeout: 8000,
      env: {
        ...process.env,
        HOME: tmpRoot,
        ANTI_CLAUDE_STATE_DIR: onceStateDir,
        ANTI_CLAUDE_USER_DIR: onceUserDir,
        ANTI_CLAUDE_NO_CDP_BOOTSTRAP: '1',
        MAGA_REMOTE_STATE_DIR: onceRemoteDir,
        MAGA_REMOTE_SOCK_PATH: onceSock,
      },
    });
    assert.equal(typeof out, 'string');
    assert.equal(fs.existsSync(onceSock), false, 'daemon --once must not start UDS bridge');
    assert.equal(fs.existsSync(path.join(onceRemoteDir, 'gateway.pid')), false, 'daemon --once must not spawn gateway');
  } finally {
    await bridgeMod.shutdownRemoteBridge().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('cdp-attach verifies rpcToken on __agRemoteTapEvent and drops forged tokens', async () => {
  const daemon = await import(pathToFileURL(path.join(REPO, 'core', 'daemon.mjs')).href);
  const { runtimeState } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'env.mjs')).href);

  const realWS = globalThis.WebSocket;
  const prevTapHandler = runtimeState.onRemoteTapEvent;
  daemon.rebuildBundleIfNeeded();
  daemon.attachedTargets.clear();
  daemon.skippedNonHostTargets.clear();

  const sockets = [];
  const receivedEvents = [];

  class TapAuthFakeSocket extends EventTarget {
    static OPEN = 1;
    constructor() {
      super();
      this.readyState = 1;
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    emitEvent(method, params) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method, params }) }));
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      const reply = (result = {}) =>
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) }));
      queueMicrotask(() => {
        if (method === 'Page.getFrameTree') reply({ frameTree: { frame: { id: 'f-main' } } });
        else if (method === 'Runtime.enable') {
          this.emitEvent('Runtime.executionContextCreated', {
            context: { id: 10, origin: 'https://127.0.0.1:60000', auxData: { frameId: 'f-main', isDefault: true } },
          });
          reply({});
        } else if (method === 'Runtime.evaluate' && String(params.expression).includes("return 'swarm'")) {
          reply({ result: { value: 'host' } });
        } else reply({ result: { value: 'dark' } });
      });
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }

  try {
    globalThis.WebSocket = TapAuthFakeSocket;
    runtimeState.onRemoteTapEvent = (parsed) => receivedEvents.push(parsed);

    const fakePage = {
      id: 'tap-auth-target',
      type: 'page',
      url: 'https://127.0.0.1:60000/c/11111111-1111-1111-1111-111111111111',
      webSocketDebuggerUrl: 'ws://127.0.0.1:60000/devtools/page/tap-auth-target',
    };
    await daemon.attachTarget(fakePage, { channel: 'test', portFile: '', fallbackPort: 0, conversationsDir: os.tmpdir() });
    const entry = daemon.attachedTargets.get(fakePage.id);
    assert.ok(entry?.rpcToken, 'host entry must have rpcToken');

    sockets[0].emitEvent('Runtime.bindingCalled', {
      name: '__agRemoteTapEvent',
      executionContextId: 10,
      payload: JSON.stringify({ token: 'forged-token-' + '0'.repeat(35), kind: 'summaries', data: { bad: true } }),
    });
    sockets[0].emitEvent('Runtime.bindingCalled', {
      name: '__agRemoteTapEvent',
      executionContextId: 999,
      payload: JSON.stringify({ token: entry.rpcToken, kind: 'summaries', data: { badCtx: true } }),
    });
    sockets[0].emitEvent('Runtime.bindingCalled', {
      name: '__agRemoteTapEvent',
      executionContextId: 10,
      payload: JSON.stringify({ token: entry.rpcToken, kind: 'summaries', data: { ok: true } }),
    });

    assert.equal(receivedEvents.length, 1);
    assert.deepEqual(receivedEvents[0].data, { ok: true });
  } finally {
    runtimeState.onRemoteTapEvent = prevTapHandler;
    for (const [, e] of daemon.attachedTargets.entries()) {
      try {
        e.ws.close();
      } catch {}
    }
    daemon.attachedTargets.clear();
    daemon.skippedNonHostTargets.clear();
    globalThis.WebSocket = realWS;
  }
});

test('buildRemotePwa(), CLI remote lifecycle (#pair=, live revoke kick 4001), and doctor localhost/cloudflare-mtls checks', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-cli-'));
  const tmpDist = path.join(tmpRoot, 'pwa-dist');
  const tmpStateDir = path.join(tmpRoot, 'anti-claude-state');
  const tmpRemoteDir = path.join(tmpRoot, 'remote-state');
  const tmpSockPath = configMod.resolveSockPath(path.join(tmpRoot, 'missing-bridge'));
  let childGw = null;
  const openSockets = [];

  try {
    const { buildRemotePwa } = await import(pathToFileURL(path.join(REPO, 'studio', 'build.mjs')).href);
    const buildRes = await buildRemotePwa({ outDir: tmpDist });
    assert.equal(buildRes.ok, true);
    for (const f of ['app.js', 'styles.css', 'index.html', 'manifest.webmanifest', 'sw.js']) {
      assert.equal(fs.existsSync(path.join(tmpDist, f)), true, `Missing built PWA file ${f}`);
    }

    const freePort = await getFreePort();
    const cliEnv = {
      ...process.env,
      ANTI_CLAUDE_STATE_DIR: tmpStateDir,
      MAGA_REMOTE_STATE_DIR: tmpRemoteDir,
      MAGA_REMOTE_SOCK_PATH: tmpSockPath,
    };
    const runCli = (args, { allowNonZero = false } = {}) =>
      new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(REPO, 'studio', 'cli.mjs'), ...args], { encoding: 'utf8', env: cliEnv }, (err, stdout, stderr) => {
          if (err && !allowNonZero) {
            err.stderr = stderr;
            err.stdout = stdout;
            reject(err);
            return;
          }
          resolve({ exitCode: err ? err.code || 1 : 0, json: stdout ? JSON.parse(stdout) : null, stderr });
        });
      });

    // CLI doctor rejects localhost bindHost and cloudflare-mtls transport
    configMod.ensureRemoteDir(tmpRemoteDir);
    configMod.writeJsonAtomic(path.join(tmpRemoteDir, 'config.json'), {
      enabled: true,
      port: freePort,
      host: 'localhost',
      transport: 'cloudflare-mtls',
    });
    const badStatus = await runCli(['remote', 'status']);
    const issueCodes = badStatus.json.diagnostics.dangerousIssues.map((x) => x.code);
    assert.equal(badStatus.json.diagnostics.ok, false);
    assert.ok(issueCodes.includes('non_loopback_bind'));
    assert.ok(issueCodes.includes('invalid_transport'));

    // Reset clean config via remote on
    fs.rmSync(path.join(tmpRemoteDir, 'config.json'), { force: true });
    const onRes = (await runCli(['remote', 'on', '--port', String(freePort), '--transport', 'loopback'])).json;
    assert.equal(onRes.ok, true);
    assert.equal(onRes.config.enabled, true);
    assert.equal(onRes.config.port, freePort);
    if (configMod.isPosixPermsEnforced()) {
      assert.equal(fs.statSync(tmpRemoteDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(tmpRemoteDir, 'config.json')).mode & 0o777, 0o600);
    }

    childGw = spawn(process.execPath, [path.join(GW_DIR, 'server.mjs')], {
      env: cliEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('gateway_spawn_timeout')), 4000);
      childGw.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('maga_remote_gateway_listening')) {
          clearTimeout(t);
          resolve();
        }
      });
      childGw.once('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`gateway_exited_${code}`));
      });
    });

    const statusRes = (await runCli(['remote', 'status'])).json;
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.gateway.running, true);
    assert.equal(statusRes.gateway.healthStatus, 'ok');

    // Pair output uses #pair= hash fragment (no ?pair= query)
    const pairRes = (await runCli(['remote', 'pair', '--role', 'observe', '--ttl', '60'])).json;
    assert.equal(pairRes.ok, true);
    assert.ok(pairRes.localUrl.includes(`/#pair=${encodeURIComponent(pairRes.code)}`));
    assert.equal(pairRes.localUrl.includes('?pair='), false);

    // Pair with turboAcknowledged=true (UDS offline => fail-closed TURBO gate requires ack)
    const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
    const complete = await (
      await fetch(`http://127.0.0.1:${freePort}/api/pair/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: pairRes.code, deviceName: 'CLI Test Device', publicKeyJwk, turboAcknowledged: true }),
      })
    ).json();
    assert.equal(complete.ok, true);

    // Connect live WS client, then revoke via CLI and verify gateway kicks client with Close 4001!
    const ch = await (await fetch(`http://127.0.0.1:${freePort}/api/auth/challenge`)).json();
    const sig = await signHello(kp.privateKey, { nonce: ch.nonce, deviceId: complete.deviceId, lastSeq: 0, lastEpoch: '' });
    const ws = await rawWsUpgrade(freePort);
    openSockets.push(ws.socket);
    const reader = readServerFrames(ws.socket, ws.head);
    ws.socket.write(
      makeMaskedClientFrame(
        0x1,
        Buffer.from(
          JSON.stringify({
            type: 'hello',
            protocol: 'maga-remote/1',
            deviceId: complete.deviceId,
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

    const revRes = (await runCli(['remote', 'revoke', complete.deviceId])).json;
    assert.equal(revRes.ok, true);
    assert.ok(revRes.revokedAt);

    let kicked = false;
    for (let i = 0; i < 6; i += 1) {
      const frm = await reader.nextFrame();
      if (frm.opcode === 0x8) {
        assert.equal(frm.payload.readUInt16BE(0), 4001);
        kicked = true;
        break;
      }
    }
    assert.equal(kicked, true, 'CLI remote revoke must kick live WS client with Close 4001');

    const devsAfter = (await runCli(['remote', 'devices'])).json;
    assert.equal(devsAfter.active, 0);
    assert.equal(devsAfter.revoked, 1);

    const offRes = (await runCli(['remote', 'off'])).json;
    assert.equal(offRes.ok, true);
    assert.equal(offRes.enabled, false);
    assert.equal(offRes.stopped, true);
    assert.equal(fs.existsSync(path.join(tmpRemoteDir, 'gateway.pid')), false);
  } finally {
    for (const s of openSockets) {
      try {
        s.destroy();
      } catch {}
    }
    if (childGw && childGw.exitCode === null) {
      try {
        childGw.kill('SIGKILL');
      } catch {}
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 1 Gateway Write Security: RBAC, demotion 4003, TURBO recheck, durable idempotency, non-blocking ping, rate limit & non-loopback Origin', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p1gw-'));
  const openSockets = [];
  const servers = [];
  let udsServer = null;

  try {
    // 1. Non-loopback transport enforces strict WS Origin & defaults allowLocalPairingWithoutEdge=false
    const tsCfg = configMod.validateAndNormalizeConfig({
      transport: 'tailscale-serve',
      tailscaleAllowedUsers: ['owner@example.com'],
    });
    assert.equal(tsCfg.allowLocalPairingWithoutEdge, false);

    const gwTs = await serverMod.createGatewayServer({
      remoteDir: path.join(tmpRoot, 'ts-gw'),
      port: 0,
      writePid: false,
      config: { transport: 'tailscale-serve', tailscaleAllowedUsers: ['owner@example.com'] },
    });
    servers.push(gwTs);

    const noOriginUpgrade = await rawWsUpgrade(gwTs.port, { 'Tailscale-User-Login': 'owner@example.com' });
    assert.equal(noOriginUpgrade.status, 403, 'non-loopback transport must reject WS upgrade missing Origin');

    const withOriginUpgrade = await rawWsUpgrade(gwTs.port, {
      'Tailscale-User-Login': 'owner@example.com',
      Origin: `http://127.0.0.1:${gwTs.port}`,
    });
    assert.equal(withOriginUpgrade.status, 101);
    openSockets.push(withOriginUpgrade.socket);
    await gwTs.close();

    // 2. Write RBAC, TURBO gate, durable idempotency across reconnect & epoch restart, non-blocking ping, rate limit, role demotion 4003
    const remoteDir = path.join(tmpRoot, 'gw-writes');
    const sockPath = configMod.resolveSockPath(tmpRoot);
    const writeToken = 'uds-boot-token-0123456789abcdef';
    const writeCalls = [];
    let writeDelayMs = 0;

    udsServer = await createFakeUdsServer(sockPath, {
      globalPreset: 3,
      expectedUdsToken: writeToken,
      onWrite: async (req) => {
        if (writeDelayMs > 0) await new Promise((r) => setTimeout(r, writeDelayMs));
        writeCalls.push({ method: req.method, params: req.params });
        return { ok: true, cascadeId: req.params.cascadeId, method: req.method };
      },
    });

    const enrollDevice = async (gw, role, name) => {
      configMod.writePairing(
        { code: `PAIR_${name}`, expiresAt: Date.now() + 60_000, role, gatewayFingerprint: gw.gatewayFingerprint },
        { remoteDir }
      );
      const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
      const res = await (
        await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: `PAIR_${name}`, deviceName: name, publicKeyJwk, turboAcknowledged: true }),
        })
      ).json();
      assert.equal(res.ok, true);
      return { deviceId: res.deviceId, kp };
    };

    const connectClient = async (gw, dev) => {
      const ch = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
      const sig = await signHello(dev.kp.privateKey, { nonce: ch.nonce, deviceId: dev.deviceId, lastSeq: 0, lastEpoch: '' });
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
              deviceId: dev.deviceId,
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
      return { ws, reader, welcome };
    };

    let gw = await serverMod.createGatewayServer({
      remoteDir,
      sockPath,
      port: 0,
      writePid: false,
      udsWriteToken: writeToken,
      maxWritesPerMinute: 3,
      maxConcurrentWrites: 4,
    });
    servers.push(gw);

    const devObs = await enrollDevice(gw, 'observe', 'Observer');
    const devSteer1 = await enrollDevice(gw, 'steer', 'Steer-1');
    const devSteer2 = await enrollDevice(gw, 'steer', 'Steer-2');

    const cObs = await connectClient(gw, devObs);
    const c1 = await connectClient(gw, devSteer1);
    const c2 = await connectClient(gw, devSteer2);
    assert.equal(c1.welcome.deviceRole, 'steer');

    const cid = '33333333-3333-4333-8333-333333333333';

    // Observe blocked
    cObs.ws.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
        type: 'req',
        reqId: 'obs-send',
        method: 'convo.send',
        params: { cascadeId: cid, text: 'hello', idempotencyKey: 'k-obs-1111', turboWriteConfirmed: true },
      })))
    );
    const obsRes = JSON.parse((await cObs.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(obsRes.ok, false);
    assert.equal(obsRes.error, 'forbidden_role_observe');

    // Live TURBO fail-closed recheck (globalPreset=3 and null)
    c1.ws.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
        type: 'req',
        reqId: 'turbo-1',
        method: 'convo.send',
        params: { cascadeId: cid, text: 'unconfirmed', idempotencyKey: 'k-turbo-001', turboWriteConfirmed: false },
      })))
    );
    const turboDeny = JSON.parse((await c1.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(turboDeny.error, 'turbo_write_confirmation_required');

    udsServer.setGlobalPreset(null);
    c1.ws.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
        type: 'req',
        reqId: 'turbo-2',
        method: 'convo.send',
        params: { cascadeId: cid, text: 'unconfirmed', idempotencyKey: 'k-turbo-001', turboWriteConfirmed: false },
      })))
    );
    const unknownDeny = JSON.parse((await c1.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(unknownDeny.error, 'turbo_write_confirmation_required');

    // Confirmed send succeeds + prompt text hashed in audit.jsonl (never plaintext)
    const secretPrompt = 'TOP_SECRET_PROMPT_DO_NOT_LOG_12345';
    c1.ws.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
        type: 'req',
        reqId: 'send-ok',
        method: 'convo.send',
        params: { cascadeId: cid, text: secretPrompt, idempotencyKey: 'k-send-persist-1', turboWriteConfirmed: true },
      })))
    );
    const sendOk = JSON.parse((await c1.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(sendOk.ok, true);
    assert.equal(writeCalls.length, 1);

    const auditRaw = fs.readFileSync(gw.paths.auditFile, 'utf8');
    assert.equal(auditRaw.includes(secretPrompt), false, 'audit.jsonl must never log plaintext prompt text');
    const writeEvt = gw.audit.readTail(10).find((e) => e.event === 'remote_write');
    assert.equal(writeEvt.textSha256, crypto.createHash('sha256').update(secretPrompt, 'utf8').digest('hex'));

    // Reconnect AND restart gateway (new epoch) -> idempotencyKey replays without calling UDS again!
    const c1Re = await connectClient(gw, devSteer1);
    c1Re.ws.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
        type: 'req',
        reqId: 'send-replay-1',
        method: 'convo.send',
        params: { cascadeId: cid, text: secretPrompt, idempotencyKey: 'k-send-persist-1', turboWriteConfirmed: true },
      })))
    );
    const rep1 = JSON.parse((await c1Re.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(rep1.ok, true);
    assert.equal(rep1.replayed, true);
    assert.equal(writeCalls.length, 1);

    const oldEpoch = gw.epoch;
    await gw.close();
    gw = await serverMod.createGatewayServer({
      remoteDir,
      sockPath,
      port: 0,
      writePid: false,
      udsWriteToken: writeToken,
      maxWritesPerMinute: 3,
      maxConcurrentWrites: 4,
    });
    servers.push(gw);
    assert.notEqual(gw.epoch, oldEpoch);

    const c1Restart = await connectClient(gw, devSteer1);
    const c2Restart = await connectClient(gw, devSteer2);
    c1Restart.ws.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
        type: 'req',
        reqId: 'send-replay-2',
        method: 'convo.send',
        params: { cascadeId: cid, text: secretPrompt, idempotencyKey: 'k-send-persist-1', turboWriteConfirmed: true },
      })))
    );
    const rep2 = JSON.parse((await c1Restart.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(rep2.ok, true);
    assert.equal(rep2.replayed, true);
    assert.equal(writeCalls.length, 1);

    // Ping/pong bypasses slow in-flight write without blocking
    writeDelayMs = 180;
    c1Restart.ws.socket.write(
      makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({
        type: 'req',
        reqId: 'slow-approve',
        method: 'convo.approve',
        params: { cascadeId: cid, stepIndex: 2, waitingStepHash: 'abcdef0123456789', decision: 'allow_once', idempotencyKey: 'k-app-slow-1' },
      })))
    );
    c1Restart.ws.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'ping', ts: 98765 }))));
    const firstFrame = JSON.parse((await c1Restart.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(firstFrame.type, 'pong', 'ping/pong must bypass in-flight slow write');
    assert.equal(firstFrame.ts, 98765);
    const appRes = JSON.parse((await c1Restart.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(appRes.ok, true);
    writeDelayMs = 0;

    // Per-device rate limit (maxWritesPerMinute=3 on devSteer1 does not block devSteer2)
    c1Restart.ws.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId: 'c1-2', method: 'convo.cancel', params: { cascadeId: cid, idempotencyKey: 'k-c1-2222' } }))));
    assert.equal(JSON.parse((await c1Restart.reader.nextFrame()).payload.toString('utf8')).ok, true);
    c1Restart.ws.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId: 'c1-3', method: 'convo.cancel', params: { cascadeId: cid, idempotencyKey: 'k-c1-3333' } }))));
    assert.equal(JSON.parse((await c1Restart.reader.nextFrame()).payload.toString('utf8')).ok, true);
    c1Restart.ws.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId: 'c1-4', method: 'convo.cancel', params: { cascadeId: cid, idempotencyKey: 'k-c1-4444' } }))));
    const rlRes = JSON.parse((await c1Restart.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(rlRes.error, 'write_rate_limited');

    c2Restart.ws.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', reqId: 'c2-1', method: 'convo.cancel', params: { cascadeId: cid, idempotencyKey: 'k-c2-1111' } }))));
    assert.equal(JSON.parse((await c2Restart.reader.nextFrame()).payload.toString('utf8')).ok, true);

    // Live role demotion steer -> observe immediately kicks client with Close 4003
    await configMod.withDevicesLock(() => {
      const devs = configMod.readDevices({ remoteDir });
      const target = devs.find((d) => d.deviceId === devSteer2.deviceId);
      target.role = 'observe';
      configMod.writeDevices(devs, { remoteDir });
    }, { remoteDir });

    let kicked4003 = false;
    for (let i = 0; i < 6; i += 1) {
      const frm = await c2Restart.reader.nextFrame();
      if (frm.opcode === 0x8) {
        assert.equal(frm.payload.readUInt16BE(0), 4003);
        kicked4003 = true;
        break;
      }
    }
    assert.equal(kicked4003, true, 'live role demotion must kick client with Close 4003');
  } finally {
    for (const s of openSockets) {
      try { s.destroy(); } catch {}
    }
    for (const srv of servers) {
      await srv.close().catch(() => {});
    }
    await udsServer?.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 1 Bridge & Tap: per-boot UDS token, zero-disk-write, multi-window convo.owns routing & Tap invoke CAS/ONCE/TURBO', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p1br-'));
  const bridgeMod = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs')).href);
  const { attachedTargets } = await import(pathToFileURL(path.join(REPO, 'core', 'daemon', 'env.mjs')).href);
  const { createRemoteTapModule } = await import(pathToFileURL(path.join(REPO, 'user', 'src', 'modules', 'remote-tap.mjs')).href);

  const cid1 = '44444444-4444-4444-8444-444444444441';
  const cid2 = '55555555-5555-4555-8555-555555555552';
  const remoteDir = path.join(tmpRoot, 'remote');
  const sockPath = configMod.resolveSockPath(tmpRoot);
  const bootToken = 'bridge-boot-secret-token-9988';
  const prevTargets = Array.from(attachedTargets.entries());

  try {
    attachedTargets.clear();
    await bridgeMod.initRemoteBridge({
      env: { MAGA_REMOTE_STATE_DIR: remoteDir, MAGA_REMOTE_SOCK_PATH: sockPath, MAGA_REMOTE_UDS_TOKEN: bootToken },
      gatewayScript: path.join(tmpRoot, 'missing-gw.mjs'),
    });

    // UDS write token enforcement
    const noTok = await udsRpcCall(sockPath, 'convo.send', { cascadeId: cid1, text: 'hi' });
    assert.equal(noTok.error, 'uds_unauthorized');
    const badTok = await udsRpcCall(sockPath, 'convo.send', { cascadeId: cid1, text: 'hi' }, 'wrong-token');
    assert.equal(badTok.error, 'uds_unauthorized');

    // No host attached -> never fall back to disk
    const noHost = await udsRpcCall(sockPath, 'convo.send', { cascadeId: cid1, text: 'hi' }, bootToken);
    assert.equal(noHost.ok, false);
    assert.equal(noHost.error, 'host_not_attached');

    // Multi-window routing: hostA owns cid1, hostB owns cid2
    const hostACalls = [];
    const hostBCalls = [];
    const makeMockEntry = (id, ownedCid, score, callLog) => ({
      id,
      type: 'page',
      hostConfirmed: true,
      trustedContextId: 1,
      ws: { readyState: 1 },
      _remoteCap: { ok: true, globalPreset: 2, capabilities: { reduxSummaries: true, sendMessage: true, approval: true, cancel: true } },
      _remoteCapScore: score,
      async send(method, params) {
        if (method === 'Runtime.evaluate') {
          const expr = String(params.expression || '');
          if (expr.includes('getCapabilities')) {
            return { result: { result: { value: { ok: true, globalPreset: 2 } } } };
          }
          if (expr.includes('"convo.owns"')) {
            return { result: { result: { value: { ok: true, owned: expr.includes(ownedCid), active: expr.includes(ownedCid) } } } };
          }
          callLog.push(expr);
          return { result: { result: { value: { ok: true, routedTo: id } } } };
        }
        return {};
      },
    });
    attachedTargets.set('host-A', makeMockEntry('host-A', cid1, 10, hostACalls));
    attachedTargets.set('host-B', makeMockEntry('host-B', cid2, 20, hostBCalls));

    const route1 = await udsRpcCall(sockPath, 'convo.send', { cascadeId: cid1, text: 'to-A' }, bootToken);
    assert.equal(route1.ok, true);
    assert.equal(route1.result.routedTo, 'host-A');
    assert.equal(hostACalls.length, 1);
    assert.equal(hostBCalls.length, 0);

    const route2 = await udsRpcCall(sockPath, 'convo.cancel', { cascadeId: cid2 }, bootToken);
    assert.equal(route2.ok, true);
    assert.equal(route2.result.routedTo, 'host-B');
    assert.equal(hostBCalls.length, 1);

    await bridgeMod.shutdownRemoteBridge();

    // Real remote-tap.mjs invoke() + live store CAS + hardcoded PermissionScope.ONCE + TURBO fail-closed
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: `https://127.0.0.1:60000/c/${cid1}`,
    });
    const keys = ['window', 'document'];
    const prevGlobals = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;

    let currentPreset = 3; // TURBO
    const stepObj = {
      stepIndex: 4,
      trajectoryId: 'traj-live-1',
      interactionCase: 'permission',
      toolName: 'run_command',
      action: 'permission',
      commandLine: 'rm -rf ./tmp-build',
    };
    const lsCalls = [];
    const mockStore = {
      subscribe: () => () => {},
      getState: () => ({
        userStatus: { permissionSettings: { globalPreset: currentPreset } },
        trajectorySummaries: {
          summaries: {
            [cid1]: {
              summary: 'Live Tap Convo',
              waitingSteps: [
                {
                  stepIndex: stepObj.stepIndex,
                  step: {
                    metadata: {
                      sourceTrajectoryStepInfo: { trajectoryId: stepObj.trajectoryId, stepIndex: stepObj.stepIndex },
                      toolCall: { name: `tool:${stepObj.toolName}` },
                    },
                    requestedInteraction: { interaction: { case: 'permission', value: { commandLine: stepObj.commandLine } } },
                    step: { case: 'runCommand', value: { commandLine: stepObj.commandLine } },
                  },
                },
              ],
            },
          },
        },
      }),
    };
    const mockLsClient = {
      sendUserCascadeMessage: async (arg) => lsCalls.push({ fn: 'send', arg }),
      handleCascadeUserInteraction: async (cidArg, intArg) => lsCalls.push({ fn: 'interact', cidArg, intArg }),
      cancelCascadeInvocation: async (arg) => lsCalls.push({ fn: 'cancel', arg }),
      createAgentStateProviderForConvo: () => ({ getState: () => null, onDidChange: () => ({ dispose: () => {} }), dispose: () => {} }),
      getCascadeTrajectory: async () => ({ trajectory: { steps: [] } }),
    };

    const rootEl = dom.window.document.getElementById('root');
    rootEl.__reactContainer$test = {
      memoizedProps: { store: mockStore, lsClient: mockLsClient },
      child: null,
      sibling: null,
    };

    const tap = createRemoteTapModule({ state: { disposed: false } });
    try {
      const api = dom.window.__agRemoteTap;
      assert.equal((await api.invoke('eval.arbitrary', { cascadeId: cid1 })).error, 'disallowed_invoke_method');

      const owns = await api.invoke('convo.owns', { cascadeId: cid1 });
      assert.deepEqual(owns, { ok: true, owned: true, active: true });

      const turboBlocked = await api.invoke('convo.send', { cascadeId: cid1, text: 'hello' });
      assert.equal(turboBlocked.error, 'turbo_write_confirmation_required');

      const sent = await api.invoke('convo.send', { cascadeId: cid1, text: 'hello', turboWriteConfirmed: true });
      assert.equal(sent.ok, true);
      assert.deepEqual(lsCalls.at(-1), { fn: 'send', arg: { cascadeId: cid1, items: [{ chunk: { case: 'text', value: 'hello' } }] } });

      const staleApp = await api.invoke('convo.approve', {
        cascadeId: cid1,
        stepIndex: 4,
        waitingStepHash: '0000000000000000',
        decision: 'allow_once',
      });
      assert.equal(staleApp.error, 'waiting_step_mismatch');

      const sumList = api.listSummaries();
      const normalizedFromTap = sumList.conversations[0].waitingSteps[0];
      const expectedHash = bridgeMod.computeWaitingStepHash(cid1, normalizedFromTap);
      assert.equal(expectedHash, bridgeMod.computeWaitingStepHash(cid1, stepObj));
      const okApp = await api.invoke('convo.approve', {
        cascadeId: cid1,
        stepIndex: 4,
        waitingStepHash: expectedHash,
        decision: 'allow_once',
      });
      assert.equal(okApp.ok, true);
      assert.deepEqual(lsCalls.at(-1), {
        fn: 'interact',
        cidArg: cid1,
        intArg: {
          trajectoryId: 'traj-live-1',
          stepIndex: 4,
          interaction: { case: 'permission', value: { allow: true, scope: 1 } },
        },
      });

      const canceled = await api.invoke('convo.cancel', { cascadeId: cid1, killBackgroundTasks: true });
      assert.equal(canceled.ok, true);
      assert.deepEqual(lsCalls.at(-1), { fn: 'cancel', arg: { cascadeId: cid1, killBackgroundTasks: true } });

      // P2 deny scope pin + strict preset allowlist on Tap + action CAS differentiation
      const hashActA = bridgeMod.computeWaitingStepHash(cid1, { ...stepObj, action: 'actA', commandLine: '' });
      const hashActB = bridgeMod.computeWaitingStepHash(cid1, { ...stepObj, action: 'actB', commandLine: '' });
      assert.notEqual(hashActA, hashActB, 'computeWaitingStepHash must include action when commandLine is empty');

      const denyApp = await api.invoke('convo.approve', {
        cascadeId: cid1,
        stepIndex: 4,
        waitingStepHash: expectedHash,
        decision: 'deny',
      });
      assert.equal(denyApp.ok, true);
      assert.deepEqual(lsCalls.at(-1), {
        fn: 'interact',
        cidArg: cid1,
        intArg: {
          trajectoryId: 'traj-live-1',
          stepIndex: 4,
          interaction: { case: 'permission', value: { allow: false, scope: 1 } },
        },
      });

      for (const unsafePreset of [0, '', false, null, undefined, 3]) {
        currentPreset = unsafePreset;
        const blocked = await api.invoke('convo.send', { cascadeId: cid1, text: 'check-unsafe' });
        assert.equal(blocked.error, 'turbo_write_confirmation_required');
      }
      currentPreset = 1;
      const safeSend = await api.invoke('convo.send', { cascadeId: cid1, text: 'check-safe-1' });
      assert.equal(safeSend.ok, true);
    } finally {
      tap.dispose();
      dom.window.close();
      for (const [k, desc] of prevGlobals.entries()) {
        if (desc) Object.defineProperty(globalThis, k, desc);
        else delete globalThis[k];
      }
    }
  } finally {
    attachedTargets.clear();
    for (const [k, v] of prevTargets) attachedTargets.set(k, v);
    await bridgeMod.shutdownRemoteBridge().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 1 Red-Team regressions: same-key race, semaphore cap, payload hash conflict, outcome_unknown persistence, preset allowlist & health consistency', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-p1rt-'));
  const openSockets = [];
  const servers = [];
  let udsServer = null;

  try {
    const remoteDir = path.join(tmpRoot, 'remote');
    const sockPath = configMod.resolveSockPath(tmpRoot);
    const writeToken = 'rt-uds-token-0123456789abcdef';
    const writeCalls = [];
    let writeHandler = async (req) => {
      writeCalls.push(req);
      return { ok: true, cascadeId: req.params.cascadeId, method: req.method };
    };

    udsServer = await createFakeUdsServer(sockPath, {
      globalPreset: 2,
      expectedUdsToken: writeToken,
      healthDelayMs: 60,
      writeDelayMs: 20,
      onWrite: async (req) => writeHandler(req),
    });

    const enroll = async (gw, role, name) => {
      configMod.writePairing(
        { code: `RT_${name}`, expiresAt: Date.now() + 60_000, role, gatewayFingerprint: gw.gatewayFingerprint },
        { remoteDir }
      );
      const kp = await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKeyJwk = await crypto.webcrypto.subtle.exportKey('jwk', kp.publicKey);
      const res = await (
        await fetch(`http://127.0.0.1:${gw.port}/api/pair/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: `RT_${name}`, deviceName: name, publicKeyJwk, turboAcknowledged: true }),
        })
      ).json();
      assert.equal(res.ok, true);
      return { deviceId: res.deviceId, kp };
    };

    const connectClient = async (gw, dev) => {
      const ch = await (await fetch(`http://127.0.0.1:${gw.port}/api/auth/challenge`)).json();
      const sig = await signHello(dev.kp.privateKey, { nonce: ch.nonce, deviceId: dev.deviceId, lastSeq: 0, lastEpoch: '' });
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
              deviceId: dev.deviceId,
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
      return { ws, reader };
    };

    let gw = await serverMod.createGatewayServer({
      remoteDir,
      sockPath,
      port: 0,
      writePid: false,
      udsWriteToken: writeToken,
      maxWritesPerMinute: 30,
      maxConcurrentWrites: 2,
    });
    servers.push(gw);

    const devSteer = await enroll(gw, 'steer', 'RT-Steer');
    const devObs = await enroll(gw, 'observe', 'RT-Obs');
    const cSteer = await connectClient(gw, devSteer);
    const cObs = await connectClient(gw, devObs);
    const cidA = '66666666-6666-4666-8666-666666666661';
    const cidB = '77777777-7777-4777-8777-777777777772';

    const sendFrame = (client, frame) => {
      client.ws.socket.write(makeMaskedClientFrame(0x1, Buffer.from(JSON.stringify(frame))));
    };
    const nextResFrames = async (reader, count) => {
      const map = new Map();
      for (let i = 0; i < count; i += 1) {
        const msg = JSON.parse((await reader.nextFrame()).payload.toString('utf8'));
        map.set(msg.reqId, msg);
      }
      return map;
    };

    // P1-1a: Concurrent same-key convo.send during 60ms bridge.health latency MUST execute UDS once
    writeCalls.length = 0;
    sendFrame(cSteer, {
      type: 'req',
      reqId: 'race-1',
      method: 'convo.send',
      params: { cascadeId: cidA, text: 'same payload', idempotencyKey: 'k-race-same-1' },
    });
    sendFrame(cSteer, {
      type: 'req',
      reqId: 'race-2',
      method: 'convo.send',
      params: { cascadeId: cidA, text: 'same payload', idempotencyKey: 'k-race-same-1' },
    });
    const raceMap = await nextResFrames(cSteer.reader, 2);
    assert.equal(raceMap.get('race-1').ok, true);
    assert.equal(raceMap.get('race-2').ok, true);
    assert.equal(raceMap.get('race-2').replayed, true);
    assert.equal(writeCalls.length, 1, 'same-key concurrent sends must deduplicate before bridge.health await');

    // P1-2: Reusing idempotencyKey for another cascadeId or different text rejects with idempotency_key_conflict
    sendFrame(cSteer, {
      type: 'req',
      reqId: 'conflict-cid',
      method: 'convo.send',
      params: { cascadeId: cidB, text: 'same payload', idempotencyKey: 'k-race-same-1' },
    });
    const cCid = JSON.parse((await cSteer.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(cCid.ok, false);
    assert.equal(cCid.error, 'idempotency_key_conflict');

    sendFrame(cSteer, {
      type: 'req',
      reqId: 'conflict-text',
      method: 'convo.send',
      params: { cascadeId: cidA, text: 'different payload', idempotencyKey: 'k-race-same-1' },
    });
    const cTxt = JSON.parse((await cSteer.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(cTxt.ok, false);
    assert.equal(cTxt.error, 'idempotency_key_conflict');

    // P1-1b: N > maxConcurrentWrites (2) distinct writes concurrently during bridge.health delay cannot bypass semaphore
    writeCalls.length = 0;
    udsServer.setWriteDelayMs(80);
    for (let i = 1; i <= 4; i += 1) {
      sendFrame(cSteer, {
        type: 'req',
        reqId: `sem-${i}`,
        method: 'convo.send',
        params: { cascadeId: cidA, text: `msg-${i}`, idempotencyKey: `k-sem-000${i}` },
      });
    }
    const semMap = await nextResFrames(cSteer.reader, 4);
    const semOk = [...semMap.values()].filter((m) => m.ok);
    const semTooMany = [...semMap.values()].filter((m) => m.error === 'too_many_concurrent_writes');
    assert.equal(semOk.length, 2);
    assert.equal(semTooMany.length, 2);
    assert.equal(writeCalls.length, 2, 'maxConcurrentWrites must enforce before bridge.health await');

    // P1-4 / P2 preset allowlist fail-closed: only 1 and 2 allowed without ack; 0/'', false, null, 3 require ack
    udsServer.setHealthDelayMs(0);
    udsServer.setWriteDelayMs(0);
    for (const p of [0, '', false, null, 3]) {
      udsServer.setGlobalPreset(p);
      sendFrame(cSteer, {
        type: 'req',
        reqId: `preset-deny-${String(p)}`,
        method: 'convo.send',
        params: { cascadeId: cidA, text: 'unsafe check', idempotencyKey: `k-pd-${String(p || 'empty')}-1234`, turboWriteConfirmed: false },
      });
      const denyRes = JSON.parse((await cSteer.reader.nextFrame()).payload.toString('utf8'));
      assert.equal(denyRes.error, 'turbo_write_confirmation_required');
    }
    udsServer.setGlobalPreset(1);
    sendFrame(cSteer, {
      type: 'req',
      reqId: 'preset-allow-1',
      method: 'convo.send',
      params: { cascadeId: cidA, text: 'safe 1', idempotencyKey: 'k-safe-preset-1', turboWriteConfirmed: false },
    });
    assert.equal(JSON.parse((await cSteer.reader.nextFrame()).payload.toString('utf8')).ok, true);

    // P1-3 & transient failure: UDS disconnect mid-write -> outcome_unknown persisted across gateway restarts; conversation_not_found NOT cached
    let failNotFound = true;
    writeCalls.length = 0;
    writeHandler = async (req) => {
      writeCalls.push(req);
      if (req.params.waitingStepHash === '1111111111111111') {
        udsServer.destroySockets();
        await new Promise((r) => setTimeout(r, 30));
        return { ok: true };
      }
      if (req.params.waitingStepHash === '2222222222222222' && failNotFound) {
        return { ok: false, error: 'conversation_not_found' };
      }
      return { ok: true, cascadeId: req.params.cascadeId };
    };

    sendFrame(cSteer, {
      type: 'req',
      reqId: 'unk-1',
      method: 'convo.approve',
      params: { cascadeId: cidA, stepIndex: 1, waitingStepHash: '1111111111111111', decision: 'allow_once', idempotencyKey: 'k-unk-1111' },
    });
    const unkRes = JSON.parse((await cSteer.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(unkRes.ok, false);
    assert.equal(unkRes.error, 'outcome_unknown');

    await gw.close();
    gw = await serverMod.createGatewayServer({
      remoteDir,
      sockPath,
      port: 0,
      writePid: false,
      udsWriteToken: writeToken,
      maxWritesPerMinute: 3,
      maxConcurrentWrites: 2,
    });
    servers.push(gw);

    const cSteerRestart = await connectClient(gw, devSteer);
    const cObsRestart = await connectClient(gw, devObs);
    const callsBeforeReplayUnk = writeCalls.length;
    sendFrame(cSteerRestart, {
      type: 'req',
      reqId: 'unk-replay',
      method: 'convo.approve',
      params: { cascadeId: cidA, stepIndex: 1, waitingStepHash: '1111111111111111', decision: 'allow_once', idempotencyKey: 'k-unk-1111' },
    });
    const unkReplay = JSON.parse((await cSteerRestart.reader.nextFrame()).payload.toString('utf8'));
    assert.equal(unkReplay.ok, false);
    assert.equal(unkReplay.error, 'outcome_unknown');
    assert.equal(unkReplay.replayed, true);
    assert.equal(writeCalls.length, callsBeforeReplayUnk, 'outcome_unknown must remain durable and block retry re-execution');

    sendFrame(cSteerRestart, {
      type: 'req',
      reqId: 'transient-1',
      method: 'convo.approve',
      params: { cascadeId: cidA, stepIndex: 2, waitingStepHash: '2222222222222222', decision: 'allow_once', idempotencyKey: 'k-trans-1111' },
    });
    assert.equal(JSON.parse((await cSteerRestart.reader.nextFrame()).payload.toString('utf8')).error, 'conversation_not_found');

    failNotFound = false;
    sendFrame(cSteerRestart, {
      type: 'req',
      reqId: 'transient-2',
      method: 'convo.approve',
      params: { cascadeId: cidA, stepIndex: 2, waitingStepHash: '2222222222222222', decision: 'allow_once', idempotencyKey: 'k-trans-1111' },
    });
    assert.equal(JSON.parse((await cSteerRestart.reader.nextFrame()).payload.toString('utf8')).ok, true, 'conversation_not_found must not be cached');

    // P2: Observe spam hits rate limit before RBAC/audit flood
    for (let i = 1; i <= 5; i += 1) {
      sendFrame(cObsRestart, {
        type: 'req',
        reqId: `obs-spam-${i}`,
        method: 'convo.send',
        params: { cascadeId: cidA, text: 'spam', idempotencyKey: `k-obs-spam-${i}` },
      });
    }
    const obsSpamMap = await nextResFrames(cObsRestart.reader, 5);
    assert.equal(obsSpamMap.get('obs-spam-1').error, 'forbidden_role_observe');
    assert.equal(obsSpamMap.get('obs-spam-3').error, 'forbidden_role_observe');
    assert.equal(obsSpamMap.get('obs-spam-4').error, 'write_rate_limited');
    assert.equal(obsSpamMap.get('obs-spam-5').error, 'write_rate_limited');
    const obsRlAudits = gw.audit.readTail(50).filter((e) => e.event === 'ws_write_rate_limited' && e.deviceId === devObs.deviceId);
    assert.equal(obsRlAudits.length, 1, 'rate-limit audit events must be throttled per device');

    // P2: probeRemoteCapabilities returns null when attached tapCap.globalPreset is null instead of falling back to diskPreset
    const fakeHome = path.join(tmpRoot, 'fake-home');
    fs.mkdirSync(path.join(fakeHome, '.gemini', 'config'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.gemini', 'config', 'config.json'), JSON.stringify({ userSettings: { globalPreset: 2 } }));
    const probeScript = `
      import assert from 'node:assert/strict';
      const bridgeMod = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'core', 'daemon', 'remote-bridge.mjs')).href)});
      const { attachedTargets } = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'core', 'daemon', 'env.mjs')).href)});
      assert.equal(bridgeMod.readDiskGlobalPreset(), 2);
      attachedTargets.set('host-null-preset', {
        id: 'host-null-preset',
        type: 'page',
        hostConfirmed: true,
        trustedContextId: 1,
        ws: { readyState: 1 },
        async send() {
          return {
            result: {
              result: {
                value: { ok: true, globalPreset: null, capabilities: { reduxSummaries: true, sendMessage: true, approval: true, cancel: true } },
              },
            },
          };
        },
      });
      const probed = await bridgeMod.probeRemoteCapabilities();
      assert.equal(probed.hostAttached, true);
      assert.equal(probed.globalPreset, null, 'attached host with globalPreset=null must stay null rather than stale diskPreset');
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', probeScript], {
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
      stdio: 'pipe',
    });
  } finally {
    for (const s of openSockets) {
      try { s.destroy(); } catch {}
    }
    for (const srv of servers) {
      await srv.close().catch(() => {});
    }
    await udsServer?.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('remote/shared/fs-paths.mjs handles Windows Named Pipes, permission gating, EPERM rename retries & IPC graceful shutdown', async () => {
  const sharedMod = await import(pathToFileURL(path.join(REPO, 'remote', 'shared', 'fs-paths.mjs')).href);

  // 1. Named pipe resolution on win32
  const winPipe = sharedMod.resolveSockPath('C:\\Users\\dev\\.gemini\\antigravity\\anti-claude\\remote', null, {
    platform: 'win32',
    env: {},
  });
  assert.equal(sharedMod.isWindowsNamedPipe(winPipe), true);
  assert.match(winPipe, /^\\\\\.\\pipe\\maga-rem-[0-9a-f]{16}$/);
  const explicitPipe = '\\\\.\\pipe\\custom-test-pipe';
  assert.equal(
    sharedMod.resolveSockPath('C:\\tmp', explicitPipe, { platform: 'win32', env: {} }),
    explicitPipe
  );
  assert.equal(sharedMod.isPosixPermsEnforced('win32'), false);
  assert.equal(sharedMod.isPosixPermsEnforced('darwin'), true);

  // 2. renameWithWinRetry recovers from transient EPERM / EBUSY on win32
  let renameAttempts = 0;
  sharedMod.renameWithWinRetry('a.tmp', 'a.json', {
    platform: 'win32',
    backoffMs: 1,
    renameFn: () => {
      renameAttempts += 1;
      if (renameAttempts < 3) {
        const err = new Error('transient lock');
        err.code = renameAttempts === 1 ? 'EPERM' : 'EBUSY';
        throw err;
      }
    },
  });
  assert.equal(renameAttempts, 3);

  // 3. Gateway IPC { type: 'shutdown' } gracefully removes PID file & flushes audit log
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maga-rem-ipc-win-'));
  const remoteDir = path.join(tmpRoot, 'remote');
  const distDir = path.join(tmpRoot, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body>OK</body></html>');
  configMod.ensureRemoteDir(remoteDir);
  const freePort = await getFreePort();
  configMod.saveRemoteConfig({ enabled: true, port: freePort, transport: 'loopback' }, { remoteDir });
  const sockPath = configMod.resolveSockPath(tmpRoot);

  const gwChild = fork(path.join(GW_DIR, 'server.mjs'), [], {
    cwd: REPO,
    env: {
      ...process.env,
      MAGA_REMOTE_STATE_DIR: remoteDir,
      MAGA_REMOTE_SOCK_PATH: sockPath,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('gateway_ipc_listen_timeout')), 5000);
      gwChild.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('maga_remote_gateway_listening')) {
          clearTimeout(t);
          resolve();
        }
      });
      gwChild.once('exit', (code) => {
        clearTimeout(t);
        reject(new Error(`gateway_exited_early_${code}`));
      });
    });

    assert.equal(fs.existsSync(path.join(remoteDir, 'gateway.pid')), true);
    const exitInfo = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('gateway_ipc_shutdown_timeout')), 4000);
      gwChild.once('exit', (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
      gwChild.send({ type: 'shutdown' });
    });
    assert.equal(exitInfo.code, 0);
    assert.equal(fs.existsSync(path.join(remoteDir, 'gateway.pid')), false, 'IPC shutdown must remove gateway.pid');
    const auditRaw = fs.readFileSync(path.join(remoteDir, 'audit.jsonl'), 'utf8');
    assert.match(auditRaw, /"event":"gateway_stop"/);
  } finally {
    if (gwChild.exitCode === null) {
      try { gwChild.kill('SIGKILL'); } catch {}
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
