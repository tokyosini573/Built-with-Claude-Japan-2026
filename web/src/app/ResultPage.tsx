// 結果: 何を比べたか＋結論（トップと同じ言い方）→ 幅の図 → どこで減ったか → 離れた理由と次に試すこと → 地図で見る。
// 数字はすべて日本全体（1万人の数に scale_to_japan を掛けたもの）。細かい説明は「?」の吹き出しと折りたたみに入れる。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InfoTip } from "../components/HeroDots";
import { JapanMap } from "../components/JapanMap";
import { Mascot } from "../components/Mascot";
import { Timeline, usePlayback } from "../components/Timeline";
import { HEADLINE_METRIC, ORGANIC_VIDEO_NOTE_JA, UNCLEAR_RANGE } from "../config";
import { formatCount, scaleFactor, type Scale } from "../lib/format";
import { metricName, stepName } from "../lib/labels";
import { href } from "../lib/router";
import { planIds, type DropTheme, type PlanId, type Replay, type TotalKey } from "../lib/replay";
import { PersonState, statesOnDay } from "../lib/states";
import { useStateTimeline } from "../lib/useReplay";
import { Trend, VideoBlock, funnelKeys } from "./MetricDetail";
import { PersonPanel } from "./PersonPanel";
import { planSummary } from "./TopPage";
import { PLAN_VAR, count, people, periodText } from "./ui";
import "./result.css";

interface Props {
  replay: Replay;
  /** 結果のページは日本全体の数だけを出す（切り替えはなくした）。呼び出し側の互換のために残す */
  scale?: Scale;
  onScale?: (s: Scale) => void;
  autoplay: boolean;
  onAutoplayDone: () => void;
}

const SCALE: Scale = "japan";

export function ResultPage({ replay, autoplay, onAutoplayDone }: Props) {
  const [picked, setPicked] = useState<{ row: number; plan: PlanId } | null>(null);
  return (
    <>
      <Verdict replay={replay} />
      <FunnelSection replay={replay} />
      <ReasonsAndNext replay={replay} />
      <Player replay={replay} autoplay={autoplay} onAutoplayDone={onAutoplayDone} picked={picked} onPick={setPicked} />
    </>
  );
}

// ---- 何を比べたか＋結論 ----

/** 安いほうが何分の1か（2倍以上違うときだけ） */
function cheaperPlan(replay: Replay): { id: PlanId; ratio: number } | null {
  const a = replay.plans.A?.totals.cpi_jpy?.p50;
  const b = replay.plans.B?.totals.cpi_jpy?.p50;
  if (!a || !b) return null;
  const ratio = Math.round(Math.max(a, b) / Math.min(a, b));
  return ratio >= 2 ? { id: a < b ? "A" : "B", ratio } : null;
}

function Verdict({ replay }: { replay: Replay }) {
  const p = replay.comparison?.p_B_better[HEADLINE_METRIC];
  const name = metricName(HEADLINE_METRIC, replay);
  const runs = replay.meta.runs;
  const ids = planIds(replay);
  const cheap = cheaperPlan(replay);
  const unclear = p !== undefined && p > UNCLEAR_RANGE[0] && p < UNCLEAR_RANGE[1];
  return (
    <section className="verdict r-verdict" aria-labelledby="verdict-h">
      <p className="r-context">
        架空のマッチングアプリ「{replay.meta.name_ja}」を、
        {ids.map((id, i) => {
          const s = planSummary(replay, id);
          return (
            <span key={id}>
              {i > 0 && "と"}
              <b style={{ color: PLAN_VAR[id] }}>
                {id}案（{s.title}
                {s.cost ? `・${s.cost.replace(/^(広告費|制作費) /, "")}` : ""}）
              </b>
            </span>
          );
        })}
        で{periodText(replay)}ずつ発売。同じ条件で{runs}回くり返した結果です。
      </p>
      <div className="with-mascot">
        <h1 className="claim" id="verdict-h">
          {p === undefined ? (
            "A案と B案の結果"
          ) : unclear ? (
            <>
              <span className="ib">{name}の数は、</span>
              <span className="ib">引き分け。</span>
            </>
          ) : (
            <>
              <span className="ib">{name}は、</span>
              <span className="ib">
                {p >= UNCLEAR_RANGE[1] ? "B" : "A"}案のほうが多い確率 <span className="num">{Math.round((p >= UNCLEAR_RANGE[1] ? p : 1 - p) * 100)}%。</span>
              </span>
            </>
          )}
          {cheap && (
            <span className="claim-2">
              <span className="ib">1インストールあたりの</span>
              <span className="ib">費用は、</span>
              <span className="ib">
                {cheap.id}案が約{cheap.ratio}分の1。
              </span>
            </span>
          )}
        </h1>
        <Mascot pose="inspect" />
      </div>
      {name === "初マッチ" && <p className="r-sub">初マッチ＝アプリで、はじめて相手とマッチした人。</p>}
      {hasRuns(replay, HEADLINE_METRIC) ? <RunsChart replay={replay} metric={HEADLINE_METRIC} /> : <RangeChart replay={replay} metric={HEADLINE_METRIC} />}
      <CostRow replay={replay} />
    </section>
  );
}

