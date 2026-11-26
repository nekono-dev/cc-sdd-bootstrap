import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hooksSrc = path.join(repo, ".agent-hooks/cc-sdd-bootstrap");

const levels = (...efforts) => efforts.map((effort) => ({ effort, description: effort }));
const FIVE = ["low", "medium", "high", "xhigh", "max"];
// 偽の codex debug models の出力（優先度の小さいものが最新）
const MODELS = { models: [
  { slug: "gpt-6.3-sol", visibility: "hide", priority: 0, supported_reasoning_levels: levels(...FIVE, "ultra") },
  { slug: "gpt-6.2-sol", visibility: "list", priority: 1, supported_reasoning_levels: levels(...FIVE, "ultra") },
  { slug: "gpt-6.2-astra", visibility: "list", priority: 2, supported_reasoning_levels: levels(...FIVE, "ultra") },
  { slug: "gpt-6.1-terra", visibility: "list", priority: 3, supported_reasoning_levels: levels("low", "medium", "high", "xhigh") },
  { slug: "gpt-6-luna", visibility: "list", priority: 4, supported_reasoning_levels: levels("low", "medium", "high") },
] };

// 偽の codex exec --help の振る舞い（既定は承認を省く指定を出す新しい Codex）
const EXEC_HELP = {
  ok: 'echo "  --dangerously-bypass-hook-trust  フックの承認の確認を省きます"; exit 0',
  old: 'echo "  --sandbox <MODE>"; exit 0',
  fail: "exit 1",
};

// 一時の根に入口と役割の規則を写し、偽の codex・claude を PATH の先頭に置く
// execHelp: 偽の codex exec --help の振る舞い（ok: 指定を出す・old: 指定を出さない古い Codex・fail: 終了コード 1）
function fixture(t, config, { debugFails = false, models = MODELS, debugScript = null, execHelp = "ok" } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "delegate-test-"));
  const hooks = path.join(root, ".agent-hooks/cc-sdd-bootstrap");
  mkdirSync(hooks, { recursive: true });
  for (const f of ["delegate.mjs", "subagent-roles.mjs", "codex-trust.mjs", "codex-trust-rules.mjs"]) {
    if (existsSync(path.join(hooksSrc, f))) copyFileSync(path.join(hooksSrc, f), path.join(hooks, f));
  }
  if (config !== undefined) writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), typeof config === "string" ? config : JSON.stringify({ subagents: config }));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const log = path.join(root, "calls.log");
  writeFileSync(path.join(root, "models.json"), JSON.stringify(models));
  for (const name of ["codex", "claude"]) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\nif [ "${name}" = codex ] && [ "$1" = debug ] && [ "$2" = models ]; then\n  ${debugScript ?? (debugFails ? "exit 1" : `cat "${path.join(root, "models.json")}"`)}\nfi\nif [ "${name}" = codex ] && [ "$1" = exec ] && [ "$2" = --help ]; then\n  ${EXEC_HELP[execHelp]}\nfi\nexit 0\n`);
    chmodSync(file, 0o755);
  }
  writeFileSync(path.join(root, "instr.md"), "指示\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const run = (...args) => spawnSync(process.execPath, [path.join(hooks, "delegate.mjs"), ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { root, run, calls, instr: path.join(root, "instr.md") };
}

const resolve = (f, from, role, orch, ...rest) => f.run("--resolve-model", "--from", from, "--role", role, "--orchestrator-model", orch, ...rest);
// 子の起動の記録。モデルの一覧の取得と、承認を省く指定の確認（codex exec --help）は除く
const launches = (f) => f.calls().filter((c) => !c.startsWith("codex debug models") && c !== "codex exec --help");

test("名前だけを求める: Claude Code の実装は指揮役の 1 つ下の定義の名前", (t) => {
  const f = fixture(t);
  for (const [orch, expected] of [["claude-sonnet-5-5", "cc-sdd-implement-haiku high"], ["claude-opus-5", "cc-sdd-implement-sonnet medium"], ["claude-fable-5", "cc-sdd-implement-opus medium"]]) {
    const r = resolve(f, "claude", "implement", orch);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${expected}\n`);
  }
  assert.deepEqual(launches(f), []);
});

