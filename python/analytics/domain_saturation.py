"""Domain saturation — distribution of entities, dreams, candidates, tensions by domain."""
from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


def _pct(part: int, total: int) -> str:
    return f"{(100 * part / total):.1f}%" if total else "-"


def analyze(data_dir: Path) -> dict:
    fact = loader.all_fact_entities(data_dir)
    dg = loader.dream_graph(data_dir)
    val = loader.validated_edges(data_dir)
    tlog = loader.tension_log(data_dir)

    fact_dom = Counter((e.get("domain") or "unknown") for e in fact)
    dream_node_dom = Counter((n.get("domain") or "unknown") for n in dg["nodes"])
    dream_edge_dom = Counter((e.get("type") or "unknown") for e in dg["edges"])  # edges have type, not domain
    validated_dom = Counter((e.get("type") or "unknown") for e in val)
    tension_active_dom = Counter((s.get("domain") or "unknown") for s in tlog["signals"])
    tension_resolved_dom = Counter(((r.get("original") or {}).get("domain") or "unknown") for r in tlog["resolved_tensions"])

    def top(c: Counter, n: int = 12) -> list[dict]:
        total = sum(c.values())
        items = c.most_common(n)
        return [{"key": k, "count": v, "pct": _pct(v, total)} for k, v in items] + (
            [{"key": "...", "count": sum(v for _, v in c.most_common()[n:]), "pct": "-"}]
            if len(c) > n else []
        )

    return {
        "fact_entities_by_domain": top(fact_dom),
        "dream_nodes_by_domain": top(dream_node_dom),
        "dream_edges_by_type": top(dream_edge_dom),
        "validated_edges_by_type": top(validated_dom),
        "active_tensions_by_domain": top(tension_active_dom),
        "resolved_tensions_by_domain": top(tension_resolved_dom),
    }


def render(result: dict) -> None:
    def block(title, rows):
        print(f"\n{title}")
        print(fmt_table([[r["key"], r["count"], r["pct"]] for r in rows], ["key", "count", "pct"]))
    block("Fact entities by domain:", result["fact_entities_by_domain"])
    block("Dream nodes by domain:", result["dream_nodes_by_domain"])
    block("Dream edges by type:", result["dream_edges_by_type"])
    block("Validated edges by type:", result["validated_edges_by_type"])
    block("Active tensions by domain:", result["active_tensions_by_domain"])
    block("Resolved tensions by domain:", result["resolved_tensions_by_domain"])


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
