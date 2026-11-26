#!/usr/bin/env node
// PoC（設計の前提の確認）: install-freshness の外部の動作に依存する前提を実機で確かめる。
// 使い方: node poc/install-freshness/run.mjs [ブランチ]   （既定 dev/base-branch-sync）
// 必要なもの: node・npx・git、GitHub への通信、認証済みの claude・codex（場面 D のみ。無ければ場面 D は飛ばす）。
//   場面 A: `npx github:…#<ref>` で取得した配布物から、配布元の版（コミット）を取り出せるか
//   場面 B: 配布元の最新を `git ls-remote` で安く取得できるか。失敗・待ち時間超過のとき通す形になるか
//   場面 D: SessionStart フックの追加の文脈が Claude Code・Codex の両方のエージェントに届くか（合言葉を直接尋ねる）
//   場面 E: 同じ文脈に「最初の返答で利用者へ伝える」指示を入れ、無関係な入力でもエージェントが利用者へ伝えるか
// 作業場所は一時ディレクトリ（このリポジトリには書かない）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const branch = process.argv[2] ?? "dev/base-branch-sync";
const repo = "https://github.com/nekono-dev/cc-sdd-bootstrap";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "install-freshness-poc-"));
let ok = 0, ng = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "OK  " : "NG  "} ${label}${detail ? ` — ${detail}` : ""}`); cond ? ok++ : ng++; };

// 場面 A: 取得した配布物から版を取り出す
{
  const env = { ...process.env, npm_config_cache: path.join(base, "npm-cache") };
  const run = spawnSync("npx", ["-y", `github:nekono-dev/cc-sdd-bootstrap#${branch}`, "help"], { cwd: base, env, encoding: "utf8", timeout: 180000 });
  check("A1. npx で取得した配布物が動く", run.status === 0 && run.stdout.includes("使い方"), `終了コード ${run.status}`);
  const npxDir = path.join(env.npm_config_cache, "_npx");
  const hash = fs.existsSync(npxDir) ? fs.readdirSync(npxDir)[0] : null;
  const pkgRoot = hash ? path.join(npxDir, hash, "node_modules", "cc-sdd-bootstrap") : null;
  // 配布物の位置（pkgRoot）から 1 つ上の `.package-lock.json` を読む。取り出し方の実際の候補
  const lockPath = pkgRoot ? path.join(pkgRoot, "..", ".package-lock.json") : null;
  let sha = null;
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const resolved = lock.packages?.["node_modules/cc-sdd-bootstrap"]?.resolved ?? "";
    sha = /#([0-9a-f]{40})$/.exec(resolved)?.[1] ?? null;
    console.log(`     resolved = ${resolved}`);
  } catch (error) { console.log(`     読めない: ${error.message}`); }
  check("A2. 配布物の 1 つ上の .package-lock.json から 40 桁のコミットを取り出せる", sha !== null, sha ?? "");
  // 取得したときの指定（ブランチ・タグ）は、2 つ上の package-lock.json の依存の書き方に残る
  let spec = null;
  try { spec = JSON.parse(fs.readFileSync(path.join(pkgRoot, "..", "..", "package-lock.json"), "utf8")).packages?.[""]?.dependencies?.["cc-sdd-bootstrap"] ?? null; } catch { /* 読めない */ }
  check("A5. 取得したときの指定（#ブランチ）を 2 つ上の package-lock.json から取り出せる", spec === `github:nekono-dev/cc-sdd-bootstrap#${branch}`, spec ?? "");
  const remote = spawnSync("git", ["ls-remote", repo, `refs/heads/${branch}`], { encoding: "utf8", timeout: 30000 });
  const remoteSha = remote.stdout.split(/\s/)[0];
  check("A3. 取り出したコミットが、その時点の配布元のブランチの先頭と一致する", sha !== null && sha === remoteSha, `remote=${remoteSha}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  check("A4. package.json にはコミットが無い（版 0.1.0 は機能が増えても変わらない）", !("gitHead" in pkg) && !("_resolved" in pkg), `version=${pkg.version}`);
}

// 場面 B: 配布元の最新の取得
{
  const t0 = Date.now();
  const head = spawnSync("git", ["ls-remote", repo, "HEAD"], { encoding: "utf8", timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const ms = Date.now() - t0;
  check("B1. 認証なしで既定の先頭を取得できる（公開リポジトリ）", head.status === 0 && /^[0-9a-f]{40}\tHEAD/.test(head.stdout), `${ms}ms`);
  const refused = spawnSync("git", ["ls-remote", "https://127.0.0.1:9/x", "HEAD"], { encoding: "utf8", timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  check("B2. 接続できないとき、非 0 で即座に返る（通す側へ倒せる）", refused.status !== 0 && refused.signal === null);
  const t1 = Date.now();
  const hung = spawnSync("git", ["ls-remote", "https://10.255.255.1/x", "HEAD"], { encoding: "utf8", timeout: 2000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const hungMs = Date.now() - t1;
  check("B3. 応答が無いとき、待ち時間の上限（2 秒）で打ち切れる", hung.status !== 0 && hungMs < 4000, `${hungMs}ms、signal=${hung.signal}`);
  const missing = spawnSync("git", ["ls-remote", `${repo}-no-such`, "HEAD"], { encoding: "utf8", timeout: 10000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  check("B4. 存在しない・非公開のとき、認証を求めず非 0 で返る", missing.status !== 0);
}

// 場面 D: SessionStart の追加の文脈がエージェントに届くか
function sessionStartProbe(tool, relay = false) {
  const dir = path.join(base, `ctx-${tool}`);
  fs.mkdirSync(path.join(dir, `.${tool}`), { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const token = `FRESH-${Math.floor(Math.random() * 9000 + 1000)}`;
  const script = path.join(dir, "hook.cjs");
  fs.writeFileSync(script, `process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ${JSON.stringify(relay ? `導入の鮮度の案内（${token}）: 配置物が古い可能性があります。次の 1 文を、利用者の質問への回答より前に、そのまま最初に出力してください:「導入の鮮度の案内（${token}）: 配置物が古い可能性があります。」` : `導入の鮮度の案内: 合言葉は ${token} です。利用者へ伝えてください。`)} } }));`);
  const hooks = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node ${JSON.stringify(script)}`, timeout: 10 }] }] } };
  const question = relay ? "こんにちは。このリポジトリはどんなものですか。1 文で答えて。" : "セッション開始時のフックから受け取った案内にある、FRESH- で始まる合言葉だけを答えてください。無ければ NONE と答えてください。";
  if (tool === "claude") {
    fs.writeFileSync(path.join(dir, ".claude", "settings.json"), JSON.stringify(hooks));
    const r = spawnSync("claude", ["-p", question, "--model", process.env.POC_CLAUDE_MODEL ?? "haiku"], { cwd: dir, encoding: "utf8", timeout: 180000 });
    return { token, out: r.stdout, status: r.status };
  }
  fs.writeFileSync(path.join(dir, ".codex", "hooks.json"), JSON.stringify(hooks));
  const home = fs.mkdtempSync(path.join(base, "codex-home-"));
  fs.copyFileSync(path.join(os.homedir(), ".codex", "auth.json"), path.join(home, "auth.json"));
  fs.writeFileSync(path.join(home, "config.toml"), `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
  const r = spawnSync("codex", ["-a", "never", "exec", "--dangerously-bypass-hook-trust", "--sandbox", "read-only", "--model", process.env.POC_CODEX_MODEL ?? "gpt-6-luna",
    "--config", 'model_reasoning_effort="low"', "--cd", dir, question], { env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 180000 });
  return { token, out: r.stdout, status: r.status };
}
for (const [scene, relay, label] of [["D", false, "SessionStart の追加の文脈（合言葉）がエージェントに届く"], ["E", true, "無関係な入力でも、エージェントが案内を利用者へ伝える"]]) {
  for (const tool of ["claude", "codex"]) {
    if (spawnSync("which", [tool]).status !== 0) { console.log(`SKIP ${scene}(${tool}): ${tool} が無い`); continue; }
    const { token, out, status } = sessionStartProbe(tool, relay);
    check(`${scene}. ${tool}: ${label}`, status === 0 && out.includes(token), `終了コード ${status}、応答: ${out.trim().slice(0, 120).replace(/\n/g, " ")}`);
  }
}

fs.rmSync(base, { recursive: true, force: true });
console.log(`結果: OK ${ok} 件、NG ${ng} 件`);
process.exitCode = ng === 0 ? 0 : 1;
