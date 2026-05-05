"""Confidence integrity — verifies the v8.2.6 inflation fix.

Cross-tabulates status × confidence buckets and surfaces:
- max confidence among rejected items (should be modest)
- min confidence among validated items
- reinforcement_count distribution
"""
from __future__ import annotations

import argparse
import statistics as stats
from collections import Counter, defaultdict
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


BUCKETS = [(0.0, 0.3), (0.3, 0.5), (0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 0.9), (0.9, 1.0001)]


def _bucket(c: float | None) -> str:
    if c is None:
        return "?"
    for lo, hi in BUCKETS:
        if lo <= c < hi:
            return f"{lo:.1f}-{min(hi, 1.0):.1f}"
    return "?"


def _scan(items: list[dict], conf_key: str = "confidence", status_key: str = "status") -> dict:
    cross: dict[str, Counter] = defaultdict(Counter)
    confs_by_status: dict[str, list[float]] = defaultdict(list)
    reinforcements: list[int] = []
    for it in items:
        st = (it.get(status_key) or "unknown")
        c = it.get(conf_key)
        if isinstance(c, (int, float)):
            cross[st][_bucket(float(c))] += 1
            confs_by_status[st].append(float(c))
        rc = it.get("reinforcement_count")
        if isinstance(rc, int):
            reinforcements.append(rc)
    return {"cross": cross, "by_status": confs_by_status, "reinforcements": reinforcements}


def analyze(data_dir: Path) -> dict:
    dg = loader.dream_graph(data_dir)
    val = loader.validated_edges(data_dir)
    cand = loader.candidate_edges(data_dir)

    sources = {
        "dream_graph_nodes": _scan(dg["nodes"]),
        "dream_graph_edges": _scan(dg["edges"]),
        "validated_edges": _scan(val),
        "candidate_edges": _scan(cand),
    }

    out: dict = {}
    integrity_alerts: list[str] = []
    for name, scan in sources.items():
        per_status = {}
        for st, confs in scan["by_status"].items():
            if not confs:
                continue
            per_status[st] = {
                "count": len(confs),
                "min": round(min(confs), 3),
                "median": round(stats.median(confs), 3),
                "mean": round(stats.fmean(confs), 3),
                "max": round(max(confs), 3),
                "buckets": dict(scan["cross"][st]),
            }
        out[name] = {"per_status": per_status}
        # Integrity checks
        rej = scan["by_status"].get("rejected", [])
        if rej and max(rej) >= 0.9:
            integrity_alerts.append(f"{name}: rejected items reach confidence={max(rej):.2f} (>=0.90 — possible inflation)")
        val_confs = scan["by_status"].get("validated", [])
        if val_confs and min(val_confs) < 0.3:
            integrity_alerts.append(f"{name}: a validated item has confidence={min(val_confs):.2f} (<0.30)")
        rc = scan["reinforcements"]
        if rc:
            out[name]["reinforcement"] = {
                "count": len(rc),
                "median": stats.median(rc),
                "mean": round(stats.fmean(rc), 2),
                "max": max(rc),
                "p95": sorted(rc)[int(0.95 * (len(rc) - 1))],
            }

    return {"sources": out, "integrity_alerts": integrity_alerts}


def render(result: dict) -> None:
    for name, info in result["sources"].items():
        print(f"\n=== {name} ===")
        per_status = info.get("per_status") or {}
        if not per_status:
            print("  (no items)")
            continue
        rows = []
        for st, s in per_status.items():
            rows.append([st, s["count"], s["min"], s["median"], s["mean"], s["max"]])
        print(fmt_table(rows, ["status", "n", "min", "median", "mean", "max"]))
        rc = info.get("reinforcement")
        if rc:
            print(f"  reinforcement: n={rc['count']} median={rc['median']} mean={rc['mean']} p95={rc['p95']} max={rc['max']}")
    alerts = result["integrity_alerts"]
    print("\nIntegrity alerts:")
    if alerts:
        for a in alerts:
            print(f"  ! {a}")
    else:
        print("  none — confidence ranges look healthy")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
