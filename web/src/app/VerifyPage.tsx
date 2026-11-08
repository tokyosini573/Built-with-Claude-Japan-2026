// 検証（白黒）。トップで言ったこと（17問中◯問・正解は後から）はくり返さず、ここでしか分からないことを先に置く。
// 1段目 = 結論と、単純な答え方との比較（点の図）。2段目 = 外れ方（ほとんど「減る」と答えた）。
// 3段目 = 記録の順番。4段目 = 事例カード。5段目 = 対照実験（折りたたみ。目立たせない）。

import { useEffect, useRef, useState } from "react";
import { REPO_URL } from "../config";
import { Mascot } from "../components/Mascot";
import { InfoTip } from "../components/HeroDots";
import { judge, loadBacktest, summarize, type Backtest, type BacktestCase } from "../lib/backtest";
import "./verify.css";

// 単純な答え方の名前（そのまま読めるように、言いかえずに全部書く）
const BASELINE_NAME: Record<string, string> = {
  always_up: "いつも「増える」と答える",
  naive: "値上げ・広告を減らしたときだけ「減る」と答える",
};

// テプリの確率は、エンジンを30回まわして「はい」になった回の割合（backtest/README.md）
const RUNS = 30;

// 正解を後から入れたことを示すコミットの順番（backtest/ の履歴）
const ORDER: { label: string; commit: string }[] = [
  { label: "ルールを固定", commit: "12d263a" },
  { label: "事例を入力", commit: "4567f94" },
  { label: "予測", commit: "5286315" },
  { label: "正解を追加", commit: "64f24e0" },
  { label: "採点", commit: "8a7521e" },
];

const repoLink = (path: string) => (REPO_URL ? `${REPO_URL}/${path}` : null);

