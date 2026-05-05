"""Hub health — high-degree but low-health entities (important but fuzzy)."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


def analyze(data_dir: Path) -> dict:
    fact = loader.all_fact_entities(data_dir)
    by_id = {e.get("id"): e for e in fact if e.get("id")}

    out_deg: Counter = Counter()
    in_deg: Counter = Counter()
    for e in fact:
        eid = e.get("id")
        for link in e.get("links") or []:
            if not isinstance(link, dict):
                continue
            tgt = link.get("target")
            if not tgt:
                continue
            out_deg[eid] += 1
            in_deg[tgt] += 1

    # Health proxy (0..1): description quality + tag/keyword richness + status active.
    # Low values flag "fuzzy" hubs.
    tlog = loader.tension_log(data_dir)
    tension_hits: Counter = Counter()
    for s in tlog["signals"]:
        for ent in s.get("entities") or []:
            tension_hits[ent] += 1

    def health(e: dict) -> float:
        score = 0.0
        if (e.get("status") or "").lower() == "active":
            score += 0.25
        desc = e.get("description") or ""
        if len(desc) >= 60:
            score += 0.25
        elif len(desc) >= 20:
            score += 0.10
        if (e.get("tags") or []):
            score += 0.15
        if (e.get("keywords") or []):
            score += 0.15
        if (e.get("source_files") or []):
            score += 0.10
        # Penalize tension pressure
        score -= min(0.30, 0.05 * tension_hits.get(e.get("id"), 0))
        return max(0.0, min(1.0, score))

    rows = []
    for eid, e in by_id.items():
        deg = out_deg[eid] + in_deg[eid]
        if deg == 0:
            continue
        rows.append({
            "id": eid,
            "name": e.get("name"),
            "domain": e.get("domain"),
            "out_degree": out_deg[eid],
            "in_degree": in_deg[eid],
            "degree": deg,
            "tension_hits": tension_hits.get(eid, 0),
            "health": round(health(e), 3),
        })

    # Sort: degree desc then health asc to surface "important but fuzzy"
    rows.sort(key=lambda r: (-r["degree"], r["health"]))
    fuzzy = [r for r in rows if r["health"] < 0.5][:25]
    return {
        "summary": {
            "total_entities": len(by_id),
            "with_links": sum(1 for r in rows),
            "fuzzy_hubs_count": len(fuzzy),
        },
        "top_hubs": rows[:25],
        "fuzzy_hubs": fuzzy,
    }


def render(result: dict) -> None:
    s = result["summary"]
    print(f"Entities: {s['total_entities']}    with at least one link: {s['with_links']}    fuzzy hubs: {s['fuzzy_hubs_count']}")
    def block(title, rows):
        print(f"\n{title}")
        print(fmt_table(
            [[r["name"] or r["id"], r["domain"], r["degree"], r["out_degree"], r["in_degree"], r["tension_hits"], r["health"]] for r in rows],
            ["entity", "domain", "deg", "out", "in", "tens", "health"],
        ))
    block("Top hubs by degree:", result["top_hubs"])
    block("Fuzzy hubs (high degree + low health):", result["fuzzy_hubs"])


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
