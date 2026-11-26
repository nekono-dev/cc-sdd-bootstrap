// lib/source.mjs（配布物の位置から配布元のコミットと取得時の指定を取り出す）の単体試験。
// 擬似の `node_modules/cc-sdd-bootstrap` 配置を一時ディレクトリに組んで確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSource } from "../lib/source.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const NAME = "cc-sdd-bootstrap";
const NONE = { commit: null, ref: null };

// 一時ディレクトリを作り、後始末の関数と一緒に返す
function makeBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "source-test-"));
  return { base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// `<base>/app/node_modules/cc-sdd-bootstrap` の配置を作る。
// lockText / rootText は、ファイルを書かないとき undefined にする（文字列はそのまま書く）
function layout(base, { lockText, rootText, name = NAME } = {}) {
  const nodeModules = path.join(base, "app", "node_modules");
  const pkgRoot = path.join(nodeModules, name);
  fs.mkdirSync(pkgRoot, { recursive: true });
  if (lockText !== undefined) fs.writeFileSync(path.join(nodeModules, ".package-lock.json"), lockText);
  if (rootText !== undefined) fs.writeFileSync(path.join(base, "app", "package-lock.json"), rootText);
  return pkgRoot;
}

// `.package-lock.json` の内容（配布元の解決結果）
function innerLock(resolved, name = NAME) {
  return JSON.stringify({ packages: { [`node_modules/${name}`]: { version: "0.1.0", resolved } } });
}

// 2 つ上の package-lock.json（取得時の指定）
function rootLock(spec, name = NAME) {
  return JSON.stringify({ packages: { "": { dependencies: { [name]: spec } } } });
}

test("コミットと取得時の指定を取り出せる", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, {
      lockText: innerLock(`git+ssh://git@github.com/nekono-dev/cc-sdd-bootstrap.git#${SHA}`),
      rootText: rootLock("github:nekono-dev/cc-sdd-bootstrap#dev/base-branch-sync"),
    });
    assert.deepEqual(readSource(pkgRoot), { commit: SHA, ref: "dev/base-branch-sync" });
  } finally {
    cleanup();
  }
});

test("取得時の指定に # が無ければ ref は null、コミットは取れる", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, {
      lockText: innerLock(`git+https://github.com/nekono-dev/cc-sdd-bootstrap.git#${SHA}`),
      rootText: rootLock("github:nekono-dev/cc-sdd-bootstrap"),
    });
    assert.deepEqual(readSource(pkgRoot), { commit: SHA, ref: null });
  } finally {
    cleanup();
  }
});

test("取得時の指定の # の後が空なら ref は null", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, {
      lockText: innerLock(`git+https://github.com/nekono-dev/cc-sdd-bootstrap.git#${SHA}`),
      rootText: rootLock("github:nekono-dev/cc-sdd-bootstrap#"),
    });
    assert.deepEqual(readSource(pkgRoot), { commit: SHA, ref: null });
  } finally {
    cleanup();
  }
});

test("2 つ上の package-lock.json が無ければ ref は null、コミットは取れる", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, {
      lockText: innerLock(`git+https://github.com/nekono-dev/cc-sdd-bootstrap.git#${SHA}`),
    });
    assert.deepEqual(readSource(pkgRoot), { commit: SHA, ref: null });
  } finally {
    cleanup();
  }
});

test("指定の値が文字列でない・依存に無いときは ref は null", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, {
      lockText: innerLock(`git+https://github.com/nekono-dev/cc-sdd-bootstrap.git#${SHA}`),
      rootText: JSON.stringify({ packages: { "": { dependencies: { [NAME]: 1 } } } }),
    });
    assert.deepEqual(readSource(pkgRoot), { commit: SHA, ref: null });
    fs.writeFileSync(path.join(base, "app", "package-lock.json"), rootLock("0.1.0", "other"));
    assert.deepEqual(readSource(pkgRoot), { commit: SHA, ref: null });
  } finally {
    cleanup();
  }
});

test(".package-lock.json が無いと両方 null", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, { rootText: rootLock("github:nekono-dev/cc-sdd-bootstrap#main") });
    assert.deepEqual(readSource(pkgRoot), NONE);
  } finally {
    cleanup();
  }
});

