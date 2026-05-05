"""``python -m analytics`` dispatcher.

Subcommands map to modules under ``analytics.*`` and accept the standard
``--instance / --data-dir / --master-dir / --json`` arguments.

Run ``python -m analytics list`` to enumerate known instances.
"""
from __future__ import annotations

import argparse
import json
import sys
from importlib import import_module

from . import instance as inst_mod

ANALYZERS = [
    "tension_flow",
    "tension_halflife",
    "reappearance_rate",
    "domain_saturation",
    "hub_health",
    "confidence_integrity",
    "promotion_funnel",
    "orphan_pressure",
    "model_impact",
    "maturity_score",
    "meaningful_edges",
    "domain_entropy",
    "cognitive_load",
]


def _list_cmd(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="analytics list", description="List known DreamGraph instances.")
    p.add_argument("--master-dir", help="Override the master directory (default: ~/.dreamgraph).")
    p.add_argument("--json", action="store_true")
    args = p.parse_args(argv)
    md = inst_mod.master_dir(args.master_dir)
    items = inst_mod.list_instances(md)
    if args.json:
        json.dump([i.to_dict() for i in items], sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0
    print(f"Master dir: {md}")
    if not items:
        print("(no instances found)")
        return 0
    print(f"{'NAME':30s}  {'UUID':38s}  STATUS    DATA DIR EXISTS")
    for i in items:
        print(f"{(i.name or '-'):30s}  {i.uuid:38s}  {i.status:8s}  {'yes' if i.data_dir.exists() else 'no'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        _print_help()
        return 0 if argv else 1
    cmd = argv[0]
    rest = argv[1:]
    if cmd == "list":
        return _list_cmd(rest)
    if cmd not in ANALYZERS:
        sys.stderr.write(f"unknown analyzer: {cmd}\n\n")
        _print_help()
        return 2
    mod = import_module(f"analytics.{cmd}")
    return mod.main(rest)


def _print_help() -> None:
    print(__doc__)
    print("Subcommands:")
    print(f"  {'list':24s} List known instances from instances.json")
    for name in ANALYZERS:
        try:
            mod = import_module(f"analytics.{name}")
            doc = (mod.__doc__ or "").strip().splitlines()[0]
        except Exception as e:  # pragma: no cover
            doc = f"(import error: {e})"
        print(f"  {name:24s} {doc}")
    print("\nCommon options:")
    print("  --instance NAME|UUID   Instance from registry (default search: ~/.dreamgraph)")
    print("  --data-dir PATH        Skip the registry and point at a data dir directly")
    print("  --master-dir PATH      Override registry root ($DREAMGRAPH_MASTER_DIR)")
    print("  --json                 Emit structured JSON")


if __name__ == "__main__":
    raise SystemExit(main())
