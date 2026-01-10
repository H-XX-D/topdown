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