test("名前だけを求める: 同じ提供元のレビューは指揮役の格以下の別の系統の定義", (t) => {
  const f = fixture(t);
  const r = resolve(f, "claude", "review", "claude-sonnet-5-5", "--to", "same");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^cc-sdd-review-haiku /);
  const r2 = resolve(f, "claude", "review", "claude-opus-5", "--to", "same");
  assert.match(r2.stdout, /^cc-sdd-review-sonnet /);
  const r3 = resolve(f, "claude", "review", "claude-haiku-5", "--to", "same");
  assert.equal(r3.status, 2);
  assert.match(r3.stderr, /指揮役自身/);
});

test("名前だけを求める: 別の提供元は一覧の最新の名前と推論量", (t) => {
  const f = fixture(t);
  const r = resolve(f, "claude", "review", "claude-opus-5");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "gpt-6.2-sol medium\n");
  const r2 = resolve(f, "claude", "investigate", "claude-sonnet-5-5");
  assert.equal(r2.stdout, "gpt-6-luna high\n");
  assert.deepEqual(launches(f), []);
});

test("名前だけを求める: 上限 Codex Sol で Astra の指揮役の Codex の実装は Sol の最新", (t) => {
  const f = fixture(t, { maxModel: { codex: "sol" } });
  const r = resolve(f, "codex", "implement", "gpt-6.2-astra");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "gpt-6.2-sol medium\n");
});

test("指揮役のモデルが無いと終了 2（名前だけを求める指定も通常の指定も）", (t) => {
  const f = fixture(t);
  const r = f.run("--resolve-model", "--from", "claude", "--role", "implement");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--orchestrator-model/);
  const r2 = f.run("--from", "claude", "--role", "review", "--instructions", f.instr);
  assert.equal(r2.status, 2);
  assert.deepEqual(f.calls(), []);
});

test("引数の誤りは終了 2", (t) => {
  const f = fixture(t);
  assert.equal(f.run("--from", "x", "--role", "review", "--orchestrator-model", "m").status, 2);
  assert.equal(resolve(f, "claude", "bogus", "claude-opus-5").status, 2);
  assert.equal(resolve(f, "claude", "review", "claude-opus-5", "--effort", "huge").status, 2);
  assert.equal(resolve(f, "claude", "review", "claude-opus-5", "--nope").status, 2);
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--instructions/);
});

test("設定が読めない・誤りなら理由を出して終了 2、ファイルが無ければ既定", (t) => {
  const broken = fixture(t, "{ なにか");
  const r = resolve(broken, "claude", "implement", "claude-opus-5");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /JSON/);
  const wrong = fixture(t, { maxModel: { codex: "fable" } });
  const r2 = resolve(wrong, "claude", "implement", "claude-opus-5");
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /maxModel/);
  const none = fixture(t);
  assert.equal(resolve(none, "claude", "implement", "claude-opus-5").status, 0);
});

test("--model だけで上限の低い系統に変えると推論量が下がり知らせが出る。高い系統に変えると元に戻る", (t) => {
  const f = fixture(t, { maxEffort: { sonnet: "low" } });
  // Astra の指揮役の Codex のレビュー既定は Opus（上限の影響なし）
  const base = resolve(f, "codex", "review", "gpt-6.2-astra");
  assert.equal(base.stdout, "opus medium\n");
  const high = fixture(t, { roles: { codex: { review: { effort: "high" } } }, maxEffort: { sonnet: "low" } });
  assert.equal(resolve(high, "codex", "review", "gpt-6.2-astra").stdout, "opus high\n");
  const down = resolve(high, "codex", "review", "gpt-6.2-astra", "--model", "sonnet");
  assert.equal(down.status, 0, down.stderr);
  assert.equal(down.stdout, "sonnet low\n");
  assert.match(down.stderr, /知らせ: 推論量 high は sonnet の上限（low）より上なので low に下げました/);
  // Terra の指揮役では既定が Sonnet（上限 low）で推論量が下がり、その実行だけ Haiku にすると元の high に戻る
  const tr = resolve(high, "codex", "review", "gpt-6.1-terra");
  assert.equal(tr.stdout, "sonnet low\n");
  assert.match(tr.stderr, /知らせ/);
  const up = resolve(high, "codex", "review", "gpt-6.1-terra", "--model", "haiku");
  assert.equal(up.stdout, "haiku high\n");
  assert.doesNotMatch(up.stderr, /知らせ/);
});

