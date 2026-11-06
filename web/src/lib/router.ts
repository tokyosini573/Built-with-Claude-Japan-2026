// ハッシュでページを切り替える（静的サイトなのでサーバー側のルーティングは使わない）。

import { useEffect, useState } from "react";

export type Route = "home" | "result" | "input" | "verify" | "sources" | "sources-full" | "live";

const ROUTES: Route[] = ["result", "input", "verify", "sources", "sources-full", "live"];

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  return (ROUTES as string[]).includes(h) ? (h as Route) : "home";
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

export function href(route: Route): string {
  return route === "home" ? "#/" : `#/${route}`;
}
