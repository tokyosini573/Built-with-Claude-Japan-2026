// 入力: 1段目 = アプリ画面5枚と A案・B案の条件カード。2段目 = カードを押すと広告素材・関門・価格。

import { useEffect, useState } from "react";
import { APP_ASSET_DIR, DEFAULT_SCREENS, MOCK_ASSET_APP_ID, ORGANIC_VIDEO_NOTE_JA } from "../config";
import { CHANNEL_JA, gateName, regionText, yen } from "../lib/labels";
import { planIds, type PlanConfig, type PlanId, type Replay } from "../lib/replay";
import { PLAN_VAR } from "./ui";

/** public/apps/<app_id>/app.json（任意）。app.yaml から作る想定 */
interface AppManifest {
  name_ja?: string;
  description_ja?: string;
  screens?: { src: string; label_ja: string }[];
  gates?: { id: string; name_ja?: string; docs_ja?: string; review_hours?: number }[];
  /** creative ID → 画像の相対パス */
  creatives?: Record<string, string>;
}

function assetBase(replay: Replay): string {
  const appId = replay.meta.is_mock ? MOCK_ASSET_APP_ID : replay.meta.app_id;
  return `${import.meta.env.BASE_URL}${APP_ASSET_DIR.replace("<app_id>", appId)}`;
}

function useManifest(base: string): AppManifest {
  const [m, setM] = useState<AppManifest>({});
  useEffect(() => {
    const ac = new AbortController();
    fetch(`${base}app.json`, { signal: ac.signal })
      .then((r) => (r.ok && !(r.headers.get("content-type") ?? "").includes("text/html") ? r.json() : {}))
      .then((d) => setM(d as AppManifest))
      .catch(() => {});
    return () => ac.abort();
  }, [base]);
  return m;
}

function Shot({ src, label, square = false }: { src: string; label: string; square?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure className="shot">
      <div className="frame">
        {failed ? <span className="placeholder">画像の準備中</span> : <img src={src} alt={label} loading="lazy" onError={() => setFailed(true)} />}
      </div>
      {!square && <figcaption>{label}</figcaption>}
    </figure>
  );
}

export function InputPage({ replay }: { replay: Replay }) {
  const base = assetBase(replay);
  const manifest = useManifest(base);
  const screens = manifest.screens ?? DEFAULT_SCREENS;
  const [open, setOpen] = useState(false);
  const ids = planIds(replay);

  return (
    <>
      <section className="section" aria-labelledby="app-h">
        <div style={{ display: "grid", gap: 8 }}>
          <p className="eyebrow">試したアプリ（架空）</p>
          <h1 className="h1" id="app-h">
            {manifest.name_ja ?? replay.meta.name_ja}
          </h1>
          {manifest.description_ja && <Description text={manifest.description_ja} />}
        </div>
        <div className="screens" tabIndex={0} aria-label="アプリの画面">
          {screens.slice(0, 5).map((s) => (
            <Shot key={s.src} src={base + s.src} label={s.label_ja} />
          ))}
        </div>
      </section>

      <section className="section" aria-labelledby="plans-h">
        <div style={{ display: "grid", gap: 6 }}>
          <h2 className="h2" id="plans-h">
            比べた2つの案
          </h2>
          <p className="note">カードの下のボタンで、広告や動画の見本・関門・価格が出ます。</p>
        </div>
        <div className="cards2">
          {ids.map((id) => (
            <PlanCard key={id} id={id} replay={replay} config={replay.plans[id]!.config} open={open} onToggle={() => setOpen(!open)} base={base} manifest={manifest} />
          ))}
        </div>
      </section>
    </>
  );
}

interface OrganicVideo {
  platforms?: string[];
  accounts?: number;
  posts_per_account_per_day?: number;
  days?: number;
  cost_per_video_jpy?: number;
  creative_ids?: string[];
}

const VIDEO_PLATFORM_JA: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram リール", youtube: "YouTube ショート" };

function totalSpend(c: PlanConfig): number {
  return Object.values(c.channels ?? {}).reduce((s, v) => s + (Number(v) || 0), 0);
}

function targetText(c: PlanConfig): string {
  const t = c.target;
  if (!t) return "指定なし";
  const age = t.age ? `${t.age[0]}〜${t.age[1]}歳` : "全年齢";
  const sex = t.sex === "M" || t.sex === "male" ? "男性" : t.sex === "F" || t.sex === "female" ? "女性" : "男女";
  return `${age}・${sex}`;
}

