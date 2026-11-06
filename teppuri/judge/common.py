"""判断担当の共通部品。

- モデルと料金の表
- プロンプトファイルの読み込み
- アプリ（app.yaml）と人口ファイルの読み込み
- リクエストの組み立て（画像はローカル参照のまま持ち、送る直前に Files API の file_id に置き換える）
- ディスクキャッシュ（同じリクエストは二度送らない）
- 費用見積もり（呼び出し前に必ず出す）
- 実クライアント（同期 / Batch API）とモッククライアント
"""
from __future__ import annotations

import base64
import copy
import csv
import hashlib
import json
import os
import re
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
JUDGE_DIR = Path(__file__).resolve().parent
PROMPTS_DIR = JUDGE_DIR / "prompts"
DEFAULT_RUNS_DIR = REPO_ROOT / "runs"
DEFAULT_POPULATION_DIR = REPO_ROOT / "data" / "population"

# ---------------------------------------------------------------------------
# モデルと料金（claude-api スキル 2026-10-06 時点の表。単位: ドル / 100万トークン）
# ---------------------------------------------------------------------------
MODEL_PERSONA = "claude-opus-5-5"
MODEL_DECIDE = "claude-haiku-5-5"
MODEL_REPORT = "claude-opus-5-5"
MODEL_INTERVIEW = "claude-sonnet-5-5"

PRICES = {
    # input, output, cache_read（キャッシュ読み込み）
    "claude-opus-5-5": {"input": 4.00, "output": 20.00, "cache_read": 0.20},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.20},
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01},
}
CACHE_WRITE_5M = 1.25  # 5分キャッシュの書き込みは入力の 1.25 倍
CACHE_WRITE_1H = 2.0  # 1時間キャッシュの書き込みは入力の 2 倍
BATCH_DISCOUNT = 0.5  # Batch API は全トークン半額

# 拒否時にサーバー側で別モデルに切り替える（Opus 5.5 / Sonnet 5.5 の同期呼び出しのみ。Batch では使えない）
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FALLBACK_MODELS = {"claude-opus-5-5", "claude-sonnet-5-5"}

LEVELS = ["higher", "similar", "lower"]
STEP_ORDER = ["install", "signup", "gate", "core_action", "retention", "pay"]


def load_env() -> None:
    """teppuri/.env を読む（キーは表示も記録もしない）。"""
    try:
        from dotenv import load_dotenv
    except ImportError:  # python-dotenv が無くても動く
        return
    load_dotenv(REPO_ROOT / ".env", override=False)


def has_api_key() -> bool:
    load_env()
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


# ---------------------------------------------------------------------------
# プロンプト
# ---------------------------------------------------------------------------
def load_prompt(name: str) -> str:
    return (PROMPTS_DIR / name).read_text(encoding="utf-8").strip()


