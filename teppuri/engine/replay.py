"""実行結果を契約 v0 §4 のリプレイ JSON にまとめる。"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from .inputs import BASIS, Population
from .simulate import DecisionIndex, PlanResult

# active と paying は「その日の人数」、ほかは「その日に新しく起きた数」（契約 v1、paying は v2 で追加）
DAILY_KEYS = ["impressions", "reached", "installs", "installs_wom_local", "installs_wom_x", "signups",
              "core_actions", "active", "payers", "paying", "revenue_jpy"]
CUMULATIVE_KEYS = ["installs", "payers", "revenue_jpy", "reached", "core_actions"]
COMPARISON_KEYS = ["installs", "payers", "revenue_jpy", "active_end", "core_actions"]
# 動画の大量投稿（organic_video）を使う案だけに出す（12d263a の固定後に追加、バックテスト未検証）
VIDEO_DAILY_KEYS = ["video_posts", "video_views", "video_reached", "installs_video", "spend_video_jpy"]
VIDEO_CUMULATIVE_KEYS = ["video_reached", "installs_video"]
EXTRAPOLATED_AFTER_DAY = 90
NO_DECISION_REASON = "判断なし（カテゴリ平均どおりの離脱）"


def _sig(x: float) -> float:
    """有効数字4桁に丸める（小さい数も消えないように）。"""
    x = float(x)
    if not np.isfinite(x):
        return 0.0
    return float(f"{x:.4g}")


def _band(values: np.ndarray, runs: int) -> dict:
    """values: (回+1, ...) → p10 / p50 / p90。mid 回（最後の行）は入れない。"""
    v = values[:runs]
    q = np.percentile(v, [10, 50, 90], axis=0)
    if q.ndim == 1:
        return {"p10": _sig(q[0]), "p50": _sig(q[1]), "p90": _sig(q[2])}
    return {k: [_sig(x) for x in q[i]] for i, k in enumerate(["p10", "p50", "p90"])}


def drop_reasons(result: PlanResult, pop: Population, gates: list[str], preset: str,
                 decisions: list[dict], top: int = 5, who_pays: str = "both") -> list[dict]:
    """段階ごとに、離脱数（mid 回、実人数の重み）が多いクラスターと、その判断の理由。

    課金の段階は、払う側（pricing.who_pays）の人だけで数える。男性だけが払うアプリで
    「女性は無料なので払わない」が上位に並ぶのは、離脱の理由として意味がないため（2026-11-08、表示だけの変更。
    エンジンの数字は変わらない）。"""
    p = result.person
    pairs = [
        ("install", p["reached"] - p["installs"]),
        ("signup", p["installs"] - p["signups"]),
    ]
    for g in gates:
        pairs.append(("gate:" + g, p["gate_in:" + g] - p["gate_pass:" + g]))
    pairs.append(("core_action", p["ready"] - p["core"]))
    pairs.append(("retention", p["installs"] - p["active_end"]))
    if preset != "shopping":
        pay_drop = p["core"] - p["pay"]
        if who_pays == "male":
            pay_drop = np.where(pop.male, pay_drop, 0.0)
        elif who_pays == "female":
            pay_drop = np.where(pop.male, 0.0, pay_drop)
        pairs.append(("pay", pay_drop))

    index = DecisionIndex(decisions)
    clusters, inv = np.unique(pop.cluster, return_inverse=True)
    out = []
    for step, drop in pairs:
        drop = np.maximum(drop, 0.0) * pop.weight
        total = drop.sum()
        if total <= 0:
            continue
        by_cluster = np.bincount(inv, weights=drop, minlength=len(clusters)) / total
        for ci in np.argsort(-by_cluster)[:top]:
            if by_cluster[ci] <= 0:
                continue
            decs = index.reasons(result.plan_key, step, int(clusters[ci]))
            decs = sorted(decs, key=lambda d: {"lower": 0, "similar": 1, "higher": 2}.get(d.get("level"), 1))
            reason = decs[0].get("reason_ja", "") if decs else NO_DECISION_REASON
            out.append({"step": step, "cluster_id": int(clusters[ci]),
                        "share": round(float(by_cluster[ci]), 4), "reason_ja": reason})
    return out


def person_decision_rows(decisions: list[dict], person_ids) -> list[dict]:
    """人単位の判断（person_id あり）のうち、people にいる人の分（契約 v2、Web 用）。"""
    ids = {int(p) for p in person_ids}
    rows = []
    for d in decisions:
        pid = d.get("person_id")
        if pid is None or int(pid) not in ids:
            continue
        rows.append({"plan": str(d.get("plan")), "person_id": int(pid), "step": str(d.get("step")),
                     "level": d.get("level", "similar"), "reason_ja": d.get("reason_ja", "")})
        if d.get("creative"):
            # install の判断がどの広告・動画の見本についてかを画面で出すため（判断そのものは変えない）
            rows[-1]["creative"] = str(d["creative"])
    return rows


def people_rows(pop: Population) -> list[list]:
    sex = np.where(pop.male, "M", "F")
    return [[int(pop.person_id[i]), int(pop.pref[i]), str(pop.city_size[i]), int(pop.age[i]),
             str(sex[i]), int(pop.cluster[i])] for i in range(pop.n)]


def cluster_rows(pop: Population) -> list[dict]:
    reps = pop.representatives
    if reps is not None and len(reps):
        return [{"cluster_id": int(r.cluster_id), "label_ja": str(getattr(r, "label_ja", "")),
                 "representative": int(r.person_id)} for r in reps.itertuples()]
    rows = []
    for c in np.unique(pop.cluster):
        first = int(pop.person_id[np.flatnonzero(pop.cluster == c)[0]])
        rows.append({"cluster_id": int(c), "label_ja": "", "representative": first})
    return rows


def plan_config(app: dict, key: str) -> dict:
    """app.yaml の plan をそのまま写し、価格は上書きを反映したものにする。"""
    plan = dict(app["plans"][key])
    plan["pricing"] = {**(app.get("pricing") or {}), **(plan.get("pricing") or {})}
    return plan


def comparison(results: dict[str, PlanResult], runs: int) -> dict:
    """同じ回どうしの差（B − A）の分位点と、B が A より良かった回の割合。"""
    if "A" not in results or "B" not in results:
        return {}
    a, b = results["A"].totals, results["B"].totals
    diff, better = {}, {}
    for k in COMPARISON_KEYS:
        d = b[k] - a[k]
        diff[k] = _band(d, runs)
        better[k] = round(float(np.mean(d[:runs] > 0)), 4)
    return {"B_minus_A": diff, "p_B_better": better}


def assemble_replay(app: dict, pop: Population, results: dict[str, PlanResult], events: dict[str, list],
                    decisions: list[dict], runs: int, horizon: int) -> dict:
    gates = [str(g["id"]) for g in app.get("gates") or []]
    plans = {}
    for key, res in results.items():
        daily = {"day": list(range(1, horizon + 1))}
        has_video = "video_views" in res.daily
        for k in DAILY_KEYS + (VIDEO_DAILY_KEYS if has_video else []):
            daily[k] = _band(res.daily[k], runs)
        cumulative = {k: _band(np.cumsum(res.daily[k], axis=1), runs)
                      for k in CUMULATIVE_KEYS + (VIDEO_CUMULATIVE_KEYS if has_video else [])}
        totals = {k: _band(v, runs) for k, v in res.totals.items()}
        plans[key] = {
            "config": plan_config(app, key),
            "daily": daily,
            "daily_cumulative": cumulative,
            "totals": totals,
            "sample_run": {"events": events.get(key, [])},
            "drop_reasons": drop_reasons(res, pop, gates, app["preset"], decisions,
                                         who_pays=str(plan_config(app, key)["pricing"].get("who_pays", "both"))),
        }
    return {
        "meta": {
            "app_id": app["app_id"],
            "name_ja": app.get("name_ja", ""),
            "period_days": horizon,
            "runs": runs,
            "population": BASIS,
            "scale_to_japan": round(pop.scale, 4),
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "extrapolated_after_day": EXTRAPOLATED_AFTER_DAY,
            "gates": [{"id": str(g["id"]), "name_ja": g.get("name_ja", "")} for g in app.get("gates") or []],
        },
        "plans": plans,
        "comparison": comparison(results, runs),
        "people": people_rows(pop),
        "person_decisions": person_decision_rows(decisions, pop.person_id),
        "clusters": cluster_rows(pop),
        "interviews": [],
        "report_ja": "",
    }
