// 結果の2段目: カードを押した指標の、B案が上回った回・ファネル・日ごとの推移・離れた理由の上位3つ。
// 読み方の説明は「?」の吹き出しに入れて、本文は短くする。

import { useEffect, useRef } from "react";
import { DailyChart, canCumulate } from "../components/DailyChart";
import { InfoTip } from "../components/HeroDots";
import { scaleFactor, type Scale } from "../lib/format";
import { metricName, stepName } from "../lib/labels";
import { planIds, type DailyKey, type DropReason, type PlanId, type Replay, type TotalKey } from "../lib/replay";
import { PLAN_VAR, PlanName, count } from "./ui";
import { ORGANIC_VIDEO_NOTE_JA } from "../config";
import { scaleLabel } from "../lib/format";

/** 指標ごとに見る離脱の段階 */
const RELATED_STEPS: Record<string, (step: string) => boolean> = {
  installs: (s) => s === "install",
  core_actions: (s) => s === "signup" || s.startsWith("gate:") || s === "core_action",
  payers: (s) => s === "pay" || s === "trial" || s === "retention",
};

export function funnelKeys(replay: Replay): TotalKey[] {
  const ids = planIds(replay);
  const has = (k: TotalKey) => ids.some((id) => replay.plans[id]!.totals[k]);
  const gates = new Set<string>();
  for (const id of ids) for (const k of Object.keys(replay.plans[id]!.totals)) if (k.startsWith("gate:")) gates.add(k);
  const keys: TotalKey[] = ["installs", "signups", ...([...gates] as TotalKey[]), "core_actions", "trials", "payers"];
  return keys.filter(has);
}

export function MetricDetail({ replay, metric, scale, onClose }: { replay: Replay; metric: string; scale: Scale; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    ref.current?.focus({ preventScroll: true });
  }, [metric]);
  const name = metricName(metric, replay);
  return (
    <div className="detail" ref={ref} tabIndex={-1} aria-label={`${name}の内訳`}>
      <div className="detail-head">
        <h3 className="h2">{name}の内訳</h3>
        <button type="button" className="close" onClick={onClose}>
          閉じる
        </button>
      </div>
      <WinCount replay={replay} metric={metric} />
      {metric === "installs" && <VideoBlock replay={replay} scale={scale} />}
      <Funnel replay={replay} metric={metric} scale={scale} />
      <Trend replay={replay} metric={metric} scale={scale} />
      <Reasons replay={replay} metric={metric} />
    </div>
  );
}

/** 同じ回どうしで比べて B案が上回った回数（comparison.p_B_better から） */
function WinCount({ replay, metric }: { replay: Replay; metric: string }) {
  const p = (replay.comparison?.p_B_better as Record<string, number | undefined> | undefined)?.[metric];
  if (p === undefined) return null;
  const runs = replay.meta.runs;
  return (
    <p className="note" style={{ marginTop: -8 }}>
      同じ回どうしで比べて、<PlanName id="B" />が上回ったのは{" "}
      <strong className="num" style={{ color: "var(--fg)" }}>
        {runs}回中{Math.round(p * runs)}回
      </strong>
      。
    </p>
  );
}

