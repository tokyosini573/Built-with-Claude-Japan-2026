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
