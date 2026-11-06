// 根拠: 1段目 = 「1万人は何からできているか」の図。2段目 = 属性ごとの出典表。3段目 = 限界の全文と DATA_SOURCES。
// 限界と出典表記は data/ の文書をそのまま読み込んで出す（画面側で数字を書き写さない）。

import dataSources from "../../../data/DATA_SOURCES.md?raw";
import populationReadme from "../../../data/population/README.md?raw";
import { REPO_URL } from "../config";
import { Markdown, extractSection } from "../lib/markdown";
import { href } from "../lib/router";

// 図の中身は data/population/README.md の「作り方」「列と出典」と DATA_SOURCES.md 1章から
const LAYERS: { step: string; attrs: string[]; src: string }[] = [
  {
    step: "1. 骨格",
    attrs: ["都道府県", "性別", "年齢"],
    src: "令和7年国勢調査。47都道府県 × 男女 × 5歳階級の人口に比例して1万人を配る",
  },
  {
    step: "2. 暮らし",
    attrs: ["都市の大きさ", "結婚", "世帯", "仕事", "所得"],
    src: "国勢調査（2025・2020）、労働力調査 2025、就業構造基本調査 2022、国民生活基礎調査 2025",
  },
  {
    step: "3. スマホと SNS",
    attrs: ["スマホ", "iPhone / Android", "LINE", "X", "Instagram", "TikTok", "YouTube"],
    src: "通信利用動向調査 2025、情報通信メディアの利用時間調査（令和7年度）、モバイル社会研究所 2026",
  },
  {
    step: "4. 気質",
    attrs: ["節約志向", "新しいもの好き", "個人情報への不安", "口コミ重視", "広告への抵抗感"],
    src: "消費者意識基本調査（令和4・5・7年度）",
  },
];

const TABLE: [string, string, string, string][] = [
  ["都道府県・性別・年齢", "都道府県 × 性 × 5歳階級に、人口に比例して配る", "令和7年国勢調査 第2-3表", "2-1"],
  ["都市の大きさ", "都道府県 × 性 × 5歳階級", "令和7年国勢調査 第2-5表", "2-2"],
  ["結婚・世帯", "都道府県 × 性 × 5歳階級。2つを同時に決める", "令和7年国勢調査 第5表", "2-3"],
  ["仕事（6区分）", "都道府県 × 性 × 5歳階級", "労働力調査 2025年平均、令和2年国勢調査", "2-4"],
  ["所得", "仕事の収入と年金を足す", "令和4年就業構造基本調査、2025年国民生活基礎調査", "2-5"],
  ["スマホを持っているか", "性 × 年齢", "令和7年通信利用動向調査 第24表", "2-6"],
  ["iPhone / Android", "スマホを持つ人だけ。性 × 10歳階級", "モバイル社会研究所（2026年）", "2-7"],
  ["SNS（5種類）", "スマホを持つ人だけ。性 × 10歳階級", "情報通信メディアの利用時間調査 表5-1-1、モバイル社会白書2026", "2-8"],
  ["気質（5つ）", "性 × 10歳階級", "消費者意識基本調査（令和4・5・7年度）", "2-12"],
];

const popLimits = extractSection(populationReadme, "限界");
const dsLimits = extractSection(dataSources, "5. 限界");
const credit = extractSection(dataSources, "画面・README に載せる出典表記");

export function SourcesPage() {
  return (
    <>
      <section className="section" aria-labelledby="src-h">
        <div style={{ display: "grid", gap: 8 }}>
          <p className="eyebrow">根拠</p>
          <h1 className="h1" id="src-h">
            1万人は何からできているか
          </h1>
          <p className="lead">全員が架空の人です。政府の統計と公開調査の割合から、1人ずつ属性を引いて作りました。AI は人を作っていません。</p>
        </div>
        <div className="layers" role="list" aria-label="1万人の作り方">
          {LAYERS.map((l, i) => (
            <div key={l.step} role="listitem" style={{ display: "grid", gap: 12 }}>
              {i > 0 && (
                <div className="arrow" aria-hidden>
                  ↓
                </div>
              )}
              <div className="layer">
                <span className="step">{l.step}</span>
                <span className="attrs">
                  {l.attrs.map((a) => (
                    <span key={a}>{a}</span>
                  ))}
                </span>
                <span className="src">{l.src}</span>
              </div>
            </div>
          ))}
          <div className="arrow" aria-hidden>
            ↓
          </div>
          <div className="layer" style={{ background: "var(--fg)", color: "var(--bg)", borderColor: "var(--fg)" }}>
            <span className="step">架空の1万人</span>
            <span style={{ fontSize: 17 }}>1人が、実際の15〜79歳の約9,680人分を表します（2025年国勢調査の 96,806,585人 ÷ 1万）。</span>
          </div>
        </div>
        <p className="note">乱数の種は固定。同じコマンドで同じ1万人ができます。</p>
      </section>

      <section className="section" aria-labelledby="tbl-h">
        <h2 className="h2" id="tbl-h">
          属性ごとの出典
        </h2>
        <details className="fold">
          <summary>表を開く（9項目）</summary>
          <div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>属性</th>
                    <th>決め方</th>
                    <th>出典</th>
                    <th>DATA_SOURCES</th>
                  </tr>
                </thead>
                <tbody>
                  {TABLE.map(([a, how, src, sec]) => (
                    <tr key={a}>
                      <td style={{ fontWeight: 700 }}>{a}</td>
                      <td>{how}</td>
                      <td>{src}</td>
                      <td className="num">{sec}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      </section>

      <section className="section" aria-labelledby="lim-h">
        <div style={{ display: "grid", gap: 6 }}>
          <h2 className="h2" id="lim-h">
            限界
          </h2>
          <p className="note">分かっている弱点を、文書のまま全部載せています。</p>
        </div>
        <details className="fold">
          <summary>1万人の作り方の限界（{popLimits.split("\n").filter((l) => /^\d+\./.test(l)).length}項目）</summary>
          <div>
            <Markdown source={popLimits} idPrefix="pl" />
          </div>
        </details>
        <details className="fold">
          <summary>データと数値の限界（DATA_SOURCES 5章）</summary>
          <div>
            <Markdown source={dsLimits} idPrefix="dl" />
          </div>
        </details>
        <p>
          <a href={href("sources-full")}>DATA_SOURCES の全文を読む</a>
          {REPO_URL && (
            <>
              {" ／ "}
              <a href={`${REPO_URL}/blob/main/data/DATA_SOURCES.md`} target="_blank" rel="noreferrer">
                GitHub で見る
              </a>
            </>
          )}
        </p>
      </section>

      {credit && (
        <section className="section" aria-labelledby="credit-h">
          <h2 className="h3" id="credit-h">
            出典表記
          </h2>
          <div className="note">
            <Markdown source={credit} idPrefix="cr" />
          </div>
        </section>
      )}
    </>
  );
}

export function SourcesFullPage() {
  return (
    <section className="section">
      <p>
        <a href={href("sources")}>← 根拠に戻る</a>
      </p>
      <Markdown source={dataSources} idPrefix="ds" />
    </section>
  );
}