test(".package-lock.json の JSON が壊れていると両方 null", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, {
      lockText: "{ 壊れている",
      rootText: rootLock("github:nekono-dev/cc-sdd-bootstrap#main"),
    });
    assert.deepEqual(readSource(pkgRoot), NONE);
  } finally {
    cleanup();
  }
});

test("resolved に 40 桁の 16 進が無いと両方 null（短いコミット・ブランチ名・ハッシュの後ろに余分がある場合）", () => {
  const { base, cleanup } = makeBase();
  try {
    const cases = [
      `git+https://github.com/nekono-dev/cc-sdd-bootstrap.git#${SHA.slice(0, 12)}`,
      `github:nekono-dev/cc-sdd-bootstrap#dev/base-branch-sync`,
      `git+https://github.com/nekono-dev/cc-sdd-bootstrap.git#${SHA}0`,
      `git+https://github.com/nekono-dev/cc-sdd-bootstrap.git#${SHA.toUpperCase().replace(/[A-F]/g, "g")}`,
      "https://registry.npmjs.org/cc-sdd-bootstrap/-/cc-sdd-bootstrap-0.1.0.tgz",
    ];
    for (const resolved of cases) {
      const pkgRoot = layout(base, {
        lockText: innerLock(resolved),
        rootText: rootLock("github:nekono-dev/cc-sdd-bootstrap#dev/base-branch-sync"),
      });
      assert.deepEqual(readSource(pkgRoot), NONE, resolved);
    }
  } finally {
    cleanup();
  }
});

test("resolved が無い・エントリが無いと両方 null", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, {
      lockText: JSON.stringify({ packages: { "node_modules/other": { resolved: `x#${SHA}` } } }),
      rootText: rootLock("github:nekono-dev/cc-sdd-bootstrap#main"),
    });
    assert.deepEqual(readSource(pkgRoot), NONE);
    fs.writeFileSync(path.join(base, "app", "node_modules", ".package-lock.json"), JSON.stringify({ packages: {} }));
    assert.deepEqual(readSource(pkgRoot), NONE);
  } finally {
    cleanup();
  }
});

test("コミットが取れなければ、取得時の指定があっても両方 null（記録の整合）", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, {
      lockText: innerLock("github:nekono-dev/cc-sdd-bootstrap#dev/base-branch-sync"),
      rootText: rootLock("github:nekono-dev/cc-sdd-bootstrap#dev/base-branch-sync"),
    });
    assert.deepEqual(readSource(pkgRoot), NONE);
  } finally {
    cleanup();
  }
});

test("node_modules の下でない位置（手元の checkout 相当）では、同じ内容があっても両方 null", () => {
  const { base, cleanup } = makeBase();
  try {
    // checkout/cc-sdd-bootstrap の親は node_modules ではない
    const checkout = path.join(base, "checkout");
    const pkgRoot = path.join(checkout, NAME);
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.writeFileSync(path.join(checkout, ".package-lock.json"), innerLock(`x#${SHA}`));
    fs.writeFileSync(path.join(base, "package-lock.json"), rootLock("github:nekono-dev/cc-sdd-bootstrap#main"));
    assert.deepEqual(readSource(pkgRoot), NONE);
  } finally {
    cleanup();
  }
});

test("配布物のディレクトリ名が違うエントリは読まない", () => {
  const { base, cleanup } = makeBase();
  try {
    const pkgRoot = layout(base, {
      lockText: innerLock(`git+https://github.com/nekono-dev/cc-sdd-bootstrap.git#${SHA}`, "other-name"),
      rootText: rootLock("github:nekono-dev/cc-sdd-bootstrap#main", "other-name"),
    });
    assert.deepEqual(readSource(pkgRoot), NONE);
  } finally {
    cleanup();
  }
});

test("例外を投げない（引数が不正・存在しないパスでも両方 null）", () => {
  assert.doesNotThrow(() => readSource("/no/such/dir/node_modules/cc-sdd-bootstrap"));
  assert.deepEqual(readSource("/no/such/dir/node_modules/cc-sdd-bootstrap"), NONE);
  assert.deepEqual(readSource(undefined), NONE);
  assert.deepEqual(readSource(null), NONE);
  assert.deepEqual(readSource(42), NONE);
  assert.deepEqual(readSource(""), NONE);
});
