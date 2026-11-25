// PoC の共通の補助（work-branch-flow・feasibility-review で使う）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const scratch = path.join(os.homedir(), '.cache/cc-sdd-bootstrap-scratch/poc-branch-flow');
export const probeSource = path.join(import.meta.dirname, 'probe.mjs');
export const brwRoot = process.env.BRW_ROOT ?? path.join(os.homedir(), 'git/nekono-dev/branch-release-workflow');

let ok = 0;
let ng = 0;
export function check(label, condition, detail = '') {
  console.log(`${condition ? 'OK' : 'NG'} ${label}${detail ? `: ${detail}` : ''}`);
  condition ? ok++ : ng++;
}
export function observe(label, detail = '') { console.log(`観測 ${label}${detail ? `: ${detail}` : ''}`); }
export function summary() { console.log(`\nOK ${ok} 件、NG ${ng} 件`); process.exitCode = ng ? 1 : 0; }

export function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 600_000, ...options });
}
export function git(dir, ...args) { return run('git', args, { cwd: dir }); }

/** 基底ブランチ develop・origin 付きの使い捨てのリポジトリを作る */
export function makeRepo(name, { files = {} } = {}) {
  const dir = path.join(scratch, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(`${dir}-origin.git`, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'develop');
  git(dir, 'config', 'user.email', 'poc@example.com');
  git(dir, 'config', 'user.name', 'poc');
  fs.writeFileSync(path.join(dir, 'README.md'), '# poc\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.poc/\n.claude/\n.codex/\n.claude-worktrees/\n');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  run('git', ['init', '-q', '--bare', `${dir}-origin.git`]);
  git(dir, 'remote', 'add', 'origin', `${dir}-origin.git`);
  git(dir, 'push', '-q', 'origin', 'develop');
  fs.mkdirSync(path.join(dir, '.poc'), { recursive: true });
  fs.copyFileSync(probeSource, path.join(dir, '.poc/probe.mjs'));
  return dir;
}

/** フックの登録（Claude Code は .claude/settings.json、Codex は .codex/hooks.json）。entries: [{event, matcher, args}] */
export function registerHooks(dir, entries) {
  const make = (tool) => {
    const hooks = {};
    for (const { event, matcher, args } of entries) {
      const command = tool === 'claude'
        ? `node "$CLAUDE_PROJECT_DIR/.poc/probe.mjs" ${args}`
        : `node "$(git rev-parse --show-toplevel)/.poc/probe.mjs" ${args}`;
      (hooks[event] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 30 }] });
    }
    return { hooks };
  };
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/settings.json'), `${JSON.stringify(make('claude'), null, 2)}\n`);
  fs.writeFileSync(path.join(dir, '.codex/hooks.json'), `${JSON.stringify(make('codex'), null, 2)}\n`);
}

export function records(dir) {
  const file = path.join(dir, '.poc/log.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}
export function resetLog(dir) { fs.rmSync(path.join(dir, '.poc/log.jsonl'), { force: true }); }

function codexHome(dir) {
  const home = path.join(scratch, 'codex-home', path.basename(dir));
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), '.codex/auth.json'), path.join(home, 'auth.json'));
  fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  fs.writeFileSync(path.join(home, 'config.toml'), `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
  return home;
}

/** 実機の指揮役を 1 回起動する。tool: 'claude' | 'codex' */
export function invoke(tool, dir, prompt, { pluginDir, extraPath, tools = 'Bash,Read,Write,Edit,Agent', model } = {}) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (extraPath) env.PATH = `${extraPath}:${env.PATH}`;
  if (tool === 'claude') {
    const args = ['-p', '--setting-sources', 'project', '--model', model ?? 'haiku', '--permission-mode', 'acceptEdits',
      '--allowedTools', tools, '--output-format', 'stream-json', '--verbose'];
    if (pluginDir) args.push('--plugin-dir', pluginDir);
    args.push(prompt);
    return run('claude', args, { cwd: dir, env });
  }
  const home = codexHome(dir);
  try {
    return run('codex', ['-a', 'never', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-hook-trust',
      '-s', 'workspace-write', '--cd', dir, ...(model ? ['--model', model] : []), prompt],
    { cwd: dir, env: { ...env, CODEX_HOME: home } });
  } finally { fs.rmSync(path.join(home, 'auth.json'), { force: true }); }
}

export function jsonLines(text) {
  return text.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
export function finalAnswer(tool, result) {
  const events = jsonLines(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (tool === 'codex') return events.filter((e) => e.item?.type === 'agent_message').map((e) => String(e.item.text ?? '')).at(-1) ?? '';
  return events.filter((e) => e.type === 'result').map((e) => String(e.result ?? '')).at(-1) ?? '';
}
export function succeeded(result) {
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return !result.error && result.status === 0 && !/API Error|rate limit|connection error|ECONN(REFUSED|RESET)|overloaded_error/.test(text);
}
