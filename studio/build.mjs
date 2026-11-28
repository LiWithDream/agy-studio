/**
 * Modular esbuild bundler & deployer for agy-studio.
 * Compiles studio/entry.mjs (ESM) + studio/styles/*.css into bounded blocks inside
 * ~/.gemini/antigravity/anti-claude/user/{custom.js,custom.css,config.json}.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPresentation } from '../vendor/agy-capsule/ui.mjs';
import { buildPickerShadowCss } from './modules/capsule-picker.mjs';
import { evaluateDeployGuard, writeDeployMeta } from './deploy-meta.mjs';
import { DEFAULT_STUDIO_PREFS } from './shared/prefs-schema.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..');
const VENDOR_CAPSULE = path.join(REPO_ROOT, 'vendor', 'agy-capsule');
const STYLES_DIR = path.join(__dirname, 'styles');
const ENTRY_FILE = path.join(__dirname, 'entry.mjs');
export const PREBUILT_STUDIO_ENTRY = path.join(__dirname, 'prebuilt', 'studio-entry.js');
const USER_ENTRY_FILE = path.join(REPO_ROOT, 'user', 'src', 'entry.mjs');
const REPO_USER_JS = path.join(REPO_ROOT, 'user', 'custom.js');
const REPO_USER_CSS = path.join(REPO_ROOT, 'user', 'custom.css');
let _esbuildPromise = null;
async function loadEsbuild() {
  if (!_esbuildPromise) {
    _esbuildPromise = import('esbuild').catch((err) => {
      _esbuildPromise = null;
      throw new Error(
        `esbuild is not installed (${err?.code || err?.message || 'missing'}). Run "npm install" or use a prebuilt release tarball.`
      );
    });
  }
  return _esbuildPromise;
}
const REMOTE_PWA_DIR = path.join(REPO_ROOT, 'remote', 'pwa');
const REMOTE_PWA_ENTRY = path.join(REMOTE_PWA_DIR, 'src', 'app.mjs');
const REMOTE_PWA_CSS = path.join(REMOTE_PWA_DIR, 'src', 'styles.css');
export const REMOTE_PWA_DIST = path.join(REMOTE_PWA_DIR, 'dist');
const HOME = homedir();

export const STATE_DIR = path.join(HOME, '.gemini', 'antigravity', 'anti-claude');
export const TARGET_USER_DIR = path.join(STATE_DIR, 'user');
export const TARGET_CUSTOM_JS = path.join(TARGET_USER_DIR, 'custom.js');
export const TARGET_CUSTOM_CSS = path.join(TARGET_USER_DIR, 'custom.css');
export const TARGET_CONFIG_JSON = path.join(TARGET_USER_DIR, 'config.json');
export const TARGET_UI_PREFS_JSON = path.join(STATE_DIR, 'ui-prefs.json');
const STUDIO_PREFS_PATH = path.join(STATE_DIR, 'studio-prefs.json');

export const JS_BEGIN = '/* === BEGIN AGY-STUDIO === */';
export const JS_END = '/* === END AGY-STUDIO === */';
export const CSS_BEGIN = '/* === BEGIN AGY-STUDIO-CSS === */';
export const CSS_END = '/* === END AGY-STUDIO-CSS === */';

const STYLE_FILES = [
  'typography.css',
  'footer-capsules.css',
  'quota-popover.css',
  'overview-usage.css',
  'studio-settings.css',
  'anchors-pill.css',
  'sidebar-projects.css',
  'projects-overview.css',
];

const DEFAULT_PREFS = DEFAULT_STUDIO_PREFS;

export function stripBlock(content, beginMarker, endMarker) {
  const start = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) return content;
  const before = content.slice(0, start).replace(/\s+$/, '');
  const after = content.slice(end + endMarker.length).replace(/^\s+/, '');
  return after ? `${before}\n\n${after}\n` : `${before}\n`;
}

