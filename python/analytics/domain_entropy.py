"""Domain entropy — is attention well-distributed across domains?

Computes Shannon entropy H over the per-domain distribution of fact entities,
dream nodes, dream edges, and active tensions, then reports normalized entropy
(0..1) and a verdict:

- normalized entropy < 0.50  → "dominated" (one or two domains hog attention)
- 0.50–0.85                  → "structured" (uneven but rich)
- > 0.85                     → "flat" (no clear focal point)

We also flag the dominant domain (max share) and the long tail.
"""
from __future__ import annotations

import argparse
import math
from collections import Counter
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


def _entropy(counts: list[int]) -> tuple[float, float]:
    total = sum(counts)
    if total == 0 or len(counts) <= 1:
        return 0.0, 0.0
    h = 0.0
    for c in counts:
        if c <= 0:
            continue
        p = c / total
        h -= p * math.log2(p)
    h_max = math.log2(len(counts))
    return h, (h / h_max if h_max else 0.0)


def _verdict(norm: float) -> str:
    if norm == 0.0:
        return "empty"
    if norm < 0.50:
        return "dominated"
    if norm < 0.85:
        return "structured"
    return "flat"


def _measure(label: str, items: list[dict], domain_key: str = "domain") -> dict:
    c: Counter = Counter((it.get(domain_key) or "unknown") for it in items)
    h, norm = _entropy(list(c.values()))
    total = sum(c.values())
    sorted_dist = c.most_common()
    dominant = sorted_dist[0] if sorted_dist else (None, 0)
    return {
        "label": label,
        "total": total,
        "distinct_domains": len(c),
        "entropy_bits": round(h, 3),
        "normalized_entropy": round(norm, 3),
        "verdict": _verdict(norm),
        "dominant_domain": dominant[0],
        "dominant_share": round(dominant[1] / total, 3) if total else 0.0,
        "top": [
            {"domain": d, "count": n, "pct": round(n / total, 3)}
            for d, n in sorted_dist[:10]
        ],
    }


def analyze(data_dir: Path) -> dict:
    fact = loader.all_fact_entities(data_dir)
    dg = loader.dream_graph(data_dir)
    tlog = loader.tension_log(data_dir)
    return {
        "measures": [
            _measure("fact_entities", fact),
            _measure("dream_nodes", dg["nodes"]),
            _measure("dream_edges", dg["edges"]),
            _measure("active_tensions", tlog["signals"]),
        ],
    }


def render(result: dict) -> None:
    print(f"{'measure':18s}  {'n':>6s}  {'doms':>5s}  {'H(bits)':>8s}  {'H_norm':>7s}  verdict      dominant (share)")
    print("-" * 90)
    for m in result["measures"]:
        dom = f"{m['dominant_domain']} ({m['dominant_share']:.0%})" if m["dominant_domain"] else "-"
        print(f"{m['label']:18s}  {m['total']:>6d}  {m['distinct_domains']:>5d}  {m['entropy_bits']:>8.3f}  {m['normalized_entropy']:>7.3f}  {m['verdict']:11s}  {dom}")
    for m in result["measures"]:
        print(f"\nTop domains in {m['label']}:")
        rows = [[t["domain"], t["count"], f"{t['pct']:.1%}"] for t in m["top"]]
        print(fmt_table(rows, ["domain", "count", "pct"]))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
