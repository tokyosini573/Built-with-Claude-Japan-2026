// 結果の3段目: 地図の点を押したときの一人のパネル。
// プロフィール、たどった道（sample_run.events）、Claude の判断の理由、インタビュー。

import { useEffect, useMemo, useRef } from "react";
import { formatCount } from "../lib/format";
import { CITY_JA, LEVEL_JA, PREF_JA, stepName } from "../lib/labels";
import { planIds, type PlanId, type Replay } from "../lib/replay";
import { PLAN_VAR, PlanName } from "./ui";

interface Props {
  replay: Replay;
  row: number;
  plan: PlanId;
  onPlan: (p: PlanId) => void;
  onClose: () => void;
}

const STEP_ORDER = ["install", "signup", "gate", "core_action", "trial", "retention", "pay"];
const stepRank = (s: string) => STEP_ORDER.indexOf(s.startsWith("gate:") ? "gate" : s);

function eventText(step: string, replay: Replay): string {
  if (step.startsWith("gate:")) return `${stepName(step, replay)}を通過`;
  return (
    {
      install: "インストール",
      signup: "登録",
      core_action: "初マッチ",
      trial: "無料体験を始めた",
      pay: "課金した",
      churn: "使うのをやめた",
    } as Record<string, string>
  )[step] ?? step;
}

/** install の判断がどの見本についてか（動画の案は「動画 v1」、広告は「広告 a1」） */
function creativeLabel(creative: string, replay: Replay, plan: PlanId): string {
  const video = replay.plans[plan]?.config.organic_video as { creative_ids?: string[] } | undefined;
  return `${video?.creative_ids?.includes(creative) ? "動画" : "広告"} ${creative}`;
}

export function PersonPanel({ replay, row, plan, onPlan, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const person = replay.people[row];
  const [pid, pref, city, age, sex, cluster] = person;
  // 右から出るシート（<dialog> なので Esc で閉じ、フォーカスも中に入る）
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    d?.scrollTo({ top: 0 });
  }, [row]);

  const label = replay.clusters.find((c) => c.cluster_id === cluster)?.label_ja;
  const events = useMemo(
    () => (replay.plans[plan]?.sample_run.events ?? []).filter((e) => e[0] === pid).sort((a, b) => a[1] - b[1] || stepRank(a[2]) - stepRank(b[2])),
    [replay, plan, pid],
  );
  const decisions = (replay.person_decisions ?? []).filter((d) => d.plan === plan && d.person_id === pid).sort((a, b) => stepRank(a.step) - stepRank(b.step));
  const groupReasons = replay.plans[plan]?.drop_reasons.filter((r) => r.cluster_id === cluster) ?? [];
  const interviews = replay.interviews.filter((iv) => iv.person_id === pid);
  const ids = planIds(replay);
  const groupSize = formatCount(replay.meta.scale_to_japan);

  return (
    <dialog
      className="sheet"
      ref={ref}
      aria-label="選んだ人"
      onClose={onClose}
      onClick={(e) => {
        // 外側（背景）を押したら閉じる
        if (e.target === e.currentTarget) onClose();
      }}
    >
    <div className="detail">
      <div className="detail-head">
        <div style={{ display: "grid", gap: 6 }}>
          <p className="eyebrow">架空の1人 ・ 番号 {pid}</p>
          <h3 className="h2">
            {age}歳・{sex === "M" ? "男性" : "女性"}・{PREF_JA[pref]}
          </h3>
          <p className="note">
            {CITY_JA[city]}に住む人。{label && `グループ「${label}」。`}この点は、似た人 約{groupSize}人を表します。
          </p>
        </div>
        <button type="button" className="close" onClick={onClose}>
          閉じる
        </button>
      </div>

      {ids.length > 1 && (
        <div className="seg" role="group" aria-label="どちらの案で見るか" style={{ justifySelf: "start" }}>
          {ids.map((id) => (
            <button key={id} type="button" aria-pressed={plan === id} onClick={() => onPlan(id)}>
              {id}案のとき
            </button>
          ))}
        </div>
      )}

      <div className="person">
        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <h4 className="h3">たどった道</h4>
          {events.length === 0 ? (
            <p>
              <PlanName id={plan} />では、この人はインストールしませんでした。
            </p>
          ) : (
            <ol className="path">
              {events.map(([, day, step, n], i) => (
                <li key={i}>
                  <span className="day num">{day}日目</span>
                  <span
                    className="dot"
                    aria-hidden
                    style={{ background: step === "pay" ? "var(--pay)" : step === "churn" ? "var(--muted)" : PLAN_VAR[plan] }}
                  />
                  <span className="what">
                    {eventText(step, replay)}
                    {n > 0 && <span className="note" style={{ display: "block" }}>似た人のうち {formatCount(n)}人</span>}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {replay.meta.extrapolated_after_day < replay.meta.period_days && events.some((e) => e[1] > replay.meta.extrapolated_after_day) && (
            <p className="note">{replay.meta.extrapolated_after_day}日より後は推計の延長です。</p>
          )}
        </div>

        <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
          <h4 className="h3">Claude の判断</h4>
          {decisions.length > 0 ? (
            <ul className="reasons">
              {decisions.map((d, i) => (
                <li key={i} style={{ gridTemplateColumns: "6.5em minmax(0,1fr)" }}>
                  <span style={{ fontWeight: 700 }}>
                    {stepName(d.step, replay)}
                    {d.creative && <span className="note" style={{ display: "block", fontWeight: 400 }}>{creativeLabel(d.creative, replay, plan)}</span>}
                  </span>
                  <div style={{ display: "grid", gap: 2 }}>
                    <span>「{d.reason_ja}」</span>
                    <span className="note">{LEVEL_JA[d.level] ?? d.level}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : groupReasons.length > 0 ? (
            <>
              <p className="note">この人の判断はリプレイに入っていないので、同じグループで多かった離れた理由を出しています。</p>
              <ul className="reasons">
                {groupReasons.slice(0, 3).map((r, i) => (
                  <li key={i} style={{ gridTemplateColumns: "6.5em minmax(0,1fr)" }}>
                    <span style={{ fontWeight: 700 }}>{stepName(r.step, replay)}</span>
                    <span>「{r.reason_ja}」</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="note">この人の判断の理由は、このリプレイには入っていません。</p>
          )}
          <p className="note">判断は「カテゴリの平均と比べて進みやすいか」と理由だけ。人数はエンジンが計算します。</p>
        </div>
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        <h4 className="h3">インタビュー</h4>
        {interviews.length === 0 ? (
          <p className="note">この人にはインタビューしていません。「話を聞いた人」から選べます。</p>
        ) : (
          interviews.map((iv) => (
            <div key={iv.plan} className="qa">
              <p className="note">
                <PlanName id={iv.plan} />を見たあとに聞きました。
              </p>
              {iv.qa.map((x, i) => (
                <div key={i}>
                  <p className="q">{x.q_ja}</p>
                  <p className="ans">{x.a_ja}</p>
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
    </dialog>
  );
}
