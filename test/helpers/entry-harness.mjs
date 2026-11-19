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
  'install-gate.mjs',
];
const fakeNpxSource = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const log = process.env.FAKE_NPX_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
process.stdout.write('fake npx progress\\n');
process.stderr.write('fake npx progress\\n');
const mode = process.env.FAKE_NPX_MODE || 'ok';
if (mode === 'fail') { process.stderr.write('fake npx failure\\n'); process.exit(7); }
if (mode === 'hang') { await new Promise((resolve) => setTimeout(resolve, 60000)); process.exit(2); }
if (mode !== 'ok') process.exit(2);
const manifestIndex = args.indexOf('--manifest');
const manifestPath = manifestIndex >= 0 ? args[manifestIndex + 1] : null;
let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { process.exit(3); }
const versionArg = args.find((arg) => arg.startsWith('cc-sdd@')) || 'cc-sdd@unknown';
const version = versionArg.slice('cc-sdd@'.length);
const langIndex = args.indexOf('--lang');
const lang = langIndex >= 0 ? args[langIndex + 1] : 'unknown';
const targets = {
  skills: ['.claude/skills/kiro-fake/SKILL.md', 'skill'],
  doc_main: ['.kiro/settings/cc-sdd-guide.md', 'guide'],
  settings_templates: ['.kiro/settings/templates/specs/tasks.md', 'templates'],
};
for (const artifact of manifest.artifacts || []) {
  const target = targets[artifact.id];
  if (!target) continue;
  const destination = path.join(process.cwd(), target[0]);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, target[1] + ' ' + version + ' ' + lang);
}
`;

export function makeRepo({ config = { format: 1, ccSdd: { version: '3.1.0', lang: 'ja' } } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-entry-repo-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sdd-entry-bin-'));
  const payloadRoot = path.join(root, '.agent-hooks/cc-sdd-bootstrap');
  fs.mkdirSync(payloadRoot, { recursive: true });
  for (const name of payloadFiles) {
    const source = path.join(projectRoot, '.agent-hooks/cc-sdd-bootstrap', name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(payloadRoot, name));
  }
  fs.writeFileSync(path.join(fakeBin, 'npx'), fakeNpxSource, { mode: 0o755 });
  if (config !== null) {
    fs.writeFileSync(path.join(root, '.cc-sdd-bootstrap.json'), typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  }
  const resolve = (rel) => path.join(root, rel);
  return {
    root,
    fakeBin,
    entry: path.join(root, '.agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs'),
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
    exists(rel) {
      return fs.existsSync(resolve(rel));
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(fakeBin, { recursive: true, force: true });
    },
  };
}

export function runEntry(repo, args = [], { mode = 'ok', env = {}, timeoutMs = 30000, cwd = os.tmpdir() } = {}) {
  const logPath = path.join(repo.fakeBin, `npx-calls-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
  const result = spawnSync(process.execPath, [repo.entry, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      ...env,
      PATH: `${repo.fakeBin}${path.delimiter}${env.PATH ?? process.env.PATH ?? ''}`,
      FAKE_NPX_MODE: mode,
      FAKE_NPX_LOG: logPath,
    },
  });
  let npxCalls = [];
  try {
    npxCalls = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    fs.rmSync(logPath, { force: true });
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error?.message ?? ''),
    npxCalls,
  };
}
