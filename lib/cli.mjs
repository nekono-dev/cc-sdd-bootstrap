// コマンドの処理の本体。いまは使い方を表示するだけの最小の形。
// （操作の解析・実行は後のタスクで同じファイルに足していく）

const USAGE = `使い方: cc-sdd-bootstrap <操作> [オプション]

操作:
  init        cc-sdd の運用一式をこのリポジトリへ導入する
  update      導入済みの一式を最新にする
  uninstall   導入した一式を取り除く

オプション:
  -h, --help  この使い方を表示する
`;

// 終了コードを返す。
export async function runCli(argv, io) {
  io.stdout.write(USAGE);
  return 0;
}
