// 開発用ページ（/?dev）。土台の部品を並べて確認するだけ。最終の画面レイアウトではない。
// ?dev&replay=<id> で public/replays/<id>.json を読む（既定は mock）。

import { useMemo, useState } from "react";
import { JapanMap } from "../components/JapanMap";
import { DailyChart, canCumulate } from "../components/DailyChart";
import { ABComparison, ExtrapolationNote, Funnel, PLAN_COLOR, PLAN_LABEL, RangeCompare, ScaleToggle, StateLegend } from "../components/Metrics";
import { MockBanner, ReplayErrorView } from "../components/ReplayErrorView";
import { Timeline, usePlayback } from "../components/Timeline";
import { metricLabel, type Scale } from "../lib/format";
import { DAILY_KEYS, planIds, validateReplay, ReplayError, type DailyKey, type PlanId, type Replay } from "../lib/replay";
import { countsOnDay, statesOnDay } from "../lib/states";
import { useReplay, useStateTimeline } from "../lib/useReplay";

export function DevPage({ replayId }: { replayId: string }) {
  const status = useReplay(replayId);
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px 64px", display: "grid", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>テプリ 部品確認ページ</h1>
        <span className="small muted">
          開発用。最終の画面ではありません。リプレイ: <code>{replayId}</code>
        </span>
      </header>
      {status.kind === "loading" && <p className="muted">リプレイを読み込み中…</p>}
      {status.kind === "error" && <ReplayErrorView error={status.error} />}
      {status.kind === "ready" && <Showcase replay={status.replay} />}
      <ErrorSamples />
    </div>
  );
}

