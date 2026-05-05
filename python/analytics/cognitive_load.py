"""Cognitive load index — how confused is the system right now?

Combines three pressures into a single 0..1 index:

- tension_pressure   : active tensions / max(fact_entities, 1), capped at 1
- hub_fuzziness      : fraction of high-degree fact entities with health<0.5
- candidate_backlog  : pending (non-validated) candidate edges / max(decided, 1), capped at 1

Each pressure is reported alongside the composite. Higher = more confused.
"""
from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from . import hub_health, loader
from ._common import add_common_args, emit, resolve_data_dir_from_args


def analyze(data_dir: Path) -> dict:
    fact = loader.all_fact_entities(data_dir)
    cand = loader.candidate_edges(data_dir)
    tlog = loader.tension_log(data_dir)

    fact_count = max(1, len(fact))
    tension_pressure = min(1.0, len(tlog["signals"]) / fact_count)

    # Backlog of undecided candidates
    status_counts: Counter = Counter((c.get("status") or "unknown").lower() for c in cand)
    decided = status_counts.get("validated", 0) + status_counts.get("rejected", 0)
    pending = sum(v for k, v in status_counts.items() if k not in ("validated", "rejected"))
    candidate_backlog = min(1.0, pending / max(1, decided))

    # Reuse hub_health to compute fuzziness rate
    hh = hub_health.analyze(data_dir)
    with_links = max(1, hh["summary"]["with_links"])
    # fuzzy_hubs is capped at 25 in the report; we need raw count for fairness:
    # recompute by scanning hh top_hubs+fuzzy unioned, or accept the cap as a floor.
    hub_fuzziness = min(1.0, hh["summary"]["fuzzy_hubs_count"] / with_links)

    composite = round(
        0.45 * tension_pressure
        + 0.30 * hub_fuzziness
        + 0.25 * candidate_backlog,
        4,
    )

    if composite < 0.20:
        verdict = "calm"
    elif composite < 0.40:
        verdict = "engaged"
    elif composite < 0.65:
        verdict = "stressed"
    else:
        verdict = "overloaded"

    return {
        "score": composite,
        "verdict": verdict,
        "components": {
            "tension_pressure": round(tension_pressure, 4),
            "hub_fuzziness": round(hub_fuzziness, 4),
            "candidate_backlog": round(candidate_backlog, 4),
        },
        "weights": {"tension_pressure": 0.45, "hub_fuzziness": 0.30, "candidate_backlog": 0.25},
        "context": {
            "fact_entities": len(fact),
            "active_tensions": len(tlog["signals"]),
            "pending_candidates": pending,
            "decided_candidates": decided,
            "fuzzy_hubs_reported": hh["summary"]["fuzzy_hubs_count"],
            "hubs_with_links": with_links,
        },
    }


def render(result: dict) -> None:
    s = result["score"]
    bar = int(s * 30)
    print(f"Cognitive load: {s:.4f}  [{'#' * bar}{'.' * (30 - bar)}]  -> {result['verdict']}")
    print("\nComponents (weight x value):")
    for k, v in result["components"].items():
        w = result["weights"][k]
        print(f"  {k:20s} {v:.4f}  x {w:.2f} = {v * w:.4f}")
    print("\nContext:")
    for k, v in result["context"].items():
        print(f"  {k:24s} {v}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
