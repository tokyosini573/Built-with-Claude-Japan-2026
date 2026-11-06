// ?replay= があればそれ、なければ DEFAULT_REPLAYS を順に試して最初に読めたものを使う。

import { useEffect, useState } from "react";
import { DEFAULT_REPLAYS } from "../config";
import { loadReplay, ReplayError, type Replay } from "./replay";
import type { ReplayStatus } from "./useReplay";

export function useReplayAuto(explicit: string | null): ReplayStatus & { id?: string } {
  const [status, setStatus] = useState<ReplayStatus & { id?: string }>({ kind: "loading" });
  useEffect(() => {
    const ac = new AbortController();
    const ids = explicit ? [explicit] : DEFAULT_REPLAYS;
    (async () => {
      let last: Error = new ReplayError("リプレイが見つかりません。");
      for (const id of ids) {
        try {
          const replay: Replay = await loadReplay(id, ac.signal);
          setStatus({ kind: "ready", replay, id });
          return;
        } catch (e) {
          if ((e as Error).name === "AbortError") return;
          last = e as Error;
          // 見つからないときだけ次を試す。形が壊れているときはそのまま見せる
          if (!(e instanceof ReplayError) || e.problems.length > 0) break;
        }
      }
      setStatus({ kind: "error", error: last });
    })();
    return () => ac.abort();
  }, [explicit]);
  return status;
}