function loadUserCapsulePrefs() {
  let saved = {};
  try {
    if (existsSync(STUDIO_PREFS_PATH)) {
      saved = JSON.parse(readFileSync(STUDIO_PREFS_PATH, 'utf8'));
    }
  } catch {}
  return {
    ...DEFAULT_PREFS,
    ...Object.fromEntries(
      Object.keys(DEFAULT_PREFS)
        .filter((k) => k in saved)
        .map((k) => [k, saved[k]])
    ),
    modelEffortPicker: true,
  };
}

export async function buildUserCustomJs({ writeToRepo = true, allowPrebuilt = false } = {}) {
  const preferPrebuilt = process.env.MAGA_USE_PREBUILT === '1';
  if (allowPrebuilt && existsSync(REPO_USER_JS)) {
    let esbuildMod = null;
    if (!preferPrebuilt) {
      try {
        esbuildMod = await loadEsbuild();
      } catch {
        esbuildMod = null;
      }
    }
    if (preferPrebuilt || !esbuildMod) {
      const code = readFileSync(REPO_USER_JS, 'utf8');
      if (code.trim()) {
        new Function('ctx', code);
        return { code, bytes: Buffer.byteLength(code, 'utf8'), prebuilt: true };
      }
    }
  }

  if (!existsSync(USER_ENTRY_FILE)) {
    throw new Error(`Missing user runtime entry point at ${USER_ENTRY_FILE}`);
  }
  const esbuild = await loadEsbuild();
  const bundled = await esbuild.build({
    entryPoints: [USER_ENTRY_FILE],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome126'],
    minify: false,
    keepNames: false,
    legalComments: 'none',
  });
  const compiled = (bundled.outputFiles?.[0]?.text || '').trim();
  if (!compiled) {
    throw new Error('esbuild produced an empty bundle for user/src/entry.mjs');
  }
  const banner = '/* Anti-Claude — user/custom.js (compiled from user/src/entry.mjs via esbuild; run `npm run build:user`) */';
  const code = `${banner}\n${compiled}\n`;
  // Validate standalone script compatibility with core/runtime.js and Chrome Desktop WebView
  new Function('ctx', code);
  if (writeToRepo) {
    writeFileSync(REPO_USER_JS, code, 'utf8');
  }
  return { code, bytes: Buffer.byteLength(code, 'utf8'), prebuilt: false };
}

export async function compileStudioCoreIife() {
  const esbuild = await loadEsbuild();
  const bundled = await esbuild.build({
    entryPoints: [ENTRY_FILE],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome126'],
    minify: false,
    keepNames: false,
    legalComments: 'none',
  });
  const compiledJs = (bundled.outputFiles?.[0]?.text || '').trim();
  if (!compiledJs) {
    throw new Error('esbuild produced an empty bundle for studio/entry.mjs');
  }
  return compiledJs;
}

