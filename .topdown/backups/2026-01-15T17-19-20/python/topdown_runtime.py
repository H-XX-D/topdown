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

import glob
import hashlib
import inspect
import json
import os
import shlex
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


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
    depends: tuple[str, ...] = ()  # Using tuple for frozen dataclass
    sources: tuple[str, ...] = ()  # File patterns this row watches

    def args_list(self) -> list[str]:
        """Split `args` like a shell command line (safe, no eval)."""
        if not self.args:
            return []
        return shlex.split(self.args)

    def get_source_files(self, base_dir: Optional[Path] = None) -> List[Path]:
        """Expand source patterns to actual file paths."""
        base = base_dir or Path.cwd()
        files: List[Path] = []
        for pattern in self.sources:
            # Support glob patterns
            matched = glob.glob(str(base / pattern), recursive=True)
            files.extend(Path(f) for f in matched)
        return sorted(set(files))


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
        deps = r.get("depends", [])
        if isinstance(deps, str):
            deps = [d.strip() for d in deps.split(",") if d.strip()]
        elif not isinstance(deps, list):
            deps = []
        sources = r.get("sources", [])
        if isinstance(sources, str):
            sources = [s.strip() for s in sources.split(",") if s.strip()]
        elif not isinstance(sources, list):
            sources = []
        return TopDownRow(
            id=wanted,
            locked=bool(r.get("locked") or False),
            name=str(r.get("name") or ""),
            args=str(r.get("args") or ""),
            expr=str(r.get("expr") or ""),
            scope=str(r.get("scope")) if r.get("scope") is not None else None,
            depends=tuple(deps),
            sources=tuple(sources),
        )

    raise TopDownIdNotFound(f"Top-Down id not found: {wanted}")


# =============================================================================
# File Change Detection
# =============================================================================

def compute_file_hash(filepath: Path) -> str:
    """Compute SHA-256 hash of a file's contents."""
    if not filepath.exists():
        return ""
    try:
        content = filepath.read_bytes()
        return hashlib.sha256(content).hexdigest()[:16]
    except (IOError, PermissionError):
        return ""


def compute_sources_hash(row: TopDownRow, base_dir: Optional[Path] = None) -> str:
    """Compute combined hash of all source files for a row."""
    files = row.get_source_files(base_dir)
    if not files:
        return ""

    # Hash each file and combine
    hashes = []
    for f in sorted(files):
        h = compute_file_hash(f)
        if h:
            hashes.append(f"{f.name}:{h}")

    if not hashes:
        return ""

    combined = "|".join(hashes)
    return hashlib.sha256(combined.encode()).hexdigest()[:16]


class FileHashCache:
    """Cache for file content hashes with change detection."""

    def __init__(self, base_dir: Optional[Path] = None):
        self.base_dir = base_dir or Path.cwd()
        self._hashes: Dict[str, str] = {}  # filepath -> hash
        self._row_hashes: Dict[str, str] = {}  # row_id -> sources hash

    def update_file(self, filepath: Path) -> Tuple[str, str, bool]:
        """Update hash for a file. Returns (old_hash, new_hash, changed)."""
        key = str(filepath.resolve())
        old_hash = self._hashes.get(key, "")
        new_hash = compute_file_hash(filepath)
        changed = old_hash != new_hash
        self._hashes[key] = new_hash
        return old_hash, new_hash, changed

    def update_row_sources(self, row: TopDownRow) -> Tuple[str, str, bool]:
        """Update hash for a row's sources. Returns (old_hash, new_hash, changed)."""
        old_hash = self._row_hashes.get(row.id, "")
        new_hash = compute_sources_hash(row, self.base_dir)
        changed = old_hash != new_hash
        self._row_hashes[row.id] = new_hash
        return old_hash, new_hash, changed

    def get_file_hash(self, filepath: Path) -> str:
        """Get cached hash for a file."""
        return self._hashes.get(str(filepath.resolve()), "")

    def get_row_hash(self, row_id: str) -> str:
        """Get cached sources hash for a row."""
        return self._row_hashes.get(row_id, "")

    def to_dict(self) -> Dict[str, Any]:
        """Export cache state."""
        return {
            "files": dict(self._hashes),
            "rows": dict(self._row_hashes),
        }

    def from_dict(self, data: Dict[str, Any]) -> None:
        """Import cache state."""
        self._hashes = dict(data.get("files", {}))
        self._row_hashes = dict(data.get("rows", {}))
