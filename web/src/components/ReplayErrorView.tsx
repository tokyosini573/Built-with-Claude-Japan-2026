// 読み込み失敗やデータ不正を分かりやすく出す。

import { ReplayError } from "../lib/replay";

export function ReplayErrorView({ error }: { error: Error }) {
  const problems = error instanceof ReplayError ? error.problems : [];
  return (
    <div
      role="alert"
      style={{
        background: "var(--error-bg)",
        color: "var(--error-text)",
        borderRadius: "var(--radius)",
        padding: 16,
      }}
    >
      <strong>リプレイを表示できません</strong>
      <p style={{ margin: "4px 0 0" }}>{error.message}</p>
      {problems.length > 0 && (
        <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** モックデータのときに出す注意 */
export function MockBanner({ note }: { note?: string }) {
  return (
    <div className="small" style={{ background: "var(--warn-bg)", color: "var(--warn-text)", padding: "6px 12px", borderRadius: 6 }}>
      {note ?? "これは開発用のモックデータです。数字に根拠はありません。"}
    </div>
  );
}