function PlanCard({
  id,
  replay,
  config,
  open,
  onToggle,
  base,
  manifest,
}: {
  id: PlanId;
  replay: Replay;
  config: PlanConfig;
  open: boolean;
  onToggle: () => void;
  base: string;
  manifest: AppManifest;
}) {
  const pricing = (config.pricing ?? {}) as { monthly_jpy?: number; free_trial_days?: number; who_pays?: string };
  const gates = manifest.gates ?? replay.meta.gates ?? [];
  const creatives = config.creatives ?? [];
  const video = (config.organic_video ?? null) as OrganicVideo | null;
  const spendBand = replay.plans[id]!.totals.spend_jpy;
  const spend = spendBand ? Math.round(spendBand.p50 * replay.meta.scale_to_japan) : null;
  const changes = Array.isArray(config.changes) ? (config.changes as { day: number; pricing?: Record<string, unknown>; channels?: Record<string, number> }[]) : [];
  const creativeSrc = (c: string) => base + (manifest.creatives?.[c] ?? (c.includes("/") ? c : `ads/${c}.png`));

  return (
    <div className="card plan-card" style={{ ["--c" as string]: PLAN_VAR[id], display: "grid", gap: 16, alignContent: "start" }}>
      <span className="plan-tag" style={{ color: PLAN_VAR[id], fontSize: 28 }}>
        {id}案
      </span>
      <dl className="kv">
        <dt>地域</dt>
        <dd>{regionText(config.regions)}</dd>
        {video ? (
          <>
            <dt>費用</dt>
            <dd>
              <strong>{spend !== null ? yen(spend) : "—"}</strong>（動画の制作費。広告費なし）
            </dd>
            <dt>動画の投稿</dt>
            <dd>
              {video.accounts ?? "—"}アカウント × 毎日{video.posts_per_account_per_day ?? 1}本 × {video.days ?? "—"}日
              {video.cost_per_video_jpy ? `、1本 ${yen(video.cost_per_video_jpy)}` : ""}
            </dd>
            <dt>投稿先</dt>
            <dd>{(video.platforms ?? []).map((p) => VIDEO_PLATFORM_JA[p] ?? p).join("・")}</dd>
          </>
        ) : (
          <>
            <dt>広告費</dt>
            <dd>
              <strong>{yen(spend ?? totalSpend(config))}</strong>
              {config.campaign_days ? `（${config.campaign_days}日間）` : ""}
            </dd>
            <dt>広告の場所</dt>
            <dd>{Object.keys(config.channels ?? {}).map((ch) => CHANNEL_JA[ch] ?? ch).join("・") || "なし"}</dd>
          </>
        )}
        <dt>届ける相手</dt>
        <dd>{targetText(config)}</dd>
      </dl>

      {open && (
        <div style={{ display: "grid", gap: 20, borderTop: "1px solid var(--line)", paddingTop: 20 }}>
          {Object.keys(config.channels ?? {}).length > 0 && (
          <div style={{ display: "grid", gap: 8 }}>
            <h3 className="h3">広告費の内訳</h3>
            <dl className="kv">
              {Object.entries(config.channels ?? {}).map(([ch, v]) => (
                <div key={ch} style={{ display: "contents" }}>
                  <dt>{CHANNEL_JA[ch] ?? ch}</dt>
                  <dd className="num">{yen(Number(v))}</dd>
                </div>
              ))}
            </dl>
          </div>
          )}
          {video && (video.creative_ids ?? []).length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              <h3 className="h3">動画の見本</h3>
              <div className="creatives">
                {(video.creative_ids ?? []).map((c) => (
                  <Shot key={c} src={creativeSrc(c)} label={`${id}案の動画の見本 ${c}`} square />
                ))}
              </div>
              <p className="note">アカウントごとに内容の違う動画を、アプリ公式・AI 生成と明示して投稿する前提です。</p>
            </div>
          )}
          {video && <p className="caveat">{ORGANIC_VIDEO_NOTE_JA}</p>}
          {creatives.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              <h3 className="h3">広告の素材</h3>
              <div className="creatives">
                {creatives.map((c) => (
                  <Shot key={c} src={creativeSrc(c)} label={`${id}案の広告 ${c}`} square />
                ))}
              </div>
            </div>
          )}
          <div style={{ display: "grid", gap: 8 }}>
            <h3 className="h3">関門</h3>
            {gates.length === 0 ? (
              <p>なし</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                {gates.map((g) => {
                  const m = g as { id: string; name_ja?: string; docs_ja?: string; review_hours?: number };
                  return (
                    <li key={m.id}>
                      {m.name_ja || gateName(m.id, replay)}
                      {m.docs_ja && `（${m.docs_ja}）`}
                      {m.review_hours ? `。審査に${m.review_hours}時間` : ""}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            <h3 className="h3">価格</h3>
            <dl className="kv">
              <dt>月額</dt>
              <dd>{pricing.monthly_jpy !== undefined ? yen(pricing.monthly_jpy) : "—"}</dd>
              <dt>払う人</dt>
              <dd>{pricing.who_pays === "male" ? "男性のみ（女性は無料）" : pricing.who_pays === "female" ? "女性のみ" : pricing.who_pays === "all" ? "全員" : (pricing.who_pays ?? "—")}</dd>
              <dt>無料体験</dt>
              <dd>{pricing.free_trial_days ? `${pricing.free_trial_days}日間` : "なし"}</dd>
            </dl>
          </div>
          {changes.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              <h3 className="h3">途中で変えたこと</h3>
              <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                {changes.map((c, i) => (
                  <li key={i}>
                    {c.day}日目から
                    {c.pricing && ` 価格を変更（${"monthly_jpy" in c.pricing ? `月額 ${yen(Number(c.pricing.monthly_jpy))}` : "条件"}）`}
                    {c.channels && ` 広告費を変更（合計 ${yen(Object.values(c.channels).reduce((s, v) => s + Number(v), 0))}）`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="note">期間: {config.period_days ?? replay.meta.period_days}日</p>
        </div>
      )}
      <button type="button" className="btn" style={{ justifySelf: "start" }} aria-expanded={open} onClick={onToggle}>
        {open ? "閉じる ▲" : video ? "動画の見本・関門・価格を見る ▼" : "広告・関門・価格を見る ▼"}
      </button>
    </div>
  );
}

/** 説明の最初の1文を大きく、残りは小さく */
function Description({ text }: { text: string }) {
  const t = text.replace(/\s+/g, "");
  const i = t.indexOf("。");
  const head = i >= 0 ? t.slice(0, i + 1) : t;
  const rest = i >= 0 ? t.slice(i + 1) : "";
  return (
    <>
      <p className="lead">{head}</p>
      {rest && <p className="note" style={{ maxWidth: "46em" }}>{rest}</p>}
    </>
  );
}
