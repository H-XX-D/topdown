# Changelog

All notable changes to the Top-Down extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-15

### Added

#### Core Features
- **Config Table** - Centralized configuration management with editable rows
- **Visual DAG View** - Interactive dependency graph visualization
- **Timeline with Restore** - Full history tracking with point-in-time restore
- **Speculative Preview** - Real-time validation before saving

#### Commands
- `Top-Down: Open Config Table` - Open the main panel
- `Top-Down: Promote to Configurable` (`Cmd+Shift+T`) - Add any symbol to config
- `Top-Down: Insert Row ID` - Quick insert row ID at cursor
- `Top-Down: Duplicate Row As Variant` - Create `-N` variant copies
- `Top-Down: Ingest Workspace` - Auto-scan and inject `@td:` markers
- `Top-Down: Restore From Backup` - Revert workspace to pre-ingest state
- `Top-Down: Generate Shippable Defs` - Export TypeScript/JavaScript/JSON defs
- `Top-Down: Re-scan Workspace` - Discover newly added symbols

#### Validation
- Circular dependency detection
- Missing dependency warnings
- Args field validation (unbalanced quotes, malformed flags)
- Schema validation support

#### Runtime Libraries
- Python runtime (`topdown_runtime.py`) with `td()` function
- Python exporter (`topdown_export.py`) for generating defs
- TypeScript/JavaScript generated defs

#### CI/CD
- CLI validator (`topdown_cli.py`)
- GitHub Action workflow template
- Exit codes for CI integration

#### UI
- Modern card-based layout
- Purple accent theme
- Tab navigation (Table View / DAG View)
- Dependency chips with click-to-navigate
- Status indicators (errors, warnings, locked)
- Timeline sidebar with restore buttons

### Technical
- VS Code 1.85.0+ compatibility
- Language server integration for symbol discovery
- Automatic workspace initialization on first open
- File backup system before destructive operations

## [Unreleased]

### Planned
- Git branch-aware configs
- Team permissions and cloud sync
- Diff view when restoring
- Export to YAML/TOML formats
- VS Code settings for customization
