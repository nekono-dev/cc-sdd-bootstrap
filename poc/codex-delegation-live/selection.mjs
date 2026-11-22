#!/usr/bin/env node
// 6.1 のクライアント別の候補選択を、実際の選択関数（delegation-select.mjs）で確かめる。
// 候補は登録の解決結果と同じ形（保存情報・能力・公開モデル）で与える。費用は掛からない。
// 実行: node poc/codex-delegation-live/selection.mjs
import { selectDelegate } from "../../.agent-hooks/cc-sdd-bootstrap/delegation-select.mjs";

const capability = (harness, tier, models) => ({ kind: "agent", harness, tier, models });
const model = (id, access = "read-only", effort = "medium") => ({ id, accepted: [{ access, effort }] });
const saved = (family, registrationName, models = {}) => ({ family, scope: "user", registrationName, registrationId: `${registrationName}-id`, models });
const settings = {
  format: 1,
  subagents: {
    claudeModels: { review: "claude-sonnet-5-5" },
    codexModels: { review: "gpt-6.1-sol" },
    localModels: {},
    efforts: { review: "medium" },
  },
};

// Claude 系のクラウドはモデルを登録側の指定（互換 ID）で受ける。Codex 系は Codex の役割設定を使う。
const claudeCloud = { saved: saved("claude", "claude-cloud", { review: { compatibleIds: ["claude-sonnet-5-5"] } }), capability: capability("claude", "cloud", [model("claude-sonnet-5-5")]), models: ["claude-sonnet-5-5"] };
const codexCloud = { saved: saved("codex", "codex-cloud"), capability: capability("codex", "cloud", [model("gpt-6.1-sol")]), models: ["gpt-6.1-sol"] };

// 1. 指揮役が Claude のとき、順位で先頭の Claude クラウドは除外され、次の Codex クラウドを選ぶ
const claudeHost = selectDelegate({ settings, role: "review", host: "claude",
  candidates: [claudeCloud, codexCloud], native: { client: "claude", available: true } });
// 2. 指揮役が Codex に変わったとき、順位で先頭の Codex クラウドは除外され、Claude クラウドを選ぶ
const codexHost = selectDelegate({ settings, role: "review", host: "codex",
  candidates: [codexCloud, claudeCloud], native: { client: "codex", available: true } });
// 3. 同系統のクラウドしか無いときは、外部候補を使わずネイティブへ移る
const onlySame = selectDelegate({ settings, role: "review", host: "claude",
  candidates: [claudeCloud], native: { client: "claude", available: true } });

console.log(JSON.stringify({
  host_claude_order_claude_then_codex: { kind: claudeHost.kind, family: claudeHost.candidate?.family, registrationName: claudeHost.candidate?.registrationName, model: claudeHost.model },
  host_codex_order_codex_then_claude: { kind: codexHost.kind, family: codexHost.candidate?.family, registrationName: codexHost.candidate?.registrationName, model: codexHost.model },
  host_claude_only_same_family_cloud: onlySame,
}, null, 2));