export async function buildStudioBundle({ allowPrebuilt = true } = {}) {
  const imp = (file) => import(pathToFileURL(path.join(VENDOR_CAPSULE, file)).href);
  const [{ AGENT_ENTRY_CSS }, { EFFORT_BAR_CSS }] = await Promise.all([
    imp('agent_entry.mjs'),
    imp('effort_bar.mjs'),
  ]);

  const prefs = loadUserCapsulePrefs();
  const presentation = createPresentation();
  const pickDict = (lang) => {
    const d = presentation.dictionaries[lang] || presentation.dictionaries.en;
    return {
      modelEffortPicker: d.modelEffortPicker,
      effortLevel: d.effortLevel,
      modelPickerUnconfirmed: d.modelPickerUnconfirmed,
      effortBarOptions: d.effortBarOptions,
    };
  };
  const labelsByLang = {
    en: pickDict('en'),
    'zh-CN': pickDict('zh-CN'),
  };

  const shadowCss = buildPickerShadowCss({
    effortBarCss: EFFORT_BAR_CSS,
    agentEntryCss: AGENT_ENTRY_CSS,
  });

  let coreIife = '';
  const preferPrebuilt = process.env.MAGA_USE_PREBUILT === '1';
  if (allowPrebuilt && existsSync(PREBUILT_STUDIO_ENTRY)) {
    let canUseEsbuild = !preferPrebuilt;
    if (canUseEsbuild) {
      try {
        await loadEsbuild();
      } catch {
        canUseEsbuild = false;
      }
    }
    if (!canUseEsbuild) {
      coreIife = readFileSync(PREBUILT_STUDIO_ENTRY, 'utf8').trim();
    }
  }
  if (!coreIife) {
    coreIife = await compileStudioCoreIife();
  }

  const wrappedJs = [
    '(function() {',
    `const __STUDIO_DEFAULT_PREFS__ = ${JSON.stringify(DEFAULT_PREFS)};`,
    `const __STUDIO_PREFS__ = ${JSON.stringify(prefs)};`,
    `const __STUDIO_LABELS__ = ${JSON.stringify(labelsByLang)};`,
    `const __PICKER_SHADOW_CSS__ = ${JSON.stringify(shadowCss)};`,
    coreIife,
    '})();',
  ].join('\n');

  const jsBlock = `${JS_BEGIN}\n${wrappedJs}\n${JS_END}\n`;

  // Fail fast if generated JS has any syntax issue before touching live files
  new Function('ctx', jsBlock);

  const combinedCss = STYLE_FILES.map((file) => {
    const body = readFileSync(path.join(STYLES_DIR, file), 'utf8').trim();
    return `/* --- studio/styles/${file} --- */\n${body}`;
  }).join('\n\n');

  const cssBlock = `${CSS_BEGIN}\n${combinedCss}\n${CSS_END}\n`;

  return { jsBlock, cssBlock, prefs };
}

const VALID_CJK_SCALES = new Set(['94.5', '95', '100']);

export function syncLiveConfigForStudio({
  configPath = TARGET_CONFIG_JSON,
  uiPrefsPath = TARGET_UI_PREFS_JSON,
} = {}) {
  let prefs = null;
  if (existsSync(uiPrefsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(uiPrefsPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        prefs = parsed;
      }
    } catch {}
  }
  if (!prefs) {
    prefs = { schema: 1, updatedAt: 0, modules: {} };
  }
  prefs.modules =
    prefs.modules && typeof prefs.modules === 'object' && !Array.isArray(prefs.modules) ? prefs.modules : {};
  const needsMigration = prefs.stepUnfoldDefaultMigrated !== true;

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    cfg.modules = cfg.modules && typeof cfg.modules === 'object' ? cfg.modules : {};
    let dirty = false;
    if (cfg.modules.claudeUxStepUnfold === undefined || (needsMigration && cfg.modules.claudeUxStepUnfold !== true)) {
      cfg.modules.claudeUxStepUnfold = true;
      dirty = true;
    }
    const curScale = String(cfg.cjkFontScale ?? '').trim();
    if (!VALID_CJK_SCALES.has(curScale)) {
      cfg.cjkFontScale = '95';
      dirty = true;
    }
    if (dirty) {
      writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    }
  }

  if (needsMigration) {
    // One-time migration off legacy deploy-forced `claudeUxStepUnfold: false`;
    // bumps updatedAt to invalidate stale client localStorage overrides while preserving
    // subsequent explicit user mode selections (e.g., Compact `false`).
    prefs.modules.claudeUxStepUnfold = true;
    prefs.stepUnfoldDefaultMigrated = true;
    prefs.updatedAt = Math.max(Date.now(), (Number(prefs.updatedAt) || 0) + 1);
    mkdirSync(path.dirname(uiPrefsPath), { recursive: true });
    writeFileSync(uiPrefsPath, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
  }
}

export function stripStudioBlocksOnly() {
  if (existsSync(TARGET_CUSTOM_JS)) {
    const raw = stripBlock(readFileSync(TARGET_CUSTOM_JS, 'utf8'), JS_BEGIN, JS_END);
    writeFileSync(TARGET_CUSTOM_JS, raw, 'utf8');
  }
  if (existsSync(TARGET_CUSTOM_CSS)) {
    const raw = stripBlock(readFileSync(TARGET_CUSTOM_CSS, 'utf8'), CSS_BEGIN, CSS_END);
    writeFileSync(TARGET_CUSTOM_CSS, raw, 'utf8');
  }
}

