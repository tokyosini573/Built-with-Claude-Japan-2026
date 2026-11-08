// 入口。?dev なら開発用ページ、それ以外は公開画面（トップ → 結果 / 入力 / 根拠、ライブで試す）。

import { useState } from "react";
import { DevPage } from "./dev/DevPage";
import { ReplayErrorView } from "./components/ReplayErrorView";
import { Decor, Wave } from "./components/Shapes";
import { ResultPage } from "./app/ResultPage";
import { InputPage } from "./app/InputPage";
import { SourcesFullPage, SourcesPage } from "./app/SourcesPage";
import { TopPage } from "./app/TopPage";
import { LivePage } from "./app/LivePage";
import { href, useRoute, type Route } from "./lib/router";
import { useReplayAuto } from "./lib/useReplayAuto";
import type { Scale } from "./lib/format";

function readParams() {
  const q = new URLSearchParams(window.location.search);
  return { dev: q.has("dev"), replay: q.get("replay") };
}

const NAV: { route: Route; label: string }[] = [
  // 「何を試したか → どうなったか → 何からできているか」の順
  { route: "input", label: "入力" },
  { route: "result", label: "結果" },
  { route: "sources", label: "根拠" },
];

export function App() {
  const { dev, replay } = readParams();
  if (dev) return <DevPage replayId={replay || "mock"} />;
  return <Site replayParam={replay} />;
}

function Site({ replayParam }: { replayParam: string | null }) {
  const route = useRoute();
  const status = useReplayAuto(replayParam);
  const [scale, setScale] = useState<Scale>("japan");
  // 入口の「デモを再生」から来たときだけ自動で再生する
  const [autoplay, setAutoplay] = useState(false);

  const ready = status.kind === "ready" ? status.replay : null;
  const isMock = !!ready?.meta.is_mock;

  return (
    <div className={`shell${route === "home" ? " is-home" : ""}`}>
      <header className="topbar">
        <div className="topbar-in">
          <a className="brand" href={href("home")} aria-label="テプリ（トップへ）">
            <img className="brand-mark" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={36} height={36} />
            テプリ
          </a>
          {/* トップはロゴだけ。「デモを再生」の後のページ（結果・入力・根拠・ライブ）でメニューを出す */}
          {route !== "home" && (
            <nav className="nav" aria-label="メニュー">
              {NAV.map((n) => (
                <a key={n.route} href={href(n.route)} aria-current={route === n.route || (route === "sources-full" && n.route === "sources") ? "page" : undefined}>
                  {n.label}
                </a>
              ))}
            </nav>
          )}
        </div>
        {isMock && (route === "result" || route === "input") && <div className="mock-note">モックの数字です。根拠はありません。</div>}
      </header>

      {route === "home" ? (
        <main id="main">
          <TopPage status={status} onPlay={() => setAutoplay(true)} />
        </main>
      ) : (
        <main className={`page${route === "result" ? " page-result" : ""}`} id="main">
          <Decor kind="page" />
          {route === "live" ? (
            <LivePage />
          ) : route === "sources" ? (
            <SourcesPage />
          ) : route === "sources-full" ? (
            <SourcesFullPage />
          ) : status.kind === "loading" ? (
            <p className="muted">結果を読み込んでいます…</p>
          ) : status.kind === "error" ? (
            <ReplayErrorView error={status.error} />
          ) : route === "input" ? (
            <InputPage replay={status.replay} />
          ) : (
            <ResultPage replay={status.replay} scale={scale} onScale={setScale} autoplay={autoplay} onAutoplayDone={() => setAutoplay(false)} />
          )}
        </main>
      )}

      <footer className="footer on-brand">
        <Wave position="top" />
        <div className="footer-in">
          <span>テプリは統計から作った架空の1万人で試すシミュレーターです。実在の人は含みません。</span>
          <span>
            地図: 「国土数値情報（行政区域データ）」（国土交通省）をもとにテプリ作成。統計の出典は<a href={href("sources")}>根拠</a>に。
          </span>
        </div>
      </footer>
    </div>
  );
}