export function VerifyPage() {
  const [bt, setBt] = useState<Backtest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    loadBacktest(ac.signal)
      .then(setBt)
      .catch((e: Error) => e.name !== "AbortError" && setError(e.message));
    return () => ac.abort();
  }, []);

  if (error) return <p className="lead">{error}</p>;
  if (!bt) return <p className="muted">読み込んでいます…</p>;

  const s = summarize(bt);
  const openCase = bt.cases.find((c) => c.case_id === open) ?? null;
  const answered = bt.cases.flatMap((c) => c.questions.map(judge)).filter((q) => q.hit !== null);
  const saidNo = answered.filter((q) => !q.predicted).length;
  // 正解が「はい」の問題と「いいえ」の問題に分けて、それぞれ何問当てたか
  const split = [
    { key: "no", label: "正解が「いいえ」", qs: answered.filter((q) => q.answer === false) },
    { key: "yes", label: "正解が「はい」", qs: answered.filter((q) => q.answer === true) },
  ].map((g) => ({ ...g, n: g.qs.length, hits: g.qs.filter((q) => q.hit).length }));
  const rows = [
    { id: "teppuri", name: "テプリ", hits: s.hits, me: true },
    ...bt.baselines.map((b) => ({ id: b.id, name: BASELINE_NAME[b.id] ?? b.name_ja, hits: b.hits, me: false })),
  ];
  const lost = bt.baselines.length > 0 && s.hits <= Math.max(...bt.baselines.map((b) => b.hits));
  const hasRecognized = bt.cases.some((c) => c.recognized);
  const reportUrl = repoLink("blob/main/backtest/report.md");

  return (
    <div className="mono vf" style={{ display: "grid", gap: 72 }}>
      {bt.is_mock && (
        <p className="mock-note" style={{ borderRadius: 12 }}>
          {bt.note_ja ?? "モックの結果です。本物のバックテストではありません。"}
        </p>
      )}

      {/* 1. 結論 */}
      <section className="section" aria-labelledby="score-h">
        <p className="eyebrow">実在のサービスの過去で試した結果</p>
        <h1 className="score" id="score-h">
          {s.answered}問中 <span className="num">{s.hits}</span>問 的中
        </h1>
        {bt.baselines.length > 0 &&
          (lost ? (
            <div className="with-mascot verify-oops">
              <p className="claim-sub">
                {/* マスコットの横で幅が狭くなるので、「、」の後で区切って語の途中で折り返さないようにする */}
                {versus(s.hits, bt.baselines)
                  .split(/(?<=、)/)
                  .map((c) => (
                    <span key={c} className="ib">
                      {c}
                    </span>
                  ))}
              </p>
              <Mascot pose="oops" />
            </div>
          ) : (
            <p className="claim-sub">{versus(s.hits, bt.baselines)}</p>
          ))}

        <p className="lead">
          名前を伏せた実在の日本のサービス{bt.cases.length}つで、値上げや広告費の増減のあと、売上や会員数が前より多いかを「はい・いいえ」で予測しました。
        </p>

        <div className="vf-dots" role="list" aria-label="当てた問題の数（点1つ＝1問）">
          {rows.map((r) => (
            <div key={r.id} role="listitem" className={`vf-dots-row${r.me ? " me" : ""}`}>
              <span className="vf-dots-name">{r.name}</span>
              <span className="vf-dots-num num">{r.hits}問</span>
              <span className="vf-dots-dots" aria-hidden>
                {Array.from({ length: s.answered }, (_, i) => (
                  <span key={i} className={`vf-dot${i < Math.floor(r.hits) ? " on" : i < r.hits ? " half" : ""}`} />
                ))}
              </span>
            </div>
          ))}
        </div>

        <p className="note">
          黒い点が当たった問題です。問題が{s.answered}問と少ないので、方法の点検であって、精度の測定ではありません。
          {s.answered < s.total && ` 残り${s.total - s.answered}問は答え合わせ待ちです。`}
        </p>
      </section>

      {/* 2. 外れ方 */}
      {!bt.is_mock && answered.length > 0 && (
        <section className="section" aria-labelledby="bias-h">
          <h2 className="h2" id="bias-h">
            ほとんど「いいえ」と答えていました
          </h2>
          <p className="lead">
            テプリは{answered.length}問中{saidNo}問で「いいえ（前より減る）」と答えました。そのため、正解が「いいえ」の問題はよく当たり、「はい」の問題はほとんど外れました。
          </p>

          <div className="vf-dots" role="list" aria-label="正解ごとに分けた的中数">
            {split.map((g) => (
              <div key={g.key} role="listitem" className="vf-dots-row me">
                <span className="vf-dots-name">
                  {g.label}の{g.n}問
                </span>
                <span className="vf-dots-num num">
                  {g.hits}問 的中
                </span>
                <span className="vf-dots-dots" aria-hidden>
                  {Array.from({ length: g.n }, (_, i) => (
                    <span key={i} className={`vf-dot${i < g.hits ? " on" : ""}`} />
                  ))}
                </span>
              </div>
            ))}
          </div>

          <p className="vf-honest">
            今のテプリは、すでに運営しているサービスの予測には、まだ使えません。デモのような新しいアプリの発売は、この点検の対象外です。
          </p>
          <p className="note">
            結果を見てからルールを直すと検証にならないので、直さずに公開しています。
            {reportUrl && (
              <>
                {" "}
                <a href={reportUrl} target="_blank" rel="noreferrer">
                  考えられる原因（GitHub）
                </a>
              </>
            )}
          </p>
        </section>
      )}

      {/* 3. 記録の順番 */}
      <section className="section" aria-labelledby="order-h">
        <h2 className="h2" id="order-h">
          正解は、予測を記録したあとで入れました
        </h2>
        <ol className="vf-steps" aria-label="記録の順番">
          {ORDER.map((o, i) => (
            <li key={o.commit} className={o.label === "正解を追加" ? "key" : undefined}>
              <span className="vf-step-n">{i + 1}</span>
              <span>{o.label}</span>
            </li>
          ))}
        </ol>
        <p className="note vf-inline">
          5つは別々に GitHub に記録してあり、日時と中身をあとから確かめられます。
          <InfoTip label="GitHub の記録">
            {ORDER.map((o, i) => (
              <span key={o.commit} style={{ display: "block" }}>
                {"①②③④⑤"[i]} {o.label}:{" "}
                {REPO_URL ? (
                  <a href={`${REPO_URL}/commit/${o.commit}`} target="_blank" rel="noreferrer" className="num">
                    {o.commit}
                  </a>
                ) : (
                  <span className="num">{o.commit}</span>
                )}
              </span>
            ))}
          </InfoTip>
        </p>
      </section>

      {/* 4. 事例 */}
      <section className="section" aria-labelledby="cases-h">
        <div style={{ display: "grid", gap: 6 }}>
          <h2 className="h2" id="cases-h">
            {bt.cases.length}つの事例
          </h2>
          <p className="note">サービスの名前は伏せています。カードを押すと、質問と答えが見られます。</p>
          {hasRecognized && (
            <p className="note">
              <span className="vf-badge">記憶の可能性</span> 予測のあとで尋ねると、Claude が説明だけでサービス名を言い当てた事例です。実際の結果を覚えていた可能性があります。
            </p>
          )}
        </div>
        <div className="cards3">
          {bt.cases.map((c) => {
            const qs = c.questions.map(judge).filter((q) => q.hit !== null);
            const hits = qs.filter((q) => q.hit).length;
            return (
              <button
                key={c.case_id}
                type="button"
                className="card vf-card"
                aria-expanded={open === c.case_id}
                onClick={() => setOpen(open === c.case_id ? null : c.case_id)}
              >
                <span className="vf-card-title">{c.title_ja}</span>
                <span className="vf-card-score">
                  <span className="vf-mini" aria-hidden>
                    {qs.map((q) => (
                      <span key={q.q_id} className={`vf-dot${q.hit ? " on" : ""}`} />
                    ))}
                  </span>
                  <span className="num">
                    {qs.length}問中 {hits}問 的中
                  </span>
                </span>
                {c.recognized && <span className="vf-badge">記憶の可能性</span>}
                <span className="more">{open === c.case_id ? "閉じる ▲" : "質問を見る ▼"}</span>
              </button>
            );
          })}
        </div>
        {openCase && <CaseDetail c={openCase} onClose={() => setOpen(null)} />}
      </section>

      <ControlExperiment />
    </div>
  );
}

