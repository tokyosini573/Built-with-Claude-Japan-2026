// 結果: 一行の結論 → 再生される地図 → 数字カード3枚 → 離れた理由（Claude のまとめ）→ 次に試すこと。
// カードを押すとその指標の内訳。地図の点を押すと一人のパネル。細かい説明は「?」の吹き出しと折りたたみに入れる。

import { useCallback, useEffect, useMemo, useState } from "react";
import { InfoTip } from "../components/HeroDots";
import { JapanMap } from "../components/JapanMap";
import { Mascot } from "../components/Mascot";
import { Timeline, usePlayback } from "../components/Timeline";
import { ScaleToggle } from "../components/Metrics";
import { CARD_METRICS, HEADLINE_METRIC, ORGANIC_VIDEO_NOTE_JA, UNCLEAR_RANGE } from "../config";
import { formatCount, scaleFactor, type Scale } from "../lib/format";
import { metricName, stepName, yen } from "../lib/labels";
import { planIds, type Band, type DropTheme, type PlanId, type Replay } from "../lib/replay";
import { PersonState, statesOnDay } from "../lib/states";
import { useStateTimeline } from "../lib/useReplay";
import { MetricDetail } from "./MetricDetail";
import { PersonPanel } from "./PersonPanel";
import { PLAN_VAR, PlanName, count, people, periodText, unit } from "./ui";
import "./result.css";

interface Props {
  replay: Replay;
  scale: Scale;
  onScale: (s: Scale) => void;
  autoplay: boolean;
  onAutoplayDone: () => void;
}

export function ResultPage({ replay, scale, onScale, autoplay, onAutoplayDone }: Props) {
  const [openMetric, setOpenMetric] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ row: number; plan: PlanId } | null>(null);

  return (
    <>
      <Verdict replay={replay} />
      <Player replay={replay} scale={scale} autoplay={autoplay} onAutoplayDone={onAutoplayDone} picked={picked} onPick={setPicked} />
      <section className="section" aria-labelledby="cards-h">
        <div className="sec-head">
          <div style={{ display: "grid", gap: 6 }}>
            <h2 className="h2" id="cards-h">
              3つの数字
            </h2>
            <p className="note">
              {periodText(replay)}の合計。大きな数字は真ん中の値です。
              <InfoTip label="数字の読み方">
                同じ条件で{replay.meta.runs}回試したうちの、真ん中の回の値（中央値）です。小さな字の「幅」は、下から10%〜90%の回が入る範囲です。カードを押すと内訳が出ます。
              </InfoTip>
            </p>
          </div>
          <ScaleToggle scale={scale} onChange={onScale} />
        </div>
        <div className="cards3">
          {CARD_METRICS.map((m) => (
            <MetricCard key={m} replay={replay} metric={m} scale={scale} open={openMetric === m} onToggle={() => setOpenMetric(openMetric === m ? null : m)} />
          ))}
        </div>
        {openMetric && <MetricDetail replay={replay} metric={openMetric} scale={scale} onClose={() => setOpenMetric(null)} />}
      </section>
      <DropThemes replay={replay} />
      <NextSteps replay={replay} />
    </>
  );
}

// ---- 一行の結論 ----

