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
    const reasons = { SYMLINK: "経路にシンボリックリンクがあります", OUTSIDE: "リポジトリの外を指しています" };
    io.stderr.write(`変更先 ${snapshot.at} には書き込みません。理由: ${reasons[snapshot.reason] ?? snapshot.reason}（${snapshot.reason}）。シンボリックリンクを外すか、リポジトリの中の通常のファイルにしてから再実行してください。\n`);
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
    io.stdout.write(formatSuccess(parsed.operation, plan));
    return 0;
  }
  const result = applyPlan(root, plan.changes);
  if (!result.ok) {
    io.stderr.write(formatApplyFailure(parsed.operation, result));
    return 1;
  }
  io.stdout.write(formatSuccess(parsed.operation, plan));
  return 0;
}

/** 計画の中止理由と修正方法を表示する。 */
export function formatAbort(abort) {
  if (abort.code === "CONFIG_EXISTS") return `${CONFIG_PATH}: 既にあります。初回登録には init、更新には update を使ってください。\n`;
  if (abort.code === "CONFIG_MISSING") return `${CONFIG_PATH}: ありません。初回登録には init を使ってください。\n`;
  const problem = (abort.messages ?? [abort.detail ?? abort.code]).join("、");
  let remedy = "内容を確認して直してください。";
  if (abort.code === "MARKERS_BROKEN") remedy = "区画の開始・終了の目印を正しい順で 1 組に直してください。";
  else if (abort.code === "HOOKS_UNREADABLE") remedy = "JSON と hooks の形を確認して直してください。";
  else if (abort.code === "CONFIG_UNREADABLE" || abort.code === "CONFIG_INVALID") remedy = "設定ファイルを開ける JSON にし、示された項目を直してください。";
  const file = abort.file ?? "対象ファイル";
  return `${file}: ${problem}。${remedy}\n`;
}

const paths = (changes) => changes.map((change) => typeof change === "string" ? change : change.path).join("、") || "なし";

const generatedNotices = (plan) => (plan.notices ?? []).filter((notice) => notice.code === "GENERATED_NOTICE").flatMap((notice) => notice.messages);

/** 適用結果と計画の案内を表示する。 */
export function formatSuccess(operation, plan) {
  if (plan.changes.length === 0) return operation === "uninstall"
    ? `取り外す登録・区画はありません。\n外した登録・区画: なし\n残っています: .cc-sdd-bootstrap.json、.agent-hooks/cc-sdd-bootstrap/、.gitignore の除外設定\n`
    : ["変更はありません。", ...generatedNotices(plan)].join("\n") + "\n";
  const lines = [operation === "uninstall" ? "取り外しが完了しました。" : "処理が完了しました。"];
  if (operation === "uninstall") {
    lines.push(`外した登録・区画: ${plan.removed?.join("、") || "なし"}`);
    lines.push("残っています: .cc-sdd-bootstrap.json、.agent-hooks/cc-sdd-bootstrap/、.gitignore の除外設定");
  } else {
    const created = plan.changes.filter((change) => change.kind === "write" && change.created).map((change) => change.path);
    const updated = plan.changes.filter((change) => change.kind === "write" && !change.created).map((change) => change.path);
    const deleted = plan.changes.filter((change) => change.kind === "delete").map((change) => change.path);
    lines.push(`作成: ${paths(created)}`, `更新: ${paths(updated)}`, `削除: ${paths(deleted)}`);
    for (const notice of plan.notices ?? []) {
      if (notice.code === "CONFIG_CREATED") {
        const defaults = notice.defaults.map((fieldPath) => {
          const field = configFields.find((item) => item.path === fieldPath);
          if (!field) return fieldPath;
          const value = typeof field.defaultValue === "object" && field.defaultValue !== null
            ? JSON.stringify(field.defaultValue)
            : String(field.defaultValue);
          return `${field.path}=${value}`;
        });
        lines.push(`設定の既定値: ${defaults.join("、") || "なし"}。変更するには ${CONFIG_PATH} を直接編集してください。`);
      }
      if (notice.code === "EXISTING_AGENT_DOCS") lines.push(`既存の ${notice.files.join("・")} は次の cc-sdd の導入で標準文書に置き換わります。独自の決まりは .kiro/steering/ へ移し、git で追跡中なら git rm --cached <ファイル名> で追跡を外してください。`);
      if (notice.code === "GENERATED_NOTICE") lines.push(...notice.messages);
    }
    lines.push(".agent-hooks/cc-sdd-bootstrap/ の配置物は直接編集せず、変更差分は git diff で確かめてください。");
    lines.push("Codex のフックは信頼の承認が必要です。最初の承認は対話の画面で codex を起動して行ってください（codex exec は未承認のフックを黙って飛ばします）。未承認の場合は AGENTS.md の指示に従ってください。");
    lines.push("git の worktree ではフック登録が本体の checkout の .codex/hooks.json から読み込まれるため、本体の checkout にも同じ導入が必要です。信頼の承認も本体側のファイルに対して行ってください。本体側が揃うまでは、worktree で Codex を起動する前に node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs を実行して cc-sdd と AGENTS.md を導入してください。");
    lines.push("共有するときは設定と配置物をコミットしてください。cc-sdd 本体は session-install の手順で導入します。");
  }
  return lines.join("\n") + "\n";
}

/** 途中まで適用した結果と再実行する操作を表示する。 */
export function formatApplyFailure(operation, result) {
  const retry = operation === "init" && result.done.some((change) => change.path === CONFIG_PATH) ? "update" : operation;
  return [
    `失敗: ${result.failed.change.path}: ${result.failed.message}`,
    `完了: ${paths(result.done)}`,
    `未処理: ${paths(result.pending)}`,
    `${retry} を再実行してください。`,
  ].join("\n") + "\n";
}
