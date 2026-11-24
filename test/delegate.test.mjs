import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// 一時の根に入口と役割の規則を写し、偽の codex・claude を PATH の先頭に置く
function fixture(t, config, { debugFails = false, models = MODELS } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "delegate-test-"));
  const hooks = path.join(root, ".agent-hooks/cc-sdd-bootstrap");
  mkdirSync(hooks, { recursive: true });
  for (const f of ["delegate.mjs", "subagent-roles.mjs"]) {
    if (existsSync(path.join(hooksSrc, f))) copyFileSync(path.join(hooksSrc, f), path.join(hooks, f));
  }
  if (config !== undefined) writeFileSync(path.join(root, ".cc-sdd-bootstrap.json"), typeof config === "string" ? config : JSON.stringify({ subagents: config }));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const log = path.join(root, "calls.log");
  writeFileSync(path.join(root, "models.json"), JSON.stringify(models));
  for (const name of ["codex", "claude"]) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\nif [ "${name}" = codex ] && [ "$1" = debug ] && [ "$2" = models ]; then\n  ${debugFails ? "exit 1" : `cat "${path.join(root, "models.json")}"`}\nfi\nexit 0\n`);
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
const launches = (f) => f.calls().filter((c) => !c.startsWith("codex debug models"));

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
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /委任先: codex モデル: gpt-6\.2-sol 推論量: medium 権限: read-only/);
  assert.match(cli.stderr, /タスク 3\.4/);
  assert.deepEqual(launches(f), []);
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

test("通常の指定は確かめを通っても子を起動しない（子の起動は 3.4）", (t) => {
  const f = fixture(t);
  const r = f.run("--from", "claude", "--role", "review", "--orchestrator-model", "claude-opus-5", "--instructions", f.instr);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /委任先: codex モデル: gpt-6\.2-sol/);
  assert.deepEqual(launches(f), []);
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