export async function deployStudio({ allowNonMain = false, mode = 'deploy', metaPath } = {}) {
  if (!existsSync(TARGET_CUSTOM_JS) || !existsSync(TARGET_CUSTOM_CSS)) {
    throw new Error(
      `Anti-Claude user directory not initialized at ${TARGET_USER_DIR}. Run "node studio/cli.mjs install" first.`
    );
  }

  const guard = evaluateDeployGuard(REPO_ROOT, { allowNonMain, mode, metaPath });
  if (!guard.allowed) {
    throw new Error(guard.reason);
  }

  await buildUserCustomJs({ writeToRepo: true, allowPrebuilt: true });
  const remotePwa = await buildRemotePwa({ allowPrebuilt: true });
  const { jsBlock, cssBlock, prefs } = await buildStudioBundle();

  let baseJs = existsSync(REPO_USER_JS) ? readFileSync(REPO_USER_JS, 'utf8') : readFileSync(TARGET_CUSTOM_JS, 'utf8');
  baseJs = stripBlock(baseJs, JS_BEGIN, JS_END);
  writeFileSync(TARGET_CUSTOM_JS, `${baseJs.replace(/\s+$/, '')}\n\n${jsBlock}`, 'utf8');

  let baseCss = existsSync(REPO_USER_CSS) ? readFileSync(REPO_USER_CSS, 'utf8') : readFileSync(TARGET_CUSTOM_CSS, 'utf8');
  baseCss = stripBlock(baseCss, CSS_BEGIN, CSS_END);
  writeFileSync(TARGET_CUSTOM_CSS, `${baseCss.replace(/\s+$/, '')}\n\n${cssBlock}`, 'utf8');

  syncLiveConfigForStudio();
  const deployedFrom = writeDeployMeta(REPO_ROOT, metaPath, { preview: Boolean(guard.preview) });

  return {
    ok: true,
    action: 'deployed',
    customJsPath: TARGET_CUSTOM_JS,
    customCssPath: TARGET_CUSTOM_CSS,
    configJsonPath: TARGET_CONFIG_JSON,
    jsBytes: Buffer.byteLength(jsBlock, 'utf8'),
    cssBytes: Buffer.byteLength(cssBlock, 'utf8'),
    remotePwa,
    deployedFrom,
    ...(guard.warnings.length ? { deployWarnings: guard.warnings } : {}),
    prefs,
  };
}

export function rollbackStudio() {
  stripStudioBlocksOnly();
  return { ok: true, action: 'rolled_back' };
}