test("--effort がその系統の上限を超えると終了 2（子は起動しない）", (t) => {
  const f = fixture(t, { maxEffort: { sonnet: "low" } });
  const r = resolve(f, "codex", "review", "gpt-6.2-astra", "--model", "sonnet", "--effort", "medium");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /上限/);
  const r2 = f.run("--from", "codex", "--role", "review", "--orchestrator-model", "gpt-6.2-astra", "--model", "sonnet", "--effort", "medium", "--instructions", f.instr);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /上限/);
  assert.deepEqual(launches(f), []);
  const ok = resolve(f, "codex", "review", "gpt-6.2-astra", "--model", "opus", "--effort", "high");
  assert.equal(ok.stdout, "opus high\n");
});

test("モデルが受け付けない推論量は終了 2（Claude Code の ultra・Luna の ultra）", (t) => {
  const f = fixture(t, { maxEffort: { default: "ultra" } });
  const r = resolve(f, "codex", "review", "gpt-6.2-astra", "--effort", "ultra");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /受け付けません/);
  const l = resolve(f, "claude", "investigate", "claude-sonnet-5-5", "--effort", "ultra");
  assert.equal(l.status, 2);
  assert.match(l.stderr, /受け付けません/);
  const s = resolve(f, "claude", "review", "claude-fable-5", "--effort", "ultra");
  assert.equal(s.status, 0, s.stderr);
  assert.equal(s.stdout, "gpt-6.2-sol ultra\n");
  assert.deepEqual(launches(f), []);
});

test("格 4・上の格・同じ系統の指定は終了 2", (t) => {
  const f = fixture(t);
  const t4 = resolve(f, "claude", "review", "claude-fable-5", "--model", "astra");
  assert.equal(t4.status, 2);
  assert.match(t4.stderr, /格 4/);
  const higher = resolve(f, "claude", "review", "claude-sonnet-5-5", "--model", "sol");
  assert.equal(higher.status, 2);
  assert.match(higher.stderr, /上の格/);
  const same = f.run("--from", "claude", "--role", "review", "--to", "same", "--orchestrator-model", "claude-opus-5", "--model", "opus", "--instructions", f.instr);
  assert.equal(same.status, 2);
  assert.match(same.stderr, /同じ系統/);
  const cap = fixture(t, { maxModel: { codex: "terra" } });
  const above = resolve(cap, "claude", "review", "claude-fable-5", "--model", "sol");
  assert.equal(above.status, 2);
  assert.match(above.stderr, /上限/);
  assert.deepEqual(launches(f), []);
});

test("modelIds.terra が Sol を指していても、実際に起動する系統（sol）で判定して止める", (t) => {
  const f = fixture(t, { maxModel: { codex: "terra" }, modelIds: { terra: "gpt-6.2-sol" } });
  const r = resolve(f, "claude", "review", "claude-fable-5");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gpt-6\.2-sol/);
  assert.match(r.stderr, /上限/);
  const r2 = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-fable-5", "--instructions", f.instr);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /上限/);
  assert.deepEqual(launches(f), []);
  assert.ok(f.calls().some((c) => c === "codex debug models"));
});

test("modelIds.haiku が Sonnet を指していても、Claude Code の組み込みの子は定義（Haiku）で判定する", (t) => {
  const f = fixture(t, { modelIds: { haiku: "claude-sonnet-5-5" } });
  const r = resolve(f, "claude", "implement", "claude-sonnet-5-5");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "cc-sdd-implement-haiku high\n");
});

