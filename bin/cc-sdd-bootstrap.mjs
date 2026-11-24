#!/usr/bin/env node
// 入口。Node の版を確かめてから、処理の本体を読み込む。
// 本体を先に読み込むと、古い Node では読み込みの段階で誤りになるため、動的に読み込む。
import { decideNodeSupported } from "../lib/node-version.mjs";

const verdict = decideNodeSupported(process.versions.node);
if (!verdict.supported) {
  process.stderr.write(
    "cc-sdd-bootstrap には Node.js " + verdict.required + " 以上が必要です（いまの版: " + verdict.actual + "）。\n" +
      "Node.js を更新してからもう一度実行してください。\n",
  );
  process.exitCode = 1;
} else {
  const { fileURLToPath } = await import("node:url");
  const { runCli } = await import("../lib/cli.mjs");
  const code = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    // 空白や日本語を含む道筋でも正しく求めるため、URL の pathname ではなく fileURLToPath を使う
    packageRoot: fileURLToPath(new URL("..", import.meta.url)),
  });
  process.exitCode = code;
}
