"""Promotion funnel — candidate → latent → validated → promoted, by strategy."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


def analyze(data_dir: Path) -> dict:
    cand = loader.candidate_edges(data_dir)
    val = loader.validated_edges(data_dir)
    dg = loader.dream_graph(data_dir)
    sessions = loader.dream_history(data_dir)

    cand_status = Counter(c.get("status") or "unknown" for c in cand)
    val_status = Counter(e.get("status") or "unknown" for e in val)
    dg_node_status = Counter(n.get("status") or "unknown" for n in dg["nodes"])
    dg_edge_status = Counter(e.get("status") or "unknown" for e in dg["edges"])

    # Per-strategy promotion data via dream_id prefix in candidate_edges
    by_strategy: dict[str, Counter] = defaultdict(Counter)
    for c in cand:
        did = (c.get("dream_id") or "").split("_")
        # dream ids look like dream_<strategy>_<ts>_<n>
        strat = did[1] if len(did) > 1 else "unknown"
        by_strategy[strat][c.get("status") or "unknown"] += 1

    strategy_rows = []
    for strat, sc in sorted(by_strategy.items()):
        total = sum(sc.values())
        validated = sc.get("validated", 0)
        rejected = sc.get("rejected", 0)
        latent = sc.get("latent", 0)
        strategy_rows.append({
            "strategy": strat,
            "total": total,
            "validated": validated,
            "latent": latent,
            "rejected": rejected,
            "validation_rate": round(validated / total, 3) if total else 0.0,
        })
    strategy_rows.sort(key=lambda r: r["total"], reverse=True)

    # History totals
    totals = Counter()
    for s in sessions:
        n = s.get("normalization") or {}
        for k in ("validated", "latent", "rejected", "promoted", "promoted_entities", "blocked_by_gate"):
            totals[k] += int(n.get(k) or 0)
        for k in ("generated_edges", "generated_nodes", "duplicates_merged", "decayed_edges", "decayed_nodes"):
            totals[k] += int(s.get(k) or 0)

    return {
        "history_totals": dict(totals),
        "candidate_edges_status": dict(cand_status),
        "validated_edges_status": dict(val_status),
        "dream_graph_node_status": dict(dg_node_status),
        "dream_graph_edge_status": dict(dg_edge_status),
        "by_strategy": strategy_rows,
    }


def render(result: dict) -> None:
    print("Lifetime totals (from dream_history):")
    for k, v in result["history_totals"].items():
        print(f"  {k:24s} {v}")
    def block(title, d):
        print(f"\n{title}")
        if not d:
            print("  (empty)")
            return
        rows = sorted(d.items(), key=lambda kv: -kv[1])
        print(fmt_table([[k, v] for k, v in rows], ["status", "count"]))
    block("candidate_edges status:", result["candidate_edges_status"])
    block("validated_edges status:", result["validated_edges_status"])
    block("dream_graph nodes status:", result["dream_graph_node_status"])
    block("dream_graph edges status:", result["dream_graph_edge_status"])
    print("\nBy strategy (candidate_edges):")
    print(fmt_table(
        [[r["strategy"], r["total"], r["validated"], r["latent"], r["rejected"], r["validation_rate"]] for r in result["by_strategy"]],
        ["strategy", "total", "valid", "latent", "rejct", "rate"],
    ))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
