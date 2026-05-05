"""Model impact — what LLM cycles produced vs deterministic ones.

dream_history sessions don't currently log model name, so we infer LLM-driven
cycles by checking whether `strategy` is "llm_dream" or "all". For "all"
cycles we attribute proportional credit by reading meta_log strategy_metrics
when available. This is a best-effort report and will note when fields are
absent.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


def analyze(data_dir: Path) -> dict:
    sessions = loader.dream_history(data_dir)
    meta = loader.meta_log(data_dir)
    bootstrap = loader.llm_bootstrap_log(data_dir)

    by_strategy: dict[str, dict] = defaultdict(lambda: {
        "cycles": 0, "generated": 0, "validated": 0, "promoted": 0,
        "tensions_created": 0, "tensions_resolved": 0,
    })
    for s in sessions:
        strat = s.get("strategy") or "unknown"
        rec = by_strategy[strat]
        rec["cycles"] += 1
        rec["generated"] += int(s.get("generated_edges") or 0) + int(s.get("generated_nodes") or 0)
        n = s.get("normalization") or {}
        rec["validated"] += int(n.get("validated") or 0)
        rec["promoted"] += int(n.get("promoted") or 0)
        rec["tensions_created"] += int(s.get("tension_signals_created") or 0)
        rec["tensions_resolved"] += int(s.get("tension_signals_resolved") or 0)

    rows = []
    for strat, rec in sorted(by_strategy.items(), key=lambda kv: -kv[1]["cycles"]):
        prom_per_cycle = round(rec["promoted"] / rec["cycles"], 2) if rec["cycles"] else 0
        rows.append({
            "strategy": strat,
            **rec,
            "promoted_per_cycle": prom_per_cycle,
            "llm_driven": strat in ("llm_dream", "all"),
        })

    # Per-strategy precision from meta_log (last entry wins)
    strategy_precision = {}
    if meta:
        last = meta[-1]
        for sm in last.get("strategy_metrics") or []:
            strategy_precision[sm.get("strategy")] = {
                "total_generated": sm.get("total_generated"),
                "total_validated": sm.get("total_validated"),
                "precision": sm.get("precision"),
                "tensions_resolved": sm.get("tensions_resolved"),
                "recommended_weight": sm.get("recommended_weight"),
            }

    # LLM bootstrap models seen
    bootstrap_models = Counter()
    for entry in bootstrap or []:
        if isinstance(entry, dict):
            for key in ("dreamer_model", "normalizer_model", "model"):
                v = entry.get(key)
                if v:
                    bootstrap_models[(key, v)] += 1

    return {
        "by_strategy": rows,
        "strategy_precision_meta": strategy_precision,
        "bootstrap_models_seen": [
            {"role": k[0], "model": k[1], "count": v} for k, v in bootstrap_models.most_common()
        ],
        "notes": [
            "dream_history does not log per-cycle model identity; this report attributes work to strategy names.",
            "LLM-driven strategies: 'llm_dream' and 'all' (which includes llm_dream alongside structural strategies).",
        ],
    }


def render(result: dict) -> None:
    print("Per-strategy session totals:")
    rows = result["by_strategy"]
    print(fmt_table(
        [[r["strategy"], "*" if r["llm_driven"] else "", r["cycles"], r["generated"], r["validated"], r["promoted"], r["tensions_created"], r["tensions_resolved"], r["promoted_per_cycle"]] for r in rows],
        ["strategy", "llm", "cyc", "gen", "valid", "prom", "t_new", "t_res", "prom/cyc"],
    ))
    if result["strategy_precision_meta"]:
        print("\nLatest meta_log precision per strategy:")
        rows = [[k, v.get("total_generated"), v.get("total_validated"), v.get("precision"), v.get("tensions_resolved"), v.get("recommended_weight")] for k, v in result["strategy_precision_meta"].items()]
        print(fmt_table(rows, ["strategy", "gen", "valid", "prec", "t_res", "rec_w"]))
    if result["bootstrap_models_seen"]:
        print("\nModels seen in llm_bootstrap_log:")
        rows = [[m["role"], m["model"], m["count"]] for m in result["bootstrap_models_seen"]]
        print(fmt_table(rows, ["role", "model", "count"]))
    print("\nNotes:")
    for n in result["notes"]:
        print(f"  - {n}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
