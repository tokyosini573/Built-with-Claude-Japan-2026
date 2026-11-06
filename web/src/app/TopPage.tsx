// トップ: 読み進めると「テプリが何で、なぜ信じられるか」が分かる1枚のページ。
// 文章は 02_전략/teppuri_overview.html・README.md・backtest/report.md から。
// デモとバックテストの数字は画面で書かず、リプレイと backtest.json から読む。

import { useEffect, useState, type ReactNode } from "react";
import { HeroDots, HERO_LEGEND } from "../components/HeroDots";
import { HEADLINE_METRIC, ORGANIC_VIDEO_NOTE_JA, REPO_URL, UNCLEAR_RANGE } from "../config";
import { loadBacktest, summarize, type Backtest } from "../lib/backtest";
import { CHANNEL_JA, metricName, regionText, yen } from "../lib/labels";
import { href } from "../lib/router";
import type { PlanId, Replay } from "../lib/replay";
import type { ReplayStatus } from "../lib/useReplay";
import { PLAN_VAR, count } from "./ui";

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

export function TopPage({ status, onPlay }: Props) {
  const replay = status.kind === "ready" ? status.replay : null;
  return (
    <div className="top">
      <Hero />
      <Problem />
      <How />
      <Outputs />
      <Effects />
      <Trust />
      <Demo replay={replay} loading={status.kind === "loading"} />
      <ClaudeUse />
      <Start onPlay={onPlay} />
    </div>
  );
}