function hasRuns(replay: Replay, metric: string): boolean {
  return planIds(replay).length === 2 && planIds(replay).every((id) => (replay.plans[id]!.per_run?.[metric]?.length ?? 0) > 0);
}

/** 30回の試しを1回ずつ見せる。上: 回ごとにどちらが多かったか（勝ち負けのマス）。下: 回ごとの人数（点1つ = 1回） */
function RunsChart({ replay, metric }: { replay: Replay; metric: TotalKey }) {
  const ids = planIds(replay);
  const k = replay.meta.scale_to_japan;
  const a = replay.plans.A!.per_run![metric]!.map((v) => v * k);
  const b = replay.plans.B!.per_run![metric]!.map((v) => v * k);
  const n = Math.min(a.length, b.length);
  const name = metricName(metric, replay);
  // エンジンの比較（comparison.p_B_better）と同じく、丸める前の値で比べる
  const win = Array.from({ length: n }, (_, i) => (b[i] > a[i] ? "B" : a[i] > b[i] ? "A" : "="));
  // 丸めると同じ数に見える回だけ、小数1桁まで出す
  const pair = (i: number) =>
    Math.round(a[i]) === Math.round(b[i]) && a[i] !== b[i]
      ? `A案 ${a[i].toFixed(1)}人・B案 ${b[i].toFixed(1)}人`
      : `A案 ${count(a[i])}人・B案 ${count(b[i])}人`;
  const nA = win.filter((w) => w === "A").length;
  const nB = win.filter((w) => w === "B").length;
  const nTie = n - nA - nB;
  const close = Math.abs(nA - nB) <= Math.round(n * 0.2);
  // 下の図: 1人〜最大の人数を、10倍ずつの目盛りで
  const all = [...a, ...b].filter((v) => v >= 0.5);
  const top = 10 ** Math.max(1, Math.ceil(Math.log10(Math.max(1, ...all))));
  const x = (v: number) => (Math.log10(Math.max(v, 1)) / Math.log10(top)) * 100;
  const ticks: number[] = [];
  for (let t = 1; t <= top * 1.0001; t *= 10) ticks.push(t);
  const per = { A: a.slice(0, n), B: b.slice(0, n) } as Record<PlanId, number[]>;
  return (
    <figure className="card r-runs">
      <div className="r-runs-part">
        <figcaption className="r-runs-cap">
          <strong>
            {n}回のシミュレーションで、{name}が多かったのはどっち？
          </strong>
          <span className="note">マス1つが1回のシミュレーション。色は、その回に{name}が多かった案です。</span>
        </figcaption>
        <div className="r-legend">
          {ids.map((id) => (
            <span key={id}>
              <i style={{ background: PLAN_VAR[id] }} />
              {id}案のほうが多かった回 <b className="num">{id === "A" ? nA : nB}回</b>
            </span>
          ))}
          {nTie > 0 && (
            <span>
              <i style={{ background: "var(--surface-2)" }} />
              同じだった回 <b className="num">{nTie}回</b>
            </span>
          )}
        </div>
        <ol className="r-tiles" aria-label={`A案が多かった回 ${nA}回、B案が多かった回 ${nB}回`}>
          {win.map((w, i) => (
            <li
              key={i}
              className="r-tile"
              style={{ background: w === "=" ? "var(--surface-2)" : PLAN_VAR[w as PlanId], color: w === "=" ? "var(--muted)" : "#fff" }}
              title={`${i + 1}回目: ${pair(i)}`}
            >
              {w === "=" ? "＝" : w}
            </li>
          ))}
        </ol>
        <p className="r-read">
          {nA}回 対 {nB}回。{close ? "ほぼ半々なので、どちらが多いとは言えません。" : `${nA > nB ? "A" : "B"}案のほうが多い回が多めです。`}
        </p>
      </div>

      <div className="r-runs-part">
        <figcaption className="r-runs-cap">
          <strong>1回ごとの{name}の人数（日本全体）</strong>
          <span className="note">点1つが1回のシミュレーション。右へ行くほど多い。目盛りは1つ右へ進むごとに10倍になります。</span>
        </figcaption>
        <DotExplainer replay={replay} name={name} />
        <div className="r-strip">
          {ids.map((id) => (
            <div className="r-srow" key={id}>
              <span className="plan-tag r-stag" style={{ color: PLAN_VAR[id] }}>
                {id}案
              </span>
              <div className="r-sline">
                {per[id].map((v, i) => (
                  <span key={i} className="r-dot" style={{ left: `${x(v)}%`, background: PLAN_VAR[id] }} title={`${i + 1}回目: ${count(v)}人`} />
                ))}
              </div>
            </div>
          ))}
          <div className="r-saxis" aria-hidden>
            {ticks.map((t) => (
              <span key={t} style={{ left: `${x(t)}%` }}>
                {count(t)}
                {t === ticks[ticks.length - 1] ? "人" : ""}
              </span>
            ))}
          </div>
        </div>
        <SpreadText replay={replay} per={per} />
      </div>
    </figure>
  );
}