test("Claude Code の組み込みの子では --model・--effort は使えず、定義が作られない系統は適用できない", (t) => {
  const f = fixture(t);
  const r = resolve(f, "claude", "implement", "claude-opus-5", "--effort", "low");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /定義/);
  const cap = fixture(t, { maxModel: { claude: "sonnet" }, roles: { claude: { implement: { model: "opus" } } } });
  const r2 = resolve(cap, "claude", "implement", "claude-fable-5");
  assert.equal(r2.status, 2);
});

test("Codex の組み込みの子で定義が作られない役割（読み取り専用）は適用できないと示す。同じ提供元の CLI 用の条件は解決できる", (t) => {
  const f = fixture(t);
  const r = resolve(f, "codex", "review", "gpt-6.2-astra", "--to", "same");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /読み取り専用/);
  assert.match(r.stderr, /適用できません/);
  const cli = f.run("--from", "codex", "--role", "review", "--to", "same", "--orchestrator-model", "gpt-6.2-astra", "--instructions", f.instr);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /委任先: codex モデル: gpt-6\.2-sol 推論量: medium 権限: read-only/);
  assert.equal(launches(f).length, 1);
});

test("同じ提供元の役割は --to same が無いと CLI では起動しない", (t) => {
  const f = fixture(t);
  const r = f.run("--from", "claude", "--role", "implement", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--to same/);
  assert.deepEqual(f.calls(), []);
});

test("モデルの一覧が取れないときは一覧なしで判断し、系統の最新を求められなければ理由を出す", (t) => {
  const f = fixture(t, undefined, { debugFails: true });
  const r = resolve(f, "claude", "review", "claude-opus-5");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /modelIds\.sol/);
  const ids = fixture(t, { modelIds: { sol: "gpt-6.2-sol" } }, { debugFails: true });
  assert.equal(resolve(ids, "claude", "review", "claude-opus-5").stdout, "gpt-6.2-sol medium\n");
});

test("系統の提供元が分からない名前でも、委任先の子の上限・格 4 を超えれば止める", (t) => {
  const f = fixture(t, { tiers: { nova: 3, zeta: 4 }, maxModel: { codex: "terra" }, modelIds: { terra: "gpt-nova" } });
  const r = resolve(f, "claude", "review", "claude-fable-5");
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /上限/);
  const z = fixture(t, { tiers: { zeta: 4 }, modelIds: { sol: "gpt-zeta" } });
  const r2 = resolve(z, "claude", "review", "claude-opus-5");
  assert.equal(r2.status, 2, r2.stdout);
  assert.match(r2.stderr, /格 4/);
  assert.deepEqual(launches(f), []);
});

test("modelIds を反映した最終的な名前が委任先の提供元のものでなければ止める", (t) => {
  const f = fixture(t, { modelIds: { sol: "claude-opus-5" } });
  const r = resolve(f, "claude", "review", "claude-opus-5");
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /委任先/);
  assert.deepEqual(launches(f), []);
});

test("一覧に推論量の項目が無いモデルは一覧なしと同じ扱い（既定の値で判定）", (t) => {
  const models = { models: [{ slug: "gpt-6.2-sol", visibility: "list", priority: 1 }] };
  const f = fixture(t, undefined, { models });
  const r = resolve(f, "claude", "review", "claude-opus-5", "--effort", "high");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "gpt-6.2-sol high\n");
});

test("--effort を採用した実行では、使われなかった役割設定の推論量の知らせは出さない", (t) => {
  const f = fixture(t, { roles: { codex: { review: { effort: "high" } } }, maxEffort: { sonnet: "low" } });
  const r = resolve(f, "codex", "review", "gpt-6.1-terra", "--effort", "low");
  assert.equal(r.stdout, "sonnet low\n");
  assert.doesNotMatch(r.stderr, /知らせ/);
});

// Codex の制限付きサンドボックスでは、子の標準入力のパイプを閉じる処理が失敗して spawnSync の error に載る。標準入力を使わない形で起動すること
// 標準入力が /dev/null か（dev・ino・rdev の比較。/proc を使わないので Linux 以外でも動く）。/dev/null なら終了 0、それ以外（パイプなど）なら 1
const stdinIsDevNull = `node -e 'const fs=require("fs");const a=fs.fstatSync(0),b=fs.statSync("/dev/null");process.exit(a.dev===b.dev&&a.ino===b.ino&&a.rdev===b.rdev?0:1)'`;