function Sec({ id, eyebrow, title, children, tone }: { id: string; eyebrow: string; title: ReactNode; children: ReactNode; tone?: "alt" }) {
  return (
    <section className={`tsec${tone === "alt" ? " alt" : ""}`} id={id} aria-labelledby={`${id}-h`}>
      <div className="tsec-in">
        <div className="tsec-head">
          <p className="eyebrow">{eyebrow}</p>
          <h2 className="h2" id={`${id}-h`}>
            {typeof title === "string" ? chunks(title) : title}
          </h2>
        </div>
        {children}
      </div>
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
  return (
    <section className="hero" aria-labelledby="hero-h">
      <div className="hero-in">
        <div className="hero-text">
          <h1 className="hero-title" id="hero-h">
            <span className="ib">アプリを出す前に、</span>
            <span className="ib">架空の日本で</span>
            <span className="ib">一度「発売」してみる。</span>
          </h1>
          <p className="lead">
            日本の統計から作った架空の日本人1万人の前でアプリを発売し、広告の出し方を2通り試して、結果を幅つきで比べるシミュレーターです。
          </p>
          <div>
            <button type="button" className="cta" onClick={() => scrollToId("start")}>
              デモを見る <span aria-hidden>↓</span>
            </button>
          </div>
        </div>
        <figure className="hero-fig">
          <HeroDots onPeople={(p) => setScale({ population: p.population, perPerson: p.scale_to_japan })} />
          <figcaption>
            <span className="hero-legend">
              {HERO_LEGEND.map((l) => (
                <span key={l.level}>
                  <span className={`swatch lv${l.level}`} />
                  {l.label}
                </span>
              ))}
            </span>
            <span className="note">
              点1つが架空の1人で、人の多い都道府県ほど点が密になります。1人は、似た属性を持つ実際の日本人 <span className="ib">約{Math.round(scale.perPerson).toLocaleString("ja-JP")}人</span>の代わりです（15〜79歳 <span className="ib">約{Math.round(total / 1e4).toLocaleString("ja-JP")}万人 ÷ {(scale.population / 1e4).toLocaleString("ja-JP")}万</span>）。色づき方はイメージで、実際の結果ではありません。
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

// ---- 2. 問題意識 ----

function Problem() {
  const items = [
    {
      t: "出してみないと分からない",
      d: "広告費を全国に撒くか、東京に絞るか。TikTok か、電車広告か。今はお金を使って出してみるまで分かりません。A/B テストも発売してからしかできません。",
    },
    {
      t: "同じ予算でも、結果は違う",
      d: "どの地域の、どの年代に、どの SNS で届くか。出し方の違いで、インストールから課金までの流れが変わります。",
    },
    {
      t: "アンケートは「地図」を見落とす",
      d: "マッチングアプリは、近くに相手がいないと続きません。一人に「使いたいか」を聞いても、まわりに誰がいるかは分かりません。",
    },
  ];
  return (
    <Sec id="problem" eyebrow="解決したいこと" title={<><span className="ib">「リリースして</span><span className="ib">みないと分からない」を、</span><span className="ib">リリース前に確かめる</span></>}>
      <ol className="points">
        {items.map((x, i) => (
          <li key={x.t}>
            <span className="pt-no num">{i + 1}</span>
            <div>
              <h3 className="h3">{x.t}</h3>
              <p>{x.d}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="claim-sub">テプリは、その前にもう一段、安く速く試せる場所をつくります。</p>
    </Sec>
  );
}

// ---- 3. しくみ ----

function How() {
  const steps = [
    { n: "1", name: "人口", sub: "統計から1万人", ai: "AI を使わない", d: "国勢調査2025などの政府統計から、年齢・性別・都道府県・仕事・収入・スマホ・SNS・性格の傾向を持つ1万人を作ります。" },
    { n: "2", name: "判断", sub: "Claude が1万人全員の立場で", ai: "Claude", d: "広告を見て、入れて、登録して、本人確認して、使って、払うかを「このカテゴリの平均より 高い / 同じ / 低い」と理由で答えます。" },
    { n: "3", name: "エンジン", sub: "数字はエンジンだけが作る", ai: "AI を使わない", d: "出典つきのベンチマーク（定着率・課金率・広告単価）に判断の倍率を掛け、毎日のファネルを計算。30回くり返して幅を出します。" },
    { n: "4", name: "結果", sub: "再生・レポート・インタビュー", ai: "Claude は文章だけ", d: "日本地図の上で再生し、離れた理由をまとめ、一人に話を聞けます。レポートの数字はエンジンの値を引用します。" },
  ];
  return (
    <Sec id="how" eyebrow="しくみ" title="4つの部品が、それぞれ得意なことだけをする" tone="alt">
      <ol className="flow">
        {steps.map((s) => (
          <li key={s.n} className="flow-step">
            <span className="flow-n num">{s.n}</span>
            <h3 className="h3">{s.name}</h3>
            <p className="flow-sub">{s.sub}</p>
            <p>{s.d}</p>
            <span className={`flow-ai${s.ai === "Claude" ? " on" : ""}`}>{s.ai}</span>
          </li>
        ))}
      </ol>
    </Sec>
  );
}

// ---- 4. 解決すること・得られるもの ----

function Outputs() {
  const items = [
    { t: "どちらの案が勝つか", d: "A案と B案のインストール・継続・課金・売上を、30回の幅で比べます。「B案が良い確率」も出します。" },
    { t: "どこで、誰が、なぜ離れたか", d: "日本地図の上で1万人が動きます。どの段階で、どんな人が、どんな理由で離れたかが分かります。" },
    { t: "どの広告・動画が誰に効いたか", d: "広告素材や動画ごとに、一人ひとりの判断と理由が残ります。" },
    { t: "一人に聞ける", d: "地図の点を一人選ぶと、たどった道と「なぜやめたの？」への答えが読めます。" },
  ];
  return (
    <Sec id="outputs" eyebrow="得られるもの" title="アプリの情報と、出し方2通りを入れるだけ">
      <div className="cards2">
        {items.map((x) => (
          <div key={x.t} className="card tcard">
            <h3 className="h3">{x.t}</h3>
            <p>{x.d}</p>
          </div>
        ))}
      </div>
    </Sec>
  );
}

// ---- 5. 期待できる効果 ----

function Effects() {
  const jp = [
    { t: "X のクチコミ", d: "X 上の拡散は全国に、身近な人づて（LINE・対面）は地域の中で広がります。" },
    { t: "電車広告", d: "都道府県ごとの鉄道通勤率で、届く人が変わります。" },
    { t: "本人確認", d: "関門で何人が離れるか、審査待ちでどれだけ減るかを計算します。" },
    { t: "地域の密度", d: "近くに相手がいるかで、出会いやすさが変わります。" },
  ];
  return (
    <Sec id="effects" eyebrow="期待できる効果" title="発売の前に、安く速く試す" tone="alt">
      <ul className="effects">
        <li>
          <h3 className="h3">発売前に試せる</h3>
          <p>お金を使って出す前に、出し方を2通り比べられます。</p>
        </li>
        <li>
          <h3 className="h3">予算の無駄を減らす</h3>
          <p>効きにくい出し方に気づけば、その分の予算を別の案に回せます。</p>
        </li>
        <li>
          <h3 className="h3">日本の市場の条件で試す</h3>
          <p>日本らしさをルールとして入れています。</p>
        </li>
      </ul>
      <div className="jp-grid">
        {jp.map((x) => (
          <div key={x.t} className="jp-item">
            <strong>{x.t}</strong>
            <span>{x.d}</span>
          </div>
        ))}
      </div>
    </Sec>
  );
}

// ---- 6. 信頼できる理由 ----

function useBacktest() {
  const [bt, setBt] = useState<Backtest | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    loadBacktest(ac.signal)
      .then(setBt)
      .catch((e: Error) => e.name !== "AbortError" && setFailed(true));
    return () => ac.abort();
  }, []);
  return { bt, failed };
}

// コミットの順番（README.md 4章）
const COMMITS: [string, string][] = [
  ["12d263a", "ルールを固定"],
  ["4567f94", "事例を入力"],
  ["5286315", "予測"],
  ["64f24e0", "正解を追加"],
  ["8a7521e", "採点"],
];

function Trust() {
  const { bt, failed } = useBacktest();
  const s = bt ? summarize(bt) : null;
  const best = bt && bt.baselines.length ? Math.max(...bt.baselines.map((b) => b.hits)) : null;
  const saidNo = bt ? bt.cases.flatMap((c) => c.questions).filter((q) => q.p_yes < 0.5).length : null;
  return (
    <Sec id="trust" eyebrow="なぜ信じられるか" title="数字の出どころを、すべて見せる">
      <div className="stats">
        <div>
          <span className="stat num">4回</span>
          <span>データ調査への独立した検証</span>
        </div>
        <div>
          <span className="stat num">157か所</span>
          <span>検証で見つかり、元資料で確認して直した箇所</span>
        </div>
        <div>
          <span className="stat num">0件</span>
          <span>元資料にない作り話の数字</span>
        </div>
      </div>

      <div className="cards3">
        <div className="card tcard">
          <h3 className="h3">出典を公開</h3>
          <p>1万人の属性とベンチマークの出典（調査名・表番号・年）を一覧で出します。出典のない値は「仮定」と書きます。</p>
        </div>
        <div className="card tcard">
          <h3 className="h3">Claude は数字を作らない</h3>
          <p>Claude の役目は「高い / 同じ / 低い」と理由だけ。レポートに表にない数字が入ると、コードが止めます。</p>
        </div>
        <div className="card tcard">
          <h3 className="h3">数字は幅で</h3>
          <p>1つの数字ではなく、30回の結果の中央値と10〜90%の幅で示します。</p>
        </div>
      </div>

      <div className="bt card">
        <div style={{ display: "grid", gap: 8 }}>
          <h3 className="h3">過去で試した。結果も正直に出す</h3>
          <p>実在の日本のサービスの過去（値上げ・広告費の増減）を、名前を伏せて予測させました。正解は予測の後にしか入れていません。</p>
        </div>
        <ol className="commits" aria-label="コミットの順番">
          {COMMITS.map(([sha, label], i) => (
            <li key={sha}>
              <span className="c-no num">{i + 1}</span>
              <span className="c-label">{label}</span>
              <code>{sha}</code>
            </li>
          ))}
        </ol>
        {s && best !== null ? (
          <div className="bt-result">
            <p className="bt-score">
              <span className="num">{s.answered}</span>問中 <span className="num">{s.hits}</span>問 的中。
              {s.hits <= best ? <><span className="ib">単純な基準に</span><span className="ib">勝てませんでした。</span></> : <span className="ib">単純な基準より多く当てました。</span>}
            </p>
            <p>
              「常に増える」などの単純な基準も {best}問 当てています。テプリは{s.answered}問中{saidNo}問で「減る」と答える偏りがありました。
              今の版は、運営中のサービスの値上げや広告の増減の方向を当てる道具としては、まだ信頼できません。
            </p>
            <p className="note">結果を見てからルールは直していません。直すと検証にならないからです。</p>
          </div>
        ) : failed ? (
          <p className="note">バックテストの結果を読み込めませんでした。</p>
        ) : (
          <p className="note">読み込んでいます…</p>
        )}
        <div className="links">
          <a href={href("verify")}>検証の全問を見る</a>
          <a href={href("sources")}>出典と限界を見る</a>
        </div>
      </div>
    </Sec>
  );
}

// ---- 7. デモ ----

function planSummary(replay: Replay, id: PlanId): { title: string; detail: string; cost: string | null } {
  const plan = replay.plans[id];
  if (!plan) return { title: `${id}案`, detail: "", cost: null };
  const c = plan.config;
  const k = replay.meta.scale_to_japan;
  const spend = plan.totals.spend_jpy ? yen(Math.round(plan.totals.spend_jpy.p50 * k)) : null;
  const video = c.organic_video as { accounts?: number; posts_per_account_per_day?: number; days?: number } | undefined;
  if (video) {
    return {
      title: "AI 動画の大量投稿",
      detail: `広告は出さず、AI で作った短尺動画を${video.accounts}アカウントから毎日${video.posts_per_account_per_day}本、${video.days}日投稿`,
      cost: spend && `制作費 ${spend}`,
    };
  }
  const ch = Object.entries(c.channels ?? {})
    .map(([name, v]) => `${CHANNEL_JA[name] ?? name} ${yen(v)}`)
    .join("・");
  return {
    title: "SNS 広告",
    detail: `${regionText(c.regions)}に ${ch}${c.campaign_days ? `（${c.campaign_days}日）` : ""}`,
    cost: spend && `広告費 ${spend}`,
  };
}

/** 結論の一行（見出しの区切りごと）と、何回中何回か。数字は comparison.p_B_better から */
function demoLine(replay: Replay): { parts: string[]; sub: string } | null {
  const p = replay.comparison?.p_B_better[HEADLINE_METRIC];
  if (p === undefined) return null;
  const name = metricName(HEADLINE_METRIC, replay);
  const runs = replay.meta.runs;
  const wins = Math.round(p * runs);
  const sub = `同じ条件で${runs}回ずつ試し、B案が A案を上回ったのは${runs}回中${wins}回でした。`;
  if (p >= UNCLEAR_RANGE[1]) return { parts: [`${name}は`, `B案のほうが多い確率 ${Math.round(p * 100)}%。`], sub };
  if (p <= UNCLEAR_RANGE[0]) return { parts: [`${name}は`, `A案のほうが多い確率 ${Math.round((1 - p) * 100)}%。`], sub };
  return { parts: [`${name}は、`, "どちらが多いか", "はっきりしない。"], sub };
}

function Demo({ replay, loading }: { replay: Replay | null; loading: boolean }) {
  const ids: PlanId[] = ["A", "B"];
  const line = replay ? demoLine(replay) : null;
  const cpi = replay ? ids.map((id) => replay.plans[id]?.totals.cpi_jpy?.p50) : [];
  return (
    <Sec id="demo" eyebrow="デモ" title={<><span className="ib">架空のマッチングアプリ</span><span className="ib">「{replay?.meta.name_ja ?? "ちかくに"}」で、</span><span className="ib">広告と AI 動画を比べる</span></>} tone="alt">
      <p className="lead">20〜30代向けの架空の恋愛マッチングアプリ（本人確認が必須）を、2通りの出し方で全国に発売しました。</p>
      {replay ? (
        <>
          <div className="cards2">
            {ids.map((id) => {
              const s = planSummary(replay, id);
              const video = !!replay.plans[id]?.config.organic_video;
              return (
                <div key={id} className="card tcard plan-card" style={{ ["--c" as string]: PLAN_VAR[id] }}>
                  <p className="plan-tag" style={{ color: PLAN_VAR[id], fontSize: 20 }}>
                    {id}案 ・ {s.title}
                  </p>
                  <p>{s.detail}</p>
                  {s.cost && <p className="num" style={{ fontWeight: 700, fontSize: 20 }}>{s.cost}</p>}
                  {video && <p className="caveat">{ORGANIC_VIDEO_NOTE_JA}</p>}
                </div>
              );
            })}
          </div>
          {line && (
            <div className="demo-line">
              <p className="claim-sub">
                {line.parts.map((t) => (
                  <span key={t} className="ib">
                    {t}
                  </span>
                ))}
              </p>
              <p>{line.sub}</p>
              {cpi.every((v) => v !== undefined) && (
                <p>
                  はっきり違うのは費用です。1インストールあたり{" "}
                  <strong style={{ color: PLAN_VAR.A }}>A案 {count(cpi[0]!)}円</strong>、
                  <strong style={{ color: PLAN_VAR.B }}>B案 {count(cpi[1]!)}円</strong>（{replay.meta.runs}回の中央値）。
                </p>
              )}
              <p className="note">答えはエンジンと1万人の判断が出し、こちらの望む結果に合わせることはしません。</p>
              {replay.meta.is_mock && <p className="note">いまはモックの数字です。根拠はありません。</p>}
            </div>
          )}
        </>
      ) : (
        <p className="note">{loading ? "結果を読み込んでいます…" : "デモの結果を読み込めませんでした。"}</p>
      )}
    </Sec>
  );
}

// ---- 8. Claude の使い方 ----

function ClaudeUse() {
  const rows = [
    { job: "市場の整理とペルソナ（410グループ）", model: "Opus 5.5", why: "1回だけで、その質が全判断の土台になる" },
    { job: "一人ひとりの判断（デモで16,978回）", model: "Haiku 5.5", why: "回数が多い。Batch API とプロンプトキャッシュで費用を抑える" },
    { job: "離れた理由のまとめとレポート", model: "Opus 5.5", why: "数字はエンジンの表の ID で引用し、コードで検査する" },
    { job: "一人へのインタビュー（デモで12人）", model: "Sonnet 5.5", why: "その人の記録だけを根拠に答える。公開サイトには事前に作った質疑を出す" },
  ];
  return (
    <Sec id="claude" eyebrow="Claude の使い方" title="仕事ごとに、合うモデルを選ぶ">
      <ul className="models">
        {rows.map((r) => (
          <li key={r.job}>
            <span className="model">{r.model}</span>
            <div>
              <strong>{r.job}</strong>
              <p className="secondary">{r.why}</p>
            </div>
          </li>
        ))}
      </ul>
      <p>
        開発そのものも Claude Code が中心です。担当ごとのサブエージェントを同時に動かし、メインのセッションは点検と再指示だけを行いました。
        {REPO_URL && (
          <>
            {" "}
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              リポジトリを見る
            </a>
          </>
        )}
      </p>
    </Sec>
  );
}

// ---- 9. 開始 ----

function Start({ onPlay }: { onPlay: () => void }) {
  return (
    <Sec id="start" eyebrow="はじめる" title="テプリで試す" tone="alt">
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
          <span>自分のアプリと出し方を入れて試します。</span>
          <span className="go">準備中 →</span>
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
