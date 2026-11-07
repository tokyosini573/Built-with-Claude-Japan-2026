// ライブで試す（#/live）: デモアプリ「ちかくに」の A案・B案の条件を変えて、ブラウザの中でエンジンをもう一度回す。
// Claude の判断は事前に取った1万人分をそのまま使い、API は呼ばない。エンジンは Python のものを Pyodide で動かす
// （src/live/live.worker.ts、teppuri/engine/live.py）。結果は結果画面の部品（ResultPage）で出す。

import { useEffect, useMemo, useState } from "react";
import { ResultPage } from "./ResultPage";
import { Mascot } from "../components/Mascot";
import { PLAN_VAR, PlanName } from "./ui";
import { href } from "../lib/router";
import { CHANNEL_JA, regionText, yen } from "../lib/labels";
import type { Scale } from "../lib/format";
import { liveBase, runLive, startLive, useLive } from "../live/engine";
import type { LiveManifest, LiveOverrides, LivePlanInput, VideoInput } from "../live/protocol";
import "../live/live.css";

type PlanKey = "A" | "B";
const PLAN_KEYS: PlanKey[] = ["A", "B"];

const PERIODS = [30, 90, 180, 365];
const RUN_CHOICES = [10, 30];
const CHANNELS: { id: string; label: string; note?: string }[] = [
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "x", label: "X" },
  { id: "youtube", label: "YouTube" },
  { id: "line", label: "LINE" },
  { id: "transit", label: "電車の広告", note: "年齢・性別では絞れない" },
  { id: "offline", label: "大学・イベント", note: "18〜29歳の学生だけ" },
];
const REGION_PRESETS: { id: string; label: string; prefs: number[] }[] = [
  { id: "all", label: "全国", prefs: [] },
  { id: "shutoken", label: "首都圏（東京・神奈川・埼玉・千葉）", prefs: [11, 12, 13, 14] },
  { id: "kansai", label: "関西（大阪・京都・兵庫・滋賀・奈良・和歌山）", prefs: [25, 26, 27, 28, 29, 30] },
  { id: "chukyo", label: "中京（愛知・岐阜・三重）", prefs: [21, 23, 24] },
  { id: "tokyo", label: "東京都だけ", prefs: [13] },
  { id: "fukuoka", label: "福岡県だけ", prefs: [40] },
  { id: "hokkaido", label: "北海道だけ", prefs: [1] },
];

const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x));
const regionId = (prefs: number[]) => REGION_PRESETS.find((r) => sameSet(r.prefs, prefs))?.id ?? "custom";

function toOverrides(m: LiveManifest): LiveOverrides {
  const plan = (k: PlanKey): LivePlanInput => {
    const d = m.defaults.plans[k];
    return {
      campaign_days: d.campaign_days,
      regions: [...d.regions],
      channels: { ...d.channels },
      monthly_jpy: d.monthly_jpy,
      free_trial_days: d.free_trial_days,
      organic_video: d.organic_video ? { ...d.organic_video } : null,
    };
  };
  return { runs: m.defaults.runs, period_days: m.defaults.period_days, plans: { A: plan("A"), B: plan("B") } };
}

function useManifest() {
  const [m, setM] = useState<LiveManifest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(`${liveBase()}manifest.json`, { cache: "no-cache" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setM)
      .catch((e: Error) => setErr(`ライブ用のファイル（live/manifest.json）を読めませんでした: ${e.message}。npm run build-live で作れます。`));
  }, []);
  return { manifest: m, error: err };
}

function spendOf(p: LivePlanInput) {
  const ads = Object.values(p.channels).reduce((s, v) => s + (v > 0 ? v : 0), 0);
  const v = p.organic_video;
  // エンジンと同じ数え方（teppuri/engine/organic_video.py）: 使い回すなら本数分、別々ならアカウント数 × 本数
  let videos = 0;
  if (v && v.accounts > 0) {
    let posts = 0;
    for (let k = 0; k < v.days; k++) posts += Math.floor((k + 1) * v.posts_per_account_per_day + 1e-9) - Math.floor(k * v.posts_per_account_per_day + 1e-9);
    videos = (v.unique_videos_per_account ? v.accounts : 1) * posts;
  }
  return { ads, videos, video: v ? videos * v.cost_per_video_jpy : 0 };
}