/** 回ごとの人数の広がりを、言葉で。広がりの小さい案と大きい案を比べ、広告と動画の違いで説明する */
function SpreadText({ replay, per }: { replay: Replay; per: Record<PlanId, number[]> }) {
  const ids = planIds(replay);
  const spread = (id: PlanId) => Math.max(...per[id]) / Math.max(1, Math.min(...per[id]));
  const [calm, wild] = [...ids].sort((x, y) => spread(x) - spread(y));
  const range = (id: PlanId) => `${count(Math.min(...per[id]))}〜${count(Math.max(...per[id]))}人`;
  const isVideo = (id: PlanId) => !!replay.plans[id]!.config.organic_video;
  const isAds = (id: PlanId) => !isVideo(id) && Object.keys(replay.plans[id]!.config.channels ?? {}).length > 0;
  return (
    <div className="r-spread">
      <p className="r-read">
        {calm}案の人数は{range(calm)}で、比較的まとまっています。{wild}案は{range(wild)}と、回によって極端に分かれました。
      </p>
      {(isAds(calm) || isVideo(wild)) && (
        <p className="note">
          {isAds(calm) && `${calm}案は、払った広告費の分だけ広告が表示されるので、結果が比較的安定します。`}
          {isVideo(wild) && `${wild}案は、動画が大きく広がった回と、あまり広がらなかった回とで、結果が極端に分かれます。`}
        </p>
      )}
    </div>
  );
}

