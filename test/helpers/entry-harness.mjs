import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const payloadFiles = [
  'install-cc-sdd.mjs',
  'install-rules.mjs',
  'config-schema.mjs',
  'stop-notice-rules.mjs',
];
/** 承認の記録の配置物。trust: false の導入先では配らない（動的 import が失敗する古い導入先の再現） */
const trustPayloadFiles = [
  'codex-trust.mjs',
  'codex-trust-rules.mjs',
];
const fakeNpxSource = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const log = process.env.FAKE_NPX_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), lock: fs.existsSync('.cache/cc-sdd-install.lock') ? fs.readFileSync('.cache/cc-sdd-install.lock', 'utf8') : null }) + '\\n');
process.stdout.write('fake npx progress\\n');
process.stderr.write('fake npx progress\\n');
const mode = process.env.FAKE_NPX_MODE || 'ok';
if (mode === 'fail') { process.stderr.write('fake npx failure\\n'); process.exit(7); }
if (mode === 'hang') { await new Promise((resolve) => setTimeout(resolve, 60000)); process.exit(2); }
const delay = Number(process.env.FAKE_NPX_DELAY_MS || 0);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
if (mode !== 'ok' && mode !== 'lock') process.exit(2);
const manifestIndex = args.indexOf('--manifest');
const manifestPath = manifestIndex >= 0 ? args[manifestIndex + 1] : null;
let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { process.exit(3); }
const versionArg = args.find((arg) => arg.startsWith('cc-sdd@')) || 'cc-sdd@unknown';
const version = versionArg.slice('cc-sdd@'.length);
const langIndex = args.indexOf('--lang');
const lang = langIndex >= 0 ? args[langIndex + 1] : 'unknown';
const codex = args.includes('--codex-skills');
const targets = {
  skills: [codex ? '.agents/skills/kiro-fake/SKILL.md' : '.claude/skills/kiro-fake/SKILL.md', 'skill'],
  doc_main: [codex ? 'AGENTS.md' : 'CLAUDE.md', 'guide'],
  settings_templates: ['.kiro/settings/templates/specs/tasks.md', 'templates'],
};
for (const artifact of manifest.artifacts || []) {
  const target = targets[artifact.id];
  if (!target) continue;
  const destination = path.join(process.cwd(), target[0]);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, target[1] + ' ' + version + ' ' + lang);
}
if (mode === 'lock') {
  fs.chmodSync(path.join(process.cwd(), '.claude/skills/kiro-fake'), 0o000);
}
`;

/**
 * 偽の git。ls-remote のときだけ環境変数で挙動を変え、それ以外は本物の git へ素通しする。
 * 本物の git の場所は作成時に決めて埋め込む（PATH に fakeBin が先頭に入るため）。
 */
function fakeGitSource(realGit) {
  return `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const realGit = ${JSON.stringify(realGit)};
