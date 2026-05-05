"""Orphan / dangling pressure across the fact graph."""
from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


def analyze(data_dir: Path) -> dict:
    fact = loader.all_fact_entities(data_dir)
    by_id = {e.get("id"): e for e in fact if e.get("id")}
    ids = set(by_id)

    out_targets: dict[str, list[str]] = {}
    in_count: Counter = Counter()
    dangling_edges = []
    for e in fact:
        eid = e.get("id")
        targets = []
        for link in e.get("links") or []:
            if not isinstance(link, dict):
                continue
            tgt = link.get("target")
            if not tgt:
                continue
            targets.append(tgt)
            if tgt in ids:
                in_count[tgt] += 1
            else:
                dangling_edges.append({
                    "from": eid,
                    "to": tgt,
                    "relationship": link.get("relationship"),
                })
        out_targets[eid] = targets

    degree_zero = []
    source_only = []
    sink_only = []
    for eid in ids:
        out_n = len(out_targets.get(eid, []))
        in_n = in_count[eid]
        if out_n == 0 and in_n == 0:
            degree_zero.append(eid)
        elif out_n > 0 and in_n == 0:
            source_only.append(eid)
        elif in_n > 0 and out_n == 0:
            sink_only.append(eid)

    by_type = {
        "feature": len(loader.features(data_dir)),
        "workflow": len(loader.workflows(data_dir)),
        "data_model": len(loader.data_model(data_dir)),
        "capability": len(loader.capabilities(data_dir)),
    }

    total = len(ids)
    return {
        "summary": {
            "total_entities": total,
            "by_type": by_type,
            "degree_zero": len(degree_zero),
            "source_only": len(source_only),
            "sink_only": len(sink_only),
            "dangling_edges": len(dangling_edges),
            "orphan_ratio": round(len(degree_zero) / total, 4) if total else 0.0,
        },
        "samples": {
            "degree_zero": degree_zero[:25],
            "source_only": source_only[:25],
            "sink_only": sink_only[:25],
            "dangling_edges": dangling_edges[:25],
        },
    }


def render(result: dict) -> None:
    s = result["summary"]
    print(f"Entities: {s['total_entities']}    {s['by_type']}")
    print(f"  degree-0     : {s['degree_zero']}    ({s['orphan_ratio']:.2%})")
    print(f"  source-only  : {s['source_only']}")
    print(f"  sink-only    : {s['sink_only']}")
    print(f"  dangling refs: {s['dangling_edges']}")
    samp = result["samples"]
    if samp["degree_zero"]:
        print("\nDegree-0 examples:")
        for x in samp["degree_zero"][:10]:
            print(f"  - {x}")
    if samp["dangling_edges"]:
        print("\nDangling edges (first 10):")
        rows = [[d["from"], d["to"], d.get("relationship") or ""] for d in samp["dangling_edges"][:10]]
        print(fmt_table(rows, ["from", "to (missing)", "relationship"]))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
