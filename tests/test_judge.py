"""判断担当（teppuri/judge）の簡易テスト。API は呼ばない（モッククライアントのみ）。"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from teppuri.judge import common as c
from teppuri.judge import decide, interview, personas, report

FIX = Path(__file__).parent / "fixtures" / "judge"
APP = FIX / "app" / "app.yaml"
POP = FIX / "population"


class ExplodingBackend:
    """呼ばれたら失敗する（dry-run で API を呼ばないことの確認用）。"""

    name = "real"

    def complete(self, job):
        raise AssertionError("API を呼んではいけない")

    def run_batch(self, jobs, state_dir):
        raise AssertionError("API を呼んではいけない")


def ctx_for(tmp_path, **kw) -> c.RunContext:
    return c.RunContext(tmp_path / "runs", "test_matching", **{"mock": True, "yes": False, **kw})


def engine_copy(tmp_path) -> Path:
    """エンジンの出力（契約 v1）を runs/<app_id>/engine.json に置く。"""
    p = tmp_path / "runs" / "test_matching" / "engine.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(FIX / "engine.json", p)
    return p


def walk_objects(schema):
    if schema.get("type") == "object":
        yield schema
        for v in schema.get("properties", {}).values():
            yield from walk_objects(v)
    if schema.get("type") == "array":
        yield from walk_objects(schema.get("items", {}))


# --- スキーマ -------------------------------------------------------------
@pytest.mark.parametrize("schema", [decide.decision_schema(c.load_app(APP)), decide.RECOGNITION_SCHEMA, personas.OVERVIEW_SCHEMA, personas.CHUNK_SCHEMA,
                                    report.REPORT_SCHEMA, interview.answer_schema(4)])
def test_schemas_are_strict(schema):
    # 構造化出力の決まり: すべての object で additionalProperties=false、全プロパティ required
    for obj in walk_objects(schema):
        assert obj.get("additionalProperties") is False
        assert sorted(obj["required"]) == sorted(obj["properties"])


def test_decide_schema_has_no_numeric_fields():
    # 判断は level と理由だけ。数値型のフィールドを持たない
    for obj in walk_objects(decide.decision_schema(c.load_app(APP))):
        for v in obj["properties"].values():
            assert v["type"] not in ("number", "integer")


def people_for(app):
    rows = c.load_population_rows(POP)
    people, skipped = decide.select_people(app, rows, None, 0, None)
    return people, skipped


def test_decisions_follow_contract_v2(tmp_path):
    app = c.load_app(APP)
    reps = c.load_representatives(POP)
    ctx = ctx_for(tmp_path)
    personas.build(app, reps, ctx)
    pj = json.loads((ctx.out_dir / "personas.json").read_text(encoding="utf-8"))
    assert all(p["interest"] in ("low", "mid", "high") for p in pj["personas"].values())  # エンジンが読む
    people, skipped = people_for(app)
    out = decide.build(app, people, ctx, skipped)
    data = json.loads((ctx.out_dir / "decisions.json").read_text(encoding="utf-8"))
    assert data == out
    # 1人×1案ごとに (その案の広告素材数 + install 以外の段階数) 行
    expected = sum((len(p["creatives"]) + len(app.steps())) * len(people) for p in app.plans().values())
    assert len(data) == expected
    for d in data:
        assert set(d) == {"plan", "step", "creative", "person_id", "cluster_id", "level", "reason_ja", "model"}
        assert d["level"] in c.LEVELS
        assert d["step"] in ("install", "signup", "core_action", "retention", "pay") or d["step"].startswith("gate:")
        assert (d["creative"] is not None) == (d["step"] == "install")
        if d["creative"]:  # その案の広告素材だけ
            assert d["creative"] in [Path(x).stem for x in app.plans()[d["plan"]]["creatives"]]
    summary = json.loads((ctx.out_dir / "decisions_summary.json").read_text(encoding="utf-8"))
    assert summary["rows"] == len(data) and summary["people"] == len(people)


def test_one_call_per_person_and_plan():
    app = c.load_app(APP)
    people, _ = people_for(app)
    jobs = decide.build_jobs(app, people, {})
    assert len(jobs) == len(people) * len(app.plans())
    assert len({j.key for j in jobs}) == len(jobs)


def test_flatten_drops_other_plans_creatives():
    app = c.load_app(APP)
    people, _ = people_for(app)
    job = next(j for j in decide.build_jobs(app, people[:1], {}) if j.meta["plan"] == "A")
    out = decide.mock_decision(app, ["a1", "b1"], "x")  # B案の素材が混ざった出力
    rows = decide.flatten(job, out, "m", app)
    assert [r["creative"] for r in rows if r["step"] == "install"] == ["a1"]


def test_cluster_ids_are_only_lookup_keys():
    # グループ分けが変わっても動く: cluster_id の値を変えると、ペルソナの引き先が変わるだけ
    app = c.load_app(APP)
    people, _ = people_for(app)
    shifted = [{**p, "cluster_id": str(int(p["cluster_id"]) + 1000)} for p in people]
    personas_ = {str(int(p["cluster_id"]) + 1000): {"persona_ja": "テスト用の人物像", "interest": "low"} for p in people}
    jobs = decide.build_jobs(app, shifted, personas_)
    assert all("テスト用の人物像" in j.request["messages"][0]["content"][-1]["text"] for j in jobs)


def test_eligibility_filters_min_age_and_smartphone():
    app = c.load_app(APP)
    rows = {1: {"person_id": "1", "age": "17", "has_smartphone": "true"},
            2: {"person_id": "2", "age": "30", "has_smartphone": "false"},
            3: {"person_id": "3", "age": "30", "has_smartphone": "true"}}
    people, skipped = decide.select_people(app, rows, None, 0, None)
    assert [p["person_id"] for p in people] == ["3"] and skipped == 2


def test_prompt_guards_against_memory():
    text = c.load_prompt("decide_system.md")
    assert "アプリ名・会社名" in text and "平均的なアプリ" in text


def test_decide_does_not_feed_engine_handled_reasons():
    # 地域・チャネル・ターゲットはエンジンが別に計算する。判断の入力に入れない（二重計算を避ける）
    app = c.load_app(APP)
    people, _ = people_for(app)
    job = decide.build_jobs(app, people[:1], {})[0]
    texts = "".join(b.get("text", "") for b in job.request["messages"][0]["content"])
    assert "regions" not in texts and "channels" not in texts and "instagram" not in texts
    assert "都道府県=" not in texts and "Instagram=" not in texts and "都市規模=" not in texts
    system = job.request["system"]
    assert "使ってはいけない理由" in system and "密度" in system and "条件付き" in system


def test_recognition_check_mock(tmp_path):
    app = c.load_app(APP)
    out = decide.recognition_check(app, ctx_for(tmp_path), 3)
    assert len(out["trials"]) == 3
    assert all(set(t) >= {"recognized", "guess_ja", "confidence", "clues_ja"} for t in out["trials"])


def test_decide_prompt_prefix_is_identical_for_caching():
    app = c.load_app(APP)
    people, _ = people_for(app)
    jobs = decide.build_jobs(app, people, {})
    prefixes = {json.dumps(c._normalize_for_key(c._prefix_part(j.request)), sort_keys=True) for j in jobs}
    assert len(prefixes) == 1  # 先頭（system + アプリ + 画像）は全呼び出しで同じ
    assert len({json.dumps(j.request["output_config"], sort_keys=True) for j in jobs}) == 1  # スキーマも同じ
    first = jobs[0].request["messages"][0]["content"]
    assert any("cache_control" in b for b in first)
    assert "cache_control" not in first[-1]  # 変わる部分（人と案）はキャッシュ境界の後ろ


# --- キャッシュ -----------------------------------------------------------
def test_disk_cache_prevents_repeat_calls(tmp_path):
    app = c.load_app(APP)
    reps = c.load_representatives(POP)
    backend = c.MockBackend()
    ctx = ctx_for(tmp_path, backend=backend)
    people, _ = people_for(app)
    decide.build(app, people, ctx)
    n_first = len(backend.calls)
    assert n_first > 0
    decide.build(app, people, ctx)
    assert len(backend.calls) == n_first  # 2回目は全部ディスクキャッシュから


def test_cache_key_ignores_image_location(tmp_path):
    img = tmp_path / "copy.png"
    shutil.copy(FIX / "app" / "ads" / "a1.png", img)
    r1 = {"model": "m", "messages": [{"role": "user", "content": [c.image_block(FIX / "app" / "ads" / "a1.png")]}]}
    r2 = {"model": "m", "messages": [{"role": "user", "content": [c.image_block(img)]}]}
    assert c.request_key(r1) == c.request_key(r2)


# --- dry-run --------------------------------------------------------------
def test_dry_run_never_calls_api(tmp_path, capsys):
    app = c.load_app(APP)
    reps = c.load_representatives(POP)
    ctx = ctx_for(tmp_path, mock=False, yes=False, backend=ExplodingBackend())
    assert decide.build(app, people_for(app)[0], ctx) is None
    assert personas.build(app, reps, ctx) is None
    rp = engine_copy(tmp_path)
    assert interview.build(rp, app, ctx, POP) is None
    assert report.build(rp, app, ctx) is None
    out = capsys.readouterr().out
    assert "費用見積もり" in out and "dry-run" in out
    assert not (ctx.out_dir / "decisions.json").exists()


def test_real_backend_requires_key(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(c, "load_env", lambda: None)
    with pytest.raises(c.JudgeError):
        c.RealBackend(tmp_path / "files.json")


def test_estimate_batch_is_cheaper_and_cache_helps():
    app = c.load_app(APP)
    jobs = decide.build_jobs(app, people_for(app)[0], {})
    (sync,) = c.estimate_jobs(jobs, None, batch=False)
    (batch,) = c.estimate_jobs(jobs, None, batch=True)
    assert batch.usd_without_cache == pytest.approx(sync.usd_without_cache / 2)
    assert batch.usd_with_cache < batch.usd_without_cache
    assert sync.calls == len(jobs)


# --- インタビュー -------------------------------------------------------------
def test_interviews_use_people_from_sample_run(tmp_path):
    app = c.load_app(APP)
    rp = engine_copy(tmp_path)
    ctx = ctx_for(tmp_path)
    before = rp.read_text(encoding="utf-8")
    out = interview.build(rp, app, ctx, POP, per_plan=2)
    assert rp.read_text(encoding="utf-8") == before  # エンジンの出力・リプレイには書かない
    replay = json.loads(before)
    saved = json.loads((ctx.out_dir / "interviews.json").read_text(encoding="utf-8"))
    assert saved == out
    for iv in saved:  # 契約 §4 の interviews 配列と同じ形
        assert set(iv) == {"person_id", "plan", "qa"}
        assert all(set(qa) == {"q_ja", "a_ja"} for qa in iv["qa"])
    n_q = len(c.load_prompt_yaml("interview_questions.yaml"))
    for iv in out:
        events = replay["plans"][iv["plan"]]["sample_run"]["events"]  # [person_id, day, step, n]
        assert iv["person_id"] in {e[0] for e in events}
        assert len(iv["qa"]) == n_q and all(qa["q_ja"] and qa["a_ja"] for qa in iv["qa"])
    assert len([iv for iv in out if iv["plan"] == "A"]) == 2


# --- レポート: リプレイにない数字を含まない -----------------------------------------
def test_report_numbers_come_only_from_replay(tmp_path):
    app = c.load_app(APP)
    rp = engine_copy(tmp_path)
    before = rp.read_text(encoding="utf-8")
    ctx = ctx_for(tmp_path)
    res = report.build(rp, app, ctx)
    assert rp.read_text(encoding="utf-8") == before  # エンジンの出力には書かない
    saved = json.loads((ctx.out_dir / "report.json").read_text(encoding="utf-8"))
    assert saved == res
    assert {"report_ja", "headline_ja", "drop_themes", "facts", "model"} <= set(saved)
    assert "154" in res["report_ja"]  # A案 installs p50 がそのまま引用されている
    assert report.numbers_not_in_facts(res["report_ja"], res["facts"]) == []
    drop_ids = {f"{p}.dr{i}" for p, pl in json.loads(before)["plans"].items() for i in range(len(pl["drop_reasons"]))}
    for t in saved["drop_themes"]:
        assert set(t) == {"theme_ja", "plan", "step", "drop_reason_ids", "summary_ja"}
        assert set(t["drop_reason_ids"]) <= drop_ids


def test_validate_template_rejects_invented_numbers():
    facts, _ = report.build_facts(json.loads((FIX / "engine.json").read_text(encoding="utf-8")))
    assert facts["cmp.p_B_better.installs"]["value"] == "78%"  # エンジンの比較もそのまま表に入る
    assert report.validate_template("差は {{cmp.B_minus_A.installs.p50}}", facts) == []
    ok = "A案は {{A.totals.installs.p50}}（{{A.totals.installs.p10}}〜{{A.totals.installs.p90}}）。一万人あたり。"
    assert report.validate_template(ok, facts) == []
    assert report.validate_template("A案はB案より15%多い", facts)  # 算用数字
    assert report.validate_template("A案はＢ案より１５％多い", facts)  # 全角数字
    assert report.validate_template("A案はB案の二倍", facts)  # 漢数字の倍率
    assert report.validate_template("{{A.totals.made_up.p50}}", facts)  # 表にない ID
    rendered = report.render(ok, facts)
    assert report.numbers_not_in_facts(rendered, facts) == []
    assert report.numbers_not_in_facts(rendered + " 差は999", facts) == ["999"]


def test_report_retries_once_on_bad_output(tmp_path):
    app = c.load_app(APP)
    rp = engine_copy(tmp_path)

    class BadThenGood(c.MockBackend):
        def complete(self, job):
            r = super().complete(job)
            if len(self.calls) == 1:  # 1回目は数字を直書きする
                r["output"]["report_ja"] = "A案が17%多い"
            return r

    backend = BadThenGood()
    res = report.build(rp, app, ctx_for(tmp_path, backend=backend))
    assert len(backend.calls) == 2
    assert "17%" not in res["report_ja"]


def test_skew_warnings_are_symmetric():
    def rows(level, n):
        return [{"plan": "A", "step": "signup", "creative": None, "person_id": i, "level": level,
                 "reason_ja": "理由", "evidence_kind": "attribute"} for i in range(n)]
    hi = decide.summarize(rows("higher", 6) + rows("similar", 4), 10, 0)["warnings"]
    lo = decide.summarize(rows("lower", 6) + rows("similar", 4), 10, 0)["warnings"]
    ok = decide.summarize(rows("lower", 3) + rows("higher", 3) + rows("similar", 4), 10, 0)["warnings"]
    assert any("higher が半分" in x for x in hi)
    assert any("lower が半分" in x for x in lo)
    assert ok == []


def test_decide_rules_are_symmetric():
    text = c.load_prompt("decide_system.md")
    assert "同じ強さの根拠" in text and "higher も lower もしません" in text
