"""Lazy JSON loaders for a DreamGraph instance data directory."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _read(data_dir: Path, filename: str) -> Any:
    p = data_dir / filename
    if not p.exists():
        return None
    with p.open("r", encoding="utf-8") as f:
        return json.load(f)


# --- Entity stores (arrays of {id, name, links, ...}) -----------------------

def features(data_dir: Path) -> list[dict]:
    return _read(data_dir, "features.json") or []


def workflows(data_dir: Path) -> list[dict]:
    return _read(data_dir, "workflows.json") or []


def data_model(data_dir: Path) -> list[dict]:
    return _read(data_dir, "data_model.json") or []


def capabilities(data_dir: Path) -> list[dict]:
    return _read(data_dir, "capabilities.json") or []


def all_fact_entities(data_dir: Path) -> list[dict]:
    """Union of features + workflows + data_model + capabilities."""
    out: list[dict] = []
    for fn in (features, workflows, data_model, capabilities):
        out.extend(fn(data_dir))
    return out


# --- Cognitive stores -------------------------------------------------------

def tension_log(data_dir: Path) -> dict:
    doc = _read(data_dir, "tension_log.json") or {}
    return {
        "signals": doc.get("signals") or [],
        "resolved_tensions": doc.get("resolved_tensions") or [],
    }


def dream_graph(data_dir: Path) -> dict:
    doc = _read(data_dir, "dream_graph.json") or {}
    return {
        "nodes": doc.get("nodes") or [],
        "edges": doc.get("edges") or [],
    }


def dream_history(data_dir: Path) -> list[dict]:
    doc = _read(data_dir, "dream_history.json") or {}
    return doc.get("sessions") or []


def candidate_edges(data_dir: Path) -> list[dict]:
    doc = _read(data_dir, "candidate_edges.json") or {}
    return doc.get("results") or []


def validated_edges(data_dir: Path) -> list[dict]:
    doc = _read(data_dir, "validated_edges.json") or {}
    return doc.get("edges") or []


def meta_log(data_dir: Path) -> list[dict]:
    doc = _read(data_dir, "meta_log.json") or {}
    return doc.get("entries") or []


def llm_bootstrap_log(data_dir: Path) -> list[dict]:
    doc = _read(data_dir, "llm_bootstrap_log.json")
    if isinstance(doc, list):
        return doc
    if isinstance(doc, dict):
        return doc.get("entries") or doc.get("events") or []
    return []
