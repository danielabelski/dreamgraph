"""Resolve a DreamGraph instance name or UUID to its data directory."""
from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)


@dataclass(frozen=True)
class Instance:
    uuid: str
    name: str
    project_root: str | None
    status: str
    data_dir: Path

    def to_dict(self) -> dict:
        return {
            "uuid": self.uuid,
            "name": self.name,
            "project_root": self.project_root,
            "status": self.status,
            "data_dir": str(self.data_dir),
        }


def master_dir(override: str | os.PathLike | None = None) -> Path:
    if override:
        return Path(override).expanduser().resolve()
    env = os.environ.get("DREAMGRAPH_MASTER_DIR")
    if env:
        return Path(env).expanduser().resolve()
    return Path.home() / ".dreamgraph"


def _load_registry(master: Path) -> list[dict]:
    reg = master / "instances.json"
    if not reg.exists():
        raise FileNotFoundError(
            f"No instances.json at {reg}. Pass --master-dir or set DREAMGRAPH_MASTER_DIR, "
            "or use --data-dir to point at the data directory directly."
        )
    with reg.open("r", encoding="utf-8") as f:
        doc = json.load(f)
    items = doc.get("instances", []) if isinstance(doc, dict) else []
    return [i for i in items if isinstance(i, dict)]


def list_instances(master: Path | None = None) -> list[Instance]:
    m = master or master_dir()
    out: list[Instance] = []
    for row in _load_registry(m):
        uuid = row.get("uuid", "")
        if not uuid:
            continue
        out.append(
            Instance(
                uuid=uuid,
                name=row.get("name", "") or "",
                project_root=row.get("project_root"),
                status=row.get("status", "") or "",
                data_dir=(m / uuid / "data"),
            )
        )
    return out


def resolve(
    selector: str,
    master: Path | None = None,
) -> Instance:
    """Resolve `selector` (UUID or name) to an Instance.

    Ambiguous name matches raise ValueError listing the candidates.
    """
    if not selector:
        raise ValueError("instance selector is empty")
    m = master or master_dir()
    instances = list_instances(m)

    if UUID_RE.match(selector):
        for inst in instances:
            if inst.uuid.lower() == selector.lower():
                return inst
        raise LookupError(f"No instance with uuid={selector} in {m}")

    matches = [i for i in instances if i.name == selector]
    if not matches:
        # case-insensitive fallback
        matches = [i for i in instances if i.name.lower() == selector.lower()]
    if not matches:
        names = sorted({i.name for i in instances if i.name})
        raise LookupError(
            f"No instance named {selector!r} in {m}. Known names: {', '.join(names) or '(none)'}"
        )
    if len(matches) > 1:
        # Prefer the most recently active.
        try:
            recents = []
            for inst in matches:
                row = next((r for r in _load_registry(m) if r.get("uuid") == inst.uuid), {})
                recents.append((row.get("last_active_at", ""), inst))
            recents.sort(key=lambda t: t[0], reverse=True)
            chosen = recents[0][1]
            sys.stderr.write(
                f"warning: name {selector!r} matched {len(matches)} instances; "
                f"picking most recently active uuid={chosen.uuid}\n"
            )
            return chosen
        except Exception:
            uuids = ", ".join(i.uuid for i in matches)
            raise LookupError(f"Name {selector!r} is ambiguous. Candidates: {uuids}")
    return matches[0]


def resolve_data_dir(
    *,
    instance: str | None = None,
    data_dir: str | os.PathLike | None = None,
    master_dir_override: str | os.PathLike | None = None,
) -> Path:
    """Resolve to a data directory from either --instance or --data-dir."""
    if data_dir:
        p = Path(data_dir).expanduser().resolve()
        if not p.exists():
            raise FileNotFoundError(f"--data-dir does not exist: {p}")
        return p
    if instance:
        inst = resolve(instance, master_dir_override and Path(master_dir_override))
        if not inst.data_dir.exists():
            raise FileNotFoundError(
                f"Instance {inst.name} ({inst.uuid}) has no data dir at {inst.data_dir}"
            )
        return inst.data_dir
    raise ValueError("must provide --instance or --data-dir")
