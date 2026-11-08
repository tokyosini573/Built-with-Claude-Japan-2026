// ハッシュでページを切り替える（静的サイトなのでサーバー側のルーティングは使わない）。

import { useEffect, useState } from "react";

export type Route = "home" | "result" | "input" | "sources" | "sources-full" | "live";

const ROUTES: Route[] = ["result", "input", "sources", "sources-full", "live"];

// 前にあった「検証」のページは、根拠の「限界」の中に移した。古いリンクはそこへ向ける
const ALIASES: Record<string, string> = { verify: "sources/backtest" };

function path(): string {
  const h = window.location.hash.replace(/^#\/?/, "");
  return ALIASES[h] ?? h;
}

function parse(): Route {
  const head = path().split("/")[0];
  return (ROUTES as string[]).includes(head) ? (head as Route) : "home";
}

/** 「#/sources/backtest」の「backtest」のように、ページの中の行き先。なければ null */
export function routeAnchor(): string | null {
  return path().split("/")[1] || null;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function href(route: Route, anchor?: string): string {
  return route === "home" ? "#/" : `#/${route}${anchor ? `/${anchor}` : ""}`;
}