const args = process.argv.slice(2);
if (args[0] !== 'ls-remote') {
  const passthrough = spawnSync(realGit, args, { stdio: 'inherit' });
  process.exit(passthrough.status ?? 1);
}
const log = process.env.FAKE_GIT_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args, gitTerminalPrompt: process.env.GIT_TERMINAL_PROMPT ?? null }) + '\\n');
const mode = process.env.FAKE_GIT_MODE || 'ok';
if (mode === 'fail') { process.stderr.write('fatal: fake git failure\\n'); process.exit(128); }
if (mode === 'hang') { await new Promise((resolve) => setTimeout(resolve, 60000)); process.exit(2); }
if (mode !== 'ok') process.exit(2);
if (process.env.FAKE_GIT_STDOUT !== undefined) process.stdout.write(process.env.FAKE_GIT_STDOUT);
`;
}

/** PATH 上の本物の git を探す（/usr/bin/git を優先）。見つからなければ例外にする */
function findRealGit() {
  if (fs.existsSync('/usr/bin/git')) return '/usr/bin/git';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error('本物の git が見つからない');
}

/** ログ（JSON 1 行ずつ）を読み、読み取り後に消す。無ければ空配列 */
function readAndRemoveLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return [];
  } finally {
    fs.rmSync(logPath, { force: true });
  }
}

/**
 * install-cc-sdd.mjs を起動する子プロセスの環境。利用者の ~/.codex を読み書きしないよう、
 * CODEX_HOME と HOME は必ず試験用の一時ディレクトリにする（extra で上書きさせない）。
 */
export function isolatedEnv(repo, extra = {}) {
  return { ...process.env, ...extra, CODEX_HOME: repo.codexHome, HOME: repo.home };
}

/**
 * 一時のリポジトリを作る。
 * - entryName: 起動する入口の名前（既定 install-cc-sdd.mjs）。repo.entry がこれを指す
 * - payload: 写す配置物の名前の配列。指定時は既定の配置物・信頼の配置物の代わりに、これだけを写す（無いファイルは写さない）
 * - fakeGit: true のとき fakeBin に偽の git を置く（ls-remote だけ偽、他は本物へ素通し）
 */
export function makeRepo({ config = { format: 1, ccSdd: { version: '3.1.0', lang: 'ja' } }, sections = true, trust = true, entryName = 'install-cc-sdd.mjs', payload, fakeGit = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-entry-repo-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-entry-bin-'));
  // 利用者の実際の ~/.codex に触れないよう、試験ごとに別の CODEX_HOME と HOME を使う
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-entry-codex-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-entry-home-'));
  const payloadRoot = path.join(root, '.agent-hooks/cc-sdd-bootstrap');
  fs.mkdirSync(payloadRoot, { recursive: true });
  const copied = payload ?? (trust ? [...payloadFiles, ...trustPayloadFiles] : payloadFiles);
  for (const name of copied) {
    const source = path.join(projectRoot, '.agent-hooks/cc-sdd-bootstrap', name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(payloadRoot, name));
  }
  fs.writeFileSync(path.join(fakeBin, 'npx'), fakeNpxSource, { mode: 0o755 });
  if (fakeGit) fs.writeFileSync(path.join(fakeBin, 'git'), fakeGitSource(findRealGit()), { mode: 0o755 });
  if (config !== null) {
    fs.writeFileSync(path.join(root, '.cc-sdd-bootstrap.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  }
  if (sections) {
    for (const name of ['agent-section-claude.md', 'agent-section-codex.md']) {
      const source = path.join(projectRoot, '.agent-hooks/cc-sdd-bootstrap', name);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(payloadRoot, name));
      else fs.writeFileSync(path.join(payloadRoot, name), '<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->\n区画\n<!-- cc-sdd-bootstrap:end -->\n');
    }
  }
  const resolve = (rel) => path.join(root, rel);
  return {
    root,
    fakeBin,
    codexHome,
    home,
    entry: path.join(payloadRoot, entryName),
    read(rel) {
      try { return fs.readFileSync(resolve(rel), 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    write(rel, text) {
      const target = resolve(rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    },
    putSections() {
      for (const name of ['agent-section-claude.md', 'agent-section-codex.md']) {
        const source = path.join(projectRoot, '.agent-hooks/cc-sdd-bootstrap', name);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(payloadRoot, name));
        else fs.writeFileSync(path.join(payloadRoot, name), '<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->\n区画\n<!-- cc-sdd-bootstrap:end -->\n');
      }
    },
    exists(rel) {
      return fs.existsSync(resolve(rel));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * 入口を子プロセスで起動する。
 * - input: 標準入力に渡す文字列（既定は空）
 * - env: 追加の環境変数（FAKE_GIT_MODE・FAKE_GIT_STDOUT など）。FAKE_NPX_LOG・FAKE_GIT_LOG は runEntry が決める
 * 結果の npxCalls・gitCalls は、それぞれの偽コマンドの呼び出しログ（無ければ空配列）。
 */
export function runEntry(repo, args = [], { mode = 'ok', env = {}, timeoutMs = 30000, cwd = os.tmpdir(), input = '' } = {}) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const npxLogPath = path.join(repo.fakeBin, `npx-calls-${stamp}.jsonl`);
  const gitLogPath = path.join(repo.fakeBin, `git-calls-${stamp}.jsonl`);
  const result = spawnSync(process.execPath, [repo.entry, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    input,
    env: {
      ...isolatedEnv(repo, env),
      PATH: `${repo.fakeBin}${path.delimiter}${env.PATH ?? process.env.PATH ?? ''}`,
      FAKE_NPX_MODE: mode,
      FAKE_NPX_LOG: npxLogPath,
      FAKE_GIT_LOG: gitLogPath,
    },
  });
  const npxCalls = readAndRemoveLog(npxLogPath);
  const gitCalls = readAndRemoveLog(gitLogPath);
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? ''),
    npxCalls,
    gitCalls,
  };
}
