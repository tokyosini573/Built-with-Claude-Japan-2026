// 結果: 1段目 = 一行の結論・再生される地図・数字カード3枚。
// 2段目 = カードを押すとその指標の内訳。3段目 = 地図の点を押すと一人のパネル。

import { useCallback, useEffect, useMemo, useState } from "react";
import { JapanMap } from "../components/JapanMap";
import { Mascot } from "../components/Mascot";
import { Timeline, usePlayback } from "../components/Timeline";
import { ScaleToggle } from "../components/Metrics";
import { CARD_METRICS, HEADLINE_METRIC, ORGANIC_VIDEO_NOTE_JA, UNCLEAR_RANGE } from "../config";
import { formatCount, scaleFactor, type Scale } from "../lib/format";
import { metricName, yen } from "../lib/labels";
import { planIds, type Band, type PlanId, type Replay } from "../lib/replay";
import { PersonState, statesOnDay } from "../lib/states";
import { useStateTimeline } from "../lib/useReplay";
import { MetricDetail } from "./MetricDetail";
import { PersonPanel } from "./PersonPanel";
import { PLAN_VAR, PlanName, count, people, periodText, unit } from "./ui";

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
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "end", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "grid", gap: 6 }}>
            <h2 className="h2" id="cards-h">
              3つの数字
            </h2>
            <p className="note">{periodText(replay)}の合計。大きな数字は{replay.meta.runs}回の真ん中（中央値）、下は10〜90%の幅です。</p>
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
          </p>
        </>
      )}
      <CostRow replay={replay} />
    </section>
  );
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
            <span className="plan-tag" style={{ color: PLAN_VAR[id] }}>
              {id}案
            </span>
            <span>
              <span className="note">{ads ? "広告費と動画の制作費" : video ? "動画の制作費" : "広告費"}</span>{" "}
              <strong className="num" style={{ fontSize: 20 }}>{t.spend_jpy ? yen(Math.round(t.spend_jpy.p50 * k)) : "—"}</strong>
            </span>
            {t.cpi_jpy && (
              <span>
                <span className="note">1インストールあたり</span>{" "}
                <strong className="num">{count(t.cpi_jpy.p50)}円</strong>
                <span className="range num">（幅 {count(t.cpi_jpy.p10)}〜{count(t.cpi_jpy.p90)}円）</span>
              </span>
            )}
            {video && <span className="caveat">{ORGANIC_VIDEO_NOTE_JA}</span>}
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
  const p = replay.comparison?.p_B_better[metric as keyof NonNullable<Replay["comparison"]>["p_B_better"]];
  return (
    <button type="button" className="card" aria-expanded={open} onClick={onToggle}>
      <span className="h3" style={{ fontFamily: "var(--display)" }}>{metricName(metric, replay)}</span>
      {planIds(replay).map((id) => {
        const b = replay.plans[id]!.totals[metric as "installs"];
        return (
          <span key={id} style={{ display: "grid", gap: 2 }}>
            <span className="plan-tag" style={{ color: PLAN_VAR[id], fontSize: 16 }}>
              {id}案
            </span>
            {b ? (
              <>
                <span className="big num">
                  {count(b.p50 * k)}
                  <span style={{ fontSize: 20, marginLeft: 2 }}>{unit(metric)}</span>
                </span>
                <span className="range num">幅 {rangeText(metric, b, k)}</span>
              </>
            ) : (
              <span className="range">データなし</span>
            )}
          </span>
        );
      })}
      {p !== undefined && (
        <span style={{ display: "grid", gap: 0, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
          <span className="note">B案が上回った回</span>
          <strong className="num" style={{ fontSize: 18 }}>
            {replay.meta.runs}回中{Math.round(p * replay.meta.runs)}回
          </strong>
        </span>
      )}
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
    <div style={{ display: "grid", gap: 10 }}>
      <h3 className="h3">話を聞いた人</h3>
      <div className="chips">
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