/** 「点1つ＝シミュレーション1回の結果」とは？ キャラクターの吹き出しを押すと説明が開く */
function DotExplainer({ replay, name }: { replay: Replay; name: string }) {
  const [open, setOpen] = useState(false);
  const runs = replay.meta.runs;
  const steps = ["広告や動画を見る", "インストール", "会員登録", ...(replay.meta.gates ?? []).map((g) => g.name_ja || g.id), name];
  return (
    <div className="dx">
      <div className="dx-head">
        <Mascot pose="point" size={72} />
        <button type="button" className="dx-bubble" aria-expanded={open} aria-controls="dx-body" onClick={() => setOpen(!open)}>
          <span>「点1つ＝シミュレーション1回の結果」とは？</span>
          <span className="dx-hint">{open ? "閉じる ▲" : "クリック ▼"}</span>
        </button>
      </div>
      {open && (
        <div className="dx-body" id="dx-body">
          <p className="dx-lead">
            点1つは、アプリを発売して{replay.meta.period_days}日間運営するまでを、架空の日本人1万人で、最初から最後まで1回シミュレーションした結果です。
          </p>
          <div className="dx-flow-wrap">
            <p className="dx-flow-cap">1回のシミュレーションの中で、架空の人たちはこの順に進み、段階ごとに一部の人が離れていきます。</p>
            <ol className="dx-flow">
              {steps.map((st, i) => (
                <li key={st} className={i === steps.length - 1 ? "is-goal" : undefined}>
                  {st}
                </li>
              ))}
            </ol>
          </div>
          <dl className="dx-notes">
            <div>
              <dt>点の位置</dt>
              <dd>そのシミュレーションで、{name}までたどり着いた人の数です。1人は1回だけ数え、日本全体の人数（15〜79歳）に換算しています。</dd>
            </div>
            <div>
              <dt>毎回、結果がちがう理由</dt>
              <dd>
                広告が押される割合、動画がどれだけ広がるか、マッチの起きやすさなど、データだけでは1つに決めきれない数字があります。テプリはこうした数字を、毎回、出典や仮定で決めた範囲の中から選び直します。だから、同じ1万人・同じ条件でも、回ごとに結果が変わります。サイコロを{runs}回振るのと同じで、{runs}回分を並べると、起こりうる結果の広がりが見えます。
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

/** 30回の幅を、対数の目盛りで A と B を並べる。重なりに色を付ける */
function RangeChart({ replay, metric }: { replay: Replay; metric: TotalKey }) {
  const ids = planIds(replay);
  const k = replay.meta.scale_to_japan;
  const bands = ids.map((id) => replay.plans[id]!.totals[metric]);
  if (ids.length < 2 || bands.some((b) => !b)) return null;
  const vals = bands.flatMap((b) => [b!.p10 * k, b!.p90 * k]).filter((v) => v > 0);
  if (vals.length === 0) return null;
  const lo = 10 ** Math.floor(Math.log10(Math.min(...vals)));
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...vals)));
  const span = Math.max(1, Math.log10(hi) - Math.log10(lo));
  const x = (v: number) => ((Math.log10(Math.max(v, lo)) - Math.log10(lo)) / span) * 100;
  const ticks: number[] = [];
  for (let t = lo; t <= hi * 1.0001; t *= 10) ticks.push(t);
  const oL = Math.max(...bands.map((b) => b!.p10 * k));
  const oR = Math.min(...bands.map((b) => b!.p90 * k));
  const name = metricName(metric, replay);
  return (
    <figure className="card r-range">
      <figcaption>
        <strong>
          {name}の人数（日本全体）・{replay.meta.runs}回の幅
        </strong>
        <span className="note">
          太い線が真ん中の回（中央値）、帯が下から10%〜90%の回が入る範囲。目盛りは10倍ずつ。
        </span>
      </figcaption>
      <div className="r-plot">
        {oR > oL && (
          <div className="r-overlap" style={{ left: `${x(oL)}%`, width: `${x(oR) - x(oL)}%` }}>
            <span>重なり</span>
          </div>
        )}
        {ids.map((id, i) => {
          const b = bands[i]!;
          return (
            <div className="r-row" key={id}>
              <span className="plan-tag r-tag" style={{ color: PLAN_VAR[id] }}>
                {id}案
              </span>
              <div className="r-band" style={{ left: `${x(b.p10 * k)}%`, width: `${x(b.p90 * k) - x(b.p10 * k)}%`, background: PLAN_VAR[id] }} />
              <div className="r-med" style={{ left: `${x(b.p50 * k)}%`, background: PLAN_VAR[id] }} />
              <span className="r-val num" style={{ left: `${x(b.p50 * k)}%`, color: PLAN_VAR[id] }}>
                {count(b.p50 * k)}人
              </span>
              <span className="r-ends num" style={{ left: `${x(b.p10 * k)}%` }}>
                {count(b.p10 * k)}〜{count(b.p90 * k)}人
              </span>
            </div>
          );
        })}
        <div className="r-axis" aria-hidden>
          {ticks.map((t) => (
            <span key={t} style={{ left: `${x(t)}%` }}>
              {count(t)}
            </span>
          ))}
        </div>
      </div>
      {oR > oL && <p className="r-read">2つの帯が大きく重なっている → どちらが多いとは言えない</p>}
    </figure>
  );
}

/** 案ごとの費用（日本全体の実際の金額）と1インストールあたりの費用 */
function CostRow({ replay }: { replay: Replay }) {
  const ids = planIds(replay);
  if (!ids.some((id) => replay.plans[id]!.totals.spend_jpy)) return null;
  return (
    <div className="costs">
      {ids.map((id) => {
        const t = replay.plans[id]!.totals;
        const s = planSummary(replay, id);
        return (
          <div key={id} className="cost">
            <span className="plan-tag" style={{ color: PLAN_VAR[id] }}>
              {id}案 ・ {s.title}
            </span>
            <span className="note">
              {s.cost ?? "—"}
              {s.video && <InfoTip label="動画の案についての注意">{ORGANIC_VIDEO_NOTE_JA}</InfoTip>}
            </span>
            {t.cpi_jpy && (
              <span className="r-cpi">
                1インストールあたり <strong className="num cost-amount">{count(t.cpi_jpy.p50)}円</strong>
              </span>
            )}
          </div>
        );
      })}
      <p className="note r-cost-note">1インストールあたりの費用 ＝ かけた費用 ÷ インストール数（{replay.meta.runs}回の中央値）。</p>
    </div>
  );
}

// ---- どこで減ったか ----

function FunnelSection({ replay }: { replay: Replay }) {
  const ids = planIds(replay);
  const keys = funnelKeys(replay);
  const k = scaleFactor(replay.meta, SCALE);
  if (keys.length < 2) return null;
  const v = (id: PlanId, key: TotalKey) => replay.plans[id]!.totals[key]?.p50;
  const rate = (id: PlanId, i: number) => {
    const cur = v(id, keys[i]);
    const prev = v(id, keys[i - 1]);
    return cur !== undefined && prev ? cur / prev : undefined;
  };
  // 一番減る段階 = 両案の「ひとつ前から進んだ割合」の平均が一番低い段階
  let worst = -1;
  let worstRate = Infinity;
  for (let i = 1; i < keys.length; i++) {
    const rs = ids.map((id) => rate(id, i)).filter((r): r is number => r !== undefined);
    if (rs.length === 0) continue;
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
    if (avg < worstRate) {
      worstRate = avg;
      worst = i;
    }
  }
  const max = Math.max(1e-9, ...ids.map((id) => v(id, keys[0]) ?? 0));
  const label = (key: TotalKey) => `${metricName(key, replay)}${key.startsWith("gate:") ? "を通過" : ""}`;
  const pct = (r: number | undefined) => (r === undefined ? "—" : `${Math.round(r * 100)}%`);
  const winsText = (["installs", "payers"] as const)
    .map((m) => {
      const p = (replay.comparison?.p_B_better as Record<string, number | undefined> | undefined)?.[m];
      return p === undefined ? null : `${metricName(m, replay)} ${Math.round(p * replay.meta.runs)}回`;
    })
    .filter(Boolean)
    .join("・");
  const isMatch = worst >= 0 && keys[worst] === "core_actions" && metricName("core_actions", replay) === "初マッチ";

  return (
    <section className="section" aria-labelledby="funnel-h">
      <div style={{ display: "grid", gap: 6 }}>
        <h2 className="h2" id="funnel-h">
          どこで減ったか
        </h2>
        <p className="note">
          インストールした人が、段階ごとに何人残ったか（日本全体・{replay.meta.runs}回の中央値）。右の%は、ひとつ前の段階から進んだ人の割合です。
          <InfoTip label="人数の読み方">
            どの段階の人数も、回ごとのばらつきが大きく、A案と B案の人数は大きく重なります{winsText ? `（B案が多かった回: ${winsText}）` : ""}。ここで見てほしいのは、両案に共通する「減り方」です。
          </InfoTip>
        </p>
      </div>
      <div className="card r-funnel">
        <p className="note">
          はじめに届いた人:{" "}
          {ids.map((id, i) => {
            const t = replay.plans[id]!.totals;
            const byVideo = (t["video_reached" as TotalKey]?.p50 ?? 0) > 0;
            const r = byVideo ? t["video_reached" as TotalKey]!.p50 : (t.reached?.p50 ?? NaN);
            return (
              <span key={id} style={{ whiteSpace: "nowrap" }}>
                {i > 0 && "、"}
                <b style={{ color: PLAN_VAR[id] }}>{id}案</b> {byVideo ? "動画で" : "広告で"} {people(r * k)}
              </span>
            );
          })}
        </p>
        <div className="funnel">
          {keys.map((key, i) => (
            <div className={`frow${i === worst ? " is-worst" : ""}`} key={key}>
              <span className="lbl">{label(key)}</span>
              <div className="fbars">
                {ids.map((id) => {
                  const val = v(id, key);
                  return (
                    <div className="fbar" key={id}>
                      <div className="track">
                        <div className="fill" style={{ width: `max(3px, ${((val ?? 0) / max) * 100}%)`, background: PLAN_VAR[id] }} />
                      </div>
                      <span className="num" style={{ textAlign: "right" }}>
                        {val === undefined ? "—" : people(val * k)}
                        {i > 0 && <span className="fpct"> {pct(rate(id, i))}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {worst > 0 && (
        <div className="r-callout">
          <p className="r-callout-head">
            一番減るのは「{label(keys[worst - 1])} → {metricName(keys[worst], replay)}」
          </p>
          <p>
            {label(keys[worst - 1])}した人のうち、{metricName(keys[worst], replay)}まで進んだのは
            {ids.map((id, i) => (
              <span key={id}>
                {i > 0 && "・"}
                <b style={{ color: PLAN_VAR[id] }}>{id}案 {pct(rate(id, worst))}</b>
              </span>
            ))}
            。
          </p>
          {isMatch && (
            <>
              <p>
                エンジンのルールでは、同じ都道府県に本人確認を通った相手（異性）が少ないほど、マッチが起きにくくなります。出たばかりのアプリは近くに相手がまだ少なく、マッチを待つあいだに多くの人が使うのをやめてしまいます。
              </p>
              <p className="note">
                マッチの起きやすさのルールは、公開されたデータがないための仮定です（<a href={href("sources")}>根拠</a>のページ）。
              </p>
            </>
          )}
        </div>
      )}
      <details className="fold r-more">
        <summary>もっと詳しく（日ごとの推移{ids.some((id) => replay.plans[id]!.config.organic_video) ? "・動画の届き方" : ""}）</summary>
        <div style={{ display: "grid", gap: 28 }}>
          <VideoBlock replay={replay} scale={SCALE} />
          <Trend replay={replay} metric="installs" scale={SCALE} />
          <Trend replay={replay} metric={HEADLINE_METRIC} scale={SCALE} />
        </div>
      </details>
    </section>
  );
}

// ---- 離れた理由と、次に試すこと ----

/** 並べる理由の数 */
const TOP_THEMES = 3;

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** テーマを集める。一番外側の drop_themes を優先し、なければ案ごとの drop_themes を重複なしで */
function collectThemes(replay: Replay): DropTheme[] {
  const top = Array.isArray(replay.drop_themes) ? replay.drop_themes : [];
  const src = top.length
    ? top
    : planIds(replay).flatMap((id) => (Array.isArray(replay.plans[id]!.drop_themes) ? replay.plans[id]!.drop_themes : []));
  const seen = new Set<string>();
  const out: DropTheme[] = [];
  for (const t of src) {
    if (!t || !nonEmpty(t.theme_ja)) continue;
    const key = `${t.theme_ja}|${t.plan ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  // まとめた離脱理由の数が多い順（同じ数ならレポートの並び）
  const n = (t: DropTheme) => (Array.isArray(t.drop_reason_ids) ? t.drop_reason_ids.length : 0);
  return out.map((t, i) => ({ t, i })).sort((a, b) => n(b.t) - n(a.t) || a.i - b.i).map((x) => x.t);
}

/** "A,B" → 両方なら null、片方なら "B" */
function onlyPlan(plan: unknown): PlanId | null {
  if (typeof plan !== "string") return null;
  const ps = [...new Set(plan.split(/[,、\s]+/).filter((p): p is PlanId => p === "A" || p === "B"))];
  return ps.length === 1 ? ps[0] : null;
}

/** "install,gate:id_verification" → "インストール・本人確認" */
function stepsText(step: unknown, replay: Replay): string {
  if (typeof step !== "string") return "";
  return [...new Set(step.split(/[,、\s]+/).filter(Boolean).map((s) => stepName(s, replay)))].join("・");
}

/** report_ja から「次に試す」の見出しの下の箇条書きだけを取り出す。見つからなければ空 */
function nextStepsFrom(report: unknown): string[] {
  if (typeof report !== "string" || !report.includes("次に試す")) return [];
  const lines = report.split(/\r?\n/).map((l) => l.trim());
  const isHeading = (l: string) => /^【[^】]*】/.test(l) || /^#{1,6}\s/.test(l) || /^■/.test(l);
  const start = lines.findIndex((l) => l.includes("次に試す") && (isHeading(l) || l.length <= 24));
  if (start < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (!l) continue;
    if (isHeading(l)) break;
    const m = /^(?:[・•●○◦\-*＊]|\d{1,2}[.)．、）])\s*(.+)$/.exec(l);
    if (m && m[1].trim()) out.push(m[1].trim());
    else if (out.length) break;
  }
  return out;
}

/** 2文字ずつの組（言葉の重なりで、理由と提案を結ぶため） */
function bigrams(s: string): Set<string> {
  const t = s.replace(/[\s、。・「」（）()，,.]/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 理由ごとに、言葉が一番重なる「次に試すこと」を1つずつ結ぶ（同じ提案は2回使わない。重なりが少なければ結ばない） */
function pairSteps(themes: DropTheme[], steps: string[]): (string | null)[] {
  const tg = themes.map((t) => bigrams(`${t.theme_ja}${t.summary_ja ?? ""}`));
  const sg = steps.map(bigrams);
  const cand: { ti: number; si: number; score: number }[] = [];
  tg.forEach((a, ti) =>
    sg.forEach((b, si) => {
      let score = 0;
      for (const x of b) if (a.has(x)) score++;
      cand.push({ ti, si, score });
    }),
  );
  cand.sort((a, b) => b.score - a.score);
  const out: (string | null)[] = themes.map(() => null);
  const used = new Set<number>();
  for (const c of cand) {
    if (c.score < 3 || out[c.ti] !== null || used.has(c.si)) continue;
    out[c.ti] = steps[c.si];
    used.add(c.si);
  }
  return out;
}

function ReasonsAndNext({ replay }: { replay: Replay }) {
  const themes = useMemo(() => collectThemes(replay).slice(0, TOP_THEMES), [replay]);
  const steps = useMemo(() => nextStepsFrom(replay.report_ja), [replay.report_ja]);
  const pairs = useMemo(() => pairSteps(themes, steps), [themes, steps]);
  if (themes.length === 0) return null;
  const anyNext = pairs.some(Boolean);
  return (
    <section className="section" aria-labelledby="themes-h">
      <div style={{ display: "grid", gap: 6 }}>
        <h2 className="h2" id="themes-h">
          {anyNext ? "離れた理由と、次に試すこと" : "離れた理由"}
        </h2>
        <p className="note">
          途中でやめた人の理由を Claude がテーマにまとめ、多い順に{themes.length}つ並べました。{anyNext && "右は、それぞれに対して Claude のレポートが挙げた次の一手です。"}
          <InfoTip label="まとめ方">
            1万人それぞれの判断の理由を、似たものどうしでまとめたものです。「出た段階」は、その理由で離れた人がいた段階です。数字はエンジンが計算したもので、Claude は理由の言葉だけをまとめています。
          </InfoTip>
        </p>
      </div>
      <ol className="r-pairs">
        {themes.map((t, i) => {
          const only = onlyPlan(t.plan);
          const st = stepsText(t.step, replay);
          return (
            <li key={`${t.theme_ja}-${i}`} className={`r-pair${pairs[i] ? "" : " no-next"}`}>
              <div className="theme r-why">
                <span className="next-no num" aria-hidden>
                  {i + 1}
                </span>
                <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
                  <strong className="theme-title">{t.theme_ja}</strong>
                  {nonEmpty(t.summary_ja) && <span className="theme-sum">{t.summary_ja}</span>}
                  {(st || only) && (
                    <span className="theme-meta">
                      {only && (
                        <span className="theme-only" style={{ color: PLAN_VAR[only] }}>
                          {only}案だけ
                        </span>
                      )}
                      {st && <span>出た段階: {st}</span>}
                    </span>
                  )}
                </div>
              </div>
              {pairs[i] && (
                <div className="r-next">
                  <b>次に試す</b>
                  <span>{pairs[i]}</span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---- 地図で見る ----

function useWide(px: number) {
  const [wide, setWide] = useState(() => window.matchMedia(`(min-width: ${px}px)`).matches);
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const on = () => setWide(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [px]);
  return wide;
}

function useCssVar(name: string) {
  const [v, setV] = useState("");
  useEffect(() => {
    const read = () => setV(getComputedStyle(document.documentElement).getPropertyValue(name).trim());
    read();
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, [name]);
  return v;
}

interface PlayerProps {
  replay: Replay;
  autoplay: boolean;
  onAutoplayDone: () => void;
  picked: { row: number; plan: PlanId } | null;
  onPick: (p: { row: number; plan: PlanId } | null) => void;
}

function Player({ replay, autoplay, onAutoplayDone, picked, onPick }: PlayerProps) {
  const ids = planIds(replay);
  const maxDay = replay.plans[ids[0]]?.daily.day.length ?? replay.meta.period_days;
  const playback = usePlayback(maxDay, 7);
  const wide = useWide(900);
  const [shown, setShown] = useState<PlanId>(ids[0] ?? "A");
  const tA = useStateTimeline(replay, "A");
  const tB = useStateTimeline(replay, "B");
  const ref = useRef<HTMLElement>(null);

  // トップの「再生」から来たときは、地図が画面に入ったところで再生を始める
  useEffect(() => {
    if (!autoplay || !ref.current) return;
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          playback.setDay(0);
          playback.setPlaying(true);
          onAutoplayDone();
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(ref.current);
    return () => io.disconnect();
    // 最初の1回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = wide ? ids : ids.filter((id) => id === shown);

  return (
    <section className="section player" aria-labelledby="player-h" ref={ref}>
      <div style={{ display: "grid", gap: 6 }}>
        <h2 className="h2" id="player-h">
          地図で見る: 同じ1万人に、{replay.meta.period_days}日間で起きたこと
        </h2>
        <p className="note">
          点1つが架空の1人（実際の約{formatCount(replay.meta.scale_to_japan)}人分）。▶ を押すと、左が A案、右が B案のときの様子が1日ずつ進みます。点を押すと、その人の判断と理由が見られます。
        </p>
      </div>
      <Timeline playback={playback} extrapolatedAfterDay={replay.meta.extrapolated_after_day} />
      {!wide && ids.length > 1 && (
        <div className="seg" role="group" aria-label="表示する案" style={{ justifySelf: "start" }}>
          {ids.map((id) => (
            <button key={id} type="button" aria-pressed={shown === id} onClick={() => setShown(id)}>
              {id}案
            </button>
          ))}
        </div>
      )}
      <div className={`maps${visible.length === 1 ? " single" : ""}`}>
        {visible.map((id) => (
          <PlanMap
            key={id}
            replay={replay}
            plan={id}
            day={playback.day}
            states={id === "A" ? tA : tB}
            selectedRow={picked?.plan === id ? picked.row : null}
            onPick={(row) => onPick({ row, plan: id })}
          />
        ))}
      </div>
      <MapLegend replay={replay} />
      <InterviewChips replay={replay} picked={picked} onPick={onPick} />
      {picked && <PersonPanel replay={replay} row={picked.row} plan={picked.plan} onPlan={(plan) => onPick({ ...picked, plan })} onClose={() => onPick(null)} />}
    </section>
  );
}

function PlanMap({
  replay,
  plan,
  day,
  states,
  selectedRow,
  onPick,
}: {
  replay: Replay;
  plan: PlanId;
  day: number;
  states: ReturnType<typeof useStateTimeline>;
  selectedRow: number | null;
  onPick: (row: number) => void;
}) {
  const p = replay.plans[plan]!;
  const color = useCssVar(plan === "A" ? "--a" : "--b");
  const gold = useCssVar("--pay");
  const muted = useCssVar("--muted");
  const untouched = useCssVar("--dot-untouched");
  const fg = useCssVar("--fg");
  // 点の直径（幅 320px のとき。地図の幅に合わせて少し変わる）。トップの図と同じく、進んだ人ほど少し大きい丸
  const style = useCallback(
    (s: PersonState) => {
      switch (s) {
        case PersonState.None:
          return { color: untouched, alpha: 0.75, size: 1.8 };
        case PersonState.Install:
        case PersonState.Signup:
          return { color, alpha: 0.6, size: 2.3 };
        case PersonState.CoreAction:
        case PersonState.Trial:
          return { color, alpha: 1, size: 2.8 };
        case PersonState.Paid:
          return { color: gold, alpha: 1, size: 3.5 };
        case PersonState.Churned:
          return { color: muted, alpha: 0.55, size: 2.1 };
        default:
          return null;
      }
    },
    [color, gold, muted, untouched],
  );
  const st = useMemo(() => (states ? statesOnDay(states, day) : undefined), [states, day]);
  const k = scaleFactor(replay.meta, SCALE);
  const cum = p.daily_cumulative.installs;
  const idx = Math.min(day, p.daily.day.length) - 1;
  const installsSoFar = cum && idx >= 0 ? cum.p50[idx] * k : 0;
  const payCum = p.daily_cumulative.payers;
  const payersSoFar = payCum && idx >= 0 ? payCum.p50[idx] * k : 0;

  return (
    <div className="map-card">
      <div className="map-head">
        <span className="plan-tag" style={{ color: PLAN_VAR[plan], fontSize: 22 }}>
          {plan}案
        </span>
        <span className="num" style={{ fontSize: 15, color: "var(--text-secondary)" }}>
          累計（日本全体）: インストール {people(installsSoFar)} ・ 課金 {people(payersSoFar)}
        </span>
      </div>
      {color && (
        <JapanMap
          people={replay.people}
          states={st}
          weights={states?.installN}
          highlightPrefs={p.config.regions ?? []}
          dotSize={2}
          maxWidth={640}
          variant="dots"
          stateStyle={style}
          onPick={onPick}
          selectedRow={selectedRow}
          selectedColor={fg}
          showCredit={false}
          ariaLabel={`${plan}案の日本地図。${day}日目の様子`}
        />
      )}
    </div>
  );
}

function MapLegend({ replay }: { replay: Replay }) {
  const configs = planIds(replay).map((id) => replay.plans[id]!.config);
  const someRegions = configs.some((c) => (c.regions ?? []).length > 0);
  const items: [string, string, number][] = [
    ["まだ届いていない", "var(--dot-untouched)", 1],
    ["インストール", "linear-gradient(90deg, var(--a) 50%, var(--b) 50%)", 0.45],
    ["初マッチ", "linear-gradient(90deg, var(--a) 50%, var(--b) 50%)", 1],
    ["課金", "var(--pay)", 1],
    ["やめた", "var(--muted)", 0.5],
  ];
  return (
    <div className="legend" aria-label="点の色">
      {items.map(([label, c, o]) => (
        <span key={label}>
          <span className="swatch" style={{ background: c, opacity: o }} />
          {label}
        </span>
      ))}
      {someRegions && <span className="note">色の濃い地域が、広告を出した地域です。</span>}
    </div>
  );
}

function InterviewChips({ replay, picked, onPick }: Pick<PlayerProps, "replay" | "picked" | "onPick">) {
  const rowOf = useMemo(() => new Map(replay.people.map((p, i) => [p[0], i])), [replay.people]);
  const list = replay.interviews.filter((iv) => rowOf.has(iv.person_id));
  if (list.length === 0) return null;
  const ids = planIds(replay).filter((id) => list.some((iv) => iv.plan === id));
  return (
    <div className="r-talk">
      <h3 className="h3">Claude が話を聞いた{list.length}人</h3>
      <p className="note">
        地図の上の架空の人に、発売のあとで Claude が話を聞きました。答えはその人の判断の記録だけから作っています。押すと、答えと判断が出ます。
      </p>
      {ids.map((id) => (
        <div key={id} className="r-talk-row">
          <span className="plan-tag" style={{ color: PLAN_VAR[id] }}>
            {id}案のとき
          </span>
          <div className="chips">
            {list
              .filter((iv) => iv.plan === id)
              .map((iv) => {
                const row = rowOf.get(iv.person_id)!;
                const p = replay.people[row];
                const on = picked?.row === row && picked.plan === iv.plan;
                return (
                  <button key={`${iv.plan}-${iv.person_id}`} type="button" className="chip" aria-pressed={on} onClick={() => onPick(on ? null : { row, plan: iv.plan })}>
                    {p[3]}歳・{p[4] === "M" ? "男性" : "女性"}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}