test("モデルの一覧の取得は標準入力を子に渡さない（パイプの標準入力だと失敗する codex でも一覧を得る）", (t) => {
  const f = fixture(t, undefined, { debugScript: `if ${stdinIsDevNull}; then cat "$(dirname "$0")/../models.json"; else exit 1; fi` });
  const r = resolve(f, "codex", "implement", "gpt-6.2-sol");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "gpt-6.1-terra medium\n");
  assert.deepEqual(launches(f), []);
});

test("モデルの一覧の取得: 有効な JSON を出しても非ゼロ終了、または終了 0 でも壊れた JSON なら、一覧なしとして止まる", (t) => {
  for (const script of [
    'cat "$(dirname "$0")/../models.json"; exit 1',
    'echo "{broken"; exit 0',
  ]) {
    const f = fixture(t, undefined, { debugScript: script });
    const r = resolve(f, "codex", "implement", "gpt-6.2-sol");
    assert.equal(r.status, 2, r.stdout);
    assert.deepEqual(launches(f), []);
  }
});

// ---- 子の起動と結果の受け渡し（タスク 3.4） ----
// 偽の CLI を node のスクリプトで置き換え、受け取った引数・標準入力・作業場所・環境変数を JSON で記録して指定の終了コードで終わる
// execHelp: codex exec --help の振る舞い（ok・old・fail。EXEC_HELP と同じ意味）。exec --help は記録しない
function installFakes(f, exits = {}, { execHelp = "ok" } = {}) {
  const bin = path.join(f.root, "bin");
  const rec = path.join(f.root, "launch.jsonl");
  const help = { ok: { out: "  --dangerously-bypass-hook-trust  フックの承認の確認を省きます\n", code: 0 },
    old: { out: "  --sandbox <MODE>\n", code: 0 }, fail: { out: "", code: 1 } }[execHelp];
  for (const name of ["codex", "claude"]) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!${process.execPath}
const fs = require("fs");
const a = process.argv.slice(2);
if ("${name}" === "codex" && a[0] === "debug" && a[1] === "models") { process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(f.root, "models.json"))}, "utf8")); process.exit(0); }
if ("${name}" === "codex" && a[0] === "exec" && a[1] === "--help") { process.stdout.write(${JSON.stringify(help.out)}); process.exit(${help.code}); }
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
const env = {};
for (const k of ["CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_EFFORT", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "KEEP_ME"]) if (k in process.env) env[k] = process.env[k];
fs.appendFileSync(${JSON.stringify(rec)}, JSON.stringify({ name: "${name}", args: a, stdin, cwd: process.cwd(), env }) + "\\n");
process.stdout.write("子の出力 ${name}\\n");
process.stderr.write("子の標準エラー ${name}\\n");
process.exit(${exits[name] ?? 0});
`);
    chmodSync(file, 0o755);
  }
  const records = () => (existsSync(rec) ? readFileSync(rec, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return records;
}
const runWith = (f, env, ...args) => spawnSync(process.execPath, [path.join(f.root, ".agent-hooks/cc-sdd-bootstrap/delegate.mjs"), ...args], {
  cwd: f.root, encoding: "utf8", env: { ...process.env, PATH: `${path.join(f.root, "bin")}:${process.env.PATH}`, ...env },
});

test("起動: Claude Code から Codex への委任（書き込み可）。引数・標準入力・作業場所・子の出力・成功の 1 行", (t) => {
  const f = fixture(t, { roles: { claude: { implement: { provider: "other" } } } });
  const records = installFakes(f);
  writeFileSync(f.instr, "実装の指示\n本文\n");
  const r = f.run("--from", "claude", "--role", "implement", "--orchestrator-model", "claude-opus-5", "--model", "terra", "--effort", "high", "--instructions", f.instr);
  assert.equal(r.status, 0, r.stderr);
  const rec = records();
  assert.equal(rec.length, 1);
  assert.equal(rec[0].name, "codex");
  assert.deepEqual(rec[0].args, ["-a", "never", "exec", "--dangerously-bypass-hook-trust", "--sandbox", "workspace-write", "--model", "gpt-6.1-terra",
    "--config", 'model_reasoning_effort="high"', "--cd", f.root, "-"]);
  assert.equal(rec[0].stdin, "実装の指示\n本文\n");
  assert.equal(realpathSync(rec[0].cwd), realpathSync(f.root));
  assert.match(r.stdout, /子の出力 codex/);
  assert.match(r.stderr, /子の標準エラー codex/);
  assert.match(r.stderr, /委任先の終了: 成功（終了コード 0）\n$/);
});

test("起動: Claude Code から Codex への委任（読み取り専用）は read-only の引数", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 0, r.stderr);
  const rec = records();
  assert.equal(rec.length, 1);
  assert.deepEqual(rec[0].args, ["-a", "never", "exec", "--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--model", "gpt-6.2-sol",
    "--config", 'model_reasoning_effort="medium"', "--cd", f.root, "-"]);
  assert.equal(rec[0].stdin, "指示\n");
});

test("起動: Codex から Claude Code への委任（書き込み可・読み取り専用）", (t) => {
  const f = fixture(t, { roles: { codex: { implement: { provider: "other" } } } });
  const records = installFakes(f);
  const w = f.run("--from", "codex", "--role", "implement", "--orchestrator-model", "gpt-6.2-sol", "--model", "sonnet", "--effort", "low", "--instructions", f.instr);
  assert.equal(w.status, 0, w.stderr);
  const ro = f.run("--from", "codex", "--role", "review", "--orchestrator-model", "gpt-6.2-astra", "--instructions", f.instr);
  assert.equal(ro.status, 0, ro.stderr);
  const rec = records();
  assert.equal(rec.length, 2);
  assert.equal(rec[0].name, "claude");
  assert.deepEqual(rec[0].args, ["-p", "--model", "sonnet", "--effort", "low", "--permission-mode", "acceptEdits", "--allowedTools", "Bash"]);
  assert.equal(rec[0].stdin, "指示\n");
  assert.equal(rec[1].name, "claude");
  assert.deepEqual(rec[1].args.slice(0, 5), ["-p", "--model", "opus", "--effort", "medium"]);
  assert.deepEqual(rec[1].args.slice(5), ["--tools", "Read,Grep,Glob"]);
  assert.equal(realpathSync(rec[1].cwd), realpathSync(f.root));
});

test("起動: 同じ提供元の CLI で読み取り専用の委任ができる（--to same）", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const r = f.run("--from", "claude", "--role", "review", "--to", "same", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 0, r.stderr);
  const rec = records();
  assert.equal(rec.length, 1);
  assert.equal(rec[0].name, "claude");
  assert.deepEqual(rec[0].args, ["-p", "--model", "sonnet", "--effort", "medium", "--tools", "Read,Grep,Glob"]);
});

test("起動: 子の終了コードをそのまま返し、失敗の 1 行を出す", (t) => {
  const f = fixture(t);
  installFakes(f, { codex: 7 });
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 7);
  assert.match(r.stderr, /委任先の終了: 失敗（終了コード 7）\n$/);
});

test("起動: 呼び出し元の推論量の環境変数と Claude Code のセッションの環境変数は偽の claude に渡らない", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const r = runWith(f, { CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_EFFORT: "max", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", KEEP_ME: "残す" },
    "--from", "codex", "--role", "review", "--orchestrator-model", "gpt-6.2-astra", "--instructions", f.instr);
  assert.equal(r.status, 0, r.stderr);
  const rec = records();
  assert.equal(rec.length, 1);
  assert.deepEqual(rec[0].env, { KEEP_ME: "残す" });
});

test("起動: 指示のファイルが読めないときは終了 2 で、子を起動しない", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", path.join(f.root, "no-such.md"));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /指示のファイル/);
  assert.deepEqual(records(), []);
});

test("起動: CLI を起動できない（PATH に無い）ときは理由を出して終了 2。別の条件でやり直さない", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  rmSync(path.join(f.root, "bin/claude"));
  // codex から claude への委任。claude が無いので終了 2 で、codex など別の経路で起動しない
  // 本物の claude が PATH にあっても起動しないよう、PATH は偽の置き場だけにする
  const r = runWith(f, { PATH: path.join(f.root, "bin") }, "--from", "codex", "--role", "review", "--orchestrator-model", "gpt-6.2-astra", "--instructions", f.instr);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /claude/);
  assert.match(r.stderr, /起動できません/);
  assert.deepEqual(records(), []);
});

test("起動: 上限を超える --effort など確かめで止まる場合は子の CLI を起動しない", (t) => {
  const f = fixture(t, { maxEffort: { sonnet: "low" } });
  const records = installFakes(f);
  const r = f.run("--from", "codex", "--role", "review", "--orchestrator-model", "gpt-6.2-astra", "--model", "sonnet", "--effort", "medium", "--instructions", f.instr);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /上限/);
  const g = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-sonnet-5-5", "--model", "sol", "--instructions", f.instr);
  assert.equal(g.status, 2);
  assert.deepEqual(records(), []);
});

test("起動: 同じ提供元の役割は --to same が無いと起動しない", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const r = f.run("--from", "claude", "--role", "implement", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--to same/);
  assert.deepEqual(records(), []);
});

test("--to は same だけ。other などは理由を出して終了 2（子を起動しない）", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const r = f.run("--from", "claude", "--role", "review", "--to", "other", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--to/);
  assert.deepEqual(records(), []);
});

test("書き込み可の別の提供元への委任は役割設定の provider で選ぶ", (t) => {
  const f = fixture(t, { roles: { claude: { implement: { provider: "other" } }, codex: { implement: { provider: "other" } } } });
  const records = installFakes(f);
  const a = f.run("--from", "claude", "--role", "implement", "--orchestrator-model", "claude-opus-5", "--model", "terra", "--instructions", f.instr);
  assert.equal(a.status, 0, a.stderr);
  const b = f.run("--from", "codex", "--role", "implement", "--orchestrator-model", "gpt-6.2-sol", "--model", "sonnet", "--instructions", f.instr);
  assert.equal(b.status, 0, b.stderr);
  const rec = records();
  assert.deepEqual(rec.map((x) => x.name), ["codex", "claude"]);
  assert.ok(rec[0].args.includes("workspace-write"));
  assert.ok(rec[1].args.includes("acceptEdits"));
});

test("--to same と、委任先に属さないその実行の --model を併用すると理由を出して終了 2（既定に置き換えず、子を起動しない）", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const r = f.run("--from", "claude", "--role", "review", "--to", "same", "--orchestrator-model", "claude-opus-5", "--model", "terra", "--instructions", f.instr);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /terra/);
  assert.match(r.stderr, /委任先/);
  assert.deepEqual(records(), []);
});

test("--instructions がディレクトリなど通常のファイルでなければ終了 2（子を起動しない）", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.root);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /通常のファイル/);
  assert.deepEqual(records(), []);
});

test("入口を根以外の場所から呼んでも、子の作業場所は根になる", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const other = mkdtempSync(path.join(os.tmpdir(), "delegate-cwd-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [path.join(f.root, ".agent-hooks/cc-sdd-bootstrap/delegate.mjs"), "--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr], {
    cwd: other, encoding: "utf8", env: { ...process.env, PATH: `${path.join(f.root, "bin")}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stderr);
  const rec = records();
  assert.equal(rec.length, 1);
  assert.equal(realpathSync(rec[0].cwd), realpathSync(f.root));
});

