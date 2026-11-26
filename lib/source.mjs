// 配布物の位置から、配布元のコミットと取得時の指定を取り出す。
// 配布物が `node_modules` の下にあるときだけ読む（手元の checkout からの実行では読まない）。
// 例外は投げない。取り出せないときは null を返す。

import fs from "node:fs";
import path from "node:path";

const NONE = { commit: null, ref: null };
const COMMIT_RE = /#([0-9a-f]{40})$/;

// JSON を読む。読めない・壊れているときは null を返す
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// packageRoot（配布物のディレクトリ）から、配布元のコミットと取得時の指定（#以降）を取り出す。
// コミットが取り出せないときは、指定があっても両方 null にする（記録の整合のため）。
export function readSource(packageRoot) {
  try {
    if (typeof packageRoot !== "string" || packageRoot === "") return { ...NONE };
    const pkgDir = path.resolve(packageRoot);
    const name = path.basename(pkgDir);
    const nodeModules = path.dirname(pkgDir);
    // node_modules の下にあるときだけ読む
    if (path.basename(nodeModules) !== "node_modules") return { ...NONE };

    // 1 つ上の .package-lock.json から、解決されたコミット（末尾の #40 桁）を取る
    const inner = readJson(path.join(nodeModules, ".package-lock.json"));
    const resolved = inner?.packages?.[`node_modules/${name}`]?.resolved;
    const commit = typeof resolved === "string" ? (COMMIT_RE.exec(resolved)?.[1] ?? null) : null;
    if (commit === null) return { ...NONE };

    // 2 つ上の package-lock.json の依存の書き方から、取得時の指定（最初の # より後）を取る
    const root = readJson(path.join(path.dirname(nodeModules), "package-lock.json"));
    const spec = root?.packages?.[""]?.dependencies?.[name];
    let ref = null;
    if (typeof spec === "string" && spec.includes("#")) {
      const after = spec.slice(spec.indexOf("#") + 1);
      ref = after === "" ? null : after;
    }
    return { commit, ref };
  } catch {
    return { ...NONE };
  }
}
