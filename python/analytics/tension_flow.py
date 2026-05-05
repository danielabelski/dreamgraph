"""Tension flow over time — derived from dream_history sessions.

Per cycle: created, resolved, expired, decayed, net delta.
Cumulative active = running net (created - resolved - expired - decayed).
"""
from __future__ import annotations

import argparse
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


def analyze(data_dir: Path) -> dict:
    sessions = loader.dream_history(data_dir)
    sessions = sorted(sessions, key=lambda s: (s.get("cycle_number") or 0, s.get("timestamp") or ""))

    rows = []
    cum_active = 0
    totals = {"created": 0, "resolved": 0, "expired": 0, "decayed": 0}
    for s in sessions:
        c = int(s.get("tension_signals_created") or 0)
        r = int(s.get("tension_signals_resolved") or 0)
        e = int(s.get("tensions_expired") or 0)
        d = int(s.get("tensions_decayed") or 0)
        delta = c - r - e - d
        cum_active = max(0, cum_active + delta)
        totals["created"] += c
        totals["resolved"] += r
        totals["expired"] += e
        totals["decayed"] += d
        rows.append({
            "cycle": s.get("cycle_number"),
            "timestamp": s.get("timestamp"),
            "created": c,
            "resolved": r,
            "expired": e,
            "decayed": d,
            "net_delta": delta,
            "cum_active_estimate": cum_active,
        })

    # ground truth from current tension_log
    tlog = loader.tension_log(data_dir)
    summary = {
        "cycles": len(rows),
        "totals": totals,
        "active_now": len(tlog["signals"]),
        "resolved_total": len(tlog["resolved_tensions"]),
        "convergence_ratio": (
            totals["resolved"] / totals["created"] if totals["created"] else None
        ),
    }
    return {"summary": summary, "per_cycle": rows}


def render(result: dict) -> None:
    s = result["summary"]
    print(f"Cycles: {s['cycles']}    active now: {s['active_now']}    resolved total: {s['resolved_total']}")
    cr = s.get("convergence_ratio")
    print(f"Convergence ratio (resolved/created across history): {cr:.2f}" if cr is not None else "Convergence ratio: n/a")
    print(f"Totals: created={s['totals']['created']}  resolved={s['totals']['resolved']}  expired={s['totals']['expired']}  decayed={s['totals']['decayed']}")
    tail = result["per_cycle"][-15:]
    if tail:
        print("\nLast 15 cycles:")
        print(fmt_table(
            [[r["cycle"], r["created"], r["resolved"], r["expired"], r["decayed"], r["net_delta"], r["cum_active_estimate"]] for r in tail],
            ["cycle", "new", "resolv", "expir", "decay", "delta", "cum~"],
        ))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
