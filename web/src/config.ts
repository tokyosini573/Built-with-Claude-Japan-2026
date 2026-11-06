// 画面の設定。リプレイやアプリが変わったときはここだけ直す。

/** ?replay= がないときに順に試すリプレイ ID。最初に見つかったものを使う */
export const DEFAULT_REPLAYS = ["demo_matching", "mock"];

/**
 * アプリの画像の置き場所（public からの相対パス）。<app_id> はリプレイの meta.app_id に置き換わる。
 * 画面と広告素材は app.yaml の screens / creatives と同じ相対パスで、この下に置く。
 */
export const APP_ASSET_DIR = "apps/<app_id>/";

/** モックのときに画像を探すアプリ（モックには画像がないので、デモアプリのものを借りる） */
export const MOCK_ASSET_APP_ID = "demo_matching";

/**
 * アプリ画面5枚。public/apps/<app_id>/app.json に {"screens": [{"src", "label_ja"}]} があればそちらを使う。
 * ラベルは設計 6-2 の画面構成。
 */
export const DEFAULT_SCREENS = [
  { src: "screens/01.png", label_ja: "はじめの画面" },
  { src: "screens/02.png", label_ja: "プロフィール作成" },
  { src: "screens/03.png", label_ja: "本人確認" },
  { src: "screens/04.png", label_ja: "近くのおすすめ" },
  { src: "screens/05.png", label_ja: "有料プラン" },
];

/** 一行の結論に使う指標（comparison.p_B_better のキー） */
export const HEADLINE_METRIC = "core_actions" as const;

/** 結果の数字カード3枚（totals のキー） */
export const CARD_METRICS = ["installs", "core_actions", "payers"] as const;

/** 指標の画面での呼び名（アプリに合わせた言い方。なければ lib/format.ts の名前） */
export const METRIC_NAMES: Record<string, string> = {
  installs: "インストール",
  core_actions: "初マッチ",
  payers: "課金者",
  signups: "登録",
  reached: "広告が届いた人",
  trials: "無料体験",
  active_end: "最終日に使っている人",
  revenue_jpy: "売上",
};

/** 公開リポジトリ（DATA_SOURCES などへのリンク）。空なら画面内の全文表示だけ */
export const REPO_URL = "";

/** バックテストの結果ファイル（public からの相対パス） */
export const BACKTEST_PATH = "backtest.json";

/** 「はっきりしない」とみなす B案が良い確率の範囲（この間なら勝ち負けを言わない） */
export const UNCLEAR_RANGE: [number, number] = [0.4, 0.6];

/** 動画の案（plans.X.config.organic_video）のそばに出す注記 */
export const ORGANIC_VIDEO_NOTE_JA =
  "動画の案は、ルールを固定した後に追加した機能で、バックテストでは検証していません。値の多くは仮定です。外部の成功例を比例換算した目安より、再生数が多めに出ています。";

/** backtest.json に findings_ja がないときに出す考察の要点（backtest/report.md「結果の読み方」から） */
export const BACKTEST_FINDINGS_FALLBACK_JA = [
  "テプリは17問中15問で「減る」と答えました。運営中のサービスでは、既存の利用者が離れる分を大きく見積もる偏りがありました。",
  "今の版は、運営中のサービスの値上げや広告の増減の方向を当てる道具としては、まだ信頼できません。新しく発売する場面（デモの使い方）はこの点検の対象外です。",
];
