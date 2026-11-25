// 共有の定数と配置する内容をまとめる。
// 設定から作る役割定義は、配置物 subagent-roles.mjs の renderDefinitions を読み込んで使う（依存の向きの例外）。
import { renderDefinitions } from "../.agent-hooks/cc-sdd-bootstrap/subagent-roles.mjs";

export const DEPLOY_DIR = ".agent-hooks/cc-sdd-bootstrap";
export const OWNED_MARKER = "/.agent-hooks/cc-sdd-bootstrap/";
export const CONFIG_PATH = ".cc-sdd-bootstrap.json";
export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CODEX_HOOKS_PATH = ".codex/hooks.json";
export const AGENT_DOCS = { claude: "CLAUDE.md", codex: "AGENTS.md" };
export const AGENT_SECTION_FILES = {
  claude: `${DEPLOY_DIR}/agent-section-claude.md`,
  codex: `${DEPLOY_DIR}/agent-section-codex.md`,
};
export const AGENT_SECTION_MARKERS = {
  begin: "<!-- cc-sdd-bootstrap:begin（この区画は cc-sdd の導入のたびに書き足される。編集しない） -->",
  end: "<!-- cc-sdd-bootstrap:end -->",
};

const kiroGateTable = [
  "| 依頼の種類 | 使うスキル |",
  "|---|---|",
  "| 新機能・新プロジェクトの相談、分割の検討 | `kiro-discovery` |",
  "| 次にやること・進み具合の確認 | `kiro-spec-status` |",
  "| 既存コードと要件の差の確認 | `kiro-validate-gap` |",
  "| 設計のレビュー | `kiro-validate-design` |",
  "| 実装後の最終確認 | `kiro-validate-impl` |",
  "| プロジェクトの方針の整備・更新 | `kiro-steering` |",
  "| 完了・成功と報告する前 | `kiro-verify-completion` |",
].join("\n");

const DELEGATE = `node ${DEPLOY_DIR}/delegate.mjs`;
const ROLE_GUIDE = "- 入口の役割は作業ごとに指定します: レビューは `--role review`、デバッグの原因調査は `--role debug`、調査は `--role investigate`（役割ごとに既定のモデルが違います。例: Sonnet の指揮役で investigate は Luna、review は Terra）。";
const NO_CANDIDATE = "- 同じ提供元に候補が無い（入口が指揮役自身で行うよう示す）ときは、その作業を指揮役が自分で行う運用です（Haiku・Luna の指揮役では別の系統が無く、入口は終了 2 を返します）。";
const MODEL_ARG = "--orchestrator-model <今の自分のモデル>";

