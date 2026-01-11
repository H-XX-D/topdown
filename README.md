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
