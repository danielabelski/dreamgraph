"""Aggregate maturity score from the other analyses.

maturity = validated_edges_ratio
         - active_tension_ratio
         - orphan_ratio
         - reappearance_penalty

Bounded to [0, 1]. Higher is healthier.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from . import (
    confidence_integrity,
    loader,
    orphan_pressure,
    promotion_funnel,
    reappearance_rate,
)
from ._common import add_common_args, emit, resolve_data_dir_from_args


def analyze(data_dir: Path) -> dict:
    cand = loader.candidate_edges(data_dir)
    val = loader.validated_edges(data_dir)
    tlog = loader.tension_log(data_dir)
    fact = loader.all_fact_entities(data_dir)

    cand_count = len(cand) or 1
    val_ratio = len(val) / cand_count
    val_ratio = min(1.0, val_ratio)

    fact_count = len(fact) or 1
    active_tension_ratio = min(1.0, len(tlog["signals"]) / fact_count)

    orphans = orphan_pressure.analyze(data_dir)
    orphan_ratio = orphans["summary"]["orphan_ratio"]

    reapp = reappearance_rate.analyze(data_dir)
    reappearance_penalty = min(1.0, reapp["summary"]["reappearance_rate"])

    integrity = confidence_integrity.analyze(data_dir)
    integrity_penalty = 0.0
    if integrity["integrity_alerts"]:
        integrity_penalty = min(0.30, 0.10 * len(integrity["integrity_alerts"]))

    raw = val_ratio - active_tension_ratio - orphan_ratio - reappearance_penalty - integrity_penalty
    score = max(0.0, min(1.0, raw))

    funnel = promotion_funnel.analyze(data_dir)

    return {
        "score": round(score, 4),
        "components": {
            "validated_edges_ratio": round(val_ratio, 4),
            "active_tension_ratio": round(active_tension_ratio, 4),
            "orphan_ratio": round(orphan_ratio, 4),
            "reappearance_penalty": round(reappearance_penalty, 4),
            "integrity_penalty": round(integrity_penalty, 4),
        },
        "context": {
            "candidates": len(cand),
            "validated": len(val),
            "active_tensions": len(tlog["signals"]),
            "resolved_tensions": len(tlog["resolved_tensions"]),
            "fact_entities": len(fact),
            "promoted_lifetime": funnel["history_totals"].get("promoted", 0),
            "integrity_alerts": integrity["integrity_alerts"],
        },
    }


def render(result: dict) -> None:
    s = result["score"]
    bar = int(s * 30)
    print(f"DreamGraph maturity: {s:.4f}  [{'#' * bar}{'.' * (30 - bar)}]")
    print("\nComponents:")
    for k, v in result["components"].items():
        sign = "+" if k.endswith("_ratio") and not k.startswith("active") and not k.startswith("orphan") else "-"
        # validated_edges_ratio is the only positive contributor
        sign = "+" if k == "validated_edges_ratio" else "-"
        print(f"  {sign} {k:24s} {v}")
    print("\nContext:")
    for k, v in result["context"].items():
        if isinstance(v, list):
            print(f"  {k}:")
            for item in v[:5]:
                print(f"    - {item}")
        else:
            print(f"  {k:24s} {v}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
