// 入口。?dev なら開発用ページ、それ以外は公開画面（入口 → 結果 / 入力 / 検証 / 根拠）。

import { useState } from "react";
import { DevPage } from "./dev/DevPage";
import { ReplayErrorView } from "./components/ReplayErrorView";
import { ResultPage } from "./app/ResultPage";
import { InputPage } from "./app/InputPage";
import { VerifyPage } from "./app/VerifyPage";
import { SourcesFullPage, SourcesPage } from "./app/SourcesPage";
import { href, useRoute, type Route } from "./lib/router";
import { useReplayAuto } from "./lib/useReplayAuto";
import type { Scale } from "./lib/format";

function readParams() {
  const q = new URLSearchParams(window.location.search);
  return { dev: q.has("dev"), replay: q.get("replay") };
}

const NAV: { route: Route; label: string }[] = [
  { route: "result", label: "結果" },
  { route: "input", label: "入力" },
  { route: "verify", label: "検証" },
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

  if (route === "home") {
    return (
      <main className="landing">
        <p className="eyebrow">Built with Claude: Japan 2026</p>
        <h1 className="title">テプリ</h1>
        <p className="tag">アプリを出す前に、架空の日本人1万人で試す。</p>
        <p className="lead">
          統計から作った1万人に、広告の出し方が違う A案と B案を見せて、どちらが良いかを幅つきで比べます。
          この画面は、事前に計算した結果を再生します。
        </p>
        <a className="cta" href={href("result")} onClick={() => setAutoplay(true)}>
          <span aria-hidden>▶</span> デモを再生
        </a>
      </main>
    );
  }

  const ready = status.kind === "ready" ? status.replay : null;
  const isMock = !!ready?.meta.is_mock;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-in">
          <a className="brand" href={href("home")}>
            テプリ
          </a>
          <nav className="nav" aria-label="メニュー">
            {NAV.map((n) => (
              <a key={n.route} href={href(n.route)} aria-current={route === n.route || (route === "sources-full" && n.route === "sources") ? "page" : undefined}>
                {n.label}
              </a>
            ))}
          </nav>
        </div>
        {isMock && (route === "result" || route === "input") && <div className="mock-note">モックの数字です。根拠はありません。</div>}
      </header>

      <main className="page" id="main">
        {route === "verify" ? (
          <VerifyPage />
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

      <footer className="footer">
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
