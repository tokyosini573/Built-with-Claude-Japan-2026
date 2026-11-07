// 検証（白黒）: 1段目 = 「17問中◯問的中」と基準との比較（点の図）、順番の図、偏りの一言。
// 2段目 = 事例カード。3段目 = 対照実験（折りたたみ。目立たせない）。
// 細かい定義・確率のずれ・コミットの番号は「?」の中に置く。

import { useEffect, useRef, useState } from "react";
import { REPO_URL } from "../config";
import { Mascot } from "../components/Mascot";
import { InfoTip } from "../components/HeroDots";
import { judge, loadBacktest, summarize, type Backtest, type BacktestCase } from "../lib/backtest";
import "./verify.css";

// 基準の短い名前（長い定義は「?」に出す）
const BASELINE_SHORT: Record<string, string> = {
  always_up: "いつも増える",
  naive: "素朴な予想",
};

// 正解を後から入れたことを示すコミットの順番（backtest/ の履歴）
const ORDER: { label: string; commit: string }[] = [
  { label: "ルールを固定", commit: "12d263a" },
  { label: "事例を入力", commit: "4567f94" },
  { label: "予測", commit: "5286315" },
  { label: "正解を追加", commit: "64f24e0" },
  { label: "採点", commit: "8a7521e" },
];

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
  const saidDown = answered.filter((q) => !q.predicted).length;
  const rows = [
    { id: "teppuri", short: "テプリ", long: null as string | null, hits: s.hits, brier: s.brier, me: true },
    ...bt.baselines.map((b) => ({ id: b.id, short: BASELINE_SHORT[b.id] ?? b.name_ja, long: b.name_ja, hits: b.hits, brier: b.brier ?? null, me: false })),
  ];
  const lost = bt.baselines.length > 0 && s.hits <= Math.max(...bt.baselines.map((b) => b.hits));
  const hasRecognized = bt.cases.some((c) => c.recognized);

  return (
    <div className="mono vf" style={{ display: "grid", gap: 64 }}>
      {bt.is_mock && (
        <p className="mock-note" style={{ borderRadius: 12 }}>
          {bt.note_ja ?? "モックの結果です。本物のバックテストではありません。"}
        </p>
      )}

      <section className="section" aria-labelledby="score-h">
        <p className="eyebrow">実在のアプリの過去で試す</p>
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

        <div className="vf-dots" role="list" aria-label="当てた問題の数">
          {rows.map((r) => (
            <div key={r.id} role="listitem" className={`vf-dots-row${r.me ? " me" : ""}`}>
              <span className="vf-dots-name">
                {r.me ? r.short : `基準「${r.short}」`}
                {r.long && <InfoTip label={`基準「${r.short}」とは`}>{r.long}。テプリが単純な答え方より当たるかを見るための比較です。</InfoTip>}
              </span>
              <span className="vf-dots-dots" aria-hidden>
                {Array.from({ length: s.answered }, (_, i) => (
                  <span key={i} className={`vf-dot${i < Math.floor(r.hits) ? " on" : i < r.hits ? " half" : ""}`} />
                ))}
              </span>
              <span className="vf-dots-num num">{r.hits}問</span>
            </div>
          ))}
        </div>

        <p className="lead">
          過去に条件を変えた日本のアプリで、正解を入れる前に予測を記録し、あとから実際と比べました。
          {s.answered < s.total && ` 残り${s.total - s.answered}問は答え合わせ待ちです。`}
        </p>

        {!bt.is_mock && answered.length > 0 && (
          <p className="vf-honest">
            テプリは{answered.length}問中{saidDown}
            問で「減る」と答えました。運営中のサービスの予測には、まだ信頼できません。新しく発売する場面はこの点検の対象外です。
          </p>
        )}

        <div className="vf-order" aria-label="答え合わせの順番">
          <p className="vf-order-title">
            順番を守りました
            <InfoTip label="コミットの番号">
              それぞれ別のコミットで記録しました。
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
          <ol className="vf-steps">
            {ORDER.map((o, i) => (
              <li key={o.commit} className={o.label === "正解を追加" ? "key" : undefined}>
                <span className="vf-step-n">{i + 1}</span>
                <span>{o.label}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="note">
          {s.answered}問は方法の点検で、精度の測定ではありません。外れた問題も全部出しています。
          {rows.some((r) => r.brier !== null) && (
            <InfoTip label="確率のずれ">
              確率のずれ（ブライアスコア。予測の確率と実際の差。0に近いほど良い）:
              {rows
                .filter((r) => r.brier !== null)
                .map((r) => (
                  <span key={r.id} style={{ display: "block" }}>
                    {r.short} {r.brier!.toFixed(2)}
                  </span>
                ))}
            </InfoTip>
          )}
        </p>
      </section>

      <section className="section" aria-labelledby="cases-h">
        <div style={{ display: "grid", gap: 6 }}>
          <h2 className="h2" id="cases-h">
            事例
          </h2>
          <p className="note">アプリの名前は伏せています。カードを押すと質問ごとの結果が出ます。</p>
          {hasRecognized && (
            <p className="note">
              <span className="vf-badge">記憶の可能性</span> 予測のあとで聞くと、Claude がアプリを言い当てた事例です。結果を覚えていた可能性があります。
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
        </div>
        <button type="button" className="close" onClick={onClose}>
          閉じる
        </button>
      </div>
      <ol className="qlist">
        {c.questions.map(judge).map((q) => (
          <li key={q.q_id} className="qitem">
            <p style={{ fontWeight: 700 }}>{q.q_ja}</p>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "center" }}>
              <div className="prob" role="img" aria-label={`「はい」の確率 ${Math.round(q.p_yes * 100)}%`}>
                <span className="fill" style={{ width: `${q.p_yes * 100}%` }} />
                <span className="mid" />
              </div>
              <span className="num" style={{ minWidth: "8.5em", textAlign: "right" }}>
                「はい」{Math.round(q.p_yes * 100)}%
              </span>
            </div>
            <p>
              予測 <strong>{q.predicted ? "はい" : "いいえ"}</strong> ／ 実際{" "}
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
        ))}
      </ol>
    </div>
  );
}

// ---- 補足: 対照実験（runs/controls/compare_controls.json の A案、v1 と同じ乱数の30回の「回ごとの差」の中央値。日本全体の人数） ----

const CONTROL_COLS = ["名札なし改善版", "見た目だけ", "わざと悪く"] as const;
const CONTROL_ROWS: { label: string; v1: number; diffs: [number, number, number] }[] = [
  { label: "設置", v1: 6091, diffs: [213, 198, -652] },
  { label: "登録", v1: 2862, diffs: [414, 82, -648] },
  { label: "初めてのマッチ", v1: 129, diffs: [47, 8, -53] },
  { label: "決済者", v1: 40, diffs: [25, 2, -20] },
];
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toLocaleString("ja-JP")}`;

function ControlExperiment() {
  return (
    <details className="fold vf-control">
      <summary>補足: テプリの判断は、見た目だけの変更に反応するか（対照実験）</summary>
      <div className="vf-control-body">
        <p>
          デモアプリ「ちかくに」で、v1 の離脱理由をもとに直した版（実験用）を試すと、数字は上がりました。ただ、離脱理由を出したのも、直したのも、判断したのも
          Claude です。判断のときにはアプリの ID に「v2」という名前も見えていました。そこで、本当に中身を見分けているかを確かめました。
        </p>

        <div className="vf-variants">
          <div>
            <strong>名札なし改善版</strong>
            <span>直した版から、名前だけ外したもの</span>
          </div>
          <div>
            <strong>見た目だけ</strong>
            <span>色・書体・イラスト・言い換えなど、見た目だけを変えたもの。価格や手順は v1 のまま</span>
          </div>
          <div>
            <strong>わざと悪く</strong>
            <span>入力項目を増やし、月額と審査時間を上げたもの</span>
          </div>
        </div>
        <p className="note">3つとも ID は無作為で、入力は判断の前にコミットしました（b4ada89）。</p>

        <div className="table-wrap">
          <table className="vf-ctable">
            <caption>A案。v1 からの差（日本全体の人数）</caption>
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col" className="num">
                  v1
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
          <li>名前の影響はほぼありませんでした。</li>
          <li>わざと悪くした版は、30回すべてで、すべての段階が下がりました。</li>
          <li>見た目だけの版でも、設置は +198 で、本物の改善（+213）とほぼ同じだけ増えました。</li>
          <li>登録より後の段階では見分けられました（決済者 +2 と +25）。</li>
        </ul>
        <p className="vf-conclusion">設置数が増えただけでは、改善の根拠になりません。</p>
        <p className="note">限界: 判断も変更づくりも同じ系統のモデル（Claude）です。本物の利用者では確かめていません。</p>
        <p className="note">
          数字: <code>runs/controls/compare_controls.json</code>（v1 と同じ乱数で30回ずつ回し、回ごとの差の中央値）。
          {REPO_URL && (
            <>
              {" "}
              <a href={`${REPO_URL}/blob/main/runs/controls/compare_controls.json`} target="_blank" rel="noreferrer">
                GitHub で見る
              </a>
            </>
          )}
        </p>
      </div>
    </details>
  );
}

/** 基準との比べ方を1行で（勝てなかったときもそのまま言う） */
function versus(hits: number, baselines: { hits: number }[]): string {
  const best = Math.max(...baselines.map((b) => b.hits));
  if (hits > best) return `単純な基準より ${hits - best}問 多く当てました。`;
  if (hits === best) return "単純な基準と同じ数で、基準に勝てませんでした。";
  return `単純な基準より ${best - hits}問 少なく、基準に勝てませんでした。`;
}