export function LivePage() {
  const { manifest, error: manifestError } = useManifest();
  const live = useLive();
  const [form, setForm] = useState<LiveOverrides | null>(null);
  const [scale, setScale] = useState<Scale>("japan");

  useEffect(() => {
    if (manifest && !form) setForm(live.result ? structuredClone(live.result.overrides) : toOverrides(manifest));
  }, [manifest, form, live.result]);

  const dirty = useMemo(() => !live.result || !form || JSON.stringify(form) !== JSON.stringify(live.result.overrides), [form, live.result]);
  const busy = live.phase === "loading" || live.phase === "running";

  if (manifestError) {
    return (
      <section className="section">
        <h1 className="h1">ライブで試す</h1>
        <p className="error-box">{manifestError}</p>
      </section>
    );
  }
  if (!manifest || !form) return <p className="muted">読み込んでいます…</p>;

  const setPlan = (k: PlanKey, patch: Partial<LivePlanInput>) => setForm({ ...form, plans: { ...form.plans, [k]: { ...form.plans[k], ...patch } } });
  const setPeriod = (d: number) => {
    // キャンペーン日数と動画の日数は期間を超えない（エンジンも同じように切る）
    const clip = (p: LivePlanInput): LivePlanInput => ({
      ...p,
      campaign_days: Math.min(p.campaign_days, d),
      organic_video: p.organic_video ? { ...p.organic_video, days: Math.min(p.organic_video.days, d) } : null,
    });
    setForm({ ...form, period_days: d, plans: { A: clip(form.plans.A), B: clip(form.plans.B) } });
  };

  return (
    <>
      <section className="section" aria-labelledby="live-h">
        <div style={{ display: "grid", gap: 10 }}>
          <p className="eyebrow">ライブで試す</p>
          <h1 className="h1" id="live-h">
            条件を変えて、エンジンをもう一度回す
          </h1>
          <p className="lead">
            デモアプリ「{manifest.name_ja}」の A案・B案の条件を変えて、あなたのブラウザの中で世界エンジンを回します。サーバーにも Claude にも送りません。
          </p>
        </div>
        <ul className="live-facts">
          <li>
            <strong>判断は事前に取ったものです。</strong>1万人のうちインストールできる {manifest.decisions.people.toLocaleString("ja-JP")}人に Claude
            が出した「平均より進みやすいか」の判断（{manifest.decisions.rows.toLocaleString("ja-JP")}件）をそのまま使います。条件を変えても、1万人の反応の理由は変わりません。
          </li>
          <li>
            <strong>数字はエンジンが作ります。</strong>予算・地域・価格・期間から、届く人数・密度・クチコミ・決済をエンジンが毎日計算します。事前計算と同じ Python のエンジンです。
          </li>
          <li>
            <strong>動画のチャネルはバックテストで検証していません。</strong>ルールを固定した後に足した機能で、値の多くは仮定です。
          </li>
        </ul>
      </section>

      <section className="section" aria-labelledby="cond-h">
        <h2 className="h2" id="cond-h">
          条件
        </h2>
        <div className="live-common">
          <div className="live-field">
            <span className="live-label">期間（両案共通）</span>
            <div className="seg" role="group" aria-label="期間">
              {PERIODS.map((d) => (
                <button key={d} type="button" aria-pressed={form.period_days === d} onClick={() => setPeriod(d)}>
                  {d}日
                </button>
              ))}
            </div>
            <span className="note">エンジンは両案を長いほうの期間で計算するので、期間は共通にしています。90日より後は推計の延長です。</span>
          </div>
          <div className="live-field">
            <span className="live-label">試す回数</span>
            <div className="seg" role="group" aria-label="試す回数">
              {RUN_CHOICES.map((n) => (
                <button key={n} type="button" aria-pressed={form.runs === n} onClick={() => setForm({ ...form, runs: n })}>
                  {n}回
                </button>
              ))}
            </div>
            <span className="note">事前計算のデモは30回。ここでは速さのため10回が既定です（幅が少し粗くなります）。</span>
          </div>
        </div>

        <div className="live-plans">
          {PLAN_KEYS.map((k) => (
            <PlanForm
              key={k}
              id={k}
              plan={form.plans[k]}
              period={form.period_days}
              creatives={manifest.defaults.plans[k].creatives}
              videoCreatives={manifest.defaults.plans[k].video_creatives}
              videoTemplate={manifest.defaults.video_template}
              onChange={(p) => setPlan(k, p)}
            />
          ))}
        </div>

        <div className="live-materials">
          <h3 className="h3">広告と動画の素材は変えられません</h3>
          <p className="note">
            Claude の判断は「この広告（動画の見本）を見たとき」の反応で、素材ごとに取ってあります。素材を変えると判断を取り直す必要があり、ブラウザの中ではできないためです。
          </p>
          <div className="live-thumbs">
            {PLAN_KEYS.flatMap((k) =>
              [...manifest.defaults.plans[k].creatives, ...manifest.defaults.plans[k].video_creatives].map((c) => (
                <figure key={`${k}-${c}`}>
                  <img src={`apps/${manifest.app_id}/ads/${c}.png`} alt={`${k}案の素材 ${c}`} loading="lazy" />
                  <figcaption>
                    <span style={{ color: PLAN_VAR[k], fontWeight: 700 }}>{k}案</span> {c.startsWith("v") ? "動画" : "広告"} {c}
                  </figcaption>
                </figure>
              )),
            )}
          </div>
          <ul className="live-caveats">
            <li>エンジンは広告の判断をチャネルと結びつけていません。A案に YouTube・LINE・電車の広告・大学を足しても、判断は A案の広告 a1〜a3 の平均をどのチャネルにも同じに使います。</li>
            <li>B案は広告の素材を持たないので、B案に広告を足すと、エンジンは install の最初の判断（動画の見本 v1）を広告の判断として使います。</li>
            <li>A案に動画を足すと、動画の見本の判断が無いので、A案の広告 a1〜a3 の判断の平均を動画にも使います。</li>
          </ul>
        </div>

        <RunBar
          live={live}
          manifest={manifest}
          dirty={dirty}
          busy={busy}
          onRun={() => runLive(structuredClone(form))}
          onReset={() => setForm(toOverrides(manifest))}
        />
      </section>

      {live.result && (
        <section className="section live-result" aria-labelledby="live-result-h">
          <div style={{ display: "grid", gap: 8 }}>
            <p className="eyebrow">ライブの結果</p>
            <h2 className="h2" id="live-result-h">
              この条件で{live.result.replay.meta.runs}回試した結果
            </h2>
            <p className="note">
              {PLAN_KEYS.map((k) => {
                const p = live.result!.overrides.plans[k];
                return (
                  <span key={k} style={{ display: "block" }}>
                    <PlanName id={k} /> {regionLabel(p.regions)}・{summary(p)}
                  </span>
                );
              })}
            </p>
            {dirty && !busy && <p className="live-stale">条件を変えました。下の結果は前の条件のものです。「この条件で回す」で計算し直せます。</p>}
            <p className="caveat">
              インタビュー・レポート・離れた理由・一人ずつの判断の理由は、事前計算のデモ（<a href={href("result")}>結果</a>）だけにあります。ライブでは出しません（理由の文は条件を変えても同じで、人数だけが変わるため）。
            </p>
          </div>
          <ResultPage key={live.result.id} replay={live.result.replay} scale={scale} onScale={setScale} autoplay={false} onAutoplayDone={() => {}} />
        </section>
      )}
    </>
  );
}

