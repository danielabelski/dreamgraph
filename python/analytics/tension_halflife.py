"""Tension half-life — lifetime of resolved tensions, broken down."""
from __future__ import annotations

import argparse
import statistics as stats
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


def _parse(ts: str | None):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def _seconds(a: str | None, b: str | None) -> float | None:
    da, db = _parse(a), _parse(b)
    if da is None or db is None:
        return None
    return (db - da).total_seconds()


def analyze(data_dir: Path) -> dict:
    tlog = loader.tension_log(data_dir)
    resolved = tlog["resolved_tensions"]
    active = tlog["signals"]

    # Per resolved tension: lifetime = resolved_at - first_seen
    res_lifetimes_sec: list[float] = []
    by_type: dict[str, list[float]] = defaultdict(list)
    by_resolution: dict[str, list[float]] = defaultdict(list)
    by_domain: dict[str, list[float]] = defaultdict(list)
    for r in resolved:
        orig = r.get("original") or {}
        secs = _seconds(orig.get("first_seen"), r.get("resolved_at"))
        if secs is None or secs < 0:
            continue
        res_lifetimes_sec.append(secs)
        by_type[orig.get("type") or "unknown"].append(secs)
        by_resolution[r.get("resolution_type") or "unknown"].append(secs)
        by_domain[orig.get("domain") or "unknown"].append(secs)

    # Active tensions: age = now - first_seen
    now = datetime.now().astimezone()
    ages_sec: list[float] = []
    for s in active:
        age = _seconds(s.get("first_seen"), now.isoformat())
        if age is not None and age >= 0:
            ages_sec.append(age)

    def summarize(xs: list[float]) -> dict:
        if not xs:
            return {"count": 0}
        return {
            "count": len(xs),
            "median_hours": round(stats.median(xs) / 3600, 2),
            "mean_hours": round(stats.fmean(xs) / 3600, 2),
            "p90_hours": round(sorted(xs)[int(0.9 * (len(xs) - 1))] / 3600, 2),
            "max_hours": round(max(xs) / 3600, 2),
        }

    return {
        "resolved_lifetime": summarize(res_lifetimes_sec),
        "active_age": summarize(ages_sec),
        "by_resolution_type": {k: summarize(v) for k, v in sorted(by_resolution.items())},
        "by_tension_type": {k: summarize(v) for k, v in sorted(by_type.items())},
        "by_domain": {k: summarize(v) for k, v in sorted(by_domain.items())},
    }


def render(result: dict) -> None:
    print("Resolved tension lifetime:")
    s = result["resolved_lifetime"]
    if s["count"]:
        print(f"  n={s['count']}  median={s['median_hours']}h  mean={s['mean_hours']}h  p90={s['p90_hours']}h  max={s['max_hours']}h")
    else:
        print("  (none)")
    print("\nActive tension age:")
    a = result["active_age"]
    if a["count"]:
        print(f"  n={a['count']}  median={a['median_hours']}h  mean={a['mean_hours']}h  p90={a['p90_hours']}h  max={a['max_hours']}h")
    else:
        print("  (none)")

    def block(title, d):
        print(f"\n{title}")
        rows = [[k, v["count"], v.get("median_hours", "-"), v.get("mean_hours", "-"), v.get("p90_hours", "-")] for k, v in d.items()]
        print(fmt_table(rows, ["key", "n", "median_h", "mean_h", "p90_h"]))

    block("By resolution_type:", result["by_resolution_type"])
    block("By tension type:", result["by_tension_type"])
    block("By domain:", result["by_domain"])


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