/** 子に任せる運用の文章。両ツールで同じ趣旨で、起動の書き方と注意だけがツールごとに違う */
function delegationSection(tool) {
  const claude = tool === "claude";
  const other = claude ? "codex" : "claude";
  const table = [
    "| 指揮役 | 実装・修正 | レビュー・デバッグ | 調査 |",
    "|---|---|---|---|",
    "| Haiku（1） | 指揮役自身 | Luna | Luna |",
    "| Sonnet（2） | Haiku | Terra | Luna |",
    "| Opus（3） | Sonnet | Sol | Luna |",
    "| Fable（4） | Opus | Sol | Terra |",
    "| Luna（1） | 指揮役自身 | Haiku | Haiku |",
    "| Terra（2） | Luna | Sonnet | Haiku |",
    "| Sol（3） | Terra | Opus | Haiku |",
    "| Astra（4） | Sol | Opus | Sonnet |",
  ].join("\n");
  const parts = [
    [
      "子（指揮役から仕事を任される別のモデル）への分担と既定のモデルは次のとおりです（括弧内は格。モデルの強さの段階で、数字が大きいほど上位です）。",
      "- 実装・修正は同じ提供元の子（指揮役の 1 つ下の格。指揮役が最下位なら指揮役自身）、レビューとデバッグの原因調査は別の提供元（指揮役の格以下で最上位）、調査は別の提供元（指揮役の 2 つ下の格、最低は格 1）が行います。",
      "- 格 4 は子に使いません。どの役割も、設定の子の上限（`subagents.maxModel.<提供元>`。未設定は格 3）まで下げます。",
      "",
      table,
      "",
      "上限が Claude は Sonnet、Codex は Sol のときは、Fable の指揮役の実装が Sonnet、Sol・Astra の指揮役のレビュー・デバッグが Sonnet になります。",
    ].join("\n"),
    [
      "格と推論量（考える深さ）の選び方の目安です。",
      "- 既定の推論量は、格 1 の子で `high`、格 2 以上の子で `medium` です（推論量の上限まで下げます）。推論量の上限は、系統ごとの上限（`subagents.maxEffort.<系統>`）、無ければ共通の上限（`subagents.maxEffort.default`）、どちらも無ければ `high` の順で求めます。",
      "- 作業ごとに、対象のモデルが受け付ける推論量のうち上限以下から選びます。格 1 は `high` を選んでよく、格 2 以上は `medium` を基本とし、重要な作業だけ `high` にします。軽い作業は `low` でよく、特に格 3 では `low` も選択肢です。",
      "- 複雑な調査（例: 複数のアプリケーションにまたがる関係箇所の洗い出し）は、指揮役の判断で調査役を 1 つ上の格にしてよいです。ただし指揮役の格より下、かつ子の上限以下にします。",
      "- 上位の格ほど推論量を上げたときの費用が大きいので、格と推論量は作業の重大度と費用の釣り合いで選びます。これらは仕組みで強制しない目安です。",
    ].join("\n"),
    [
      "作業の流れです。",
      "- 実装: 実装役の実装 → 別の提供元のレビュー 1 回 → 指摘があるときだけ、同じ実装役が修正 → 同じレビュー役が指摘箇所だけ再確認します。",
      "- 設計: 読み取り専用の調査役が事実を集めて要約を返す → 指揮役が設計 → 別の提供元が設計をレビューします。判断を含む確認（技術の実現性の確認・PoC（試作）の検証）は調査役ではなくレビュー役に任せます。",
      "- デバッグ: 読み取り専用の原因調査（別の提供元。別の提供元による確認を兼ねます）→ 修正（同じ提供元）→ テストで確かめます。修正の後に別のレビューを重ねない運用です。",
      "- 結果の扱い: 指揮役は同じ観点のレビューをやり直さず、子の結果を未確認として扱い、差分と必要なテストで確かめてから完了とします。",
    ].join("\n"),
  ];
  if (claude) {
    parts.push([
      "cc-sdd の手順が「Agent ツールで子に任せる」と書く箇所は、次のように読み替えます。",
      `- 子の起動のたびに、今の自分のモデルを渡して名前を求めます: \`${DELEGATE} --resolve-model --from claude --role implement ${MODEL_ARG}\``,
      "- 出力は `<名前> <推論量>` の 1 行です。先頭の名前を `subagent_type` に入れて起動します（モデルと推論量は定義に入っています）。フックは起動の引数の `model` か定義から子のモデルを取り、起動の引数と定義のどちらにもモデルが無い起動は、未指定として拒否され、使う定義の名前を求めるコマンドが示される。",
      "- Codex の子を起動する入口（`delegate.mjs`）は、設定 `codex.trustHooks` が false でなければ、その起動の間だけ承認の確認を省く指定（`--dangerously-bypass-hook-trust`）を付けます。指定は設定ファイルには保存されません。この Codex が指定を受け付けないときは子を起動せず案内します。",
      ROLE_GUIDE,
      `- 別の提供元の入口の例（役割ごとに指定を変え、同じ依頼内容と成果物の形式のまま渡します）: \`${DELEGATE} --from claude --role review ${MODEL_ARG} --instructions <指示のファイル>\`、\`${DELEGATE} --from claude --role debug ${MODEL_ARG} --instructions <指示のファイル>\`、\`${DELEGATE} --from claude --role investigate ${MODEL_ARG} --instructions <指示のファイル>\``,
      "- 環境変数 `CLAUDE_CODE_EFFORT_LEVEL` が設定されていると、指揮役と子の推論量がすべてその値になり、役割定義の推論量は効きません。",
      `- 組み込みの子は起動ごとに推論量を変えられず、選んだ定義の推論量で動きます。別の推論量が要るときは同じ提供元の入口（\`claude -p\`）を使います: \`${DELEGATE} --from claude --role implement --to same --effort <値> ${MODEL_ARG} --instructions <指示のファイル>\``,
    ].join("\n"));
    parts.push([
      "別の提供元が使えないときは、すべての役割を同じ提供元の、指揮役と異なり指揮役の格以下かつ子の上限以下のモデルで行い、レビューは 1 回です。",
      `- 名前は \`${DELEGATE} --resolve-model --from claude --role review --to same ${MODEL_ARG}\` のように、該当する役割（review・debug・investigate・implement）を指定して求め、出力の先頭の定義の名前（読み取り専用の定義は道具を制限済み）を \`subagent_type\` に入れて起動します。`,
      NO_CANDIDATE,
    ].join("\n"));
  } else {
    parts.push([
      "cc-sdd の手順が「子に任せる」と書く箇所は、次のように読み替えます。",
      `- 子の起動のたびに、今の自分のモデルを渡して名前を求めます: \`${DELEGATE} --resolve-model --from codex --role implement ${MODEL_ARG}\``,
      "- 出力は `<名前> <推論量>` の 1 行です。`cc_sdd_implement` を `agent_type` にし、名前を `model`、推論量（または作業に合わせて選んだ上限以下の値）を `reasoning_effort` に入れて明示し、`fork_turns` を `none` にします（履歴を引き継ぐと親と同じモデルになるため）。",
      "- フックは起動の引数の `model` か定義から子のモデルを取ります。`model` を明示すれば定義が無くても未指定の理由では拒否されず、`cc_sdd_implement` を指定しても `model` が無ければ拒否されます（だから `model` の明示が要ります）。",
      ROLE_GUIDE,
      `- 別の提供元の入口の例（役割ごとに指定を変え、同じ依頼内容と成果物の形式のまま渡します）: \`${DELEGATE} --from codex --role review ${MODEL_ARG} --instructions <指示のファイル>\`、\`${DELEGATE} --from codex --role debug ${MODEL_ARG} --instructions <指示のファイル>\`、\`${DELEGATE} --from codex --role investigate ${MODEL_ARG} --instructions <指示のファイル>\``,
      "- この入口から `claude -p` の子を使うには、シェルに通信の許可（`sandbox_workspace_write.network_access=true` など）が要ります。無いと子は応答を返せません。",
      "- フックの信頼が承認されていないと起動前の確認は働きません。その場合は役割表に従い、`model` と推論量を明示し、指揮役と同じモデル・上の格・格 4・上限より上を避けます。",
      "- `spawn_agent` の推論量は、定義に推論量があると定義が優先されます（生成する定義には書きません）。",
    ].join("\n"));
    parts.push([
      "別の提供元が使えないときは、すべての役割を同じ提供元の、指揮役と異なり指揮役の格以下かつ子の上限以下のモデルで行い、レビューは 1 回です。",
      `- 書き込む役割は \`${DELEGATE} --resolve-model --from codex --role implement --to same ${MODEL_ARG}\` のように名前を求めて上の組み込みの子で行います。`,
      `- 組み込みの子は読み取り専用にできないので、読み取り専用の役割は、該当する役割（review・debug・investigate）を指定して同じ提供元の入口で行います: \`${DELEGATE} --from codex --role review --to same --model <指揮役と異なり指揮役の格以下かつ子の上限以下のモデル> ${MODEL_ARG} --instructions <指示のファイル>\``,
      NO_CANDIDATE,
    ].join("\n"));
  }
  parts.push([
    "指示のファイルと書き込みの決まりです。",
    "- 指示のファイルは `~/.cache/cc-sdd-bootstrap-scratch/` に置きます（リポジトリ内と `/tmp` には置きません）。範囲・必要な決まり・禁止する操作・成果物の形式を書き、子が CLAUDE.md・AGENTS.md を読むことに頼らないでください。",
    "- 書き込みは 1 つずつ行います。書き込み可の子の実行中は、読み取り専用の子も重ねない運用です。",
  ].join("\n"));
  parts.push([
    "子の起動が拒否されたときの扱いです。",
    "- 組み込みの子の起動が利用環境の許可の判定で拒否された場合に限り、依頼の範囲・決まり・成果物の形式を依頼文に直接書いて 1 度だけ起動し直します。入口の CLI の委任は指示のファイルを標準入力に渡すので対象外です。",
    "- それでも拒否されたら、指揮役が子の作業を代わりに進めず、拒否の状況と選べる進め方（利用者が許可する・別の提供元が使えるまで待つ・指揮役が直接進めることを利用者が認める）を示して止まります。",
    "- 導入時に子の起動の許可は前もって与えない（許可の決まりは置かない）ものとします。",
    `- 別の提供元（${other}）の子が使えないときに、指揮役の提供元の子へ切り替えることには、利用者の許可を求めない運用です。`,
  ].join("\n"));
  parts.push("プロジェクト独自の決まりは `.kiro/steering/` から読んでください。");
  return parts.join("\n\n");
}

