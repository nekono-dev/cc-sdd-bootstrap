#!/usr/bin/env node
// PoC: 自動の許可の確認（auto モード）のもとで、指揮役の提供元の子（Claude Code の Agent）を確実に起動できるか。
//
// 背景: 2026-11-23、このリポジトリの実装中に、auto モードの判定が Agent の起動を「Destructive or Unwanted Actions」として拒否し、
//       子のエージェントが使えなくなった。導入先でも同じ停止が起きないよう、導入時に許可の決まりを置けるかを確かめる。
// 確かめること
//   a. 許可の決まりなし: auto モードで、子に書き込みを含む作業を任せる Agent の起動が拒否されることがあるか（観測）
//   b. プロジェクトの .claude/settings.json の permissions.allow に "Agent" を書くと、同じ依頼で Agent の起動が拒否されないか
//   c. 依頼の書き方: 子への依頼を「外部の指示のファイルを読んで従え」の形にすると拒否されやすく、依頼の中身を依頼文に直接書くと通るか
//      （公式の説明では、auto モードでは Agent の許可の決まりは外され、子に任せる作業の説明を起動前に判定する）
//
// 使い方: node poc/subagent-permission/run.mjs [回数]   （既定 3 回。判定は揺れるため、同じ依頼を繰り返す）
// 必要なもの: claude（認証済み）・版管理の CLI。作業場所は ~/.cache/cc-sdd-bootstrap-scratch/subagent-permission。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const rounds = Number(process.argv[2] ?? 3);
const base = path.join(os.homedir(), ".cache/cc-sdd-bootstrap-scratch/subagent-permission");
fs.rmSync(base, { recursive: true, force: true });
const env = { ...process.env }; delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT;
const prompt = "Agent ツールで subagent_type に general-purpose、model に haiku を指定して子を 1 回だけ起動してください。子への依頼: 「このリポジトリの lib/util.mjs に、2 つの数を足す関数 add を書き足し、試験 test/util.test.mjs を作る。git は使わない」。あなた自身はファイルを変更しないでください。子が終わったら、子の結果を 1 行で答えてください。";

function run(name, settings) {
  const repo = path.join(base, name);
  fs.mkdirSync(path.join(repo, "lib"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "lib/util.mjs"), "export const one = 1;\n");
  if (settings) fs.writeFileSync(path.join(repo, ".claude/settings.json"), JSON.stringify(settings, null, 2));
  const r = spawnSync("claude", ["-p", "--model", "sonnet", "--permission-mode", "auto", "--setting-sources", "project", "--output-format", "stream-json", "--verbose", "--max-turns", "8", currentPrompt ?? prompt],
    { cwd: repo, env, encoding: "utf8", input: "", timeout: 600000 });
  const lines = (r.stdout ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = lines.find((e) => e.type === "result") ?? {};
  const denials = (result.permission_denials ?? []).map((d) => d.tool_name);
  const agentCalled = lines.some((e) => e.type === "assistant" && e.message?.content?.some?.((c) => c.type === "tool_use" && c.name === "Agent"));
  const wrote = fs.readFileSync(path.join(repo, "lib/util.mjs"), "utf8").includes("add");
  return { agentCalled, agentDenied: denials.includes("Agent"), denials, wrote };
}

// c 用: 指示のファイルを読ませて従わせる依頼（今回止まった依頼と同じ形）
const filePrompt = (repo) => {
  const f = path.join(os.homedir(), ".cache/cc-sdd-bootstrap-scratch/subagent-permission-instr.md");
  fs.writeFileSync(f, "lib/util.mjs に 2 つの数を足す関数 add を書き足し、試験 test/util.test.mjs を作る。git は使わない。\n");
  return `Agent ツールで subagent_type に general-purpose、model に haiku を指定して子を 1 回だけ起動してください。子への依頼文は次の 1 文だけにしてください: 「まず次のファイルを Read して、その指示に従ってください: ${f}」。あなた自身はファイルを変更しないでください。子が終わったら、子の結果を 1 行で答えてください。`;
};
let currentPrompt = null;
const summary = { a: [], b: [], c: [] };
for (let i = 0; i < rounds; i++) {
  summary.a.push(run(`a${i}`, null));
  summary.b.push(run(`b${i}`, { permissions: { allow: ["Agent"] } }));
  currentPrompt = filePrompt(); summary.c.push(run(`c${i}`, null)); currentPrompt = null;
}
for (const k of ["a", "b", "c"]) {
  console.log(`== ${k === "a" ? "a. 許可の決まりなし（依頼の中身を直接書く）" : k === "b" ? "b. permissions.allow に Agent" : "c. 許可の決まりなし（指示のファイルを読んで従えと依頼）"}`);
  for (const [i, s] of summary[k].entries()) console.log(`     ${i + 1} 回目: Agent の呼び出し=${s.agentCalled} 拒否=${s.agentDenied} 拒否された道具=${JSON.stringify(s.denials)} 子が書けた=${s.wrote}`);
}
const bOk = summary.b.every((s) => s.agentCalled && !s.agentDenied);
console.log(`${bOk ? "OK" : "NG"}   b. permissions.allow に Agent を書くと、${rounds} 回とも Agent の起動が拒否されない（ただし a でも拒否されないので、許可の決まりの効果は示せない）`);
console.log(`     観測: c で拒否された回数 ${summary.c.filter((s) => s.agentDenied).length} / ${rounds}、a で拒否された回数 ${summary.a.filter((s) => s.agentDenied).length} / ${rounds}`);
if (!process.env.POC_KEEP) fs.rmSync(base, { recursive: true, force: true });
process.exit(bOk ? 0 : 1);
