// 検証（白黒）: 1段目 = 「17問中◯問的中」と比較の基準。2段目 = 事例カード。3段目 = 質問ごとの予測確率と実際、出典。

import { useEffect, useRef, useState } from "react";
import { BACKTEST_FINDINGS_FALLBACK_JA } from "../config";
import { judge, loadBacktest, summarize, type Backtest, type BacktestCase } from "../lib/backtest";

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
  const findings = bt.findings_ja ?? (bt.is_mock ? [] : BACKTEST_FINDINGS_FALLBACK_JA);
  const rows = [{ id: "teppuri", name_ja: "テプリ", hits: s.hits, me: true }, ...bt.baselines.map((b) => ({ ...b, me: false }))];

  return (
    <div className="mono" style={{ display: "grid", gap: 64 }}>
      {bt.is_mock && <p className="mock-note" style={{ borderRadius: 12 }}>{bt.note_ja ?? "モックの結果です。本物のバックテストではありません。"}</p>}
      <section className="section" aria-labelledby="score-h">
        <p className="eyebrow">実在のアプリの過去で試す</p>
        <h1 className="score" id="score-h">
          {s.answered}問中 <span className="num">{s.hits}</span>問 的中
        </h1>
        {rows.length > 1 && <p className="claim-sub">{versus(s.hits, bt.baselines)}</p>}
        <p className="lead">
          過去に条件を変えた日本のアプリについて、結果を知らない状態で「はい／いいえ」を予測し、あとから実際と比べました。
          {s.answered < s.total && ` 残り${s.total - s.answered}問は答え合わせ待ちです。`}
        </p>
        <div className="cmp" aria-label="比較の基準">
          {rows.map((r) => (
            <div key={r.id} className={`cmp-row${r.me ? " me" : ""}`}>
              <span>{r.name_ja}</span>
              <span className="track">
                <span className="fill" style={{ display: "block", width: `${s.answered ? (r.hits / s.answered) * 100 : 0}%` }} />
              </span>
              <span className="num" style={{ textAlign: "right" }}>
                {r.hits}問
              </span>
            </div>
          ))}
        </div>
        {findings.length > 0 && (
          <ul className="findings">
            {findings.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        <p className="note">
          {s.answered}問は方法の点検で、精度の測定ではありません。外れた問題も含めて全部出しています。
          {s.brier !== null && ` 確率のずれ（0に近いほど良い）: テプリ ${s.brier.toFixed(2)}`}
          {bt.baselines.filter((b) => b.brier !== undefined).map((b) => ` ／ ${b.name_ja} ${b.brier!.toFixed(2)}`)}
        </p>
      </section>

      <section className="section" aria-labelledby="cases-h">
        <div style={{ display: "grid", gap: 6 }}>
          <h2 className="h2" id="cases-h">
            事例
          </h2>
          <p className="note">アプリの名前は伏せています。カードを押すと質問ごとの結果が出ます。</p>
        </div>
        <div className="cards3">
          {bt.cases.map((c) => {
            const qs = c.questions.map(judge);
            const ans = qs.filter((q) => q.hit !== null);
            return (
              <button key={c.case_id} type="button" className="card" aria-expanded={open === c.case_id} onClick={() => setOpen(open === c.case_id ? null : c.case_id)}>
                <span className="h3" style={{ fontFamily: "var(--display)" }}>
                  {c.title_ja}
                </span>
                <span className="clamp3" style={{ fontSize: 16, color: "var(--text-secondary)" }}>{c.description_ja}</span>
                <span style={{ fontSize: 18, fontWeight: 700 }} className="num">
                  {ans.length}問中 {ans.filter((q) => q.hit).length}問 的中
                </span>
                {c.recognized && <span className="note">※ Claude がアプリを言い当てた事例（記憶の可能性あり）</span>}
                <span className="more">{open === c.case_id ? "閉じる ▲" : "質問を見る ▼"}</span>
              </button>
            );
          })}
        </div>
        {openCase && <CaseDetail c={openCase} onClose={() => setOpen(null)} />}
      </section>
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
              予測 <strong>{q.predicted ? "はい" : "いいえ"}</strong> ／ 実際 <strong>{q.answer === null ? "答え合わせ待ち" : q.answer ? "はい" : "いいえ"}</strong>
              {q.hit !== null && (
                <span className="mark" style={{ marginLeft: 12 }} aria-label={q.hit ? "的中" : "外れ"}>
                  {q.hit ? "○ 的中" : "× 外れ"}
                </span>
              )}
            </p>
            {q.source_ja && (
              <p className="note">
                出典: {q.source_url ? <a href={q.source_url} target="_blank" rel="noreferrer">{q.source_ja}</a> : q.source_ja}
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 基準との比べ方を1行で（勝てなかったときもそのまま言う） */
function versus(hits: number, baselines: { hits: number }[]): string {
  const best = Math.max(...baselines.map((b) => b.hits));
  if (hits > best) return `単純な基準より ${hits - best}問 多く当てました。`;
  if (hits === best) return "単純な基準と同じ数で、基準に勝てませんでした。";
  return `単純な基準より ${best - hits}問 少なく、基準に勝てませんでした。`;
}