function Verdict({ replay }: { replay: Replay }) {
  const p = replay.comparison?.p_B_better[HEADLINE_METRIC];
  const name = metricName(HEADLINE_METRIC, replay);
  return (
    <section className="verdict" aria-labelledby="verdict-h">
      <div className="with-mascot">
        <div className="verdict">
          <p className="eyebrow">
            {replay.meta.name_ja} ・ {periodText(replay)} ・ {replay.meta.runs}回の試行
          </p>
          <h1 className="claim" id="verdict-h">
            {p === undefined ? (
              "A案と B案の結果"
            ) : p >= UNCLEAR_RANGE[1] ? (
              <>
                <span className="ib">{name}は</span>{" "}
                <span className="ib">
                  <PlanName id="B" />のほうが多い確率 <span className="num">{Math.round(p * 100)}%</span>
                </span>
              </>
            ) : p <= UNCLEAR_RANGE[0] ? (
              <>
                <span className="ib">{name}は</span>{" "}
                <span className="ib">
                  <PlanName id="A" />のほうが多い確率 <span className="num">{Math.round((1 - p) * 100)}%</span>
                </span>
              </>
            ) : (
              <>
                <span className="ib">{name}は、</span>
                <span className="ib">どちらが多いか</span>{" "}
                <span className="ib">はっきりしない</span>
              </>
            )}
          </h1>
        </div>
        <Mascot pose="inspect" />
      </div>
      {p !== undefined && (
        <>
          <div className="pbar" role="img" aria-label={`B案が上回った回 ${replay.meta.runs}回中${Math.round(p * replay.meta.runs)}回`}>
            <span style={{ right: 0, width: `${p * 100}%`, background: PLAN_VAR.B }} />
          </div>
          <p className="note">
            同じ条件で{replay.meta.runs}回ずつ試し、<PlanName id="B" />の{name}が A案を上回ったのは {replay.meta.runs}回中
            <strong className="num">{Math.round(p * replay.meta.runs)}回</strong>でした。
            <OtherVerdicts replay={replay} headlineUnclear={p > UNCLEAR_RANGE[0] && p < UNCLEAR_RANGE[1]} />
          </p>
        </>
      )}
      <CostRow replay={replay} />
    </section>
  );
}

// ---- 費用 ----

/** ほかのカードの指標の勝ち負けを一文で（数字は出さない。回数はカードの内訳に） */
function OtherVerdicts({ replay, headlineUnclear }: { replay: Replay; headlineUnclear: boolean }) {
  const pb = replay.comparison?.p_B_better as Record<string, number | undefined> | undefined;
  if (!pb) return null;
  const groups: Record<"unclear" | "B" | "A", string[]> = { unclear: [], B: [], A: [] };
  for (const m of CARD_METRICS) {
    if (m === HEADLINE_METRIC) continue;
    const p = pb[m];
    if (p === undefined) continue;
    groups[p >= UNCLEAR_RANGE[1] ? "B" : p <= UNCLEAR_RANGE[0] ? "A" : "unclear"].push(metricName(m, replay));
  }
  const parts: string[] = [];
  if (groups.unclear.length) parts.push(`${groups.unclear.join("・")}${headlineUnclear ? "も" : "は"}、どちらが多いかはっきりしません。`);
  if (groups.B.length) parts.push(`${groups.B.join("・")}は、B案が上回った回のほうが多めです。`);
  if (groups.A.length) parts.push(`${groups.A.join("・")}は、A案が上回った回のほうが多めです。`);
  return parts.length ? <> {parts.join("")}</> : null;
}

// ---- 費用 ----

