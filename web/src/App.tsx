// 入口。画面レイアウトはまだ決まっていないので、今は開発用ページ（/?dev）だけ。

import { DevPage } from "./dev/DevPage";

function readParams() {
  const q = new URLSearchParams(window.location.search);
  return { dev: q.has("dev"), replay: q.get("replay") || "mock" };
}

export function App() {
  const { dev, replay } = readParams();
  if (dev) return <DevPage replayId={replay} />;
  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "64px 16px" }}>
      <h1 style={{ margin: 0 }}>テプリ</h1>
      <p className="secondary">
        統計から作った架空の日本人1万人で、アプリの発売とマーケティングを試すシミュレーター。
      </p>
      <p className="small muted">
        公開画面は準備中です。部品の確認は <a href="?dev">開発用ページ</a> へ。
      </p>
    </main>
  );
}
