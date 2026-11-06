# 出典とライセンス（web/）

## 都道府県の境界 `public/geo/japan-prefectures.json`

- **原典:** 国土交通省「国土数値情報（行政区域データ N03）」令和3年（2021年1月1日時点）
  - https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-v3_0.html
  - 使用許諾条件: 平成30年度以降のデータは「オープンデータ」（国土数値情報ダウンロードサイトの利用規約。現在は公共データ利用規約 第1.0版（PDL1.0）を適用。CC BY 4.0 と互換）
  - 利用規約: https://nlftp.mlit.go.jp/ksj/other/agreement.html
  - 原典の注記: 国土地理院「数値地図（国土基本情報）」の行政区画データから整備（測量法に基づく国土地理院長承認（複製）R2JHf 450）
- **中間データ:** スマートニュース メディア研究所「japan-topography」の `data/municipality/topojson/s0010/prefectures.json`（簡素化1%）
  - https://github.com/smartnews-smri/japan-topography （コミット `b403e71eb97f1fdf32f63d16bd485129f703855e`）
  - README の「クレジット」: 商用・非商用にかかわらず無償で利用可。加工者（スマートニュース）のクレジットは不要。ただし市区町村データは国土交通省の指示するクレジット記載が必要。
- **テプリでの加工:** `scripts/build-japan-map.mjs` で、線をさらに間引き（Douglas-Peucker、許容誤差0.006度）、小さな島・小笠原諸島・大東諸島を省略、座標を小数3桁に丸めた。画面では沖縄県を左上に移して表示する。

**画面に出す出典表記（PDL1.0 の記載例に合わせる）:**

> 「国土数値情報（行政区域データ）」（国土交通省）（https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N03-v3_0.html）をもとにテプリ作成（簡素化・一部の島を省略）

※ 加工したデータを、国が作成したかのように見せてはいけない（PDL1.0）。

## フォント

- Noto Sans JP（Google Fonts から読み込み。SIL Open Font License 1.1）。リポジトリにはフォントファイルを入れていない。

## ライブラリ

- React / React DOM（MIT）、Vite・@vitejs/plugin-react（MIT）、TypeScript（Apache-2.0）。グラフと地図は自前のコードで描く。