def load_prompt_yaml(name: str) -> Any:
    return yaml.safe_load((PROMPTS_DIR / name).read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# アプリと人口
# ---------------------------------------------------------------------------
@dataclass
class App:
    path: Path
    data: dict

    @property
    def app_id(self) -> str:
        return self.data["app_id"]

    @property
    def base_dir(self) -> Path:
        return self.path.parent

    def screens(self) -> list[Path]:
        return [self.base_dir / s for s in self.data.get("screens", [])]

    def plans(self) -> dict[str, dict]:
        return self.data.get("plans", {})

    def creatives(self) -> list[tuple[str, str, Path]]:
        """(plan, creative_id, path) の一覧。creative_id はファイル名の拡張子なし（契約 §3 の例 "a1"）。

        広告（plan.creatives）に加え、オーガニック動画（plan.organic_video.creative_ids）も含む。
        動画の見本画像は organic_video.images があればそれ、なければ ads/<id>.png。
        """
        return [(p, cid, path) for p, cid, path, _ in self.creative_items()]

    def creative_items(self) -> list[tuple[str, str, Path, str]]:
        """(plan, creative_id, path, kind)。kind は "ad"（広告）か "organic_video"（オーガニックの短尺動画）。"""
        out = []
        for plan_id, plan in self.plans().items():
            for c in plan.get("creatives", []) or []:
                out.append((plan_id, Path(c).stem, self.base_dir / c, "ad"))
            ov = plan.get("organic_video") or {}
            ids = ov.get("creative_ids", []) or []
            images = ov.get("images", []) or []
            for i, cid in enumerate(ids):
                img = images[i] if i < len(images) else f"ads/{cid}.png"
                out.append((plan_id, str(cid), self.base_dir / img, "organic_video"))
        return out

    def steps(self) -> list[str]:
        """install 以外の段階。gate は app.yaml の宣言順。"""
        gates = [f"gate:{g['id']}" for g in self.data.get("gates", []) or []]
        return ["signup", *gates, "core_action", "retention", "pay"]


def load_app(path: str | Path) -> App:
    p = Path(path).resolve()
    with p.open(encoding="utf-8") as f:
        data = yaml.safe_load(f)
    for key in ("app_id", "preset", "plans"):
        if key not in data:
            raise ValueError(f"app.yaml に {key} がありません: {p}")
    return App(p, data)


def app_summary_ja(app: App, include_plans: bool = True) -> str:
    """プロンプトに入れるアプリ情報（数字は app.yaml の入力そのもの）。キャッシュのため毎回同じ文字列になるよう sort_keys を使う。

    include_plans=False のときは案の条件（地域・ターゲット・チャネル）を入れない（判断ではエンジンが別に扱うため）。"""
    d = app.data
    keep = {k: d.get(k) for k in ("app_id", "name_ja", "preset", "min_age", "description_ja", "gates", "pricing")}
    plans = {}
    for plan_id, plan in sorted(app.plans().items()):
        plans[plan_id] = {k: plan.get(k) for k in ("regions", "period_days", "campaign_days", "target", "channels")}
        plans[plan_id]["creatives"] = [Path(c).stem for c in plan.get("creatives", []) or []]
    if include_plans:
        keep["plans"] = plans
    return yaml.safe_dump(keep, allow_unicode=True, sort_keys=True)


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def load_representatives(population_dir: Path) -> list[dict]:
    """representatives.csv と、あれば japan_10k.csv の属性をつないで返す。"""
    reps = read_csv(population_dir / "representatives.csv")
    people_path = population_dir / "japan_10k.csv"
    people = {}
    if people_path.exists():
        people = {row["person_id"]: row for row in read_csv(people_path)}
    out = []
    for r in reps:
        attrs = dict(people.get(r["person_id"], {}))
        attrs.pop("weight", None)
        attrs.pop("cluster_id", None)
        out.append({
            "cluster_id": int(r["cluster_id"]),
            "person_id": int(r["person_id"]),
            "label_ja": r.get("label_ja", ""),
            "cluster_size": r.get("cluster_size"),
            "attributes": attrs,
        })
    out.sort(key=lambda x: x["cluster_id"])
    return out


def load_population_rows(population_dir: Path) -> dict[int, dict]:
    p = population_dir / "japan_10k.csv"
    if not p.exists():
        return {}
    return {int(r["person_id"]): r for r in read_csv(p)}


ATTR_LABELS_JA = {
    "age": "年齢", "sex": "性別", "pref_name": "都道府県", "city_size": "都市規模", "marital": "婚姻",
    "household": "世帯", "employment": "就業", "income_band": "所得帯", "has_smartphone": "スマホ",
    "os": "OS", "sns_line": "LINE", "sns_x": "X", "sns_instagram": "Instagram", "sns_tiktok": "TikTok",
    "sns_youtube": "YouTube", "trait_price": "価格への敏感さ", "trait_novelty": "新しもの好き",
    "trait_privacy": "個人情報への警戒", "trait_wom": "口コミ・レビュー依存", "trait_ad_aversion": "広告嫌い",
}


# 判断（decide）に渡さない属性: 地域・都市規模（密度）・SNS 利用はエンジンが別に計算する
ENGINE_HANDLED_ATTRS = ("pref_name", "city_size", "sns_line", "sns_x", "sns_instagram", "sns_tiktok", "sns_youtube")


def attrs_line_ja(attrs: dict, exclude: tuple[str, ...] = ()) -> str:
    """属性を「年齢=27 / 性別=F / …」の一行にする（列の順は固定）。"""
    parts = []
    for key, label in ATTR_LABELS_JA.items():
        if key in exclude:
            continue
        if key in attrs and attrs[key] not in (None, ""):
            parts.append(f"{label}={attrs[key]}")
    return " / ".join(parts)


# ---------------------------------------------------------------------------
# リクエストの部品
# ---------------------------------------------------------------------------
def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def media_type_of(path: Path) -> str:
    ext = path.suffix.lower()
    return {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "application/octet-stream")


def text_block(text: str, cache: str | None = None) -> dict:
    """cache: None / "5m" / "1h"。"""
    b: dict = {"type": "text", "text": text}
    if cache == "1h":
        b["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
    elif cache:
        b["cache_control"] = {"type": "ephemeral"}
    return b


def image_block(path: Path, cache: str | None = None) -> dict:
    """ローカル画像への参照。送る直前に Files API の file_id へ置き換える。キャッシュキーは sha256 で決まる。"""
    b: dict = {"type": "image", "source": {"type": "local_file", "path": str(path),
                                            "sha256": file_sha256(path), "media_type": media_type_of(path)}}
    if cache == "1h":
        b["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
    elif cache:
        b["cache_control"] = {"type": "ephemeral"}
    return b


def json_output(schema: dict) -> dict:
    return {"format": {"type": "json_schema", "schema": schema}}


# ---------------------------------------------------------------------------
# ジョブとキャッシュ
# ---------------------------------------------------------------------------
@dataclass
class Job:
    task: str
    request: dict  # messages.create の引数（画像はローカル参照）
    est_output_tokens: int
    mock_output: dict | None = None
    meta: dict = field(default_factory=dict)

    @property
    def model(self) -> str:
        return self.request["model"]

    @property
    def key(self) -> str:
        return request_key(self.request)


def _normalize_for_key(obj: Any) -> Any:
    """キャッシュキー用: 画像の絶対パスを除き、sha256 だけで区別する。"""
    if isinstance(obj, dict):
        if obj.get("type") == "local_file":
            return {"type": "local_file", "sha256": obj["sha256"]}
        return {k: _normalize_for_key(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize_for_key(v) for v in obj]
    return obj


def request_key(request: dict) -> str:
    s = json.dumps(_normalize_for_key(request), ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


class DiskCache:
    """1リクエスト = 1ファイル。中身は {"output", "model", "usage"}。"""

    def __init__(self, root: Path):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        return self.root / key[:2] / f"{key}.json"

    def get(self, key: str) -> dict | None:
        p = self._path(key)
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
        return None

    def put(self, key: str, value: dict) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(p)


# ---------------------------------------------------------------------------
# 費用見積もり
# ---------------------------------------------------------------------------
def estimate_text_tokens(text: str) -> int:
    """おおまかな推定: ASCII は4文字で1トークン、日本語などは1文字1トークン（多めに見る）。"""
    ascii_n = sum(1 for ch in text if ord(ch) < 128)
    return int(ascii_n / 4 + (len(text) - ascii_n) * 1.0) + 1


def image_size(path: Path) -> tuple[int, int] | None:
    data = path.read_bytes()[:65536]
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", data[16:24])
        return w, h
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            seg_len = struct.unpack(">H", data[i + 2:i + 4])[0]
            i += 2 + seg_len
    return None


# 実測の補正: デモアプリの画像11枚で、下の式の約2倍のトークンだった（2026-11-06、Haiku 5.5）
IMAGE_TOKEN_FACTOR = 2.0


def estimate_image_tokens(path: Path) -> int:
    """長辺 1568px・約115万画素に縮小される前提で (幅×高さ)/750 に実測の補正を掛ける。読めなければ 3200。"""
    size = image_size(Path(path)) if Path(path).exists() else None
    if not size:
        return 3200
    w, h = size
    scale = min(1.0, 1568 / max(w, h), (1_150_000 / (w * h)) ** 0.5)
    return max(1, int((w * scale) * (h * scale) / 750 * IMAGE_TOKEN_FACTOR))


def _block_tokens(block: dict) -> int:
    if block.get("type") == "text":
        return estimate_text_tokens(block["text"])
    if block.get("type") == "image":
        return estimate_image_tokens(Path(block["source"].get("path", "")))
    return 0


def split_prefix_tokens(request: dict) -> tuple[int, int, str | None]:
    """(キャッシュ対象の先頭トークン, それ以外, ttl) を返す。順序は system → messages。"""
    blocks: list[dict] = []
    system = request.get("system")
    if isinstance(system, str):
        blocks.append({"type": "text", "text": system})
    elif system:
        blocks.extend(system)
    for m in request.get("messages", []):
        c = m["content"]
        blocks.extend([{"type": "text", "text": c}] if isinstance(c, str) else c)
    schema_tokens = estimate_text_tokens(json.dumps(request.get("output_config", {}), ensure_ascii=False))
    last_cache = -1
    ttl = None
    for i, b in enumerate(blocks):
        if "cache_control" in b:
            last_cache = i
            ttl = b["cache_control"].get("ttl", "5m")
    toks = [_block_tokens(b) for b in blocks]
    prefix = sum(toks[: last_cache + 1]) if last_cache >= 0 else 0
    rest = sum(toks[last_cache + 1:]) + schema_tokens
    return prefix, rest, ttl


@dataclass
class Estimate:
    task: str
    model: str
    calls: int
    cached_calls: int
    input_tokens: int
    output_tokens: int
    usd_with_cache: float
    usd_without_cache: float
    batch: bool


def estimate_jobs(jobs: list[Job], cache: DiskCache | None, batch: bool) -> list[Estimate]:
    groups: dict[tuple[str, str], list[Job]] = {}
    for j in jobs:
        groups.setdefault((j.task, j.model), []).append(j)
    out = []
    seen_prefix: set[str] = set()  # 同じ先頭部分はタスクをまたいでも最初の1回だけ書き込み
    for (task, model), js in groups.items():
        price = PRICES[model]
        mult = BATCH_DISCOUNT if batch else 1.0
        todo = [j for j in js if not (cache and cache.get(j.key))]
        in_tok = out_tok = 0
        with_cache = without_cache = 0.0
        for j in todo:
            prefix, rest, ttl = split_prefix_tokens(j.request)
            in_tok += prefix + rest
            out_tok += j.est_output_tokens
            out_cost = j.est_output_tokens * price["output"]
            without_cache += (prefix + rest) * price["input"] + out_cost
            # キャッシュが効く場合: 同じ先頭部分の最初の1回だけ書き込み、残りは読み込み
            pkey = json.dumps(_normalize_for_key(_prefix_part(j.request)), sort_keys=True, ensure_ascii=False)
            if prefix and pkey not in seen_prefix:
                seen_prefix.add(pkey)
                w = CACHE_WRITE_1H if ttl == "1h" else CACHE_WRITE_5M
                with_cache += prefix * price["input"] * w
            else:
                with_cache += prefix * price["cache_read"]
            with_cache += rest * price["input"] + out_cost
        out.append(Estimate(task, model, len(js), len(js) - len(todo), in_tok, out_tok,
                            with_cache * mult / 1e6, without_cache * mult / 1e6, batch))
    return out


def _prefix_part(request: dict) -> list:
    """キャッシュ境界までの部分（見積もりで「同じ先頭か」を判定するため）。"""
    parts: list = [request.get("model"), request.get("system")]
    for m in request.get("messages", []):
        c = m["content"]
        if isinstance(c, str):
            parts.append(c)
            continue
        for b in c:
            parts.append(b)
            if "cache_control" in b:
                return parts
    return parts


def print_estimates(ests: list[Estimate], out=None) -> None:
    out = out or sys.stdout
    print("=== 費用見積もり（推定。トークンは文字数と画像サイズからの概算） ===", file=out)
    total_c = total_n = 0.0
    for e in ests:
        mode = "Batch(半額)" if e.batch else "同期"
        print(f"- {e.task} / {e.model} / {mode}: 呼び出し {e.calls - e.cached_calls} 回"
              f"（全 {e.calls} 回中 {e.cached_calls} 回はディスクキャッシュ済み）", file=out)
        print(f"    入力 約{e.input_tokens:,} トークン / 出力 約{e.output_tokens:,} トークン（思考を含む推定）", file=out)
        print(f"    推定 ${e.usd_with_cache:.3f}（プロンプトキャッシュが効いた場合）"
              f" 〜 ${e.usd_without_cache:.3f}（効かなかった場合）", file=out)
        total_c += e.usd_with_cache
        total_n += e.usd_without_cache
    print(f"合計: ${total_c:.3f} 〜 ${total_n:.3f}", file=out)


def actual_cost(model: str, usage: dict, batch: bool) -> float:
    p = PRICES.get(model.removeprefix("mock:"), PRICES[MODEL_PERSONA])
    cost = (usage.get("input_tokens", 0) * p["input"]
            + usage.get("cache_creation_input_tokens", 0) * p["input"] * CACHE_WRITE_1H
            + usage.get("cache_read_input_tokens", 0) * p["cache_read"]
            + usage.get("output_tokens", 0) * p["output"]) / 1e6
    return cost * (BATCH_DISCOUNT if batch else 1.0)


# ---------------------------------------------------------------------------
# バックエンド
# ---------------------------------------------------------------------------
class JudgeError(RuntimeError):
    pass


def mock_from_schema(schema: dict, seed: str, path: str = "") -> Any:
    """JSON スキーマに合う決定的なダミー値を作る（モック用）。"""
    t = schema.get("type")
    if "enum" in schema:
        opts = schema["enum"]
        h = int(hashlib.sha256((seed + path).encode()).hexdigest(), 16)
        return opts[h % len(opts)]
    if t == "object":
        return {k: mock_from_schema(v, seed, f"{path}.{k}") for k, v in schema.get("properties", {}).items()}
    if t == "array":
        return [mock_from_schema(schema.get("items", {}), seed, f"{path}[0]")]
    if t == "integer":
        return 0
    if t == "number":
        return 0.0
    if t == "boolean":
        return False
    return f"（モック）{path.lstrip('.')}"


class MockBackend:
    """API を呼ばない。job.mock_output があればそれを、無ければスキーマから作った値を返す。"""

    name = "mock"

    def __init__(self):
        self.calls: list[Job] = []

    def complete(self, job: Job) -> dict:
        self.calls.append(job)
        if job.mock_output is not None:
            out = copy.deepcopy(job.mock_output)
        else:
            schema = job.request["output_config"]["format"]["schema"]
            out = mock_from_schema(schema, job.key)
        return {"output": out, "model": f"mock:{job.model}", "usage": {}}

    def run_batch(self, jobs: list[Job], state_dir: Path) -> dict[str, dict]:
        return {j.key: self.complete(j) for j in jobs}


class RealBackend:
    """Anthropic SDK を使う。画像は Files API で一度だけ上げ、file_id で参照する。"""

    name = "real"

    def __init__(self, files_map_path: Path):
        load_env()
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise JudgeError("ANTHROPIC_API_KEY がありません。teppuri/.env に入れるか --mock で実行してください。")
        import anthropic

        self.anthropic = anthropic
        self.client = anthropic.Anthropic()
        self.files_map_path = files_map_path
        self.files_map: dict[str, str] = {}
        if files_map_path.exists():
            self.files_map = json.loads(files_map_path.read_text(encoding="utf-8"))

    # 画像の置き換え -------------------------------------------------------
    def _file_id(self, src: dict) -> str:
        sha = src["sha256"]
        if sha not in self.files_map:
            p = Path(src["path"])
            uploaded = self.client.files.upload(file=(p.name, p.read_bytes(), src["media_type"]))
            self.files_map[sha] = uploaded.id
            self.files_map_path.parent.mkdir(parents=True, exist_ok=True)
            self.files_map_path.write_text(json.dumps(self.files_map, indent=1), encoding="utf-8")
        return self.files_map[sha]

    def _resolve(self, obj: Any) -> Any:
        if isinstance(obj, dict):
            if obj.get("type") == "local_file":
                return {"type": "file", "file_id": self._file_id(obj)}
            return {k: self._resolve(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [self._resolve(v) for v in obj]
        return obj

    @staticmethod
    def _parse(msg: Any) -> dict:
        if msg.stop_reason == "refusal":
            raise JudgeError(f"拒否されました: {getattr(msg, 'stop_details', None)}")
        if msg.stop_reason == "max_tokens":
            raise JudgeError("max_tokens に達して出力が途中で切れました")
        text = next((b.text for b in msg.content if b.type == "text"), None)
        if text is None:
            raise JudgeError("テキストの出力がありません")
        u = msg.usage
        usage = {k: getattr(u, k, 0) or 0 for k in
                 ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")}
        return {"output": json.loads(text), "model": msg.model, "usage": usage}

    # 同期 -----------------------------------------------------------------
    def complete(self, job: Job) -> dict:
        params = self._resolve(job.request)
        if job.model in FALLBACK_MODELS:
            with self.client.beta.messages.stream(**params, betas=[FALLBACK_BETA], fallbacks="default") as s:
                msg = s.get_final_message()
        else:
            with self.client.messages.stream(**params) as s:
                msg = s.get_final_message()
        return self._parse(msg)

    # Batch API ------------------------------------------------------------
    def run_batch(self, jobs: list[Job], state_dir: Path, poll_seconds: int = 30) -> dict[str, dict]:
        """未送信なら送り、送信済み（state ファイルあり）なら結果を待つ。同じジョブ集合を二重に送らない。"""
        state_dir.mkdir(parents=True, exist_ok=True)
        keys = sorted(j.key for j in jobs)
        set_id = hashlib.sha256("".join(keys).encode()).hexdigest()[:16]
        state_path = state_dir / f"batch_{set_id}.json"
        by_custom = {j.key[:64]: j for j in jobs}
        if state_path.exists():
            batch_ids = json.loads(state_path.read_text())["batch_ids"]
            print(f"送信済みの Batch を待ちます: {batch_ids}")
        else:
            batch_ids = []
            chunk = 10000
            for i in range(0, len(jobs), chunk):
                reqs = [{"custom_id": j.key[:64], "params": self._resolve(j.request)} for j in jobs[i:i + chunk]]
                b = self.client.messages.batches.create(requests=reqs)
                batch_ids.append(b.id)
            state_path.write_text(json.dumps({"batch_ids": batch_ids}), encoding="utf-8")
            print(f"Batch を送信しました: {batch_ids}")
        results: dict[str, dict] = {}
        for bid in batch_ids:
            while True:
                b = self.client.messages.batches.retrieve(bid)
                if b.processing_status == "ended":
                    break
                print(f"  {bid}: {b.processing_status} 処理中 {b.request_counts.processing}")
                time.sleep(poll_seconds)
            for r in self.client.messages.batches.results(bid):
                job = by_custom.get(r.custom_id)
                if job is None:
                    continue
                if r.result.type == "succeeded":
                    try:
                        results[job.key] = self._parse(r.result.message)
                    except (JudgeError, json.JSONDecodeError) as e:
                        print(f"  失敗 {r.custom_id}: {e}")
                else:
                    print(f"  失敗 {r.custom_id}: {r.result.type}")
        state_path.unlink(missing_ok=True)
        return results


# ---------------------------------------------------------------------------
# 実行の共通手順
# ---------------------------------------------------------------------------
@dataclass
class RunContext:
    runs_dir: Path
    app_id: str
    mock: bool
    yes: bool
    batch: bool = False
    backend: Any = None  # テストで差し替える

    @property
    def out_dir(self) -> Path:
        return self.runs_dir / self.app_id

    @property
    def cache(self) -> DiskCache:
        return DiskCache(self.out_dir / ".judge_cache" / ("mock" if self.mock else "real"))

    def get_backend(self):
        if self.backend is None:
            self.backend = MockBackend() if self.mock else RealBackend(self.out_dir / ".judge_cache" / "files.json")
        return self.backend


def run_jobs(jobs: list[Job], ctx: RunContext, out=None) -> dict[str, dict] | None:
    """見積もり → （dry-run なら終了）→ 未キャッシュ分だけ呼ぶ → キャッシュに保存。

    戻り値は {job.key: {"output", "model", "usage"}}。dry-run のときは None。
    モックは費用がかからないので --yes なしで実行する。
    """
    out = out or sys.stdout
    cache = ctx.cache
    print_estimates(estimate_jobs(jobs, None if ctx.mock else cache, ctx.batch), out=out)
    if not ctx.mock and not ctx.yes:
        print("dry-run です（API は呼んでいません）。実行するには --yes を付けてください。", file=out)
        return None
    backend = ctx.get_backend()
    results: dict[str, dict] = {}
    todo: list[Job] = []
    seen: set[str] = set()
    for j in jobs:
        hit = cache.get(j.key)
        if hit is not None:
            results[j.key] = hit
        elif j.key not in seen:
            seen.add(j.key)
            todo.append(j)
    if todo:
        if ctx.batch:
            fresh = backend.run_batch(todo, ctx.out_dir / ".judge_cache" / "batches")
        else:
            fresh = {}
            for i, j in enumerate(todo, 1):
                try:
                    fresh[j.key] = backend.complete(j)
                except (JudgeError, json.JSONDecodeError) as e:
                    print(f"  失敗 ({j.task} {i}/{len(todo)}): {e}", file=out)
        spent = 0.0
        for k, v in fresh.items():
            cache.put(k, v)
            results[k] = v
            spent += actual_cost(v["model"], v.get("usage", {}), ctx.batch)
        if not ctx.mock:
            print(f"実際の費用（usage から計算）: ${spent:.4f}", file=out)
    print(f"結果: {len(results)}/{len(set(j.key for j in jobs))} 件（新規 {len(todo)} 件）", file=out)
    return results


def add_common_args(parser) -> None:
    parser.add_argument("--app", required=True, help="apps/<app_id>/app.yaml")
    parser.add_argument("--runs-dir", default=str(DEFAULT_RUNS_DIR))
    parser.add_argument("--yes", action="store_true", help="実際に API を呼ぶ（無ければ dry-run）")
    parser.add_argument("--mock", action="store_true", help="API を呼ばずモックで出力を作る")


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def write_json_gz(path: Path, data: Any) -> Path:
    """<path>.gz に書く（コミットする大きなファイル用。中身は .json と同じ）。"""
    import gzip

    gz = Path(str(path) + ".gz") if not str(path).endswith(".gz") else Path(path)
    gz.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(gz, "wt", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    return gz


def json_exists(path: Path) -> bool:
    """path か path.gz のどちらかがあるか。"""
    return Path(path).exists() or Path(str(path) + ".gz").exists()


def read_json(path: Path) -> Any:
    """.json を読む。無ければ .json.gz を読む。"""
    import gzip

    p = Path(path)
    if not p.exists() and Path(str(p) + ".gz").exists():
        p = Path(str(p) + ".gz")
    if p.suffix == ".gz":
        with gzip.open(p, "rt", encoding="utf-8") as f:
            return json.load(f)
    return json.loads(p.read_text(encoding="utf-8"))


NUMERIC_IN_REASON = re.compile(r"[0-9０-９]+\s*(%|％|割|人|倍|パーセント)")


def app_context_blocks(app: App, cache: str | None = "1h", include_plans: bool = True) -> list[dict]:
    """アプリ情報・画面・広告を並べた user コンテンツ。全呼び出しで同じ内容なので先頭に置き、最後にキャッシュ境界を付ける。"""
    blocks: list[dict] = [text_block("## アプリの情報（app.yaml）\n" + app_summary_ja(app, include_plans))]
    # 画像ファイルがまだ無い場合（デモの画面ができる前など）は、その旨を文字で書いて画像は送らない
    for i, path in enumerate(app.screens(), 1):
        if path.exists():
            blocks.append(text_block(f"画面 {i:02d}（{path.name}）"))
            blocks.append(image_block(path))
        else:
            blocks.append(text_block(f"画面 {i:02d}（{path.name}）: 画像なし"))
    for plan_id, cid, path, kind in app.creative_items():
        label = (f"広告 {cid}（{plan_id}案の広告素材）" if kind == "ad"
                 else f"短尺動画 {cid}（{plan_id}案のオーガニック投稿。動画の絵コンテ見本）")
        if path.exists():
            blocks.append(text_block(label))
            blocks.append(image_block(path))
        else:
            blocks.append(text_block(f"{label}: 画像なし。アプリの説明と案の条件から想像する"))
    if cache:
        last = blocks[-1]
        last["cache_control"] = {"type": "ephemeral", "ttl": "1h"} if cache == "1h" else {"type": "ephemeral"}
    return blocks