function Showcase({ replay }: { replay: Replay }) {
  const ids = planIds(replay);
  const [scale, setScale] = useState<Scale>("sample");
  const [metric, setMetric] = useState<DailyKey>("installs");
  const [cumulative, setCumulative] = useState(true);
  const metricKeys = DAILY_KEYS.filter((m) => ids.some((id) => replay.plans[id]!.daily[m]));
  const maxDay = replay.plans[ids[0]]?.daily.day.length ?? replay.meta.period_days;
  const playback = usePlayback(maxDay);

  return (
    <>
      {replay.meta.is_mock && <MockBanner note={replay.meta.note_ja} />}
      {replay.warnings.length > 0 && (
        <details className="panel small" style={{ color: "var(--warn-text)" }}>
          <summary style={{ cursor: "pointer" }}>契約 v1 と違う点が {replay.warnings.length}件あります（表示はできます）</summary>
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {replay.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      <section className="panel" style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h2 className="panel-title" style={{ margin: 0 }}>
            {replay.meta.name_ja}
          </h2>
          <span className="small muted num">
            {replay.meta.population.toLocaleString("ja-JP")}人 × {replay.meta.runs}回 ・ {replay.meta.period_days}日間
          </span>
          <ExtrapolationNote replay={replay} />
          <span style={{ marginLeft: "auto" }}>
            <ScaleToggle scale={scale} onChange={setScale} />
          </span>
        </div>
        <Timeline playback={playback} extrapolatedAfterDay={replay.meta.extrapolated_after_day} />
      </section>

      <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        {ids.map((id) => (
          <PlanMap key={id} replay={replay} plan={id} day={playback.day} scale={scale} />
        ))}
      </section>

      <section className="panel">
        <h2 className="panel-title">主要指標（A/B の範囲比較）</h2>
        <RangeCompare replay={replay} scale={scale} />
      </section>

      <section className="panel">
        <h2 className="panel-title">A/B の差（comparison）</h2>
        <ABComparison replay={replay} scale={scale} />
      </section>

      <section className="panel">
        <h2 className="panel-title">ファネル（中央値、かっこ内は前の段階からの割合）</h2>
        <Funnel replay={replay} scale={scale} />
      </section>

      <section className="panel" style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <h2 className="panel-title" style={{ margin: 0 }}>
            日別グラフ
          </h2>
          <span className="seg" role="group" aria-label="指標">
            {metricKeys.map((m) => (
              <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)}>
                {metricLabel(m)}
              </button>
            ))}
          </span>
          <span className="seg" role="group" aria-label="日別か累計か">
            <button type="button" aria-pressed={!cumulative || !canCumulate(replay, metric)} onClick={() => setCumulative(false)}>
              日別
            </button>
            <button
              type="button"
              aria-pressed={cumulative && canCumulate(replay, metric)}
              disabled={!canCumulate(replay, metric)}
              title={canCumulate(replay, metric) ? "" : "累計は installs / payers / revenue_jpy だけ"}
              onClick={() => setCumulative(true)}
            >
              累計
            </button>
          </span>
        </div>
        <DailyChart replay={replay} metric={metric} scale={scale} cumulative={cumulative} cursorDay={playback.day} />
      </section>
    </>
  );
}

function PlanMap({ replay, plan, day, scale }: { replay: Replay; plan: PlanId; day: number; scale: Scale }) {
  const timeline = useStateTimeline(replay, plan);
  const states = useMemo(() => (timeline ? statesOnDay(timeline, day) : undefined), [timeline, day]);
  const counts = timeline ? countsOnDay(timeline, day) : [];
  const p = replay.plans[plan]!;
  // 出稿地域は config.regions から（空なら全国）
  const regions = p.config.regions ?? [];
  // 広告が届いた人はイベントにないので、daily.reached の中央値をその日まで足した目安を出す
  const reached = useMemo(() => {
    const r = p.daily.reached?.p50;
    if (!r) return null;
    let s = 0;
    for (let i = 0; i < Math.min(day, r.length); i++) s += r[i];
    return s;
  }, [p, day]);
  const unknown = timeline ? [...timeline.unknownEvents.entries()] : [];

  return (
    <div className="panel" style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 700 }}>
        <span className="swatch" style={{ background: PLAN_COLOR[plan] }} />
        {PLAN_LABEL[plan]}
        <span className="small muted" style={{ fontWeight: 400 }}>
          この再生での1回分（点1つ = 約{Math.round(replay.meta.scale_to_japan).toLocaleString("ja-JP")}人を表す1人）
        </span>
      </div>
      <JapanMap people={replay.people} states={states} weights={timeline?.installN} highlightPrefs={regions} />
      <StateLegend counts={counts} scale={scale} scaleToJapan={replay.meta.scale_to_japan} reached={reached} />
      {unknown.length > 0 && (
        <p className="small" style={{ color: "var(--warn-text)", margin: 0 }}>
          契約 v1 にない step を無視しました: {unknown.map(([k, n]) => `${k}（${n}件）`).join("、")}
        </p>
      )}
    </div>
  );
}

/** 壊れたデータのときのエラー表示を確認する */
function ErrorSamples() {
  const samples: [string, unknown][] = [
    ["plans がない", { meta: { app_id: "x", name_ja: "x", period_days: 90, runs: 30, population: 10000, scale_to_japan: 1, extrapolated_after_day: 90 }, people: [] }],
    ["数値が文字列", { meta: { app_id: "x", name_ja: "x", period_days: "90" }, plans: { A: { daily: { day: [1, 2] } } }, people: [[0, 99]] }],
  ];
  return (
    <details className="panel">
      <summary style={{ cursor: "pointer", fontWeight: 700 }}>エラー表示の確認（壊れたデータの例）</summary>
      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        {samples.map(([label, data]) => {
          let error: Error | null = null;
          try {
            validateReplay(data);
          } catch (e) {
            error = e as ReplayError;
          }
          return (
            <div key={label}>
              <div className="small secondary" style={{ marginBottom: 4 }}>
                例: {label}
              </div>
              {error && <ReplayErrorView error={error} />}
            </div>
          );
        })}
      </div>
    </details>
  );
}