function regionLabel(prefs: number[]): string {
  return REGION_PRESETS.find((r) => sameSet(r.prefs, prefs))?.label ?? regionText(prefs);
}

function summary(p: LivePlanInput): string {
  const s = spendOf(p);
  const parts: string[] = [];
  const ch = Object.entries(p.channels).filter(([, v]) => v > 0);
  if (ch.length) parts.push(`広告 ${ch.map(([c, v]) => `${CHANNEL_JA[c] ?? c} ${yen(v)}`).join("・")}（${p.campaign_days}日）`);
  if (p.organic_video) parts.push(`動画 ${p.organic_video.accounts}アカウント × 1日${p.organic_video.posts_per_account_per_day}本 × ${p.organic_video.days}日（制作費 ${yen(s.video)}）`);
  if (!parts.length) parts.push("広告も動画もなし");
  parts.push(`男性月額 ${yen(p.monthly_jpy)}`);
  return parts.join("・");
}

// ---- 案ごとの条件 ----

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  suffix,
  note,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  note?: string;
}) {
  // 入力中の文字列は手元に持ち、数として読めたときだけ反映する（消して打ち直せるように）
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="live-num">
      <span className="live-label">{label}</span>
      <span className="live-input">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(v)) onChange(Math.max(min, max !== undefined ? Math.min(max, v) : v));
          }}
          onBlur={() => setText(String(value))}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </span>
      {note && <span className="note">{note}</span>}
    </label>
  );
}

