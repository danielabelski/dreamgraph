"""Meaningful vs weak edge ratio.

Counts edges rejected for "weak meaning" reasons (tension descriptions or
rejection reasons mentioning weak/insignificant/no meaning) versus edges
that were promoted into the dream graph or validated.

Sources:
- candidate_edges (status + reason fields)
- validated_edges
- tension_log.signals + resolved_tensions (for "weak_connection" / weak meaning hits)
"""
from __future__ import annotations

import argparse
import re
from collections import Counter
from pathlib import Path

from . import loader
from ._common import add_common_args, emit, fmt_table, resolve_data_dir_from_args


WEAK_PATTERNS = re.compile(
    r"weak|insignificant|no\s+(?:meaning|significance|value)|not\s+meaningful|trivial|"
    r"does not reveal|no architectural|low signal|noise",
    re.IGNORECASE,
)


def _is_weak_text(s: str | None) -> bool:
    return bool(s and WEAK_PATTERNS.search(s))


def analyze(data_dir: Path) -> dict:
    cand = loader.candidate_edges(data_dir)
    val = loader.validated_edges(data_dir)
    tlog = loader.tension_log(data_dir)

    rejected = [c for c in cand if (c.get("status") or "").lower() == "rejected"]
    rejected_weak = 0
    rejected_other = 0
    reason_buckets: Counter = Counter()
    for c in rejected:
        text = " ".join(
            str(c.get(k) or "")
            for k in ("rejection_reason", "reason", "rationale", "notes", "description")
        )
        if _is_weak_text(text):
            rejected_weak += 1
            # Use first matching keyword for bucket label
            m = WEAK_PATTERNS.search(text)
            reason_buckets[m.group(0).lower() if m else "weak"] += 1
        else:
            rejected_other += 1

    promoted = [c for c in cand if (c.get("status") or "").lower() == "validated"]
    validated_total = len(val)

    # Tension-side: how often was "weak_connection" the dominant tension type?
    weak_active = sum(
        1 for s in tlog["signals"] if (s.get("type") or "").lower() == "weak_connection"
    )
    weak_resolved = sum(
        1 for r in tlog["resolved_tensions"]
        if (r.get("original") or {}).get("type", "").lower() == "weak_connection"
    )

    total_decided = rejected_weak + rejected_other + len(promoted)
    meaningful_ratio = (
        len(promoted) / total_decided if total_decided else 0.0
    )
    weak_rejection_share = (
        rejected_weak / len(rejected) if rejected else 0.0
    )
    weak_to_promoted = (
        rejected_weak / len(promoted) if promoted else float("inf")
    )

    return {
        "summary": {
            "candidates_total": len(cand),
            "promoted_candidates": len(promoted),
            "validated_edges_total": validated_total,
            "rejected_total": len(rejected),
            "rejected_for_weak_meaning": rejected_weak,
            "rejected_other": rejected_other,
            "meaningful_ratio": round(meaningful_ratio, 4),
            "weak_share_of_rejections": round(weak_rejection_share, 4),
            "weak_to_promoted_ratio": (
                round(weak_to_promoted, 2)
                if weak_to_promoted != float("inf") else None
            ),
        },
        "tension_evidence": {
            "active_weak_connection": weak_active,
            "resolved_weak_connection": weak_resolved,
        },
        "weak_reason_buckets": dict(reason_buckets.most_common(15)),
    }


def render(result: dict) -> None:
    s = result["summary"]
    print("Decisions on candidate edges:")
    print(f"  promoted (validated)   : {s['promoted_candidates']}")
    print(f"  rejected - weak meaning: {s['rejected_for_weak_meaning']}")
    print(f"  rejected - other       : {s['rejected_other']}")
    print(f"\n  meaningful ratio        : {s['meaningful_ratio']:.2%}  (promoted / decided)")
    print(f"  weak share of rejections: {s['weak_share_of_rejections']:.2%}")
    if s["weak_to_promoted_ratio"] is not None:
        print(f"  weak rejected per promotion: {s['weak_to_promoted_ratio']}x")
    t = result["tension_evidence"]
    print(f"\nTension corroboration: weak_connection active={t['active_weak_connection']}  resolved={t['resolved_weak_connection']}")
    if result["weak_reason_buckets"]:
        print("\nWeak-meaning reason keywords:")
        print(fmt_table(
            [[k, v] for k, v in result["weak_reason_buckets"].items()],
            ["keyword", "count"],
        ))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    add_common_args(p)
    args = p.parse_args(argv)
    emit(analyze(resolve_data_dir_from_args(args)), args, render=render)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