/** 案ごとの費用（日本全体の実際の金額）と1インストールあたりの費用。数字はリプレイの totals から */
function CostRow({ replay }: { replay: Replay }) {
  const ids = planIds(replay);
  if (!ids.some((id) => replay.plans[id]!.totals.spend_jpy)) return null;
  const k = replay.meta.scale_to_japan;
  return (
    <div className="costs">
      {ids.map((id) => {
        const t = replay.plans[id]!.totals;
        const video = !!replay.plans[id]!.config.organic_video;
        // 動画の案に広告も足したとき（ライブで試す）は、費用が広告費と制作費の合計になる
        const ads = video && (t.spend_jpy?.p50 ?? 0) > (t["spend_video_jpy" as "spend_jpy"]?.p50 ?? 0) * 1.0001;
        return (
          <div key={id} className="cost">
            <span className="cost-top">
              <span className="plan-tag" style={{ color: PLAN_VAR[id] }}>
                {id}案
              </span>
              <span className="note">
                {ads ? "広告費と動画の制作費" : video ? "動画の制作費" : "広告費"}
                {video && <InfoTip label="動画の案についての注意">{ORGANIC_VIDEO_NOTE_JA}</InfoTip>}
              </span>
            </span>
            <strong className="num cost-amount">{t.spend_jpy ? yen(Math.round(t.spend_jpy.p50 * k)) : "—"}</strong>
            {t.cpi_jpy && (
              <span className="note">
                1インストールあたり <strong className="num" style={{ color: "var(--fg)" }}>{count(t.cpi_jpy.p50)}円</strong>
                <span className="range num cost-range">幅 {count(t.cpi_jpy.p10)}〜{count(t.cpi_jpy.p90)}円</span>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- 数字カード ----

function rangeText(metric: string, b: Band<number>, k: number) {
  return `${count(b.p10 * k)}〜${count(b.p90 * k)}${unit(metric)}`;
}

function MetricCard({ replay, metric, scale, open, onToggle }: { replay: Replay; metric: string; scale: Scale; open: boolean; onToggle: () => void }) {
  const k = scaleFactor(replay.meta, scale, metric);
  return (
    <button type="button" className="card mcard" aria-expanded={open} onClick={onToggle}>
      <span className="h3" style={{ fontFamily: "var(--display)" }}>{metricName(metric, replay)}</span>
      {planIds(replay).map((id) => {
        const b = replay.plans[id]!.totals[metric as "installs"];
        return (
          <span key={id} className="mrow">
            <span className="plan-tag" style={{ color: PLAN_VAR[id] }}>
              {id}案
            </span>
            {b ? (
              <>
                <span className="mval num">
                  {count(b.p50 * k)}
                  <span className="munit">{unit(metric)}</span>
                </span>
                <span className="range num mrange">幅 {rangeText(metric, b, k)}</span>
              </>
            ) : (
              <span className="range">データなし</span>
            )}
          </span>
        );
      })}
      <span className="more">{open ? "閉じる ▲" : "内訳を見る ▼"}</span>
    </button>
  );
}

// ---- 地図の再生 ----

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
  scale: Scale;
  autoplay: boolean;
  onAutoplayDone: () => void;
  picked: { row: number; plan: PlanId } | null;
  onPick: (p: { row: number; plan: PlanId } | null) => void;
}

function Player({ replay, scale, autoplay, onAutoplayDone, picked, onPick }: PlayerProps) {
  const ids = planIds(replay);
  const maxDay = replay.plans[ids[0]]?.daily.day.length ?? replay.meta.period_days;
  const playback = usePlayback(maxDay, 7);
  const wide = useWide(900);
  const [shown, setShown] = useState<PlanId>(ids[0] ?? "A");
  const tA = useStateTimeline(replay, "A");
  const tB = useStateTimeline(replay, "B");

  useEffect(() => {
    if (autoplay) {
      playback.setDay(0);
      playback.setPlaying(true);
      onAutoplayDone();
    }
    // 最初の1回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = wide ? ids : ids.filter((id) => id === shown);

  return (
    <section className="section player" aria-labelledby="player-h">
      <div style={{ display: "grid", gap: 6 }}>
        <h2 className="h2" id="player-h">
          1万人に起きたこと
        </h2>
        <p className="note">点1つが架空の1人（実際の約{formatCount(replay.meta.scale_to_japan)}人分）。点を押すと、その人の様子が見られます。</p>
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
            scale={scale}
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
  scale,
  states,
  selectedRow,
  onPick,
}: {
  replay: Replay;
  plan: PlanId;
  day: number;
  scale: Scale;
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
  const k = scaleFactor(replay.meta, scale);
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
          インストール {people(installsSoFar)} ・ 課金 {people(payersSoFar)}
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
  const allNational = configs.every((c) => (c.regions ?? []).length === 0);
  const hasVideo = configs.some((c) => !!c.organic_video);
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
      <span className="note">
        {allNational ? `全国に出稿${hasVideo ? "（動画は地域を絞れない）" : ""}` : "色の濃い地域が、広告を出した地域です。"}
      </span>
    </div>
  );
}

function InterviewChips({ replay, picked, onPick }: Pick<PlayerProps, "replay" | "picked" | "onPick">) {
  const rowOf = useMemo(() => new Map(replay.people.map((p, i) => [p[0], i])), [replay.people]);
  const list = replay.interviews.filter((iv) => rowOf.has(iv.person_id));
  if (list.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <h3 className="h3">話を聞いた人</h3>
      <p className="note">地図から選んだ{new Set(list.map((iv) => iv.person_id)).size}人に、Claude が話を聞きました。答えはその人の記録だけから作っています。</p>
      <div className="chips" style={{ marginTop: 4 }}>
        {list.map((iv) => {
          const row = rowOf.get(iv.person_id)!;
          const p = replay.people[row];
          const on = picked?.row === row && picked.plan === iv.plan;
          return (
            <button key={`${iv.plan}-${iv.person_id}`} type="button" className="chip" aria-pressed={on} onClick={() => onPick(on ? null : { row, plan: iv.plan })}>
              <span style={{ color: on ? undefined : PLAN_VAR[iv.plan], fontWeight: 700 }}>{iv.plan}</span> {p[3]}歳・{p[4] === "M" ? "男性" : "女性"}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- 離れた理由（report.json のテーマ）----

/** 最初に見せるテーマの数。残りは「すべて見る」の中 */
const TOP_THEMES = 4;

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

function ThemeList({ themes, replay }: { themes: DropTheme[]; replay: Replay }) {
  return (
    <ul className="themes">
      {themes.map((t, i) => {
        const only = onlyPlan(t.plan);
        const steps = stepsText(t.step, replay);
        return (
          <li key={`${t.theme_ja}-${i}`} className="theme">
            {(steps || only) && (
              <span className="theme-meta">
                {only && (
                  <span className="theme-only" style={{ color: PLAN_VAR[only] }}>
                    {only}案だけ
                  </span>
                )}
                {steps && <span>{steps}</span>}
              </span>
            )}
            <strong className="theme-title">{t.theme_ja}</strong>
            {nonEmpty(t.summary_ja) && <span className="theme-sum">{t.summary_ja}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function DropThemes({ replay }: { replay: Replay }) {
  const themes = useMemo(() => collectThemes(replay), [replay]);
  if (themes.length === 0) return null;
  const top = themes.slice(0, TOP_THEMES);
  const rest = themes.slice(TOP_THEMES);
  return (
    <section className="section" aria-labelledby="themes-h">
      <div style={{ display: "grid", gap: 6 }}>
        <h2 className="h2" id="themes-h">
          離れた理由
        </h2>
        <p className="note">
          途中でやめた人の理由を、Claude がテーマにまとめました。
          <InfoTip label="まとめ方">
            段階とグループごとの離れた理由を、似たものどうしでまとめたものです。上から、まとめた理由の数が多い順です。小さな字は、その理由が出た段階です。
          </InfoTip>
        </p>
      </div>
      <ThemeList themes={top} replay={replay} />
      {rest.length > 0 && (
        <details className="fold themes-more">
          <summary>すべて見る（ほか{rest.length}件）</summary>
          <div>
            <ThemeList themes={rest} replay={replay} />
          </div>
        </details>
      )}
    </section>
  );
}

// ---- 次に試すこと（report_ja の「次に試す…」の箇条書き）----

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

function NextSteps({ replay }: { replay: Replay }) {
  const steps = useMemo(() => nextStepsFrom(replay.report_ja), [replay.report_ja]);
  if (steps.length === 0) return null;
  return (
    <section className="section next" aria-labelledby="next-h">
      <div style={{ display: "grid", gap: 6 }}>
        <h2 className="h2" id="next-h">
          次に試すこと
        </h2>
        <p className="note">Claude のレポートから。</p>
      </div>
      <ol className="next-list">
        {steps.map((t, i) => (
          <li key={i}>
            <span className="next-no num" aria-hidden>
              {i + 1}
            </span>
            <span>{t}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
