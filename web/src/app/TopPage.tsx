// トップ: 初めての人が「テプリが何で、なぜ信じられるか」を一本の流れで分かる1枚のページ。
// 流れ: ヒーロー → 解決したいこと → 例えば（デモの結果）→ しくみ（4つの部品・1人を追う・日本の条件）→ なぜ信じられるか → Claude の使い方 → はじめる。
// 各節は見出し1つ・図1つ・短い文2つまで。細かい説明は「?」（InfoTip）か <details> に入れる。
// デモとバックテストの数字は画面で書かず、リプレイと backtest.json から読む。

import { useEffect, useState, type ReactNode } from "react";
import { HeroDots, HeroRegionList, HERO_LEGEND, InfoTip } from "../components/HeroDots";
import { Mascot } from "../components/Mascot";
import { Decor, Wave } from "../components/Shapes";
import { HEADLINE_METRIC, ORGANIC_VIDEO_NOTE_JA, REPO_URL, UNCLEAR_RANGE } from "../config";
import { loadBacktest, summarize } from "../lib/backtest";
import { CHANNEL_JA, PREF_JA, metricName, regionText, stepName, yen } from "../lib/labels";
import { href } from "../lib/router";
import type { PersonDecision, PlanId, Replay } from "../lib/replay";
import type { ReplayStatus } from "../lib/useReplay";
import { PLAN_VAR, count } from "./ui";
import "./top.css";

interface Props {
  status: ReplayStatus;
  onPlay: () => void;
}

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

/**
 * スクロールで節が少しだけ浮かび上がる（.rv → .in）。動きを減らす設定では何もしない（CSS 側でも止める）。
 * 監視の通知が来ない環境（見えていないタブなど）でも内容が消えたままにならないよう、少し待って全部出す
 */
