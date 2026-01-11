# Top-Down

Developer-facing language augmentation with a Fusion-style **intent timeline** + **config table**.

## Core Idea

- The **config table is the source of truth**.
- Code rewrites/markers/renames are projections of that truth.
- **Locked rows do not get mutated** by automatic systems; if code changes under a locked row, Top-Down creates a *new* row.

## UX Placement

The config table is a **Panel tab** (bottom panel) so the table can be wide without fighting the sidebar.

## Dev

- `npm install`
- `npm run compile`
- Run via VS Code Extension Development Host.

## Sharing With Teammates

There are two things to share:

1) **The extension** (Top-Down) — each teammate needs it installed.
2) **The source of truth** (the table) — this should live in your repo so everyone sees the same intent.

Top-Down persists the table to:

- `.topdown/config.json`

If you want teammates to share the same IDs/rows/locks, commit `.topdown/config.json` to git.

## Packaging / Installing

To create an installable artifact:

- `npm install`
- `npm run package`

This produces a `.vsix` you can send to teammates.

Install on another machine:

- VS Code Command Palette → `Extensions: Install from VSIX...`

## Python Runtime (Shorthand)

If you want to use Top-Down IDs as Python-friendly shorthand that resolves at runtime, use the tiny stdlib-only runtime helper:

- [python/topdown_runtime.py](python/topdown_runtime.py)

Example:

```py
from topdown_runtime import td

row = td("cla7-2")
print(row.name)
print(row.args_list())
```

It auto-finds `.topdown/config.json` by walking upward from your script or cwd.

### Export (Optional)

For production or faster startup, generate a static Python module:

```bash
python python/topdown_export.py --out .topdown/generated/topdown_defs.py
```