export async function buildRemotePwa({ outDir = REMOTE_PWA_DIST, allowPrebuilt = false } = {}) {
  const prebuiltAssets = ['index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'sw.js'];
  const preferPrebuilt = process.env.MAGA_USE_PREBUILT === '1';
  if (allowPrebuilt && prebuiltAssets.every((f) => existsSync(path.join(outDir, f)))) {
    let esbuildMod = null;
    if (!preferPrebuilt) {
      try {
        esbuildMod = await loadEsbuild();
      } catch {
        esbuildMod = null;
      }
    }
    if (preferPrebuilt || !esbuildMod) {
      const appCode = readFileSync(path.join(outDir, 'app.js'), 'utf8');
      if (appCode.trim()) {
        new Function(appCode);
        const files = Object.fromEntries(
          prebuiltAssets.map((f) => [f, readFileSync(path.join(outDir, f)).byteLength])
        );
        return { ok: true, outDir, prebuilt: true, files };
      }
    }
  }

  if (!existsSync(REMOTE_PWA_ENTRY)) {
    throw new Error(`Missing remote PWA entry point at ${REMOTE_PWA_ENTRY}`);
  }
  if (!existsSync(REMOTE_PWA_CSS)) {
    throw new Error(`Missing remote PWA stylesheet at ${REMOTE_PWA_CSS}`);
  }

  const esbuild = await loadEsbuild();
  const bundled = await esbuild.build({
    entryPoints: [REMOTE_PWA_ENTRY],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome126', 'safari17'],
    minify: false,
    keepNames: false,
    legalComments: 'none',
  });
  const compiledJs = (bundled.outputFiles?.[0]?.text || '').trim();
  if (!compiledJs) {
    throw new Error('esbuild produced an empty bundle for remote/pwa/src/app.mjs');
  }
  const jsOut = `/* AGY Studio Remote PWA — compiled from remote/pwa/src/app.mjs */\n${compiledJs}\n`;
  new Function(jsOut);

  if (!existsSync(REMOTE_PWA_CSS)) {
    throw new Error(`Missing remote PWA stylesheet at ${REMOTE_PWA_CSS}`);
  }
  const cssBundled = await esbuild.build({
    entryPoints: [REMOTE_PWA_CSS],
    bundle: true,
    write: false,
    minify: false,
    legalComments: 'none',
  });
  const cssOut = cssBundled.outputFiles?.[0]?.text || '';
  if (!cssOut.trim()) {
    throw new Error('esbuild produced an empty CSS bundle for remote/pwa/src/styles.css');
  }
  if (cssOut.includes(':has(')) {
    throw new Error('remote/pwa/src/styles.css must not contain :has() selectors');
  }
  if (cssOut.includes('height: 100dvh') || cssOut.includes('height:100dvh')) {
    throw new Error('remote/pwa/src/styles.css must avoid height: 100dvh');
  }

  mkdirSync(outDir, { recursive: true });

  const jsDest = path.join(outDir, 'app.js');
  const cssDest = path.join(outDir, 'styles.css');
  writeFileSync(jsDest, jsOut, 'utf8');
  writeFileSync(cssDest, cssOut, 'utf8');

  const staticFileNames = ['index.html', 'manifest.webmanifest', 'sw.js'];
  const binaryStaticFiles = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
  const staticSources = {};
  for (const staticFile of staticFileNames) {
    const src = path.join(REMOTE_PWA_DIR, staticFile);
    if (!existsSync(src)) {
      throw new Error(`Missing remote PWA static asset at ${src}`);
    }
    staticSources[staticFile] = readFileSync(src, 'utf8');
  }

  const buildHash = createHash('sha256')
    .update(jsOut)
    .update('\0')
    .update(cssOut)
    .update('\0')
    .update(staticSources['index.html'])
    .update('\0')
    .update(staticSources['sw.js'])
    .update('\0')
    .update(staticSources['manifest.webmanifest'])
    .digest('hex')
    .slice(0, 8);

  const files = {
    'app.js': Buffer.byteLength(jsOut, 'utf8'),
    'styles.css': Buffer.byteLength(cssOut, 'utf8'),
  };

  for (const staticFile of staticFileNames) {
    const src = path.join(REMOTE_PWA_DIR, staticFile);
    const dst = path.join(outDir, staticFile);
    if (staticFile === 'index.html') {
      const htmlSrc = staticSources['index.html']
        .replace('href="/styles.css"', `href="/styles.css?v=${buildHash}"`)
        .replace('src="/app.js"', `src="/app.js?v=${buildHash}"`);
      writeFileSync(dst, htmlSrc, 'utf8');
    } else if (staticFile === 'sw.js') {
      const swSrc = staticSources['sw.js'].replace(
        /const CACHE_NAME = ['"][^'"]+['"];/,
        `const CACHE_NAME = 'maga-remote-shell-${buildHash}';`
      );
      writeFileSync(dst, swSrc, 'utf8');
    } else {
      copyFileSync(src, dst);
    }
    files[staticFile] = readFileSync(dst).byteLength;
  }

  for (const iconFile of binaryStaticFiles) {
    const src = path.join(REMOTE_PWA_DIR, iconFile);
    if (!existsSync(src)) continue;
    const dst = path.join(outDir, iconFile);
    copyFileSync(src, dst);
    files[iconFile] = readFileSync(dst).byteLength;
  }

  return {
    ok: true,
    outDir,
    prebuilt: false,
    buildHash,
    files,
  };
}