// ---- 承認を省く指定（タスク 4.2） ----
// 既定（設定が無い・項目が無い）では Codex の子に指定を付け、起動の直前に 1 行知らせる
test("承認を省く指定: 既定で Codex の子に付き、起動の直前に標準エラー出力へ 1 行出す", (t) => {
  const f = fixture(t);
  const records = installFakes(f);
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 0, r.stderr);
  const rec = records();
  assert.equal(rec.length, 1);
  assert.equal(rec[0].args[2], "exec");
  assert.equal(rec[0].args[3], "--dangerously-bypass-hook-trust");
  const notice = "delegate: 承認の確認を省く指定（--dangerously-bypass-hook-trust）を付けて委任先を起動します\n";
  assert.ok(r.stderr.includes(notice), r.stderr);
  // 知らせは子の起動より前に出る
  assert.ok(r.stderr.indexOf(notice) < r.stderr.indexOf("子の標準エラー codex"));
});

// 設定 codex.trustHooks が false なら指定は付けず、exec --help も呼ばない
test("承認を省く指定: codex.trustHooks が false なら指定を付けず、exec --help も呼ばない", (t) => {
  const f = fixture(t, JSON.stringify({ codex: { trustHooks: false } }));
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(launches(f), ["codex -a never exec --sandbox read-only --model gpt-6.2-sol --config model_reasoning_effort=\"medium\" --cd " + f.root + " -"]);
  assert.ok(!f.calls().includes("codex exec --help"));
  assert.doesNotMatch(r.stderr, /承認の確認を省く指定/);
});