function useReveal() {
  useEffect(() => {
    const root = document.documentElement;
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>(".top .rv"));
    let fired = false;
    const io = new IntersectionObserver(
      (entries) => {
        fired = true;
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    root.classList.add("rv-ready");
    els.forEach((el) => io.observe(el));
    const fallback = window.setTimeout(() => {
      if (!fired) els.forEach((el) => el.classList.add("in"));
    }, 1500);
    return () => {
      io.disconnect();
      window.clearTimeout(fallback);
      root.classList.remove("rv-ready");
    };
  }, []);
}

export function TopPage({ status, onPlay }: Props) {
  const replay = status.kind === "ready" ? status.replay : null;
  const loading = status.kind === "loading";
  useReveal();
  return (
    <div className="top">
      <Hero />
      <Problem />
      <Demo replay={replay} loading={loading} />
      <How />
      <FollowOne replay={replay} loading={loading} />
      <Trust />
      <ClaudeUse />
      <Start onPlay={onPlay} />
    </div>
  );
}

type Tone = "brand" | "tint";

function Sec({ id, eyebrow, title, children, tone, aside, last }: { id: string; eyebrow: string; title: ReactNode; children: ReactNode; tone?: Tone; aside?: ReactNode; last?: boolean }) {
  const head = (
    <div className="tsec-head">
      <p className="eyebrow">{eyebrow}</p>
      <h2 className="h2" id={`${id}-h`}>
        {typeof title === "string" ? chunks(title) : title}
      </h2>
    </div>
  );
  return (
    <section className={`tsec${tone === "brand" ? " on-brand" : tone === "tint" ? " tint" : ""}`} id={id} aria-labelledby={`${id}-h`}>
      {tone === "brand" && <Wave position="top" />}
      {tone && <Decor kind={tone === "brand" ? (id === "start" ? "start" : "how") : "tint"} />}
      <div className="tsec-in rv">
        {aside ? (
          <div className="with-mascot">
            {head}
            {aside}
          </div>
        ) : (
          head
        )}
        {children}
      </div>
      {tone === "brand" && !last && <Wave position="bottom" />}
    </section>
  );
}

/** 見出しを「、」の後で区切り、スマホで語の途中で折り返さないようにする */
function chunks(text: string) {
  return text.split(/(?<=、)/).map((c, i) => (
    <span key={i} className="ib">
      {c}
    </span>
  ));
}

// ---- 1. ヒーロー ----

function Hero() {
  // 1人が表す人数（契約 §1: weight の合計 96,806,585 ÷ 1万人）。図のデータを読んだらその値にする
  const [scale, setScale] = useState({ population: 10000, perPerson: 96806585 / 10000 });
  const total = scale.population * scale.perPerson;
  // 再生の終わり（地方別の割合を出している間）。スマホでは地図の下の一覧をこのときだけ見せる
  const [revealed, setRevealed] = useState(false);
  return (
    <section className="hero on-brand" aria-labelledby="hero-h">
      <Decor kind="hero" />
      <div className="hero-in">
        <div className="hero-text">
          <div className="hero-head">
            <h1 className="hero-name" id="hero-h">テプリ</h1>
            <p className="hero-title">
              <span className="ib">アプリを出す前に、</span>
              <span className="ib">架空の日本で</span>
              <span className="ib">一度「発売」してみる。</span>
            </p>
          </div>
          <p className="lead">
            日本の統計から作った架空の日本人1万人の前でアプリを発売し、出し方2通り（A案とB案）の結果を、幅つきで比べるシミュレーターです。
          </p>
          {/* マスコットはボタンの横で大きく、右の地図を指す */}
          <div className="hero-cta">
            <button type="button" className="cta" onClick={() => scrollToId("start")}>
              デモを見る <span aria-hidden>↓</span>
            </button>
            <Mascot pose="point" className="hero-mascot" />
          </div>
        </div>
        <figure className="hero-fig hero-card">
          <div className="hero-stage">
            <HeroDots onPeople={(p) => setScale({ population: p.population, perPerson: p.scale_to_japan })} onReveal={setRevealed} />
          </div>
          <figcaption>
            <span className="hero-legend">
              {HERO_LEGEND.map((l) => (
                <span key={l.level}>
                  <span className={`swatch lv${l.level}`} />
                  {l.label}
                </span>
              ))}
            </span>
            <HeroRegionList shown={revealed} />
            <span className="note">地方ごとの%は全国の合計に占める割合で、デモ（ちかくに・A案）の1回分の結果です。</span>
            <span className="note">
              点1つが架空の1人で、人の多い都道府県ほど点が密になります。
              <InfoTip label="1人が表す人数と、色づき方について">
                1人は、似た属性を持つ実際の日本人 <span className="ib">約{Math.round(scale.perPerson).toLocaleString("ja-JP")}人</span>の代わりです（15〜79歳 <span className="ib">約{Math.round(total / 1e4).toLocaleString("ja-JP")}万人 ÷ {(scale.population / 1e4).toLocaleString("ja-JP")}万</span>）。色づき方はイメージで、実際の結果ではありません。
              </InfoTip>
            </span>
          </figcaption>
        </figure>
      </div>
      <Wave position="bottom" />
    </section>
  );
}

// ---- 2. 解決したいこと ----

function Problem() {
  const items = [
    { t: "試せるのは、発売のあと", d: "全国に広告を出すか、東京に絞るか。A/B テストも、お金をかけて発売した後でしかできません。", fix: "発売の前に、架空の1万人の前で何度でも試せます。" },
    { t: "同じ予算でも、結果は違う", d: "どの地域の、どの年代に、どの SNS で届くかで、インストールから課金までの流れが変わります。", fix: "地域・年代・SNS ごとに、インストールから課金までの人数を数えて比べます。" },
    { t: "アンケートは「地図」を見落とす", d: "マッチングアプリは、近くに相手がいないと続きません。一人に聞いても、まわりに誰がいるかは分かりません。", fix: "1万人を日本地図の上に置き、近くに相手がいるかまで数えます。" },
  ];
  return (
    <Sec id="problem" eyebrow="解決したいこと" aside={<Mascot pose="wonder" />} title={<><span className="ib">「出してみないと</span><span className="ib">分からない」を、</span><span className="ib">出す前に確かめる</span></>}>
      <ol className="points t-points">
        {items.map((x, i) => (
          <li key={x.t}>
            <div>
              <p className="t-q">問題 {i + 1}</p>
              <h3 className="h3">{x.t}</h3>
              <p>{x.d}</p>
              <p className="t-fix">
                <b>テプリなら</b>
                <span>{x.fix}</span>
              </p>
            </div>
          </li>
        ))}
      </ol>
      <p className="t-bridge">
        <strong>
          <span className="ib">テプリは、本番の前の</span>
          <span className="ib">「通し稽古」です。</span>
        </strong>
        <span>架空の1万人の前で、A案と B案を安く何度でも試せます。</span>
      </p>
    </Sec>
  );
}

// ---- 3. 例えば（デモの結果を先に） ----

export function planSummary(replay: Replay, id: PlanId): { title: string; detail: string; cost: string | null; video: boolean } {
  const plan = replay.plans[id];
  if (!plan) return { title: `${id}案`, detail: "", cost: null, video: false };
  const c = plan.config;
  const k = replay.meta.scale_to_japan;
  const spend = plan.totals.spend_jpy ? yen(Math.round(plan.totals.spend_jpy.p50 * k)) : null;
  const video = c.organic_video as { accounts?: number; posts_per_account_per_day?: number; days?: number } | undefined;
  if (video) {
    return {
      title: "AI 動画の大量投稿",
      detail: `広告は出さず、AI で作った短い動画を${video.accounts}アカウントから毎日${video.posts_per_account_per_day}本、${video.days}日間投稿`,
      cost: spend && `制作費 ${spend}`,
      video: true,
    };
  }
  const ch = Object.entries(c.channels ?? {})
    .map(([name, v]) => `${CHANNEL_JA[name] ?? name} ${yen(v)}`)
    .join("・");
  return {
    title: "SNS 広告",
    detail: `${regionText(c.regions)}に ${ch}${c.campaign_days ? `（${c.campaign_days}日）` : ""}`,
    cost: spend && `広告費 ${spend}`,
    video: false,
  };
}

/** 結論の見出し（区切りごと）。数字は comparison.p_B_better から。はっきりしないときだけ「費用」へつなぐ */
function demoHeadline(replay: Replay): { parts: string[]; unclear: boolean; sub: string } | null {
  const p = replay.comparison?.p_B_better[HEADLINE_METRIC];
  if (p === undefined) return null;
  const name = metricName(HEADLINE_METRIC, replay);
  const runs = replay.meta.runs;
  const wins = Math.round(p * runs);
  const sub = `同じ条件で${runs}回ずつ試し、${name}の数で B案が上回ったのは${runs}回中${wins}回でした。`;
  if (p >= UNCLEAR_RANGE[1]) return { parts: [`${name}は、`, `B案のほうが多い確率 ${Math.round(p * 100)}%。`], unclear: false, sub };
  if (p <= UNCLEAR_RANGE[0]) return { parts: [`${name}は、`, `A案のほうが多い確率 ${Math.round((1 - p) * 100)}%。`], unclear: false, sub };
  return {
    parts: [`${name}の数は、`, "引き分け。"],
    unclear: true,
    sub: `1回だけの試しでは、偶然の差が「勝ち」に見えます。テプリは同じ条件で${runs}回くり返すので（B案が多かったのは${wins}回）、その偶然を見分けられます。`,
  };
}

function Demo({ replay, loading }: { replay: Replay | null; loading: boolean }) {
  const ids: PlanId[] = ["A", "B"];
  const head = replay ? demoHeadline(replay) : null;
  const cpi = replay ? ids.map((id) => replay.plans[id]?.totals.cpi_jpy?.p50) : [];
  const hasCpi = cpi.length === 2 && cpi.every((v) => v !== undefined && v > 0);
  const maxCpi = hasCpi ? Math.max(...(cpi as number[])) : 1;
  // 安いほうが何分の1か（2倍以上違うときだけ見出しに出す）
  const cheap = hasCpi
    ? (() => {
        const [a, b] = cpi as number[];
        const ratio = Math.round(Math.max(a, b) / Math.min(a, b));
        return ratio >= 2 ? { id: a < b ? "A" : "B", ratio } : null;
      })()
    : null;
  const k = replay?.meta.scale_to_japan ?? 1;
  const core = replay ? ids.map((id) => replay.plans[id]?.totals[HEADLINE_METRIC]) : [];
  return (
    <Sec
      id="demo"
      eyebrow="例えば"
      tone="tint"
      title={<><span className="ib">架空のマッチングアプリ</span><span className="ib">「{replay?.meta.name_ja ?? "ちかくに"}」を、</span><span className="ib">2通りの出し方で発売してみた</span></>}
    >
      <p className="lead">20〜30代向けで本人確認が必須の、架空の恋愛マッチングアプリです。</p>
      {replay ? (
        <div className="t-demo">
          <div className="t-vs">
            {ids.map((id, i) => {
              const s = planSummary(replay, id);
              return (
                <div key={id} className="t-vs-item">
                  {i === 1 && <span className="t-vs-mark" aria-hidden>VS</span>}
                  <div className="card plan-card t-plan" style={{ ["--c" as string]: PLAN_VAR[id] }}>
                    <p className="plan-tag t-plan-name" style={{ color: PLAN_VAR[id] }}>
                      {id}案 ・ {s.title}
                    </p>
                    {s.cost && (
                      <p className="t-plan-cost num">
                        {s.cost}
                        {s.video && (
                          <InfoTip label="動画の案についての注意">
                            {ORGANIC_VIDEO_NOTE_JA}
                          </InfoTip>
                        )}
                      </p>
                    )}
                    <p className="t-plan-detail">{s.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>

          {head && (
            <div className="card t-result">
              <h3 className="t-claim">
                {head.parts.map((t) => (
                  <span key={t} className="ib">
                    {t}
                  </span>
                ))}
                {core.every((b) => b) && (
                  <InfoTip label={`${metricName(HEADLINE_METRIC, replay)}の人数`}>
                    {metricName(HEADLINE_METRIC, replay)}の人数（日本全体・{replay.meta.runs}回の中央値）は A案 {count(core[0]!.p50 * k)}人、B案 {count(core[1]!.p50 * k)}人。ただし10〜90%の幅は A案 {count(core[0]!.p10 * k)}〜{count(core[0]!.p90 * k)}人、B案 {count(core[1]!.p10 * k)}〜{count(core[1]!.p90 * k)}人で、大きく重なります。
                  </InfoTip>
                )}
                {head.unclear && cheap && (
                  <span className="t-claim-2">
                    <span className="ib">1インストールあたりの</span>
                    <span className="ib">費用は、</span>
                    <span className="ib">{cheap.id}案が約{cheap.ratio}分の1。</span>
                  </span>
                )}
              </h3>
              <p className="secondary t-claim-sub">{head.sub}</p>
              {hasCpi && (
                <figure className="t-cpi">
                  <figcaption>1インストールあたりの費用（かけた費用 ÷ インストール数。{replay.meta.runs}回の中央値）</figcaption>
                  {ids.map((id, i) => (
                    <div key={id} className="t-cpi-row">
                      <span className="t-cpi-label" style={{ color: PLAN_VAR[id] }}>{id}案</span>
                      <span className="t-cpi-track">
                        <span className="t-cpi-fill" style={{ width: `${Math.max(2, (cpi[i]! / maxCpi) * 100)}%`, background: PLAN_VAR[id] }} />
                      </span>
                      <span className="t-cpi-val num">{count(cpi[i]!)}円</span>
                    </div>
                  ))}
                </figure>
              )}
              {replay.meta.is_mock && <p className="note">いまはモックの数字です。根拠はありません。</p>}
            </div>
          )}
        </div>
      ) : (
        <p className="note">{loading ? "結果を読み込んでいます…" : "デモの結果を読み込めませんでした。"}</p>
      )}
    </Sec>
  );
}

// ---- 4. しくみ ----

function How() {
  const steps = [
    { n: "1", name: "人口", sub: "統計から1万人", ai: "AI を使わない", d: "国勢調査2025などの政府統計から、年齢・性別・都道府県・仕事・収入・スマホ・SNS・性格の傾向を持つ1万人を作ります。" },
    { n: "2", name: "判断", sub: "Claude が一人ひとりの立場で", ai: "Claude", d: "広告を見て、入れて、登録して、本人確認して、使って、払うかどうかを、「同じ種類のアプリの平均より 高い / 同じ / 低い」とその理由で答えます。" },
    { n: "3", name: "エンジン", sub: "人数を数えるのはエンジン", ai: "AI を使わない", d: "実際のアプリの平均（例: マッチングアプリでは、入れた人の約47%が登録する。出典つき）を出発点に、Claude の「高い / 低い」で上げ下げして、毎日何人が先へ進むかを数えます。30回くり返すので、結果は「◯人〜◯人」の幅で出ます。" },
    { n: "4", name: "結果", sub: "見て、読んで、聞ける", ai: "Claude は文章だけ", d: "1万人が日本地図の上で動く様子を再生できます。どこで何人が離れたか、なぜやめたかを Claude がまとめ、気になる一人に「なぜやめたの？」と聞くこともできます。数字はすべてエンジンが数えたものです。" },
  ];
  return (
    <Sec id="how" eyebrow="しくみ" title={<><span className="ib">Claude は判断するだけ。</span><span className="ib">人数はエンジンが数える</span></>} tone="brand">
      <p className="lead">
        テプリは4つの部品でできています。Claude が受け持つのは、一人ひとりの判断（2）と結果の文章（4）だけ。人数は、統計（1）と出典のある平均をもとに、AI を使わないエンジン（3）が数えます。だから AI が、もっともらしい数字をつくることはありません。
      </p>
      <div className="flow-wrap">
        {/* 番号をつなぐ流れ（広い画面だけ） */}
        <svg className="flow-line" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path d="M60 34 C 160 4, 230 4, 312 30 S 470 58, 562 30 S 730 2, 812 30 S 920 52, 960 30" />
        </svg>
        <ol className="flow">
          {steps.map((s) => (
            <li key={s.n} className="flow-step card">
              <span className="flow-n num">{s.n}</span>
              <h3 className="h3">{s.name}</h3>
              <p className="flow-sub">{s.sub}</p>
              <p>{s.d}</p>
              <span className={`flow-ai${s.ai === "Claude" ? " on" : ""}`}>{s.ai}</span>
            </li>
          ))}
        </ol>
      </div>
    </Sec>
  );
}

// ---- 5. しくみ: 1人を追ってみる ----

/** 追う1人（デモの A案）。属性と判断はリプレイの people・person_decisions から読む */
const FOLLOW = { plan: "A" as PlanId, personId: 3415 };
/** 画面に並べる判断（step と広告の ID）。残りは「すべて見る」に入れる */
const FOLLOW_PICK: [string, string | null][] = [
  ["install", "a2"],
  ["install", "a3"],
  ["signup", null],
  ["pay", null],
];
/** 登録の平均。rules/presets.yaml matching.signup.mid（出典 [LD22] p.18 日本 46.61%） */
const SIGNUP_BASE = 0.466;
/** 判断の掛け算の値。rules/multipliers.yaml levels.*.mid */
const LEVEL_MULT = { higher: 1.3, similar: 1.0, lower: 0.7 } as const;
const LEVEL_SHORT = { higher: "高い", similar: "同じ", lower: "低い" } as const;

/** A案の広告3種類がどの SNS 向けか（apps/demo_matching/app.yaml の creatives のコメント） */
const CREATIVE_JA: Record<string, string> = { a1: "TikTok 広告", a2: "Instagram 広告", a3: "X 広告" };

function decisionLabel(d: PersonDecision, replay: Replay): string {
  if (d.step === "install" && d.creative) return CREATIVE_JA[d.creative] ?? "広告";
  return stepName(d.step, replay);
}

function LevelPill({ level }: { level: PersonDecision["level"] }) {
  return <span className={`t-pill lv-${level}`}>{LEVEL_SHORT[level]}</span>;
}

function pct(v: number) {
  return `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
}

function FollowOne({ replay, loading }: { replay: Replay | null; loading: boolean }) {
  const row = replay?.people.find((p) => p[0] === FOLLOW.personId);
  const all = replay?.person_decisions?.filter((d) => d.plan === FOLLOW.plan && d.person_id === FOLLOW.personId) ?? [];
  const picked = FOLLOW_PICK.map(([step, cr]) => all.find((d) => d.step === step && (cr === null || d.creative === cr))).filter(
    (d): d is PersonDecision => !!d,
  );
  // 上に並べた判断を除いた残り（「ほかの判断も見る」に入れる）
  const rest = all.filter((d) => !picked.includes(d));
  const signup = all.find((d) => d.step === "signup");
  const label = row ? replay?.clusters.find((c) => c.cluster_id === row[5])?.label_ja : undefined;
  const marital = label?.match(/未婚|既婚/)?.[0];
  const facts = row ? [`${row[3]}歳`, row[4] === "M" ? "男性" : "女性", PREF_JA[row[1]], marital].filter((v): v is string => !!v) : [];
  const name = replay?.meta.name_ja ?? "ちかくに";

  const jp = [
    { t: "X のクチコミ", d: "X での拡散は全国へ、身近な人からのクチコミは地域の中で広がります。" },
    { t: "電車広告", d: "都道府県ごとの鉄道通勤率で、届く人が変わります。" },
    { t: "本人確認", d: "書類と審査待ちで、何人が離れるかを数えます。" },
    { t: "地域の密度", d: "近くに相手がいるかで、初マッチの起きやすさが変わります。" },
  ];

  return (
    <Sec id="follow" eyebrow="しくみ ・ 1人を追ってみる" title="架空の日本人1万人のうちの1人に、何が起きたか">
      {row && picked.length > 0 && replay ? (
        <>
          <div className="t-follow">
            <div className="card t-person">
              <p className="t-person-id num">架空の人 #{FOLLOW.personId}</p>
              <p className="t-person-facts">
                {facts.map((f, i) => (
                  <span key={f} className="ib">
                    {i > 0 && "・"}
                    {f}
                  </span>
                ))}
              </p>
              <p className="note">
                「{name}」の{FOLLOW.plan}案で、Claude が実際に出した判断です。
                <InfoTip label="この1人が表す人数">
                  この1人の点は、似た属性を持つ実際の日本人 約{Math.round(replay.meta.scale_to_japan).toLocaleString("ja-JP")}人ぶんを表します。
                </InfoTip>
              </p>
            </div>
            <div className="t-steps-wrap">
              <p className="t-steps-lead">
                Claude は段階ごとに、この人が<strong>同じ種類のアプリの平均より先へ進みやすいか</strong>を「高い・同じ・低い」で答え、理由を書きます。
              </p>
              <ol className="t-steps">
                {picked.map((d) => (
                  <li key={`${d.step}-${d.creative ?? ""}`}>
                    <span className="t-step-name">{decisionLabel(d, replay)}</span>
                    <LevelPill level={d.level} />
                    <span className="t-step-why">{d.reason_ja}</span>
                  </li>
                ))}
              </ol>
              {rest.length > 0 && (
                <details className="t-more">
                  <summary>この人の、ほかの判断も見る（{rest.length}つ）</summary>
                  <ol className="t-steps t-steps-sm">
                    {rest.map((d) => (
                      <li key={`${d.step}-${d.creative ?? ""}`}>
                        <span className="t-step-name">{decisionLabel(d, replay)}</span>
                        <LevelPill level={d.level} />
                        <span className="t-step-why">{d.reason_ja}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          </div>

          {signup && (
            <div className="t-eq-wrap">
              <h3 className="h3">Claude の判断が、確率になるまで（インストールした後、{stepName("signup", replay)}するか）</h3>
              <div className="t-eq" role="group" aria-label="登録する確率の計算">
                <div className="t-eq-box">
                  <span className="t-eq-tag">出典のある平均</span>
                  <span className="t-eq-num num">{pct(SIGNUP_BASE)}</span>
                  <span className="t-eq-d">日本のマッチングアプリを入れた人のうち、登録まで進む人の割合の平均（出典 [LD22]）</span>
                </div>
                <span className="t-eq-op" aria-label="かける">×</span>
                <div className="t-eq-box is-claude">
                  <span className="t-eq-tag">Claude の判断</span>
                  <span className="t-eq-num num">{LEVEL_MULT[signup.level].toFixed(1)}</span>
                  <span className="t-eq-d">
                    この人の判断は「{LEVEL_SHORT[signup.level]}」。低いなら ×{LEVEL_MULT.lower}、高いなら ×{LEVEL_MULT.higher}
                  </span>
                </div>
                <span className="t-eq-op" aria-label="は">=</span>
                <div className="t-eq-box is-engine">
                  <span className="t-eq-tag">エンジンの計算</span>
                  <span className="t-eq-num num">{pct(SIGNUP_BASE * LEVEL_MULT[signup.level])}</span>
                  <span className="t-eq-d">この人が登録する確率</span>
                </div>
              </div>
              <p className="t-eq-cap">
                <span className="ib">Claude が決めるのは「高い・同じ・低い」の向きだけ。</span>
                <span className="ib">数字は、出典のある平均からエンジンが計算します。</span>
              </p>
            </div>
          )}
        </>
      ) : (
        <p className="note">{loading ? "判断を読み込んでいます…" : "この人の判断を読み込めませんでした。"}</p>
      )}

      <div className="t-jp">
        <h3 className="h3">日本の市場の条件も、エンジンのルールに入っている</h3>
        <ul className="t-jp-row">
          {jp.map((x) => (
            <li key={x.t}>
              <strong>{x.t}</strong>
              <span>{x.d}</span>
            </li>
          ))}
        </ul>
      </div>
    </Sec>
  );
}

// ---- 6. なぜ信じられるか ----

interface BacktestLine {
  hits: number;
  total: number;
  best: number;
  cases: number;
}

function useBacktestLine(): BacktestLine | null {
  const [v, setV] = useState<BacktestLine | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    loadBacktest(ac.signal)
      .then((bt) => {
        const s = summarize(bt);
        const best = bt.baselines.reduce((m, b) => Math.max(m, b.hits), 0);
        if (s.answered > 0) setV({ hits: s.hits, total: s.answered, best, cases: bt.cases.length });
      })
      .catch(() => setV(null));
    return () => ac.abort();
  }, []);
  return v;
}

function Trust() {
  const bt = useBacktestLine();
  const n = (v: number) => v.toLocaleString("ja-JP", { maximumFractionDigits: 1 });
  const pastLine = !bt
    ? "過去の事例を、名前を伏せて予測させた"
    : `過去の事例で ${bt.total}問中${n(bt.hits)}問的中。${
        bt.hits === bt.best ? "単純な予想と同じで、勝てなかった" : bt.hits < bt.best ? "単純な予想に届かなかった" : "単純な予想より多く当たった"
      }`;
  const checks: { k: string; t: string; sub: string; tip: string; link?: boolean }[] = [
    {
      k: "入力",
      t: "すべての数字に出典がある",
      sub: "データ調査を独立して4回検証。157か所を元資料で確かめて直し、作り話の数字は0件。",
      tip: "出典は調査名・表番号・年まで一覧で公開しています。出典のない値は「仮定」と書き、理由を添えます。",
    },
    {
      k: "出力",
      t: "Claude は数字を書けない",
      sub: "レポートの数字は、エンジンの表の ID で引用。本文に数字を直接書くと、コードが止める。",
      tip: "Claude は数字の代わりに表の ID を書き、コードがそれを数字に置き換えます。画面に出る数字は、すべてエンジンが数えたものです。",
    },
    {
      k: "過去",
      t: pastLine,
      sub: "名前を伏せた実在のサービスで、ルールを固定してから予測し、正解は後から入れた。",
      tip: `${bt ? `事例は${bt.cases}つ、問題は${bt.total}問と少ないので、方法の点検であって精度の測定ではありません。` : ""}「いつも増える」と答えるだけの単純な予想${bt ? `も${n(bt.best)}問当たります` : "と比べています"}。結果を見てからルールを直すと検証にならないので、直さずにそのまま公開しています。`,
      link: true,
    },
  ];
  return (
    <Sec id="trust" eyebrow="なぜ信じられるか" title="入力・出力・過去の3つで確かめる" tone="tint">
      <ol className="t-checks">
        {checks.map((c, i) => (
          <li key={c.k} className="card">
            <span className="t-check-k">
              <span className="t-check-n num" aria-hidden>{i + 1}</span>
              {c.k}
            </span>
            <p className="t-check-t">
              {c.t}
              <InfoTip label={`${c.k}の確かめ方`}>{c.tip}</InfoTip>
            </p>
            <p className="t-check-sub">{c.sub}</p>
            {c.link && (
              <a className="t-check-link" href={href("sources", "backtest")}>
                詳しく見る →
              </a>
            )}
          </li>
        ))}
      </ol>
      <p className="links">
        <a href={href("sources")}>出典と限界を見る</a>
      </p>
    </Sec>
  );
}

// ---- 7. Claude の使い方 ----

function ClaudeUse() {
  const rows = [
    { model: "Opus 5.5", job: "人の種類とペルソナの設計", n: "410グループ" },
    { model: "Haiku 5.5", job: "一人ひとりの判断", n: "デモで16,978回" },
    { model: "Opus 5.5", job: "離れた理由のまとめとレポート", n: "数字は表の ID で引用" },
    { model: "Sonnet 5.5", job: "一人へのインタビュー", n: "その人の記録だけが根拠" },
  ];
  return (
    <Sec id="claude" eyebrow="Claude の使い方" title="仕事ごとに、合うモデルを選ぶ">
      <ul className="t-models">
        {rows.map((r) => (
          <li key={r.job}>
            <span className="model">{r.model}</span>
            <span>{r.job}</span>
            <span className="t-model-n">{r.n}</span>
          </li>
        ))}
      </ul>
      <p className="secondary">
        開発も Claude Code が中心です。担当ごとのサブエージェントを同時に動かし、メインのセッションは点検と再指示だけを行いました。
        {REPO_URL && (
          <>
            {" "}
            <a className="ib" href={REPO_URL} target="_blank" rel="noreferrer">
              リポジトリを見る
            </a>
          </>
        )}
      </p>
    </Sec>
  );
}

// ---- 8. はじめる ----

function Start({ onPlay }: { onPlay: () => void }) {
  return (
    <Sec id="start" eyebrow="はじめる" title="テプリで試す" tone="brand" last aside={<Mascot pose="action" />}>
      <div className="cards2 start">
        <a className="card start-card primary" href={href("result")} onClick={onPlay}>
          <span className="h3">
            <span aria-hidden>▶ </span>デモを再生
          </span>
          <span>事前に計算した「ちかくに」の結果を、日本地図の上で再生します。</span>
          <span className="go">結果の画面へ →</span>
        </a>
        <a className="card start-card" href={href("live")}>
          <span className="h3">ライブで試す</span>
          <span>「ちかくに」の地域・予算・価格・動画の投稿数などを変えて、ブラウザの中でエンジンを回し直します。</span>
          <span className="go">条件を変えて回す →</span>
        </a>
      </div>
    </Sec>
  );
}

// ---- ライブ（仮のページ） ----

export function LivePage() {
  return (
    <section className="section" aria-labelledby="live-h">
      <p className="eyebrow">ライブで試す</p>
      <h1 className="h1" id="live-h">
        準備中です
      </h1>
      <p className="lead">いまの公開サイトは、事前に計算した結果を再生するだけです。</p>
      <div>
        <a className="cta" href={href("home")}>
          トップへ戻る
        </a>
      </div>
    </section>
  );
}
