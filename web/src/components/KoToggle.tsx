// 一時的な機能: 画面の日本語を韓国語に訳して読むためのボタン（作者が読むため。提出前に消す）。
// 消すとき: このファイル、App.tsx の <KoToggle />、index.css の「韓国語ボタン」の節。
//
// 訳はブラウザ内蔵の翻訳（Chrome の Translator API、端末の中で動く）を使う。外部に文章を送らない。
// 使えないブラウザでは、Google 翻訳で開くリンクを出す。
// 画面の文字（テキストノード）を訳文に差し替え、React が書き換えたら訳し直す。オフにすると元に戻す。

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TranslatorLike = { translate: (s: string) => Promise<string> };
type Phase = "off" | "loading" | "on" | "unsupported";

const JA = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;
const STORE_KEY = "teppuri-ko";

const original = new WeakMap<Text, string>(); // 元の日本語
const shown = new WeakMap<Text, string>();    // こちらが入れた訳文
const cache = new Map<string, Promise<string>>();

function skip(node: Text): boolean {
  const p = node.parentElement;
  if (!p) return true;
  if (p.closest("script, style, noscript, [data-no-ko]")) return true;
  return !JA.test(node.nodeValue || "");
}

function proxyUrl(): string {
  const path = window.location.pathname;
  return `https://tokyosini573-github-io.translate.goog${path}?_x_tr_sl=ja&_x_tr_tl=ko&_x_tr_hl=ko${window.location.hash}`;
}

export function KoToggle() {
  const [phase, setPhase] = useState<Phase>("off");
  const [progress, setProgress] = useState(0);
  const translator = useRef<TranslatorLike | null>(null);
  // 狭い画面では右下に浮かせる。上の帯は backdrop-filter で fixed の基準になるので、body 直下に出す
  const [small, setSmall] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const on = () => setSmall(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const observer = useRef<MutationObserver | null>(null);

  function translateNode(node: Text) {
    const t = translator.current;
    if (!t) return;
    const value = node.nodeValue || "";
    if (shown.get(node) === value) return; // 自分で入れた訳文
    if (skip(node)) return;
    original.set(node, value);
    const core = value.trim();
    const lead = value.slice(0, value.indexOf(core));
    const tail = value.slice(lead.length + core.length);
    let job = cache.get(core);
    if (!job) {
      job = t.translate(core).catch(() => core);
      cache.set(core, job);
    }
    job.then((ko) => {
      if (node.nodeValue !== value) return; // 途中で React が書き換えた
      const next = lead + ko + tail;
      shown.set(node, next);
      node.nodeValue = next;
    });
  }

  function walk(root: Node) {
    if (root.nodeType === Node.TEXT_NODE) return translateNode(root as Text);
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode(); n; n = it.nextNode()) translateNode(n as Text);
  }

  function start() {
    walk(document.body);
    observer.current = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") translateNode(m.target as Text);
        else m.addedNodes.forEach((n) => walk(n));
      }
    });
    observer.current.observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  function stop() {
    observer.current?.disconnect();
    observer.current = null;
    const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = it.nextNode() as Text | null; n; n = it.nextNode() as Text | null) {
      const ja = original.get(n);
      if (ja !== undefined && shown.get(n) === n.nodeValue) n.nodeValue = ja;
    }
  }

  async function turnOn() {
    const api = (self as unknown as { Translator?: any }).Translator;
    if (!api) return setPhase("unsupported");
    try {
      const opts = { sourceLanguage: "ja", targetLanguage: "ko" };
      setPhase("loading");
      // 内蔵翻訳があっても答えが返らないブラウザがあるので、5秒で諦める
      const avail = await Promise.race([
        api.availability(opts),
        new Promise((resolve) => setTimeout(() => resolve("unavailable"), 5000)),
      ]);
      if (avail === "unavailable") return setPhase("unsupported");
      translator.current = await api.create({
        ...opts,
        monitor(m: EventTarget) {
          m.addEventListener("downloadprogress", (e) => setProgress(Math.round(((e as ProgressEvent).loaded || 0) * 100)));
        },
      });
      setPhase("on");
      start();
      try { localStorage.setItem(STORE_KEY, "1"); } catch { /* 保存できなくても動く */ }
    } catch {
      setPhase("unsupported");
    }
  }

  function turnOff() {
    stop();
    setPhase("off");
    try { localStorage.removeItem(STORE_KEY); } catch { /* 同上 */ }
  }

  // 前回オンにしていたら、モデルが端末にあるときだけ自動でオンにする
  useEffect(() => {
    let on = false;
    try { on = localStorage.getItem(STORE_KEY) === "1"; } catch { /* 同上 */ }
    const api = (self as unknown as { Translator?: any }).Translator;
    if (on && api) {
      api.availability({ sourceLanguage: "ja", targetLanguage: "ko" })
        .then((a: string) => { if (a === "available") turnOn(); })
        .catch(() => {});
    }
    return () => observer.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const label =
    phase === "on" ? "日本語" :
    phase === "loading" ? (progress > 0 && progress < 100 ? `번역 준비 ${progress}%` : "번역 중…") :
    "한국어";

  const ui = (
    <div className="ko-toggle" data-no-ko>
      <button
        type="button"
        className="ko-btn"
        aria-pressed={phase === "on"}
        disabled={phase === "loading"}
        onClick={() => (phase === "on" ? turnOff() : turnOn())}
      >
        {label}
      </button>
      {phase === "unsupported" && (
        <div className="ko-pop" role="status">
          <p>이 브라우저에는 내장 번역이 없어요. 최신 Chrome에서 열거나, Google 번역으로 보세요.</p>
          <a href={proxyUrl()} target="_blank" rel="noopener noreferrer">Google 번역으로 열기</a>
          <button type="button" className="ko-close" onClick={() => setPhase("off")} aria-label="닫기">×</button>
        </div>
      )}
    </div>
  );
  return small ? createPortal(ui, document.body) : ui;
}
