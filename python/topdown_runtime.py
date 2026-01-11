"""Top-Down runtime resolver for Python.

This is intentionally dependency-free (stdlib only).

Usage:

    from topdown_runtime import td

    row = td("cla7-2")
    args = row.args_list()  # shlex-split args

The resolver auto-finds `.topdown/config.json` by walking upward from:
- `TOPDOWN_ROOT` (if set), else
- the caller's file directory, else
- current working directory.
"""

from __future__ import annotations

import inspect
import json
import os
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


STORE_RELATIVE = Path(".topdown") / "config.json"


class TopDownError(RuntimeError):
    pass


class TopDownNotFound(TopDownError):
    pass


class TopDownIdNotFound(TopDownError):
    pass


@dataclass(frozen=True)
class TopDownRow:
    id: str
    locked: bool = False
    name: str = ""
    args: str = ""
    expr: str = ""
    scope: Optional[str] = None

    def args_list(self) -> list[str]:
        """Split `args` like a shell command line (safe, no eval)."""
        if not self.args:
            return []
        return shlex.split(self.args)


def _iter_parents(start: Path) -> Iterable[Path]:
    p = start
    while True:
        yield p
        if p.parent == p:
            return
        p = p.parent


def _caller_dir() -> Optional[Path]:
    try:
        for frame in inspect.stack()[2:]:
            filename = frame.filename
            if not filename:
                continue
            # Skip stdlib/internal frames.
            if filename.startswith("<"):
                continue
            path = Path(filename)
            if path.exists():
                return path.parent
    except Exception:
        return None
    return None


def find_topdown_root(start: Optional[os.PathLike[str] | str] = None) -> Path:
    """Find the project root containing `.topdown/config.json`.

    Order:
    1) `TOPDOWN_ROOT` env var, if set.
    2) `start` argument.
    3) caller's directory.
    4) current working directory.

    Walks upward until it finds `.topdown/config.json`.
    """

    env_root = os.environ.get("TOPDOWN_ROOT")
    if env_root:
        root = Path(env_root).expanduser().resolve()
        if (root / STORE_RELATIVE).exists():
            return root

    candidates: list[Path] = []
    if start is not None:
        candidates.append(Path(start).expanduser().resolve())
    caller = _caller_dir()
    if caller is not None:
        candidates.append(caller.resolve())
    candidates.append(Path.cwd().resolve())

    for base in candidates:
        for p in _iter_parents(base):
            if (p / STORE_RELATIVE).exists():
                return p

    raise TopDownNotFound(f"Could not find {STORE_RELATIVE} (set TOPDOWN_ROOT or run within a project that has it)")


_cache: dict[Path, tuple[float, dict[str, Any]]] = {}


def _load_store(config_path: Path) -> dict[str, Any]:
    stat = config_path.stat()
    mtime = stat.st_mtime

    cached = _cache.get(config_path)
    if cached and cached[0] == mtime:
        return cached[1]

    data = json.loads(config_path.read_text("utf-8"))
    if not isinstance(data, dict):
        raise TopDownError("Invalid Top-Down config: expected a JSON object")

    _cache[config_path] = (mtime, data)
    return data


def td(row_id: str, *, root: Optional[os.PathLike[str] | str] = None) -> TopDownRow:
    """Resolve a Top-Down row by ID from `.topdown/config.json`.

    Returns a `TopDownRow` dataclass.
    """

    if not isinstance(row_id, str) or not row_id.strip():
        raise ValueError("row_id must be a non-empty string")

    project_root = find_topdown_root(root)
    config_path = project_root / STORE_RELATIVE

    store = _load_store(config_path)
    rows = store.get("rows")
    if not isinstance(rows, list):
        raise TopDownError("Invalid Top-Down config: expected 'rows' to be a list")

    wanted = row_id.strip()
    for r in rows:
        if not isinstance(r, dict):
            continue
        if r.get("id") != wanted:
            continue
        return TopDownRow(
            id=wanted,
            locked=bool(r.get("locked") or False),
            name=str(r.get("name") or ""),
            args=str(r.get("args") or ""),
            expr=str(r.get("expr") or ""),
            scope=str(r.get("scope")) if r.get("scope") is not None else None,
        )

    raise TopDownIdNotFound(f"Top-Down id not found: {wanted}")
