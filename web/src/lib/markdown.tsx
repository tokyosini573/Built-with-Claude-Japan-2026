// リポジトリの Markdown（DATA_SOURCES.md など）を画面に出すための小さな変換。
// 見出し・段落・箇条書き（入れ子）・表・コード・引用・太字・コード・リンクだけを扱う。

import type { ReactNode } from "react";

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = key * 1000;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={i++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={i++}>{t.slice(1, -1)}</code>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      const url = lm[2];
      out.push(
        /^https?:\/\//.test(url) ? (
          <a key={i++} href={url} target="_blank" rel="noreferrer">
            {lm[1]}
          </a>
        ) : (
          <span key={i++}>{lm[1]}</span>
        ),
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

interface ListItem {
  text: string;
  children: ListNode | null;
}
interface ListNode {
  ordered: boolean;
  items: ListItem[];
}

const LIST_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

function parseList(lines: string[], start: number): [ListNode, number] {
  const first = LIST_RE.exec(lines[start])!;
  const indent = first[1].length;
  const node: ListNode = { ordered: /\d/.test(first[2]), items: [] };
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      // 空行の次も同じ箇条書きなら続ける
      const next = lines[i + 1];
      if (next && LIST_RE.test(next) && LIST_RE.exec(next)![1].length >= indent) {
        i++;
        continue;
      }
      break;
    }
    const m = LIST_RE.exec(line);
    if (m) {
      const ind = m[1].length;
      if (ind < indent) break;
      if (ind > indent) {
        const [child, j] = parseList(lines, i);
        const lastItem = node.items[node.items.length - 1];
        if (lastItem) lastItem.children = child;
        i = j;
        continue;
      }
      node.items.push({ text: m[3], children: null });
      i++;
    } else if (/^\s+\S/.test(line) && node.items.length) {
      // 続きの行
      node.items[node.items.length - 1].text += " " + line.trim();
      i++;
    } else break;
  }
  return [node, i];
}

function renderList(node: ListNode, key: number): ReactNode {
  const items = node.items.map((it, i) => (
    <li key={i}>
      {inline(it.text, key + i)}
      {it.children && renderList(it.children, key * 7 + i + 1)}
    </li>
  ));
  return node.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
}

export function Markdown({ source, idPrefix = "md" }: { source: string; idPrefix?: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "" || /^---+\s*$/.test(line)) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(4, h[1].length + 1);
      const Tag = `h${level}` as "h2";
      blocks.push(
        <Tag key={k++} id={`${idPrefix}-${k}`}>
          {inline(h[2])}
        </Tag>,
      );
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++}>{buf.join("\n")}</pre>);
      continue;
    }
    if (line.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push(cells);
        i++;
      }
      const [head, ...body] = rows;
      blocks.push(
        <div className="table-wrap" key={k++}>
          <table>
            <thead>
              <tr>{head.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (LIST_RE.test(line)) {
      const [node, j] = parseList(lines, i);
      blocks.push(renderList(node, k++));
      i = j;
      continue;
    }
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(
        <blockquote key={k++} style={{ margin: 0, paddingLeft: 16, borderLeft: "3px solid var(--line)" }}>
          {inline(buf.join(" "))}
        </blockquote>,
      );
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#|\||```|>)/.test(lines[i]) && !LIST_RE.test(lines[i])) buf.push(lines[i++].trim());
    blocks.push(<p key={k++}>{inline(buf.join(" "))}</p>);
  }
  return <div className="md">{blocks}</div>;
}

/** 「## 5. 限界」のような見出しから、次の同じ深さの見出しまでを切り出す */
export function extractSection(source: string, headingStartsWith: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s+/, "").startsWith(headingStartsWith));
  if (start < 0) return "";
  const depth = /^#+/.exec(lines[start])![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= depth) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}
