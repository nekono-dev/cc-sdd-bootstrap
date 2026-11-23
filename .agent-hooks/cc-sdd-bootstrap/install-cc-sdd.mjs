#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  CONFIG_FILE, UPDATE_COMMAND, FAILURE_RECORD, STATE_PATH, LOCK_PATH, INSTALL_DEADLINE_MS, RECORD_IN_PROGRESS, SECTION_BEGIN_MARKER,
  RETRY_COMMAND,
  readInstallConfig, parseState, buildState, decideInstall,
  removalTargets, buildManifest, npxArgs, messageInstalled, messageSkipped,
  messageGuide, failureRecordText, messageFailed
} from './install-rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const absolute = (rel, repoRoot = root) => path.join(repoRoot, rel);
const writeRecord = (rel, text) => {
  fs.mkdirSync(path.dirname(absolute(rel)), { recursive: true });
  fs.writeFileSync(absolute(rel), text, 'utf8');
};
/** 導入判断に使う材料を一度に読み取る */
export function readInstallFacts(repoRoot = root) {
  let configText = null;
  try { configText = fs.readFileSync(absolute(CONFIG_FILE, repoRoot), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`${CONFIG_FILE} を読み取れません: ${error.message} ${CONFIG_FILE} を直すか、${UPDATE_COMMAND} で設定を新しくしてください。`);
    }
  }
  const config = readInstallConfig(configText);
  let stateText = null;
  try { stateText = fs.readFileSync(absolute(STATE_PATH, repoRoot), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') stateText = ''; }
  const state = parseState(stateText);
  let lock = { present: false };
  try { lock = { present: true, ageMs: Math.max(0, Date.now() - fs.statSync(absolute(LOCK_PATH, repoRoot)).mtimeMs) }; }
  catch (error) { if (error.code !== 'ENOENT') lock = { present: true, ageMs: 0 }; }
  let failure = { present: false };
  try { failure = { present: true, text: fs.readFileSync(absolute(FAILURE_RECORD, repoRoot), 'utf8') }; }
  catch (error) { if (error.code !== 'ENOENT') failure = { present: true, text: null }; }
  const missingFiles = state ? state.files.filter((rel) => !fs.existsSync(absolute(rel, repoRoot))) : [];
  const sectionPresent = Object.fromEntries(['claude', 'codex'].map((tool) => {
    const doc = tool === 'claude' ? 'CLAUDE.md' : 'AGENTS.md';
    try { return [tool, fs.readFileSync(absolute(doc, repoRoot), 'utf8').split(/\r?\n/).includes(SECTION_BEGIN_MARKER)]; }
    catch { return [tool, false]; }
  }));
  return { config, state, lock, failure, missingFiles, sectionPresent };
}
/** 消す道筋の各区間にシンボリックリンクがあれば、削除前に失敗させる */
function rejectLinkedPath(rel) {
  let current = '';
  for (const part of rel.split('/')) {
    current = current ? `${current}/${part}` : part;
    try {
      if (fs.lstatSync(absolute(current)).isSymbolicLink()) throw new Error(`${current} がシンボリックリンクです。`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      break;
    }
  }
}

function removeTarget(rel) {
  const full = absolute(rel);
  let stat;
  try { stat = fs.lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(full, { recursive: true, force: false });
  else fs.unlinkSync(full);
}

/** 導入物の道筋の一覧を返す（中身は持たない） */
function collectFiles() {
  const files = [];
  const collect = (rel, includeAll = false) => {
    let entries;
    try { entries = fs.readdirSync(absolute(rel), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) collect(child, includeAll);
      else if (entry.isFile() && (includeAll || child.endsWith('/SKILL.md') || child === 'CLAUDE.md' || child === 'AGENTS.md')) files.push(child);
    }
  };
  for (const dir of ['.claude/skills', '.agents/skills']) {
    let skillEntries = [];
    try { skillEntries = fs.readdirSync(absolute(dir), { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of skillEntries) {
      if (entry.name.startsWith('kiro-') && entry.isDirectory()) collect(`${dir}/${entry.name}`, true);
    }
  }
  collect('.kiro/settings', true);
  for (const doc of ['CLAUDE.md', 'AGENTS.md']) {
    try { if (fs.statSync(absolute(doc)).isFile()) files.push(doc); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return files;
}

const SECTION_FILES = { claude: '.agent-hooks/cc-sdd-bootstrap/agent-section-claude.md', codex: '.agent-hooks/cc-sdd-bootstrap/agent-section-codex.md' };
const recordedInstallErrors = new WeakSet();

function appendSection(tool, doc) {
  const sectionPath = SECTION_FILES[tool];
  let section;
  try {
    section = fs.readFileSync(absolute(sectionPath), 'utf8');
  } catch (error) {
    throw new Error(`${sectionPath} を読み取れません: ${error.message}`);
  }
  if (section.trim().length === 0) throw new Error(`${sectionPath} に運用の区画がありません。`);
  const full = absolute(doc);
  let contents;
  try { contents = fs.readFileSync(full, 'utf8'); }
  catch (error) { throw new Error(`${doc} を読み取れません: ${error.message}`); }
  const separator = contents.length > 0 && !contents.endsWith('\n') ? '\n' : '';
  try { fs.writeFileSync(full, `${contents}${separator}${section}`, 'utf8'); }
  catch (error) { throw new Error(`${doc} に運用の区画を書けません: ${error.message}`); }
}

class BusyInstallError extends Error {}

function performInstall(config) {
  fs.mkdirSync(absolute(path.dirname(LOCK_PATH)), { recursive: true });
  let lockFd;
  try {
    lockFd = fs.openSync(absolute(LOCK_PATH), 'wx');
    fs.writeFileSync(lockFd, `${new Date().toISOString()}\n${RETRY_COMMAND}\n`, 'utf8');
  } catch (error) {
    if (lockFd !== undefined) fs.closeSync(lockFd);
    if (error.code === 'EEXIST') throw new BusyInstallError('別の導入が進行中です。');
    if (lockFd !== undefined) fs.rmSync(absolute(LOCK_PATH), { force: true });
    throw error;
  }
  fs.closeSync(lockFd);
  const manifestPaths = [];
  try {
    writeRecord(FAILURE_RECORD, RECORD_IN_PROGRESS);
    const entries = { claude: [], codex: [] };
    for (const [tool, dir] of [['claude', '.claude/skills'], ['codex', '.agents/skills']]) {
      rejectLinkedPath(dir);
      try { entries[tool] = fs.readdirSync(absolute(dir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const targets = removalTargets(entries);
    for (const target of targets) rejectLinkedPath(target);
    for (const target of targets) removeTarget(target);

    const rawTimeout = process.env.CC_SDD_BOOTSTRAP_NPX_TIMEOUT_MS;
    const override = /^\d+$/.test(rawTimeout ?? '') && Number(rawTimeout) > 0 ? Number(rawTimeout) : INSTALL_DEADLINE_MS;
    const deadline = Date.now() + Math.min(INSTALL_DEADLINE_MS, override);
    for (const tool of ['claude', 'codex']) {
      const cache = absolute('.cache');
      fs.mkdirSync(cache, { recursive: true });
      const manifestPath = absolute(`.cache/cc-sdd-install.manifest.${process.pid}.${tool}.json`);
      manifestPaths.push(manifestPath);
      fs.writeFileSync(manifestPath, JSON.stringify(buildManifest(tool)), 'utf8');
      const timeout = Math.max(1, deadline - Date.now());
      const result = spawnSync('npx', npxArgs(config, tool, manifestPath), { cwd: root, stdio: ['ignore', 2, 2], timeout });
      if (result.error?.code === 'ETIMEDOUT') throw new Error(`導入全体の期限（${Math.ceil(Math.min(INSTALL_DEADLINE_MS, override) / 1000)}秒）を過ぎました。通信を確かめてから再試行してください`);
      if (result.error) throw new Error(`npx を起動できませんでした: ${result.error.message}`);
      if (result.status !== 0) throw new Error(`npx（${tool}）の終了コードが ${result.status ?? result.signal} でした。通信・版（${config.version}）・言語（${config.lang}）を確かめてください`);
    }

    appendSection('claude', 'CLAUDE.md');
    appendSection('codex', 'AGENTS.md');
    const state = buildState(config, collectFiles());
    const stateTmp = absolute(`${STATE_PATH}.${process.pid}.tmp`);
    fs.writeFileSync(stateTmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(stateTmp, absolute(STATE_PATH));
    fs.rmSync(absolute(FAILURE_RECORD), { force: true });
    process.stdout.write(`${messageInstalled(config)}\n${messageGuide()}\n`);
  } catch (error) {
    try { writeRecord(FAILURE_RECORD, failureRecordText(error.message)); }
    catch (recordError) { process.stderr.write(`失敗の記録を書けませんでした: ${recordError.message}\n`); }
    const failure = error instanceof Error ? error : new Error(String(error));
    recordedInstallErrors.add(failure);
    throw failure;
  } finally {
    for (const manifestPath of manifestPaths) fs.rmSync(manifestPath, { force: true });
    fs.rmSync(absolute(LOCK_PATH), { force: true });
  }
}

function runCli() {
const hookMode = process.argv[2] === 'session-start';
const argsValid = process.argv.length === 2 || (process.argv.length === 3 && hookMode);
if (!argsValid) {
  process.stderr.write('使い方: node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs [session-start]\n');
  process.exit(2);
}
try {
  const facts = readInstallFacts();
  const checked = facts.config;
  if (!checked.ok) throw new Error(checked.reason);
  const config = checked.config;
  const decision = decideInstall(facts);
  if (decision.action === 'skip') {
    process.stdout.write(`${messageSkipped(config)}\n${messageGuide()}\n`);
  } else if (decision.action === 'install') {
    performInstall(config);
  } else {
    process.stdout.write(`${decision.action === 'busy' ? '導入中の印があります。' : decision.reason}\n`);
    process.exitCode = 1;
    process.exit();
  }
  process.exitCode = 0;
} catch (error) {
  if (error instanceof BusyInstallError) {
    process.stdout.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  // 失敗記録は導入中の印を持つ実行だけが更新する。
  if (!(error instanceof Error && recordedInstallErrors.has(error)) && !fs.existsSync(absolute(LOCK_PATH))) {
    try { writeRecord(FAILURE_RECORD, failureRecordText(reason)); }
    catch (recordError) { process.stderr.write(`失敗の記録を書けませんでした: ${recordError.message}\n`); }
  }
  process.stdout.write(`${messageFailed(reason)}\n`);
  process.exitCode = hookMode ? 0 : 1;
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runCli();