// 指定を出さない古い Codex では子を起動せず、終了コード 2 で止まる（Stop の既存の扱い）
test("承認を省く指定: 古い Codex（指定が exec --help に出ない）では子を起動せず終了 2", (t) => {
  const f = fixture(t, undefined, { execHelp: "old" });
  const records = installFakes(f, {}, { execHelp: "old" });
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /受け付けません/);
  assert.match(r.stderr, /--dangerously-bypass-hook-trust/);
  assert.deepEqual(records(), []);
  assert.deepEqual(launches(f), []);
});

// exec --help が失敗する Codex も「受け付けない」として子を起動しない
test("承認を省く指定: exec --help が失敗する Codex でも子を起動せず終了 2", (t) => {
  const f = fixture(t, undefined, { execHelp: "fail" });
  const records = installFakes(f, {}, { execHelp: "fail" });
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /受け付けません/);
  assert.deepEqual(records(), []);
});

// 指定を付けた子が終了コード 2 で終わったら、拒否の可能性の案内を出し、終了コードは 2 のまま
test("承認を省く指定: 指定を付けた子が終了コード 2 で終わると拒否の可能性の案内を出す", (t) => {
  const f = fixture(t);
  installFakes(f, { codex: 2 });
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /委任先の終了: 失敗（終了コード 2）\n/);
  assert.match(r.stderr, /delegate: 終了コード 2 は引数の拒否の可能性があります。承認を省く指定が受け付けられなかった場合は、Codex を更新するか、設定 codex.trustHooks を false にして手でフックを承認してください/);
});

