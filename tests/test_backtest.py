"""バックテスト実行器のテスト（小さな架空の事例と小さな人口で、predict と score が動くこと）。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pytest
import yaml

from teppuri.backtest import run as bt

FIX = Path(__file__).parent / "fixtures" / "engine"
SMALL_POP = FIX / "population_small.csv"

TOY_APP = {
    "app_id": "bt_toy",
    "name_ja": "テスト用の架空サブスク",
    "preset": "subscription",
    "min_age": 18,
    "description_ja": "テスト専用の架空の動画サブスク",
    "screens": [],
    "gates": [],
    "pricing": {"monthly_jpy": 600, "free_trial_days": 0},
    "plans": {"A": {
        "regions": [], "period_days": 120, "campaign_days": 60,
        "target": {"age": [20, 49], "sex": "any"},
        "channels": {"instagram": 20000000},
        "initial_state": {"active": 300000, "payers": 100000, "as_of_day_since_launch": 1000},
        "changes": [
            {"day": 61, "pricing": {"monthly_jpy": 900}, "applies_to": "all"},
            {"day": 61, "channels": {"instagram": 0}},
        ],
    }},
}

TOY_QUESTIONS = {
    "cases": {"case_toy": {"day1": "2024-01-01", "horizon": 120}},
    "questions": [
        {"id": "case_toy_Q1", "case": "case_toy", "text_ja": "後半の売上は前半より多いか",
         "metric": "revenue_jpy", "how": "sum",
         "a": {"days": [1, 60], "dates": ["2024-01-01", "2024-02-29"]},
         "b": {"days": [61, 120], "dates": ["2024-03-01", "2024-04-29"]},
         "direction": "greater", "change_between": ["price_up", "ad_down"]},
        {"id": "case_toy_Q2", "case": "case_toy", "text_ja": "120日目の会員数は30日目より多いか",
         "metric": "paying", "how": "last",
         "a": {"days": [30, 30]}, "b": {"days": [120, 120]},
         "direction": "greater", "change_between": ["price_up"]},
        {"id": "case_toy_Q3", "case": "case_toy", "text_ja": "後半の純減は前半より大きいか",
         "metric": "paying", "how": "delta",
         "a": {"days": [1, 60]}, "b": {"days": [61, 120]},
         "direction": "less", "change_between": ["price_up"]},
        {"id": "case_toy_Q4", "case": "case_toy", "text_ja": "最後の月の1人あたり単価は最初の月より高いか",
         "metric": "arpu", "how": "ratio",
         "a": {"days": [1, 30]}, "b": {"days": [91, 120]},
         "direction": "greater", "change_between": ["price_up"]},
    ],
}


@pytest.fixture
def toy(tmp_path):
    cases = tmp_path / "cases" / "case_toy"
    cases.mkdir(parents=True)
    (cases / "app.yaml").write_text(yaml.safe_dump(TOY_APP, allow_unicode=True), encoding="utf-8")
    qpath = tmp_path / "questions.yaml"
    qpath.write_text(yaml.safe_dump(TOY_QUESTIONS, allow_unicode=True), encoding="utf-8")
    popdir = tmp_path / "pop"
    popdir.mkdir()
    shutil.copy(SMALL_POP, popdir / "japan_10k.csv")   # 判断担当の読み込みはこのファイル名
    shutil.copy(FIX / "representatives.csv", popdir / "representatives.csv")
    return {"dir": tmp_path, "cases": tmp_path / "cases", "questions": qpath,
            "population": popdir / "japan_10k.csv", "runs_dir": tmp_path / "runs"}


# --- 質問の検査 ---------------------------------------------------------------

def test_real_questions_and_cases_are_consistent():
    """リポジトリの questions.yaml の日付と日が一致し、各事例の app.yaml が読めて期間が合う。"""
    cases, questions = bt.load_questions()
    assert len(questions) == 17
    for cid, c in cases.items():
        app = bt.load_app(bt.case_app_path(cid))
        plan = app["plans"]["A"]
        assert int(plan["period_days"]) == int(c["horizon"])
        assert plan["initial_state"]["payers"] > 0
        for ch in plan.get("changes") or []:
            assert 1 <= int(ch["day"]) <= int(c["horizon"])


def test_validate_rejects_mismatched_dates():
    q = json.loads(json.dumps(TOY_QUESTIONS))
    q["questions"][0]["a"]["dates"] = ["2024-01-02", "2024-02-29"]
    with pytest.raises(ValueError, match="合いません"):
        bt.validate_questions(q["cases"], q["questions"])


def test_validate_rejects_out_of_range():
    q = json.loads(json.dumps(TOY_QUESTIONS))
    q["questions"][1]["b"]["days"] = [121, 121]
    with pytest.raises(ValueError, match="期間"):
        bt.validate_questions(q["cases"], q["questions"])


# --- 区間の値 -----------------------------------------------------------------

def test_interval_values():
    daily = {
        "revenue_jpy": np.array([[1.0, 2, 3, 4], [2, 2, 2, 2]]),
        "paying": np.array([[10.0, 9, 8, 7], [5, 6, 7, 8]]),
    }
    assert bt.interval_value(daily, "revenue_jpy", "sum", [2, 3]).tolist() == [5, 4]
    assert bt.interval_value(daily, "paying", "last", [4, 4]).tolist() == [7, 8]
    # delta = 4日目 − 2日目（開始の前日）
    assert bt.interval_value(daily, "paying", "delta", [3, 4]).tolist() == [-2, 2]
    # 開始が1日目なら1日目で代用
    assert bt.interval_value(daily, "paying", "delta", [1, 4]).tolist() == [-3, 3]
    # arpu = 売上合計 / paying 平均
    assert bt.interval_value(daily, "arpu", "ratio", [1, 2]).tolist() == pytest.approx([3 / 9.5, 4 / 5.5])


def test_answer_question_counts_runs():
    daily = {"revenue_jpy": np.array([[1.0, 2], [2, 1], [1, 1]])}
    q = {"metric": "revenue_jpy", "how": "sum", "a": {"days": [1, 1]}, "b": {"days": [2, 2]},
         "direction": "greater"}
    assert bt.answer_question(daily, q)["p_yes"] == pytest.approx(1 / 3)   # 同じ値は「いいえ」
    q["direction"] = "less"
    assert bt.answer_question(daily, q)["p_yes"] == pytest.approx(1 / 3)


def test_baselines():
    qs = {q["id"]: q for q in TOY_QUESTIONS["questions"]}
    assert bt.baseline_answers(qs["case_toy_Q1"]) == {"always_up": 1.0, "naive": 0.0}
    # 純減が大きいか（less）: 常に増える → いいえ、値上げなら減る → はい
    assert bt.baseline_answers(qs["case_toy_Q3"]) == {"always_up": 0.0, "naive": 1.0}
    # 単価は値上げで増える
    assert bt.baseline_answers(qs["case_toy_Q4"]) == {"always_up": 1.0, "naive": 1.0}
    q = dict(qs["case_toy_Q1"], change_between=["ad_up"])
    assert bt.baseline_answers(q)["naive"] == 1.0


# --- 判断の補助 ---------------------------------------------------------------

def test_fill_cluster_decisions_majority_and_tie():
    decs = [
        {"plan": "A", "step": "pay", "creative": None, "person_id": 1, "cluster_id": 3, "level": "higher"},
        {"plan": "A", "step": "pay", "creative": None, "person_id": 2, "cluster_id": 3, "level": "higher"},
        {"plan": "A", "step": "pay", "creative": None, "person_id": 3, "cluster_id": 3, "level": "lower"},
        {"plan": "A", "step": "pay", "creative": None, "person_id": 4, "cluster_id": 5, "level": "higher"},
        {"plan": "A", "step": "pay", "creative": None, "person_id": 5, "cluster_id": 5, "level": "lower"},
    ]
    filled = bt.fill_cluster_decisions(decs)
    cl = {d["cluster_id"]: d["level"] for d in filled if d.get("person_id") is None}
    assert cl == {3: "higher", 5: "similar"}
    assert len(filled) == len(decs) + 2


def test_stratified_people_keeps_every_cluster():
    rows = {i: {"person_id": str(i), "cluster_id": str(i % 4)} for i in range(400)}
    rows[400] = {"person_id": "400", "cluster_id": "99"}   # 1人だけのクラスターも残る
    chosen = bt.stratified_people(rows, lambda r: True, 40, seed=1)
    assert {r["cluster_id"] for r in chosen} == {"0", "1", "2", "3", "99"}
    assert 40 <= len(chosen) <= 45
    assert len(bt.stratified_people(rows, lambda r: True, None, seed=1)) == 401


# --- predict と score ----------------------------------------------------------

def test_predict_and_score_without_judge(toy, tmp_path):
    out = tmp_path / "predictions.json"
    res = bt.predict(toy["cases"], toy["questions"], out, toy["population"], runs=5, judge="none",
                     runs_dir=toy["runs_dir"])
    assert out.exists()
    qs = {q["id"]: q for q in res["questions"]}
    assert set(qs) == {"case_toy_Q1", "case_toy_Q2", "case_toy_Q3", "case_toy_Q4"}
    for q in qs.values():
        assert 0.0 <= q["p_yes"] <= 1.0 and q["runs"] == 5
        assert set(q["baselines"]) == {"always_up", "naive"}
    # 全員への値上げのあとは1人あたり単価が上がる
    assert qs["case_toy_Q4"]["p_yes"] == 1.0
    assert res["cases"]["case_toy"]["judge"] == "none"

    answers = tmp_path / "answers.yaml"
    answers.write_text("answers:\n  case_toy_Q1: no\n  case_toy_Q2: no\n  case_toy_Q3: yes\n", encoding="utf-8")
    rec = tmp_path / "recognition.json"
    rec.write_text(json.dumps({"cases": {"case_toy": {"recognized_any": False}}}), encoding="utf-8")
    report = tmp_path / "report.md"
    s = bt.score(out, answers, rec, report)
    assert s["missing"] == ["case_toy_Q4"]
    assert s["summary"]["all"]["n"] == 3
    assert s["summary"]["not_recognized"]["n"] == 3 and s["summary"]["recognized"]["n"] == 0
    # 常に増える: Q1・Q2 は「はい」と答えて外れ、Q3 は「いいえ」で外れ → 0 点、Brier 1
    assert s["summary"]["all"]["always_up"] == {"hits": 0, "brier": 1.0}
    # 素朴: 3問とも当たる
    assert s["summary"]["all"]["naive"] == {"hits": 3, "brier": 0.0}
    text = report.read_text(encoding="utf-8")
    assert "精度の測定ではありません" in text and "case_toy_Q1" in text and "case_toy_Q4" in text


def test_predict_with_mock_judge(toy, tmp_path):
    """モックの判断（API を呼ばない）を取ってからエンジンに渡せる。"""
    out = tmp_path / "predictions.json"
    res = bt.predict(toy["cases"], toy["questions"], out, toy["population"], runs=3, judge="mock",
                     sample=50, runs_dir=toy["runs_dir"])
    c = res["cases"]["case_toy"]
    assert c["judge"] == "mock" and c["sampled"] is True
    assert 0 < c["people_judged"] <= 80
    assert (toy["runs_dir"] / "bt_toy" / "decisions.json").exists()


def test_real_judge_without_yes_only_estimates(toy, tmp_path, capsys):
    """判断がなく --yes もなければ、見積もりだけで予測は書かない（API を呼ばない）。"""
    out = tmp_path / "predictions.json"
    res = bt.predict(toy["cases"], toy["questions"], out, toy["population"], runs=3, judge="real",
                     runs_dir=toy["runs_dir"], log=__import__("sys").stdout)
    assert res is None and not out.exists()
    assert "dry-run" in capsys.readouterr().out
    assert not (toy["runs_dir"] / "bt_toy" / "decisions.json").exists()


def test_load_answers_accepts_yaml_booleans(tmp_path):
    p = tmp_path / "a.yaml"
    p.write_text("answers:\n  Q1: yes\n  Q2: no\n  Q3: \"yes\"\n  Q4: いいえ\n", encoding="utf-8")
    assert bt.load_answers(p) == {"Q1": True, "Q2": False, "Q3": True, "Q4": False}


def test_export_web_shape(toy, tmp_path):
    """Web 用 JSON が web/src/lib/backtest.ts の形になり、正解がなければ answer: null。"""
    pred = tmp_path / "predictions.json"
    bt.predict(toy["cases"], toy["questions"], pred, toy["population"], runs=3, judge="none",
               runs_dir=toy["runs_dir"])
    out = tmp_path / "backtest.json"
    w = bt.export_web(pred, tmp_path / "none.yaml", tmp_path / "none.json", out, toy["cases"], "abc1234")
    assert w["is_mock"] is False and w["prediction_commit"] == "abc1234"
    assert [b["id"] for b in w["baselines"]] == ["always_up", "naive"]
    assert all(b["hits"] == 0 and "brier" not in b for b in w["baselines"])
    case = w["cases"][0]
    assert set(case) >= {"case_id", "title_ja", "description_ja", "questions"} and "recognized" not in case
    assert all(q["answer"] is None and set(q) >= {"q_id", "q_ja", "p_yes"} for q in case["questions"])

    answers = tmp_path / "answers.yaml"
    answers.write_text("answers:\n  case_toy_Q1: no\n"
                       "  case_toy_Q3: {answer: yes, source_ja: 決算資料, source_url: 'https://example.com'}\n",
                       encoding="utf-8")
    rec = tmp_path / "recognition.json"
    rec.write_text(json.dumps({"cases": {"case_toy": {"recognized_any": True}}}), encoding="utf-8")
    w = bt.export_web(pred, answers, rec, out, toy["cases"], None)
    qs = {q["q_id"]: q for q in w["cases"][0]["questions"]}
    assert qs["case_toy_Q1"]["answer"] is False and qs["case_toy_Q2"]["answer"] is None
    assert qs["case_toy_Q3"]["source_url"] == "https://example.com"
    assert w["cases"][0]["recognized"] is True
    b = {x["id"]: x for x in w["baselines"]}
    assert b["always_up"] == {"id": "always_up", "name_ja": bt.BASELINE_NAMES["always_up"], "hits": 0, "brier": 1.0}
    assert b["naive"]["hits"] == 2 and b["naive"]["brier"] == 0.0
    assert json.loads(out.read_text(encoding="utf-8")) == w