/** @type {{ hooks: object[], gitignore: string[], agentSections: object[], generated: object[], files: {path:string}[] }} */
export const catalog = {
  hooks: [
    { tools: ["claude"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "claude"], timeout: 30 },
    { tools: ["codex"], event: "SessionStart", script: "install-cc-sdd.mjs", args: ["session-start", "--tool", "codex"], timeout: 30 },
    { tools: ["claude"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "claude"], timeout: 600 },
    { tools: ["codex"], event: "UserPromptSubmit", script: "install-cc-sdd.mjs", args: ["user-prompt-submit", "--tool", "codex"], timeout: 600 },
    ...["claude", "codex"].flatMap((tool) => [
      { tools: [tool], event: "SessionStart", script: "kiro-gate.mjs", args: ["session-start", "--tool", tool], timeout: 10 },
      { tools: [tool], event: "UserPromptSubmit", script: "kiro-gate.mjs", args: ["user-prompt-submit", "--tool", tool], timeout: 10 },
      { tools: [tool], event: "PreToolUse", script: "kiro-gate.mjs", args: ["pre-tool-use", "--tool", tool], timeout: 10 },
      { tools: [tool], event: "PostToolUse", script: "kiro-gate.mjs", args: ["post-tool-use", "--tool", tool], timeout: 10 },
      { tools: [tool], event: "Stop", script: "kiro-gate.mjs", args: ["stop", "--tool", tool], timeout: 10 },
    ]),
    { tools: ["claude"], event: "PreToolUse", matcher: "Agent", script: "subagent-check.mjs", args: ["pre-tool-use", "--tool", "claude"], timeout: 10 },
    { tools: ["codex"], event: "PreToolUse", script: "subagent-check.mjs", args: ["pre-tool-use", "--tool", "codex"], timeout: 10 },
  ],
  gitignore: [
    ".claude/skills/kiro-*/",
    ".agents/skills/kiro-*/",
    ".kiro/settings/",
    "/CLAUDE.md",
    "/AGENTS.md",
    "/.cache/",
  ],
  agentSections: [
    {
      id: "bootstrap-intro",
      claude: [
        "この区画は cc-sdd-bootstrap の導入のたびに書き足されるため、直接編集しないでください。",
        `共通の配置物（\`${DEPLOY_DIR}/\`）を直接編集しないでください。変更は導入コマンドの更新で反映し、差分は git で確認してください。`,
        "プロジェクト独自の決まりは、作業を始める前に `.kiro/steering/` の `product.md`・`tech.md`・`structure.md` と独自の文書を読んでください。",
      ].join("\n\n"),
      codex: [
        "この区画は cc-sdd-bootstrap の導入のたびに書き足されるため、直接編集しないでください。",
        `共通の配置物（\`${DEPLOY_DIR}/\`）を直接編集しないでください。変更は導入コマンドの更新で反映し、差分は git で確認してください。`,
        "プロジェクト独自の決まりは、作業を始める前に `.kiro/steering/` の `product.md`・`tech.md`・`structure.md` と独自の文書を読んでください。",
      ].join("\n\n"),
    },
    {
      id: "session-install",
      claude: [
        "cc-sdd の導入は起動前（環境の準備スクリプト）か最初の入力時に行われ、必要なファイルが揃っていれば省かれます。`kiro-` で始まる独自のスキルを置かないでください。",
        "導入が未完了なら入力は止まります。再試行は通常の端末で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行してください。",
        "スキル一覧に載らないスキルは `.claude/skills/<名前>/SKILL.md` を直接読んで手順を最後まで実行してください。手順書が見つからなければ導入を確かめて再試行し、手順書が使えるまで開発作業を進めないでください。",
        "プロジェクト独自の決まりは `.kiro/steering/` から読んでください。",
      ].join("\n\n"),
      codex: [
        "cc-sdd の導入は起動前（環境の準備スクリプト）か最初の入力時に行われ、必要なファイルが揃っていれば省かれます。`kiro-` で始まる独自のスキルを置かないでください。",
        "導入が未完了なら入力は止まります。再試行は通常の端末で `node .agent-hooks/cc-sdd-bootstrap/install-cc-sdd.mjs` を実行してください。",
        "スキル一覧に載らないスキルは `.agents/skills/<名前>/SKILL.md` を直接読んで手順を最後まで実行してください。手順書が見つからなければ導入を確かめて再試行し、手順書が使えるまで開発作業を進めないでください。",
        "プロジェクト独自の決まりは `.kiro/steering/` から読んでください。",
        "Codex のフックは、信頼の承認が済むまで動きません。承認の記録は導入・更新（`init`・`update`）と起動前の導入で自動で書かれます（設定 `codex.trustHooks` が false なら書かれません）。記録が効いていないときは、対話の `codex` を起動して「Hooks need review」の画面で承認してください（`codex exec` は未承認のフックを黙って飛ばします）。プロジェクトを Codex が信頼していないとフックは読まれないので、最初の確認画面か `codex exec --trust` で信頼してください。シンボリックリンク経由で開いたリポジトリでは承認が効かない場合があります。Codex のクラウドのセッションでは承認の記録を書けない場合があります。",
        "フックの信頼が承認されていないと、入力の停止は機械的には保証されません。その場合は作業の前に上の再試行コマンドで導入を実行・確認し、失敗・未完了なら作業を止めて利用者に復旧方法を伝えてください。",
      ].join("\n\n"),
    },
    {
      id: "kiro-gate",
      claude: [kiroGateTable,
        "表に該当する依頼では `/kiro-*` で始まっていなくても、対応する手順書を読んで手順を最後まで実行してください。",
        "手順書は `.claude/skills/<スキル名>/SKILL.md` を直接読んでください。",
        "依頼の種類を判断できなければ、スキルを使うか利用者に尋ねてください。",
        "`/kiro-*` で始めた依頼では、フックが有効なら手順書を読むまで他の作業ツールが拒否されます。",
        "プロジェクト独自の決まりは `.kiro/steering/` から読んでください。",
      ].join("\n\n"),
      codex: [kiroGateTable,
        "表に該当する依頼では `/kiro-*` で始まっていなくても、対応する手順書を読んで手順を最後まで実行してください。",
        "手順書は `.agents/skills/<スキル名>/SKILL.md` を直接読んでください。",
        "依頼の種類を判断できなければ、スキルを使うか利用者に尋ねてください。",
        "`/kiro-*`（Codex は `$kiro-*`）で始めた依頼では、フックが有効なら手順書を読むまで他の作業ツールが拒否されます。",
        "フックの信頼が承認されていない環境でも、作業の前に対応する手順書を読んでください。",
        "プロジェクト独自の決まりは `.kiro/steering/` から読んでください。",
      ].join("\n\n"),
    },
    {
      id: "subagent-delegation",
      claude: delegationSection("claude"),
      codex: delegationSection("codex"),
    },
  ],
  generated: [
    {
      id: "subagent-definitions",
      owns: [".claude/agents/cc-sdd-*.md", ".codex/agents/cc_sdd_*.toml"],
      render: (config) => renderDefinitions(config.subagents ?? {}),
    },
  ],
  files: [
    { path: `${DEPLOY_DIR}/install-cc-sdd.mjs` },
    { path: `${DEPLOY_DIR}/install-rules.mjs` },
    { path: `${DEPLOY_DIR}/config-schema.mjs` },
    { path: `${DEPLOY_DIR}/subagent-roles.mjs` },
    { path: `${DEPLOY_DIR}/kiro-gate.mjs` },
    { path: `${DEPLOY_DIR}/kiro-gate-rules.mjs` },
    { path: `${DEPLOY_DIR}/subagent-check.mjs` },
    { path: `${DEPLOY_DIR}/delegate.mjs` },
    { path: `${DEPLOY_DIR}/codex-trust.mjs` },
    { path: `${DEPLOY_DIR}/codex-trust-rules.mjs` },
  ],
};
