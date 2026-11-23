// 引数を受け取り、対象の読み取り・計画・適用を順に行う。
import path from "node:path";
import { configFields } from "./config-schema.mjs";
import { catalog, CONFIG_PATH } from "./catalog.mjs";
import { computePlan } from "./plan.mjs";
import { applyPlan, isGitRoot, readSnapshot } from "./target.mjs";

const OPERATIONS = new Set(["init", "update", "uninstall"]);

/** 引数を解析する。 */
export function parseArgs(argv) {
  const args = [...argv];
  if (args.length === 0 || args.length === 1 && ["help", "--help", "-h"].includes(args[0])) return { kind: "help" };
  const operation = args[0];
  if (!OPERATIONS.has(operation)) return { kind: "usage-error", message: `未知の操作です: ${operation}` };
  if (args.length > 1) return { kind: "usage-error", message: `未対応の指定または余分な引数です: ${args.slice(1).join(" ")}` };
  return { kind: "run", operation };
}

/** 使い方と設定の編集方法を表示する。 */
export function buildUsage() {
  return [
    "使い方: cc-sdd-bootstrap <操作>",
    "",
    "操作:",
    "  init        運用一式を導入する",
    "  update      運用一式を更新する",
    "  uninstall   フック登録と運用区画を取り外す",
    "  help, -h, --help  この使い方を表示する",
    "",
    `設定値は ${CONFIG_PATH} を直接編集してください。`,
  ].join("\n") + "\n";
}

/** CLI の処理。 */
export async function runCli(argv, io) {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") { io.stdout.write(buildUsage()); return 0; }
  if (parsed.kind === "usage-error") {
    io.stderr.write(`${parsed.message}\n\n${buildUsage()}`);
    return 1;
  }
  const root = io.cwd ?? process.cwd();
  if (!isGitRoot(root)) {
    io.stderr.write("git リポジトリの最上位で実行してください。\n");
    return 1;
  }
  let snapshot;
  try {
    snapshot = readSnapshot(root, io.packageRoot ?? path.resolve("."), catalog, parsed.operation);
  } catch (error) {
    io.stderr.write(`対象を読み取れません: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (snapshot?.ok === false) {
    io.stderr.write(`変更先 ${snapshot.at} は安全ではありません（${snapshot.reason}）。\n`);
    return 1;
  }
  let plan;
  try { plan = computePlan({ operation: parsed.operation, snapshot, catalog, fields: configFields }); }
  catch (error) {
    io.stderr.write(`変更案を作れません: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (!plan.ok) {
    for (const abort of plan.aborts) io.stderr.write(formatAbort(abort));
    return 1;
  }
  if (plan.changes.length === 0) {
    io.stdout.write(parsed.operation === "uninstall" ? "取り外すものはありません。\n" : "変更はありません。\n");
    return 0;
  }
  const result = applyPlan(root, plan.changes);
  if (!result.ok) {
    io.stderr.write(`${result.failed.message}\n完了: ${result.done.map((change) => change.path).join("、") || "なし"}\n未処理: ${result.pending.map((change) => change.path).join("、") || "なし"}\n${parsed.operation} を再実行してください。\n`);
    return 1;
  }
  io.stdout.write(parsed.operation === "uninstall" ? "取り外しが完了しました。\n" : "処理が完了しました。\n");
  return 0;
}

function formatAbort(abort) {
  if (abort.code === "CONFIG_EXISTS") return `${CONFIG_PATH} が既にあります。更新には update を使ってください。\n`;
  if (abort.code === "CONFIG_MISSING") return `${CONFIG_PATH} がありません。初回は init を使ってください。\n`;
  if (abort.file) return `${abort.file}: ${(abort.messages ?? [abort.detail ?? abort.code]).join("、")}\n`;
  return `${abort.detail ?? abort.code}\n`;
}
