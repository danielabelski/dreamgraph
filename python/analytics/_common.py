"""Shared output helpers for analytics modules."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from . import instance as inst_mod


def add_common_args(p: argparse.ArgumentParser) -> None:
    g = p.add_argument_group("instance selection")
    g.add_argument("--instance", "-i", help="Instance name or UUID (resolved via instances.json).")
    g.add_argument("--data-dir", help="Path to a data directory (escape hatch; bypasses the registry).")
    g.add_argument("--master-dir", help="Override the master directory (default: $DREAMGRAPH_MASTER_DIR or ~/.dreamgraph).")
    p.add_argument("--json", action="store_true", help="Emit JSON instead of a human-readable summary.")


def resolve_data_dir_from_args(args: argparse.Namespace) -> Path:
    return inst_mod.resolve_data_dir(
        instance=getattr(args, "instance", None),
        data_dir=getattr(args, "data_dir", None),
        master_dir_override=getattr(args, "master_dir", None),
    )


def emit(result: dict, args: argparse.Namespace, *, render) -> None:
    """Print JSON or call ``render(result)`` for a human summary."""
    if getattr(args, "json", False):
        json.dump(result, sys.stdout, indent=2, default=str)
        sys.stdout.write("\n")
    else:
        render(result)


def fmt_table(rows: list[list[Any]], headers: list[str]) -> str:
    cols = list(zip(*([headers] + [[str(c) for c in r] for r in rows]))) if rows else [headers]
    widths = [max(len(c) for c in col) for col in cols]
    line = "  ".join(h.ljust(w) for h, w in zip(headers, widths))
    sep = "  ".join("-" * w for w in widths)
    out = [line, sep]
    for r in rows:
        out.append("  ".join(str(c).ljust(w) for c, w in zip(r, widths)))
    return "\n".join(out)
