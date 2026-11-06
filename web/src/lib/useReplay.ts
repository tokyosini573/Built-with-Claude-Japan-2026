// リプレイを読み込む React フック。

import { useEffect, useMemo, useState } from "react";
import { loadReplay, ReplayError, type PlanId, type Replay } from "./replay";
import { buildStateTimeline, type StateTimeline } from "./states";

export type ReplayStatus =
  | { kind: "loading" }
  | { kind: "error"; error: ReplayError | Error }
  | { kind: "ready"; replay: Replay };

export function useReplay(id: string): ReplayStatus {
  const [status, setStatus] = useState<ReplayStatus>({ kind: "loading" });
  useEffect(() => {
    const ac = new AbortController();
    setStatus({ kind: "loading" });
    loadReplay(id, ac.signal)
      .then((replay) => setStatus({ kind: "ready", replay }))
      .catch((error: Error) => {
        if (error.name !== "AbortError") setStatus({ kind: "error", error });
      });
    return () => ac.abort();
  }, [id]);
  return status;
}

/** その案の sample_run から全日の状態を作る（案ごとに1回だけ） */
export function useStateTimeline(replay: Replay | null, plan: PlanId): StateTimeline | null {
  return useMemo(() => {
    if (!replay) return null;
    const p = replay.plans[plan];
    if (!p) return null;
    const ids = replay.people.map((r) => r[0]);
    const dayCount = p.daily.day.length || replay.meta.period_days;
    return buildStateTimeline(ids, p.sample_run.events, dayCount);
  }, [replay, plan]);
}