function Funnel({ replay, metric, scale }: { replay: Replay; metric: string; scale: Scale }) {
  const ids = planIds(replay);
  const keys = funnelKeys(replay);
  const k = scaleFactor(replay.meta, scale);
  const max = Math.max(1e-9, ...ids.map((id) => replay.plans[id]!.totals.installs?.p50 ?? 0));
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <h4 className="h3">どこで減ったか</h4>
        <p className="note">
          インストールした人が、段階ごとに何人残ったか。
          <InfoTip label="棒の読み方">
            {replay.meta.runs}回の真ん中（中央値）の人数です。上の棒が A案、下の棒が B案。右の%は、ひとつ前の段階から進んだ人の割合です。
          </InfoTip>
        </p>
        <p className="note">
          届いた人:{" "}
          {ids.map((id, i) => {
            const t = replay.plans[id]!.totals;
            const v = (t["video_reached" as TotalKey]?.p50 ?? 0) > 0;
            const r = v ? t["video_reached" as TotalKey]!.p50 : (t.reached?.p50 ?? NaN);
            return (
              <span key={id}>
                {i > 0 && "、"}
                {id}案 {v ? "動画で" : "広告で"} <span className="num">{count(r * k)}</span>人
              </span>
            );
          })}
        </p>
      </div>
      <div className="funnel">
        {keys.map((key, i) => (
          <div className="frow" key={key}>
            <span className="lbl" style={{ fontWeight: key === metric ? 700 : 400 }}>
              {metricName(key, replay)}
              {key.startsWith("gate:") && "を通過"}
            </span>
            <div className="fbars">
              {ids.map((id) => {
                const t = replay.plans[id]!.totals;
                const v = t[key]?.p50;
                const prev = i > 0 ? t[keys[i - 1]]?.p50 : undefined;
                return (
                  <div className="fbar" key={id}>
                    <div className="track">
                      <div className="fill" style={{ width: `max(3px, ${((v ?? 0) / max) * 100}%)`, background: PLAN_VAR[id], opacity: key === metric ? 1 : 0.55 }} />
                    </div>
                    <span className="num" style={{ textAlign: "right" }}>
                      {v === undefined ? "—" : `${count(v * k)}人`}
                      {v !== undefined && prev ? <span className="muted"> {Math.round((v / prev) * 100)}%</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Trend({ replay, metric, scale }: { replay: Replay; metric: string; scale: Scale }) {
  const dailyKey = metric as DailyKey;
  const ids = planIds(replay);
  if (!ids.some((id) => replay.plans[id]!.daily[dailyKey])) return null;
  const cum = canCumulate(replay, dailyKey);
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <h4 className="h3">日ごとの推移{cum ? "（累計）" : "（その日の数）"}</h4>
        <p className="note">
          線が中央値、帯が10〜90%の幅。
          {ids.map((id) => (
            <span key={id} style={{ marginLeft: 12, whiteSpace: "nowrap" }}>
              <span className="swatch" style={{ background: PLAN_VAR[id], marginRight: 6, verticalAlign: -1 }} />
              {id}案
            </span>
          ))}
        </p>
      </div>
      <DailyChart replay={replay} metric={dailyKey} scale={scale} cumulative={cum} height={260} hideHeader />
    </div>
  );
}

function topReasons(replay: Replay, plan: PlanId, metric: string): DropReason[] {
  const all = replay.plans[plan]!.drop_reasons;
  const rel = RELATED_STEPS[metric];
  const pick = rel ? all.filter((r) => rel(r.step)) : all;
  return [...(pick.length ? pick : all)].sort((a, b) => b.share - a.share).slice(0, 3);
}

function Reasons({ replay, metric }: { replay: Replay; metric: string }) {
  const ids = planIds(replay);
  const clusterLabel = new Map(replay.clusters.map((c) => [c.cluster_id, c.label_ja]));
  if (ids.every((id) => replay.plans[id]!.drop_reasons.length === 0)) return null;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 4 }}>
        <h4 className="h3">
          離れた理由の上位3つ
          <InfoTip label="理由と%の読み方">
            Claude が一人ずつ判断したときの理由から。%は、その段階で離れた人のうち、そのグループが占める割合です。
          </InfoTip>
        </h4>
      </div>
      <div className="cards2">
        {ids.map((id) => (
          <div key={id} style={{ display: "grid", gap: 10, alignContent: "start" }}>
            <PlanName id={id} />
            <ol className="reasons">
              {topReasons(replay, id, metric).map((r, i) => (
                <li key={i}>
                  <span className="pct num">{Math.round(r.share * 100)}%</span>
                  <div style={{ display: "grid", gap: 2 }}>
                    <span>「{r.reason_ja}」</span>
                    <span className="note">
                      {stepName(r.step, replay)}の段階 ・ {clusterLabel.get(r.cluster_id) || `グループ ${r.cluster_id}`}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}


const VIDEO_ROWS: [TotalKey, string, string][] = [
  ["video_views" as TotalKey, "動画の再生数", "回"],
  ["video_reached" as TotalKey, "動画が届いた人", "人"],
  ["installs_video" as TotalKey, "動画からのインストール", "人"],
];

/** 動画の大量投稿の案（config.organic_video）の再生数・届いた人・インストール */
export function VideoBlock({ replay, scale }: { replay: Replay; scale: Scale }) {
  const ids = planIds(replay).filter((id) => replay.plans[id]!.config.organic_video);
  if (ids.length === 0) return null;
  const k = scaleFactor(replay.meta, scale);
  return (
    <>
      {ids.map((id) => {
        const t = replay.plans[id]!.totals;
        return (
          <div key={id} style={{ display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 4 }}>
              <h4 className="h3">
                <PlanName id={id} />の動画はどこまで届いたか
                <InfoTip label="動画の案についての注意">{ORGANIC_VIDEO_NOTE_JA}</InfoTip>
              </h4>
              <p className="note">{scaleLabel(scale)}。大きな数字は中央値、下は10〜90%の幅です。</p>
            </div>
            <div className="cards3">
              {VIDEO_ROWS.map(([key, label, u]) => {
                const b = t[key];
                return (
                  <div key={key} className="cost">
                    <span className="note">{label}</span>
                    <strong className="num" style={{ fontSize: 26, fontFamily: "var(--display)" }}>
                      {b ? `${count(b.p50 * k)}${u}` : "—"}
                    </strong>
                    {b && (
                      <span className="range num">
                        幅 {count(b.p10 * k)}〜{count(b.p90 * k)}
                        {u}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}
