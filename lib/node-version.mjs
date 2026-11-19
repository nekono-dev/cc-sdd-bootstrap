// Node の版の判定。古い Node でも読み込めるよう、標準の構文だけで書く。
// lib/ の他のファイルは読み込まない。

// 必要な Node の先頭の数（メジャー版）
export const REQUIRED_NODE_MAJOR = 22;

// 版の文字列（例: "22.16.0"）が対応しているかを決める。
// 読み取れない版は対応していない扱いにする。
export function decideNodeSupported(version) {
  var major = parseInt(String(version).split(".")[0], 10);
  return {
    supported: !isNaN(major) && major >= REQUIRED_NODE_MAJOR,
    required: REQUIRED_NODE_MAJOR,
    actual: String(version),
  };
}