// 子が終了コード 1 のときは拒否の案内を出さない
test("承認を省く指定: 子が終了コード 1 のときは拒否の案内を出さない", (t) => {
  const f = fixture(t);
  installFakes(f, { codex: 1 });
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /引数の拒否の可能性/);
});

// --resolve-model は名前だけを求めるので、承認を省く指定の確認（exec --help）を呼ばない
test("承認を省く指定: --resolve-model では codex exec --help を呼ばない", (t) => {
  const f = fixture(t);
  const r = resolve(f, "claude", "review", "claude-opus-5");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "gpt-6.2-sol medium\n");
  assert.ok(!f.calls().includes("codex exec --help"));
});

// Claude の子は影響を受けない（exec --help を呼ばず、引数は今までどおり）
test("承認を省く指定: Claude の子は exec --help を呼ばず、引数も今までどおり", (t) => {
  const f = fixture(t);
  const r = f.run("--from", "codex", "--role", "review", "--orchestrator-model", "gpt-6.2-astra", "--instructions", f.instr);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!f.calls().includes("codex exec --help"));
  assert.deepEqual(launches(f), ["claude -p --model opus --effort medium --tools Read,Grep,Glob"]);
  assert.doesNotMatch(r.stderr, /承認の確認を省く指定/);
});
