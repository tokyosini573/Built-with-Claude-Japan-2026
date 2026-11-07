# 対照実験の判断を Batch ではなく通常の呼び出し（同期・並列）で作り、decide と同じディスクキャッシュに入れる。
# 2026-11-07: Batch が2時間たっても進まなかったため（ユーザーの指示で通常の呼び出しに切り替え）。
#
# teppuri/ のコードは変えずに、decide と同じ関数で同じリクエストを作り、同じ RealBackend.complete で呼ぶ。
# キャッシュのキーはリクエストの中身だけで決まる（Batch か同期かは入らない）ので、
# このあと `python -m teppuri.judge.decide --app ... --yes` を実行すると全件キャッシュから読まれ、
# いつもどおり decisions.json などが書き出される。
#
# 1. 送信済みの Batch を取り消し、取り消し前に終わっていた結果をキャッシュに入れる（同じ判断を二重に払わない）
# 2. 残りを並列で呼び、1件ごとにキャッシュへ書く（途中で止まっても再実行で続きから）
#
# 実行: PYTHONPATH=. .venv/bin/python runs/controls/sync_fill_cache.py demo_matching_t5 demo_matching_m8 demo_matching_q3
import json, sys, threading, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from teppuri.judge import common as c
from teppuri.judge import decide as dz

WORKERS = int(__import__("os").environ.get("WORKERS", "24"))


def jobs_for(app_id: str):
    app = c.load_app(f"apps/{app_id}/app.yaml")
    ctx = c.RunContext(c.DEFAULT_RUNS_DIR, app.app_id, mock=False, yes=True, batch=False)
    rows = c.load_population_rows(c.DEFAULT_POPULATION_DIR)
    people, _ = dz.select_people(app, rows, None, 0, None)   # decide の既定（全員）と同じ
    jobs = dz.build_jobs(app, people, dz.load_personas(ctx.out_dir), None)
    return ctx, jobs


def harvest_batches(ctx, jobs, backend) -> int:
    """送信済みの Batch を取り消し、終わっていた分をキャッシュに入れる。"""
    by_custom = {j.key[:64]: j for j in jobs}
    cache = ctx.cache
    n = 0
    for state in sorted((ctx.out_dir / ".judge_cache" / "batches").glob("batch_*.json")):
        for bid in json.loads(state.read_text())["batch_ids"]:
            b = backend.client.messages.batches.retrieve(bid)
            if b.processing_status == "in_progress":
                backend.client.messages.batches.cancel(bid)
                print(f"  {ctx.app_id} {bid}: 取り消しを依頼", flush=True)
            for _ in range(120):
                b = backend.client.messages.batches.retrieve(bid)
                if b.processing_status == "ended":
                    break
                time.sleep(10)
            else:
                print(f"  {ctx.app_id} {bid}: 終わらないので結果の回収を飛ばす", flush=True)
                continue
            for r in backend.client.messages.batches.results(bid):
                job = by_custom.get(r.custom_id)
                if job is None or r.result.type != "succeeded" or cache.get(job.key) is not None:
                    continue
                try:
                    v = backend._parse(r.result.message)
                except Exception as e:  # noqa: BLE001
                    print(f"  回収できない {r.custom_id}: {e}", flush=True)
                    continue
                v["usage"] = dict(v.get("usage") or {}, _via="batch")
                cache.put(job.key, v)
                n += 1
            print(f"  {ctx.app_id} {bid}: {b.processing_status} {b.request_counts}", flush=True)
    return n


def main(app_ids: list[str]) -> None:
    import anthropic
    plans = []
    for app_id in app_ids:
        ctx, jobs = jobs_for(app_id)
        backend = ctx.get_backend()
        backend.client = anthropic.Anthropic(max_retries=10)   # 速度制限（429）は SDK に待って再試行させる
        got = harvest_batches(ctx, jobs, backend)
        uniq = {j.key: j for j in jobs}
        todo = [j for k, j in uniq.items() if ctx.cache.get(k) is None]
        print(f"{app_id}: 全 {len(uniq)} 件、Batch から回収 {got} 件、これから呼ぶ {len(todo)} 件", flush=True)
        plans.append((ctx, backend, todo))

    lock = threading.Lock()
    stats = {"done": 0, "fail": 0, "cost": 0.0, "batch_cost": 0.0}
    total = sum(len(t) for _, _, t in plans)
    t0 = time.time()

    def one(ctx, backend, job):
        for attempt in range(4):
            try:
                v = backend.complete(job)
                ctx.cache.put(job.key, v)
                return v
            except (c.JudgeError, json.JSONDecodeError) as e:
                err = e
            except Exception as e:  # noqa: BLE001  通信エラーなど
                err = e
                time.sleep(5 * (attempt + 1))
        raise RuntimeError(f"{ctx.app_id} {job.key[:12]}: {err}")

    with ThreadPoolExecutor(WORKERS) as ex:
        # 3つのアプリの呼び出しを交互に並べる（どれか1つだけが先に進まないように）
        order = []
        longest = max((len(t) for _, _, t in plans), default=0)
        for i in range(longest):
            for ctx, backend, todo in plans:
                if i < len(todo):
                    order.append((ctx, backend, todo[i]))
        futs = [ex.submit(one, *o) for o in order]
        for f in as_completed(futs):
            with lock:
                try:
                    v = f.result()
                    stats["done"] += 1
                    stats["cost"] += c.actual_cost(v["model"], v.get("usage", {}), False)
                except Exception as e:  # noqa: BLE001
                    stats["fail"] += 1
                    print(f"  失敗: {e}", flush=True)
                k = stats["done"] + stats["fail"]
                if k % 500 == 0 or k == total:
                    el = time.time() - t0
                    print(f"  {k}/{total} 件（失敗 {stats['fail']}）{el/60:.1f}分 費用 ${stats['cost']:.2f}", flush=True)
    print(f"完了: 成功 {stats['done']} 件、失敗 {stats['fail']} 件、通常の呼び出しの費用 ${stats['cost']:.2f}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