interface PlanFormProps {
  id: PlanKey;
  plan: LivePlanInput;
  period: number;
  creatives: string[];
  videoCreatives: string[];
  videoTemplate: VideoInput;
  onChange: (p: Partial<LivePlanInput>) => void;
}

function PlanForm({ id, plan, period, creatives, videoCreatives, videoTemplate, onChange }: PlanFormProps) {
  const rid = regionId(plan.regions);
  const s = spendOf(plan);
  const v = plan.organic_video;
  const setVideo = (patch: Partial<VideoInput>) => onChange({ organic_video: { ...(v ?? videoTemplate), ...patch } });
  const noCreativeChannels = Object.entries(plan.channels).some(([, yen]) => yen > 0) && creatives.length === 0;

  return (
    <fieldset className="live-plan" style={{ borderColor: PLAN_VAR[id] }}>
      <legend>
        <PlanName id={id} />
      </legend>

      <label className="live-num">
        <span className="live-label">地域（出荷地域 ＝ 広告の地域）</span>
        <select
          value={rid}
          onChange={(e) => {
            const r = REGION_PRESETS.find((x) => x.id === e.target.value);
            if (r) onChange({ regions: [...r.prefs] });
          }}
        >
          {REGION_PRESETS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
          {rid === "custom" && <option value="custom">{regionText(plan.regions)}</option>}
        </select>
        <span className="note">地域の外ではアプリを使えません。動画は地域を絞れず全国に届きますが、地域の外の人は設置しません。</span>
      </label>

      <div className="live-group">
        <span className="live-label">チャネル別の広告費</span>
        <div className="live-channels">
          {CHANNELS.map((c) => (
            <NumberField
              key={c.id}
              label={c.label}
              value={Math.round((plan.channels[c.id] ?? 0) / 1e4)}
              step={10}
              suffix="万円"
              note={c.note}
              onChange={(man) => onChange({ channels: { ...plan.channels, [c.id]: man * 1e4 } })}
            />
          ))}
        </div>
        <NumberField
          label="キャンペーン日数（広告費をこの日数で等分）"
          value={plan.campaign_days}
          min={1}
          max={period}
          suffix="日"
          onChange={(d) => onChange({ campaign_days: Math.round(d) })}
        />
        <p className="note">
          広告素材: {creatives.length ? creatives.join("・") : "なし"}（固定）。オンライン広告は20〜34歳に出します。
          {noCreativeChannels && " この案は広告の素材を持たないので、広告の判断には動画の見本 v1 の判断が使われます。"}
        </p>
      </div>

      <div className="live-group">
        <span className="live-label">価格</span>
        <div className="live-row2">
          <NumberField label="男性の月額" value={plan.monthly_jpy} step={100} suffix="円" onChange={(y) => onChange({ monthly_jpy: Math.round(y) })} />
          <NumberField label="無料体験" value={plan.free_trial_days} max={60} suffix="日" onChange={(d) => onChange({ free_trial_days: Math.round(d) })} />
        </div>
        <p className="note">女性は無料のまま。無料体験の日数は、マッチングのプリセットではエンジンが使いません（変えても数字は変わりません。サブスク・習慣のアプリ向けの項目です）。</p>
      </div>

      <div className="live-group">
        <label className="live-check">
          <input type="checkbox" checked={!!v} onChange={(e) => onChange({ organic_video: e.target.checked ? { ...videoTemplate, days: Math.min(videoTemplate.days, period) } : null })} />
          <span className="live-label">動画の大量投稿（広告費なし、自社アカウントから毎日投稿）</span>
        </label>
        {v && (
          <>
            <div className="live-row2">
              <NumberField label="アカウント数" value={v.accounts} min={1} max={100} onChange={(n) => setVideo({ accounts: Math.round(n) })} />
              <NumberField label="1アカウント1日の本数" value={v.posts_per_account_per_day} min={0.1} max={10} step={0.5} suffix="本" onChange={(n) => setVideo({ posts_per_account_per_day: n })} />
              <NumberField label="投稿する日数" value={v.days} min={1} max={period} suffix="日" onChange={(n) => setVideo({ days: Math.round(n) })} />
              <NumberField label="1本の制作費" value={v.cost_per_video_jpy} step={50} suffix="円" onChange={(n) => setVideo({ cost_per_video_jpy: Math.round(n) })} />
            </div>
            <label className="live-check">
              <input type="checkbox" checked={!v.unique_videos_per_account} onChange={(e) => setVideo({ unique_videos_per_account: !e.target.checked })} />
              <span>同じ動画を全アカウントで使い回す（制作は少なくて済むが、推薦されにくくなる）</span>
            </label>
            <p className="note">
              TikTok・リール・ショートに投稿。動画の見本: {videoCreatives.length ? videoCreatives.join("・") : `なし（A案の広告 ${creatives.join("・")} の判断を使う）`}（固定）。
              同じ動画の使い回しや一般人を装う運用は、各社の規約やステルスマーケティング規制に当たるおそれがあります。
            </p>
            <p className="caveat">動画のチャネルはバックテストで検証していません。</p>
          </>
        )}
      </div>

      <p className="live-total num">
        費用 {yen(s.ads + s.video)}
        <span className="note">
          （広告 {yen(s.ads)}
          {v ? `・動画 ${s.videos.toLocaleString("ja-JP")}本 ${yen(s.video)}` : ""}）
        </span>
      </p>
    </fieldset>
  );
}

// ---- 実行ボタンと進み具合 ----

function RunBar({
  live,
  manifest,
  dirty,
  busy,
  onRun,
  onReset,
}: {
  live: ReturnType<typeof useLive>;
  manifest: LiveManifest;
  dirty: boolean;
  busy: boolean;
  onRun: () => void;
  onReset: () => void;
}) {
  const first = live.loadSeconds === null;
  return (
    <div className="live-run" aria-live="polite">
      <div className="live-buttons">
        <button type="button" className="cta" disabled={busy} onClick={onRun}>
          {live.phase === "loading" ? "エンジンを読み込んでいます…" : live.phase === "running" ? "計算しています…" : first ? "エンジンを読み込んで回す" : "この条件で回す"}
        </button>
        <button type="button" className="live-reset" disabled={busy} onClick={onReset}>
          元の条件（app.yaml）に戻す
        </button>
        {first && live.phase === "idle" && (
          <button type="button" className="live-reset" onClick={startLive}>
            先に読み込むだけ
          </button>
        )}
      </div>
      {first && (
        <p className="note">
          初回は、ブラウザで動く Python（Pyodide）と numpy・pandas を CDN から読み込みます。合わせて約20MB（転送は約14MB）で、回線によって数十秒かかります。
          エンジンと1万人・判断のファイルは {(manifest.total_gzip_bytes / 1e6).toFixed(1)}MB（圧縮後）です。2回目からは計算だけです。
        </p>
      )}
      {(busy || live.progress) && (
        <div className="live-busy">
          {busy && <Mascot pose="busy" size={56} />}
          {live.progress && (
            <div className="live-progress">
              <div className="bar">
                <span style={{ width: `${Math.round(live.progress.ratio * 100)}%` }} />
              </div>
              <span className="note">{live.progress.text}</span>
            </div>
          )}
        </div>
      )}
      {live.error && <p className="error-box">うまく動きませんでした: {live.error}</p>}
      {(live.loadSeconds !== null || live.result) && (
        <p className="note num">
          {live.loadSeconds !== null && `読み込み ${live.loadSeconds.toFixed(1)}秒`}
          {live.result && ` ・ 前回の計算 ${live.result.seconds.toFixed(1)}秒（${live.result.replay.meta.runs}回）`}
          {live.pyodide && ` ・ Pyodide ${live.pyodide}`}
        </p>
      )}
      {!dirty && live.result && !busy && <p className="note">いまの条件の結果を表示しています。</p>}
    </div>
  );
}