function CaseDetail({ c, onClose }: { c: BacktestCase; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    ref.current?.focus({ preventScroll: true });
  }, [c.case_id]);
  return (
    <div className="detail" ref={ref} tabIndex={-1} aria-label={c.title_ja}>
      <div className="detail-head">
        <div style={{ display: "grid", gap: 6 }}>
          <h3 className="h2">{c.title_ja}</h3>
          <p className="note">{c.description_ja}</p>
          <p className="note">テプリはエンジンを{RUNS}回まわし、半分より多い回で「はい」なら「はい」と答えたとみなします。</p>
        </div>
        <button type="button" className="close" onClick={onClose}>
          閉じる
        </button>
      </div>
      <ol className="qlist">
        {c.questions.map(judge).map((q) => {
          const yes = Math.round(q.p_yes * RUNS);
          return (
            <li key={q.q_id} className="qitem">
              <p style={{ fontWeight: 700 }}>{q.q_ja}</p>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center" }}>
                <div className="prob" role="img" aria-label={`${RUNS}回中${yes}回が「はい」`}>
                  <span className="fill" style={{ width: `${q.p_yes * 100}%` }} />
                  <span className="mid" />
                </div>
                <span className="num" style={{ minWidth: "9em", textAlign: "right" }}>
                  {RUNS}回中{yes}回「はい」
                </span>
              </div>
              <p>
                テプリ <strong>{q.predicted ? "はい" : "いいえ"}</strong> ／ 正解{" "}
                <strong>{q.answer === null ? "答え合わせ待ち" : q.answer ? "はい" : "いいえ"}</strong>
                {q.hit !== null && (
                  <span className="mark" style={{ marginLeft: 12 }} aria-label={q.hit ? "的中" : "外れ"}>
                    {q.hit ? "○ 的中" : "× 外れ"}
                  </span>
                )}
              </p>
              {q.source_ja && (
                <p className="note">
                  出典:{" "}
                  {q.source_url ? (
                    <a href={q.source_url} target="_blank" rel="noreferrer">
                      {q.source_ja}
                    </a>
                  ) : (
                    q.source_ja
                  )}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---- 補足: 対照実験（runs/controls/compare_controls.json の A案。v1 と同じ乱数の30回の「回ごとの差」の中央値。日本全体の人数） ----
// 画面では v1 =「結果画面の A案」と呼ぶ（初マッチ 129人は結果画面の A案と同じ）。

const CONTROL_COLS = ["名前を外した改善版", "見た目だけ変えた版", "わざと悪くした版"] as const;
const CONTROL_ROWS: { label: string; v1: number; diffs: [number, number, number] }[] = [
  { label: "インストール", v1: 6091, diffs: [213, 198, -652] },
  { label: "登録", v1: 2862, diffs: [414, 82, -648] },
  { label: "初マッチ", v1: 129, diffs: [47, 8, -53] },
  { label: "課金者", v1: 40, diffs: [25, 2, -20] },
];
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toLocaleString("ja-JP")}`;

function ControlExperiment() {
  const dataUrl = repoLink("blob/main/runs/controls/compare_controls.json");
  return (
    <details className="fold vf-control">
      <summary>補足: テプリは、見た目だけの変更にもだまされるか（対照実験）</summary>
      <div className="vf-control-body">
        <p className="vf-conclusion">インストール数が増えただけでは、改善の根拠になりません。</p>
        <p>
          見た目だけ変えた版でも、インストールは本物の改善版とほぼ同じだけ増えました（+198 と +213）。課金者まで見ると、見分けられました（+2 と +25）。
        </p>

        <p>
          なぜ確かめたか: デモアプリ「ちかくに」を、結果画面の「離れた理由」をもとに直すと、数字は上がりました。ただ、離れた理由を出したのも、直したのも、判断したのも Claude です。判断する
          Claude には、直した版だと分かる名前も見えていました。そこで、次の3つの版で、本当に中身を見分けているかを試しました。
        </p>

        <div className="vf-variants">
          <div>
            <strong>{CONTROL_COLS[0]}</strong>
            <span>直した版と中身は同じで、名前だけを意味のない記号にしたもの</span>
          </div>
          <div>
            <strong>{CONTROL_COLS[1]}</strong>
            <span>色・書体・イラスト・言い回しなど、見た目だけを変えたもの。価格や手順は元のまま</span>
          </div>
          <div>
            <strong>{CONTROL_COLS[2]}</strong>
            <span>入力項目を増やし、月額を上げ、審査時間を延ばしたもの</span>
          </div>
        </div>

        <div className="table-wrap">
          <table className="vf-ctable">
            <caption>結果画面の A案と比べて、何人増えたか・減ったか（日本全体の人数）</caption>
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col" className="num">
                  A案（元の版）
                </th>
                {CONTROL_COLS.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CONTROL_ROWS.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  <td className="num vf-muted">{r.v1.toLocaleString("ja-JP")}</td>
                  {r.diffs.map((d, i) => (
                    <td key={i} className={`num${d < 0 ? " neg" : ""}`}>
                      {signed(d)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="vf-findings">
          <li>名前を外しても、改善版の伸びはほぼ変わりませんでした。</li>
          <li>わざと悪くした版は、30回すべてで、すべての段階が下がりました。</li>
        </ul>
        <p className="note">
          数字の出し方: 結果画面と同じ30回（同じ偶然の流れ）で3つの版も回し、回ごとの差を小さい順に並べたときの真ん中の値です。3つの版は、判断の前に GitHub に記録しました。
          {dataUrl && (
            <>
              {" "}
              <a href={dataUrl} target="_blank" rel="noreferrer">
                数字を GitHub で見る
              </a>
            </>
          )}
        </p>
        <p className="note">限界: 判断したのも、変更案を作ったのも、同じ系統のモデル（Claude）です。本物の利用者では確かめていません。</p>
      </div>
    </details>
  );
}

/** 単純な答え方との比べ方を1行で（勝てなかったときもそのまま言う） */
function versus(hits: number, baselines: { hits: number }[]): string {
  const best = Math.max(...baselines.map((b) => b.hits));
  if (hits > best) return `単純な答え方より ${hits - best}問 多く当てました。`;
  if (hits === best) return "単純な答え方と同じ数で、勝てませんでした。";
  return `単純な答え方より ${best - hits}問 少なく、勝てませんでした。`;
}
