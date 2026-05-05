"""Reappearance rate — tensions on the same entity-pair returning after resolution."""
from __future__ import annotations

import argparse
from collections import defaultdict
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


def _pair(entities) -> tuple[str, ...]:
    if not isinstance(entities, list):
        return ()
    return tuple(sorted(str(e) for e in entities if e))


def analyze(data_dir: Path) -> dict:
    tlog = loader.tension_log(data_dir)

    # Resolved → first resolution timestamp per pair (and total occurrences)
    resolved_pairs: dict[tuple[str, ...], dict] = defaultdict(lambda: {"count": 0, "first_resolved_at": None, "types": set()})
    for r in tlog["resolved_tensions"]:
        orig = r.get("original") or {}
        pair = _pair(orig.get("entities"))
        if not pair:
            continue
        rec = resolved_pairs[pair]
        rec["count"] += 1
        ts = r.get("resolved_at")
        if ts and (rec["first_resolved_at"] is None or ts < rec["first_resolved_at"]):
            rec["first_resolved_at"] = ts
        rec["types"].add(orig.get("type") or "unknown")

    # Active signals on a pair that was previously resolved → reappearance
    reappearances = []
    for s in tlog["signals"]:
        pair = _pair(s.get("entities"))
        if pair in resolved_pairs:
            r = resolved_pairs[pair]
            reappearances.append({
                "pair": list(pair),
                "active_first_seen": s.get("first_seen"),
                "active_last_seen": s.get("last_seen"),
                "active_occurrences": s.get("occurrences"),
                "previously_resolved_count": r["count"],
                "previously_resolved_at": r["first_resolved_at"],
                "type": s.get("type"),
            })

    # Multi-resolution pairs (pair was resolved more than once historically)
    repeat_resolved = sum(1 for v in resolved_pairs.values() if v["count"] > 1)

    total_resolved_pairs = len(resolved_pairs)
    return {
        "summary": {
            "distinct_resolved_pairs": total_resolved_pairs,
            "pairs_resolved_more_than_once": repeat_resolved,
            "active_reappearances": len(reappearances),
            "reappearance_rate": (
                len(reappearances) / total_resolved_pairs if total_resolved_pairs else 0.0
            ),
        },
        "reappearances": sorted(
            reappearances,
            key=lambda x: (x["previously_resolved_count"], x["active_occurrences"] or 0),
            reverse=True,
        )[:50],
    }


def render(result: dict) -> None:
    s = result["summary"]
    print(f"Distinct resolved pairs:        {s['distinct_resolved_pairs']}")
    print(f"Pairs resolved >1 times:        {s['pairs_resolved_more_than_once']}")
    print(f"Active tensions on resolved pairs: {s['active_reappearances']}")
    print(f"Reappearance rate:              {s['reappearance_rate']:.2%}")
    if result["reappearances"]:
        print("\nTop reappearances:")
        rows = [
            [f"{r['pair'][0]} <-> {r['pair'][1]}" if len(r['pair']) >= 2 else str(r['pair']),
             r["previously_resolved_count"], r["active_occurrences"], r["type"]]
            for r in result["reappearances"][:20]
        ]
        print(fmt_table(rows, ["pair", "prev_resolves", "active_occ", "type"]))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
