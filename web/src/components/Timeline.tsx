// 再生タイムライン: 日付スライダー、再生/一時停止、速度。
// 日は 0（発売前）〜 maxDay。再生中は小数の日を進め、表示は整数の日。

import { useCallback, useEffect, useRef, useState } from "react";

export const SPEEDS = [1, 3, 7, 15] as const; // 1秒あたりの日数

export interface Playback {
  day: number;
  maxDay: number;
  playing: boolean;
  speed: number;
  setDay: (d: number) => void;
  setPlaying: (p: boolean) => void;
  setSpeed: (s: number) => void;
}

export function usePlayback(maxDay: number, initialSpeed = 7): Playback {
  // 小数の日は ref に持ち、整数の日が変わったときだけ再描画する（毎フレーム全体を描き直さない）
  const dayFloat = useRef(0);
  const [day, setDayState] = useState(0);
  const [playing, setPlayingState] = useState(false);
  const [speed, setSpeed] = useState(initialSpeed);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let prev: number | null = null;
    const tick = (t: number) => {
      const dt = prev === null ? 0 : (t - prev) / 1000;
      prev = t;
      const next = Math.min(maxDay, dayFloat.current + dt * speed);
      dayFloat.current = next;
      setDayState(Math.floor(next));
      if (next >= maxDay) {
        setPlayingState(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, maxDay]);

  useEffect(() => {
    if (dayFloat.current > maxDay) {
      dayFloat.current = maxDay;
      setDayState(maxDay);
    }
  }, [maxDay]);

  const setDay = useCallback(
    (d: number) => {
      const v = Math.max(0, Math.min(maxDay, Math.round(d)));
      dayFloat.current = v;
      setDayState(v);
    },
    [maxDay],
  );

  const setPlaying = useCallback(
    (p: boolean) => {
      // 最後まで再生したあとに押したら最初から
      if (p && dayFloat.current >= maxDay) setDay(0);
      setPlayingState(p);
    },
    [maxDay, setDay],
  );

  return { day, maxDay, playing, speed, setDay, setPlaying, setSpeed };
}

export interface TimelineProps {
  playback: Playback;
  /** この日より後は「推計の延長」 */
  extrapolatedAfterDay?: number;
  /** 発売日（日付表示用、任意）。なければ「n日目」 */
  startDate?: Date;
}

function dayLabel(day: number, start?: Date): string {
  if (day === 0) return "発売前";
  if (!start) return `${day}日目`;
  const d = new Date(start.getTime() + (day - 1) * 86400000);
  return `${d.getMonth() + 1}月${d.getDate()}日（${day}日目）`;
}

export function Timeline({ playback, extrapolatedAfterDay, startDate }: TimelineProps) {
  const { day, maxDay, playing, speed, setDay, setPlaying, setSpeed } = playback;
  const extra = extrapolatedAfterDay !== undefined && extrapolatedAfterDay < maxDay ? extrapolatedAfterDay : null;
  const extraPct = extra !== null ? (extra / maxDay) * 100 : 100;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn"
          onClick={() => setPlaying(!playing)}
          aria-label={playing ? "一時停止" : "再生"}
          style={{ minWidth: 88 }}
        >
          {playing ? "❚❚ 一時停止" : "▶ 再生"}
        </button>
        <span className="num" style={{ fontWeight: 700, minWidth: 140 }}>
          {dayLabel(day, startDate)}
        </span>
        {extra !== null && day > extra && <span className="badge">推計の延長（{extra}日より後）</span>}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="small secondary" style={{ whiteSpace: "nowrap" }}>速度</span>
          <span className="seg" role="group" aria-label="再生速度">
            {SPEEDS.map((s) => (
              <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                {s}日/秒
              </button>
            ))}
          </span>
        </span>
      </div>
      <div style={{ position: "relative" }}>
        {/* 延長部分の帯（スライダーの裏） */}
        {extra !== null && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: `${extraPct}%`,
              right: 0,
              top: 4,
              bottom: 4,
              background: "var(--extrapolated)",
              borderLeft: "1px dashed var(--text-muted)",
              borderRadius: 4,
            }}
          />
        )}
        <input
          type="range"
          min={0}
          max={maxDay}
          step={1}
          value={day}
          onChange={(e) => {
            setPlaying(false);
            setDay(Number(e.target.value));
          }}
          aria-label="日付"
          aria-valuetext={dayLabel(day, startDate)}
          style={{ width: "100%", position: "relative", accentColor: "var(--text-primary)" }}
        />
      </div>
      <div className="small muted num" style={{ position: "relative", height: 18 }}>
        <span style={{ position: "absolute", left: 0 }}>発売前</span>
        {extra !== null && extraPct > 12 && extraPct < 88 && (
          <span style={{ position: "absolute", left: `${extraPct}%`, transform: "translateX(-50%)" }}>{extra}日</span>
        )}
        <span style={{ position: "absolute", right: 0 }}>{maxDay}日</span>
      </div>
    </div>
  );
}
