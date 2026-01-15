# Top-Down

**Parametric code configuration with a Fusion 360-style timeline.**

Top-Down brings parametric modeling concepts to code. Define configurable elements once, track dependencies visually, and see what breaks before you break it.

## Features

### Config Table
Centralize code configurations in one editable table. Each row represents a configurable element in your codebase.

- **ID** - Unique identifier used in code via `td("myId")`
- **Name** - Human-readable description
- **Args** - Parameters (flags, values, JSON)
- **Expression** - Computed values
- **Dependencies** - What this row depends on

### Visual DAG
See your dependency graph rendered as an interactive diagram. Click nodes to navigate, hover to highlight connections. Circular dependencies are flagged in red.

### Timeline with Restore
Every change is tracked. Scrub through history and restore to any previous state—like undo, but for your entire config.

### Speculative Preview
See validation warnings *before* you save. Circular dependencies, missing refs, and malformed args are caught in real-time.

### Promote to Configurable
Select any symbol in your code and press `Cmd+Shift+T` to add it to the config table. Top-Down uses your language server to discover functions, classes, and methods.

### CI/CD Validation
Validate configs in your pipeline:
```bash
python python/topdown_cli.py validate --strict
```

## Quick Start

1. Install the extension
2. Open a workspace
3. Top-Down auto-scans and builds your initial config table
4. Open the **Top-Down** panel (bottom panel area)
5. Add rows, set dependencies, and watch the DAG update

## Usage in Code

### Python
```python
from topdown_runtime import td

config = td("my-feature")
print(config.args)  # "--flag value"
print(config.expr)  # "x + y"
```

### TypeScript/JavaScript
```typescript
import { td } from './.topdown/generated/topdown_defs';

const config = td("my-feature");
console.log(config.args);
```

### Markers
Add `@td:` comments to link code to config rows:
```python
# @td:my-feature
def my_feature():
    pass
```

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| Top-Down: Open Config Table | `Cmd+Shift+D` | Open the config panel |
| Top-Down: Promote to Configurable | `Cmd+Shift+T` | Add selection to config |
| Top-Down: Insert Row ID | `Cmd+Shift+I` | Insert a row ID at cursor |
| Top-Down: Previous Step | `Cmd+Shift+[` | Navigate timeline backward |
| Top-Down: Next Step | `Cmd+Shift+]` | Navigate timeline forward |
| Top-Down: Duplicate Row As Variant | - | Create a `-N` variant |
| Top-Down: Ingest Workspace | - | Scan and inject `@td:` markers |
| Top-Down: Restore From Backup | - | Restore pre-ingest state |
| Top-Down: Generate Shippable Defs | - | Export to `.topdown/generated/` |
| Top-Down: Re-scan Workspace | - | Discover new symbols |

> **Note:** On Windows/Linux, use `Ctrl` instead of `Cmd`.

## CLI

Validate configs in CI/CD:

```bash
# Basic validation
python python/topdown_cli.py validate

# Fail on specific issues
python python/topdown_cli.py validate --fail-on-cycle --fail-on-missing-deps

# Strict mode (fail on any warning)
python python/topdown_cli.py validate --strict

# Show config info
python python/topdown_cli.py info --verbose
```

### GitHub Action

```yaml
name: Validate Config
on:
  pull_request:
    paths: ['.topdown/**']
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - run: python python/topdown_cli.py validate --strict
```

## Config Structure

Configs live in `.topdown/config.json`:

```json
{
  "version": 1,
  "rows": [
    {
      "id": "auth-module",
      "locked": false,
      "name": "Authentication",
      "args": "--timeout 30",
      "expr": "",
      "depends": ["database"]
    }
  ],
  "history": [...],
  "playheadIndex": 0
}
```

## Why "Top-Down"?

In Fusion 360, you model parametrically—change a dimension, and everything downstream updates. Top-Down brings this to code:

1. **Config is source of truth** - Code references config, not the other way around
2. **Dependencies are explicit** - See what depends on what
3. **Changes propagate** - Edit something, see what breaks
4. **History is preserved** - Every state is restorable

## Requirements

- VS Code 1.85.0+
- Python 3.9+ (for runtime/CLI)
- Node.js 18+ (for TypeScript runtime)

## License

MIT
