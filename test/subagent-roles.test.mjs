import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIERS,
  FAMILY_VENDOR,
  CHILD_MAX_TIER,
  EFFORT_ORDER,
  DEFAULT_MAX_EFFORT,
  familyOf,
  vendorOfFamily,
  childMaxTier,
  defaultEffortFor,
  effortCapFor,
  effortAbove,
  checkChildModel,
  compareTier,
  subagentsField,
  validateSubagents,
} from "../.agent-hooks/cc-sdd-bootstrap/subagent-roles.mjs";

// 検証の失敗の理由を 1 つにまとめて返す補助
const problemsOf = (value) => {
  const r = validateSubagents(value);
  assert.equal(r.ok, false, "誤りが返るはず");
  return r.problems.join("\n");
};

test("既定の格と系統ごとの提供元", () => {
  assert.deepEqual(DEFAULT_TIERS, {
    haiku: 1, luna: 1, sonnet: 2, terra: 2, opus: 3, sol: 3, fable: 4, astra: 4,
  });
  assert.equal(FAMILY_VENDOR.sonnet, "claude");
  assert.equal(FAMILY_VENDOR.terra, "codex");
  assert.equal(CHILD_MAX_TIER, 3);
  assert.deepEqual(EFFORT_ORDER, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(DEFAULT_MAX_EFFORT, "high");
});

test("familyOf: 版の違う名前が同じ系統になる", () => {
  assert.equal(familyOf("gpt-6.1-terra", DEFAULT_TIERS), "terra");
  assert.equal(familyOf("gpt-6.2-terra", DEFAULT_TIERS), "terra");
  assert.equal(familyOf("claude-sonnet-5-5", DEFAULT_TIERS), "sonnet");
  assert.equal(familyOf("Claude-Sonnet-5-6", DEFAULT_TIERS), "sonnet");
  assert.equal(familyOf("opus", DEFAULT_TIERS), "opus");
  assert.equal(familyOf("gpt-4o", DEFAULT_TIERS), null);
});

test("familyOf: 長い語を先に照合する", () => {
  const tiers = { ...DEFAULT_TIERS, sol: 3, solar: 2 };
  assert.equal(familyOf("gpt-6-solar", tiers), "solar");
  assert.equal(familyOf("gpt-6-sol", tiers), "sol");
});

test("vendorOfFamily: 既定の系統は提供元を返し、足した語は null", () => {
  assert.equal(vendorOfFamily("haiku"), "claude");
  assert.equal(vendorOfFamily("astra"), "codex");
  assert.equal(vendorOfFamily("custom"), null);
});

test("childMaxTier: 未設定は格 3、maxModel の系統の格、格 3 を超えない", () => {
  assert.equal(childMaxTier("claude", {}), 3);
  assert.equal(childMaxTier("codex", {}), 3);
  assert.equal(childMaxTier("claude", { maxModel: { claude: "sonnet" } }), 2);
  assert.equal(childMaxTier("codex", { maxModel: { claude: "sonnet" } }), 3);
  assert.equal(childMaxTier("codex", { maxModel: { codex: "gpt-6.1-terra" } }), 2);
  assert.equal(childMaxTier("claude", { maxModel: { claude: "fable" } }), 3);
  // 設定で足した格も使える
  assert.equal(childMaxTier("claude", { tiers: { sonnet: 1 }, maxModel: { claude: "sonnet" } }), 1);
});

test("effortAbove: 弱い順の位置で比べる", () => {
  assert.equal(effortAbove("xhigh", "high"), true);
  assert.equal(effortAbove("high", "high"), false);
  assert.equal(effortAbove("low", "high"), false);
  assert.equal(effortAbove("ultra", "max"), true);
});

test("effortCapFor: 系統ごと → 共通 → 既定 high の順", () => {
  assert.equal(effortCapFor("sonnet", {}), "high");
  assert.equal(effortCapFor("sonnet", { maxEffort: { default: "xhigh" } }), "xhigh");
  assert.equal(
    effortCapFor("sonnet", { maxEffort: { default: "xhigh", sonnet: "medium" } }),
    "medium"
  );
  assert.equal(
    effortCapFor("opus", { maxEffort: { default: "xhigh", sonnet: "medium" } }),
    "xhigh"
  );
  assert.equal(effortCapFor(null, { maxEffort: { default: "max" } }), "max");
});

test("defaultEffortFor: 格 1 は high、ほかは medium、上限で下がる", () => {
  assert.equal(defaultEffortFor("haiku", {}), "high");
  assert.equal(defaultEffortFor("luna", {}), "high");
  assert.equal(defaultEffortFor("sonnet", {}), "medium");
  assert.equal(defaultEffortFor("opus", {}), "medium");
  assert.equal(defaultEffortFor("sol", {}), "medium");
  assert.equal(defaultEffortFor("haiku", { maxEffort: { haiku: "medium" } }), "medium");
  assert.equal(defaultEffortFor("sonnet", { maxEffort: { default: "low" } }), "low");
  // 設定で格を上書きすると既定の推論量も変わる
  assert.equal(defaultEffortFor("sonnet", { tiers: { sonnet: 1 } }), "high");
});

test("checkChildModel: 格 4・上限より上を判定する", () => {
  assert.deepEqual(checkChildModel("fable", {}), { ok: false, kind: "tier4", family: "fable" });
  assert.deepEqual(checkChildModel("gpt-7-astra", {}), { ok: false, kind: "tier4", family: "astra" });
  assert.deepEqual(checkChildModel("opus", {}), { ok: true });
  const cfg = { maxModel: { claude: "sonnet", codex: "sol" } };
  assert.deepEqual(checkChildModel("claude-opus-5", cfg), { ok: false, kind: "above-cap", family: "opus" });
  assert.deepEqual(checkChildModel("claude-sonnet-5-5", cfg), { ok: true });
  assert.deepEqual(checkChildModel("gpt-6.1-sol", cfg), { ok: true });
  assert.deepEqual(checkChildModel("gpt-6.1-terra", cfg), { ok: true });
  // 系統・提供元が分からなければ問題なし
  assert.deepEqual(checkChildModel("gpt-4o", cfg), { ok: true });
  assert.deepEqual(checkChildModel("mymodel", { tiers: { mymodel: 3 } }), { ok: true });
  assert.deepEqual(checkChildModel("mymodel", { tiers: { mymodel: 4 } }), {
    ok: false, kind: "tier4", family: "mymodel",
  });
});

test("compareTier: 上・同じ系統・問題なし・確認できない", () => {
  assert.equal(compareTier("opus", "sonnet", DEFAULT_TIERS), "higher");
  assert.equal(compareTier("claude-sonnet-5-5", "sonnet", DEFAULT_TIERS), "same-model");
  assert.equal(compareTier("haiku", "opus", DEFAULT_TIERS), "ok");
  assert.equal(compareTier("terra", "claude-sonnet-5-5", DEFAULT_TIERS), "ok");
  assert.equal(compareTier("gpt-4o", "opus", DEFAULT_TIERS), "unknown");
  assert.equal(compareTier("sonnet", null, DEFAULT_TIERS), "unknown");
  assert.equal(compareTier("sonnet", "mystery", DEFAULT_TIERS), "unknown");
});

test("validateSubagents: 空・未指定は成功", () => {
  assert.deepEqual(validateSubagents({}), { ok: true, config: {} });
  assert.deepEqual(validateSubagents(undefined), { ok: true, config: {} });
});

test("validateSubagents: 正しい設定は成功する", () => {
  const cfg = {
    tiers: { mymodel: 2 },
    modelIds: { sonnet: "claude-sonnet-5-5" },
    maxModel: { claude: "sonnet", codex: "sol" },
    maxEffort: { default: "high", sonnet: "medium" },
    roles: {
      claude: {
        implement: { provider: "same", model: "haiku", effort: "high", permission: "write" },
        review: { provider: "other", model: "gpt-6.1-terra", effort: "medium" },
      },
      codex: { review: { permission: "read-only" } },
    },
  };
  assert.deepEqual(validateSubagents(cfg), { ok: true, config: cfg });
});

test("validateSubagents: オブジェクトでなければ誤り", () => {
  assert.match(problemsOf("x"), /^subagents/);
  assert.match(problemsOf([]), /^subagents/);
  assert.match(problemsOf(null), /^subagents/);
});

test("validateSubagents: 格は正の整数", () => {
  for (const bad of [0, -1, 1.5, "2", null]) {
    assert.match(problemsOf({ tiers: { foo: bad } }), /subagents\.tiers\.foo/);
  }
  assert.match(problemsOf({ tiers: { "": 1 } }), /subagents\.tiers/);
  assert.match(problemsOf({ tiers: [1] }), /subagents\.tiers/);
});

test("validateSubagents: modelIds は空でない文字列", () => {
  assert.match(problemsOf({ modelIds: { sonnet: "" } }), /subagents\.modelIds\.sonnet/);
  assert.match(problemsOf({ modelIds: { sonnet: 3 } }), /subagents\.modelIds\.sonnet/);
});

test("validateSubagents: maxModel は自分の提供元の系統で格 3 以下", () => {
  assert.match(problemsOf({ maxModel: { gemini: "sonnet" } }), /subagents\.maxModel\.gemini/);
  assert.match(problemsOf({ maxModel: { claude: "terra" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { codex: "sonnet" } }), /subagents\.maxModel\.codex/);
  assert.match(problemsOf({ maxModel: { claude: "fable" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { claude: "unknown-thing" } }), /subagents\.maxModel\.claude/);
  // 系統の語と完全に一致するものだけを受け付ける（版付き・部分一致は誤り）
  assert.match(problemsOf({ maxModel: { claude: "claude-sonnet-5-5" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { claude: "not-a-sonnet-model" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { codex: "gpt-6.1-terra" } }), /subagents\.maxModel\.codex/);
  assert.match(problemsOf({ maxModel: { claude: "" } }), /subagents\.maxModel\.claude/);
  assert.match(problemsOf({ maxModel: { claude: 1 } }), /subagents\.maxModel\.claude/);
  // 設定で格を下げれば fable も上限にできる
  assert.equal(validateSubagents({ tiers: { fable: 3 }, maxModel: { claude: "fable" } }).ok, true);
});

test("validateSubagents: 明示のモデルを委任先の提供元の上限と比べる", () => {
  const base = { tiers: { nova: 3 }, maxModel: { codex: "terra" } };
  // other の委任先は codex。提供元が分からない系統でも格で比べる
  assert.match(
    problemsOf({ ...base, roles: { claude: { review: { provider: "other", model: "gpt-7-nova" } } } }),
    /subagents\.roles\.claude\.review\.model/
  );
  // provider の明示が無ければ既定（review は other）
  assert.match(
    problemsOf({ ...base, roles: { claude: { review: { model: "gpt-7-nova" } } } }),
    /subagents\.roles\.claude\.review\.model/
  );
  // same の委任先は claude（上限は未設定で格 3）なので通る
  assert.equal(
    validateSubagents({ ...base, roles: { claude: { implement: { provider: "same", model: "nova" } } } }).ok,
    true
  );
  // codex が指揮役で other なら委任先は claude
  assert.match(
    problemsOf({
      tiers: { nova: 3 }, maxModel: { claude: "haiku" },
      roles: { codex: { review: { model: "nova" } } },
    }),
    /subagents\.roles\.codex\.review\.model/
  );
  // 格 4 以上も誤り
  assert.match(
    problemsOf({ tiers: { nova: 4 }, roles: { claude: { review: { model: "nova" } } } }),
    /subagents\.roles\.claude\.review\.model/
  );
});

test("validateSubagents: maxEffort のキーと値", () => {
  assert.match(problemsOf({ maxEffort: { default: "turbo" } }), /subagents\.maxEffort\.default/);
  assert.match(problemsOf({ maxEffort: { nothing: "high" } }), /subagents\.maxEffort\.nothing/);
  assert.match(problemsOf({ maxEffort: { sonnet: 5 } }), /subagents\.maxEffort\.sonnet/);
  assert.equal(validateSubagents({ maxEffort: { default: "ultra", opus: "low" } }).ok, true);
});

test("validateSubagents: 役割・提供元の名前、各項目の型", () => {
  assert.match(problemsOf({ roles: { gemini: {} } }), /subagents\.roles\.gemini/);
  assert.match(problemsOf({ roles: { claude: { design: {} } } }), /subagents\.roles\.claude\.design/);
  assert.match(
    problemsOf({ roles: { claude: { review: { provider: "both" } } } }),
    /subagents\.roles\.claude\.review\.provider/
  );
  assert.match(
    problemsOf({ roles: { claude: { review: { effort: "turbo" } } } }),
    /subagents\.roles\.claude\.review\.effort/
  );
  assert.match(
    problemsOf({ roles: { claude: { review: { permission: "rw" } } } }),
    /subagents\.roles\.claude\.review\.permission/
  );
  assert.match(
    problemsOf({ roles: { claude: { review: { model: "" } } } }),
    /subagents\.roles\.claude\.review\.model/
  );
  assert.match(
    problemsOf({ roles: { claude: { review: { unknownKey: 1 } } } }),
    /subagents\.roles\.claude\.review\.unknownKey/
  );
  assert.match(problemsOf({ roles: { claude: { review: "x" } } }), /subagents\.roles\.claude\.review/);
});

test("validateSubagents: 明示のモデルが格 4・上限より上なら誤り", () => {
  assert.match(
    problemsOf({ roles: { claude: { implement: { model: "fable" } } } }),
    /subagents\.roles\.claude\.implement\.model/
  );
  assert.match(
    problemsOf({
      maxModel: { claude: "sonnet" },
      roles: { claude: { implement: { model: "claude-opus-5" } } },
    }),
    /subagents\.roles\.claude\.implement\.model/
  );
  assert.equal(
    validateSubagents({
      maxModel: { claude: "sonnet" },
      roles: { claude: { implement: { model: "claude-sonnet-5-5" } } },
    }).ok,
    true
  );
});

test("validateSubagents: 明示の推論量が明示のモデルの系統の上限より上なら誤り", () => {
  assert.match(
    problemsOf({
      maxEffort: { sonnet: "medium" },
      roles: { claude: { implement: { model: "sonnet", effort: "high" } } },
    }),
    /subagents\.roles\.claude\.implement\.effort/
  );
  // モデルが無ければ共通の上限（既定 high）と比べる
  assert.match(
    problemsOf({ roles: { claude: { review: { effort: "xhigh" } } } }),
    /subagents\.roles\.claude\.review\.effort/
  );
  // モデルが無いとき、系統ごとの上限は誤りにしない（定義と入口で下げる）
  assert.equal(
    validateSubagents({
      maxEffort: { sonnet: "low" },
      roles: { claude: { review: { effort: "high" } } },
    }).ok,
    true
  );
  assert.equal(
    validateSubagents({
      maxEffort: { default: "xhigh" },
      roles: { claude: { review: { effort: "xhigh" } } },
    }).ok,
    true
  );
});

test("validateSubagents: 複数の誤りは道筋つきですべて返る", () => {
  const text = problemsOf({
    tiers: { a: 0 },
    maxModel: { claude: "terra" },
    roles: { claude: { review: { permission: "rw" } } },
  });
  assert.match(text, /subagents\.tiers\.a/);
  assert.match(text, /subagents\.maxModel\.claude/);
  assert.match(text, /subagents\.roles\.claude\.review\.permission/);
});

test("subagentsField: 項目の形と検証", () => {
  assert.equal(subagentsField.path, "subagents");
  assert.equal(subagentsField.kind, "map");
  assert.deepEqual(subagentsField.defaultValue, {});
  assert.equal(subagentsField.validate({}), null);
  const msg = subagentsField.validate({ maxModel: { claude: "terra" }, tiers: { a: 0 } });
  assert.equal(typeof msg, "string");
  assert.match(msg, /subagents\.maxModel\.claude/);
  assert.match(msg, /subagents\.tiers\.a/);
  assert.match(msg, /、/);
});
