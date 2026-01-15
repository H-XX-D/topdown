import * as vscode from 'vscode';

type ConfigRow = {
  id: string;
  locked: boolean;
  name: string;
  args: string;
  expr: string;
  scope?: string;
  depends?: string[];  // IDs this row depends on
  sources?: string[];  // File glob patterns this row watches
  status?: 'ok' | 'warning' | 'error';  // Computed status from diagnostics
  statusMessage?: string;
  pinned?: boolean;  // Pin row to top of list
  notes?: string;  // User notes/comments for this row
};

type Bookmark = {
  id: string;
  name: string;
  ts: number;
  rowsSnapshot: ConfigRow[];
};

type RowTemplate = {
  id: string;
  name: string;
  description: string;
  row: Partial<ConfigRow>;
};

// Built-in row templates for common patterns
const BUILTIN_TEMPLATES: RowTemplate[] = [
  {
    id: 'empty',
    name: 'Empty Row',
    description: 'A blank row with no defaults',
    row: { locked: false, name: '', args: '', expr: '' },
  },
  {
    id: 'config-flag',
    name: 'Config Flag',
    description: 'A boolean configuration flag',
    row: { locked: false, name: 'Feature Flag', args: '--enabled', expr: 'true' },
  },
  {
    id: 'build-target',
    name: 'Build Target',
    description: 'A build/compile target with sources',
    row: { locked: false, name: 'Build Target', args: '-O2 -Wall', expr: '', sources: ['src/**/*.c'] },
  },
  {
    id: 'env-var',
    name: 'Environment Variable',
    description: 'An environment variable definition',
    row: { locked: false, name: 'ENV_VAR', args: '', expr: '${VALUE}' },
  },
  {
    id: 'api-endpoint',
    name: 'API Endpoint',
    description: 'An API endpoint configuration',
    row: { locked: false, name: 'API Endpoint', args: 'GET /api/v1/resource', expr: '' },
  },
  {
    id: 'test-suite',
    name: 'Test Suite',
    description: 'A test suite or test configuration',
    row: { locked: false, name: 'Test Suite', args: '--coverage --verbose', expr: '' },
  },
  {
    id: 'deployment',
    name: 'Deployment Config',
    description: 'A deployment configuration',
    row: { locked: false, name: 'Deployment', args: '--env production', expr: '', scope: 'deploy' },
  },
];

type HistoryEntry = {
  ts: number;
  kind: string;
  label: string;
  snapshots?: Record<string, string>;  // file path -> content snapshot for restore
  rowsSnapshot?: ConfigRow[];  // Snapshot of rows at this point in time
};

type ConfigStoreV1 = {
  version: 1;
  rows: ConfigRow[];
  playheadIndex?: number;
  history?: HistoryEntry[];
  bookmarks?: Bookmark[];  // Named snapshots
  collapsedScopes?: string[];  // Collapsed scope sections
  lastBackup?: number;  // Timestamp of last auto-backup
  schema?: {
    // Schema definitions for args validation per row ID
    [rowId: string]: {
      argsPattern?: string;  // Regex pattern for args validation
      argsType?: 'flags' | 'keyvalue' | 'json' | 'free';
      requiredArgs?: string[];  // Required arg names
    };
  };
};

// -----------------------------------------------------------------------------------------
// Dependency Graph Utilities
// -----------------------------------------------------------------------------------------

type DependencyNode = {
  id: string;
  depends: string[];
  dependents: string[];  // Reverse edges - who depends on this node
};

type DependencyGraph = Map<string, DependencyNode>;

function buildDependencyGraph(rows: ConfigRow[]): DependencyGraph {
  const graph: DependencyGraph = new Map();

  // Initialize all nodes
  for (const row of rows) {
    graph.set(row.id, {
      id: row.id,
      depends: row.depends ?? [],
      dependents: [],
    });
  }

  // Build reverse edges (dependents)
  for (const row of rows) {
    for (const depId of row.depends ?? []) {
      const depNode = graph.get(depId);
      if (depNode) {
        depNode.dependents.push(row.id);
      }
    }
  }

  return graph;
}

function detectCycles(graph: DependencyGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(nodeId: string): boolean {
    visited.add(nodeId);
    recursionStack.add(nodeId);
    path.push(nodeId);

    const node = graph.get(nodeId);
    if (node) {
      for (const depId of node.depends) {
        if (!visited.has(depId)) {
          if (dfs(depId)) return true;
        } else if (recursionStack.has(depId)) {
          // Found a cycle
          const cycleStart = path.indexOf(depId);
          cycles.push(path.slice(cycleStart).concat([depId]));
          return true;
        }
      }
    }

    path.pop();
    recursionStack.delete(nodeId);
    return false;
  }

  for (const nodeId of graph.keys()) {
    if (!visited.has(nodeId)) {
      dfs(nodeId);
    }
  }

  return cycles;
}

function topologicalSort(graph: DependencyGraph): { sorted: string[]; hasCycle: boolean } {
  const inDegree = new Map<string, number>();
  const sorted: string[] = [];

  // Initialize in-degrees
  for (const [id, node] of graph) {
    inDegree.set(id, node.depends.filter(d => graph.has(d)).length);
  }

  // Find all nodes with no dependencies
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);

    const node = graph.get(current);
    if (node) {
      for (const depId of node.dependents) {
        const newDegree = (inDegree.get(depId) ?? 1) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) queue.push(depId);
      }
    }
  }

  return {
    sorted,
    hasCycle: sorted.length !== graph.size,
  };
}

function getAffectedDownstream(graph: DependencyGraph, changedId: string): string[] {
  const affected: string[] = [];
  const visited = new Set<string>();

  function traverse(id: string) {
    if (visited.has(id)) return;
    visited.add(id);

    const node = graph.get(id);
    if (node) {
      for (const depId of node.dependents) {
        affected.push(depId);
        traverse(depId);
      }
    }
  }

  traverse(changedId);
  return affected;
}

function computeMaxDepth(graph: DependencyGraph): number {
  const depths = new Map<string, number>();

  function getDepth(id: string, visited: Set<string>): number {
    if (visited.has(id)) return 0; // Cycle detected
    if (depths.has(id)) return depths.get(id)!;

    visited.add(id);
    const node = graph.get(id);
    if (!node || node.depends.length === 0) {
      depths.set(id, 0);
      visited.delete(id);
      return 0;
    }

    let maxChildDepth = 0;
    for (const dep of node.depends) {
      maxChildDepth = Math.max(maxChildDepth, getDepth(dep, visited));
    }

    const depth = maxChildDepth + 1;
    depths.set(id, depth);
    visited.delete(id);
    return depth;
  }

  let maxDepth = 0;
  for (const id of graph.keys()) {
    maxDepth = Math.max(maxDepth, getDepth(id, new Set()));
  }
  return maxDepth;
}

// -----------------------------------------------------------------------------------------
// Schema Validation Utilities
// -----------------------------------------------------------------------------------------

type ValidationResult = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

function validateArgs(args: string, schema?: { argsPattern?: string; argsType?: string; requiredArgs?: string[] }): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!args.trim()) {
    return { valid: true, errors, warnings };
  }

  // Check for unbalanced quotes
  const singleQuotes = (args.match(/'/g) || []).length;
  const doubleQuotes = (args.match(/"/g) || []).length;
  if (singleQuotes % 2 !== 0) {
    errors.push('Unbalanced single quotes');
  }
  if (doubleQuotes % 2 !== 0) {
    errors.push('Unbalanced double quotes');
  }

  // Check for common flag patterns
  const flagPattern = /--?([a-zA-Z][-a-zA-Z0-9_]*)/g;
  const flags = new Set<string>();
  let match;
  while ((match = flagPattern.exec(args)) !== null) {
    flags.add(match[1]);
  }

  // Check required args if schema provided
  if (schema?.requiredArgs) {
    for (const req of schema.requiredArgs) {
      if (!flags.has(req) && !args.includes(req)) {
        warnings.push(`Missing required arg: ${req}`);
      }
    }
  }

  // Check pattern if provided
  if (schema?.argsPattern) {
    try {
      const regex = new RegExp(schema.argsPattern);
      if (!regex.test(args)) {
        warnings.push(`Args don't match expected pattern`);
      }
    } catch {
      // Invalid regex in schema
    }
  }

  // Type-specific validation
  if (schema?.argsType === 'json') {
    try {
      JSON.parse(args);
    } catch {
      errors.push('Invalid JSON in args');
    }
  } else if (schema?.argsType === 'keyvalue') {
    // Check for key=value format
    const kvPattern = /^(\s*[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*[^\s,]+\s*,?\s*)+$/;
    if (!kvPattern.test(args.trim())) {
      warnings.push('Expected key=value format');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

type SpeculativeValidation = {
  hasIssues: boolean;
  cycleWarnings: string[];
  missingDeps: string[];
  argsErrors: Array<{ id: string; errors: string[]; warnings: string[] }>;
  affectedRows: string[];
};

function speculativeValidate(rows: ConfigRow[], schema?: ConfigStoreV1['schema']): SpeculativeValidation {
  const result: SpeculativeValidation = {
    hasIssues: false,
    cycleWarnings: [],
    missingDeps: [],
    argsErrors: [],
    affectedRows: [],
  };

  const rowIds = new Set(rows.map(r => r.id));

  // Check for cycles
  const graph = buildDependencyGraph(rows);
  const cycles = detectCycles(graph);
  if (cycles.length > 0) {
    result.hasIssues = true;
    for (const cycle of cycles) {
      result.cycleWarnings.push(`Circular: ${cycle.join(' → ')}`);
    }
  }

  // Check for missing dependencies
  for (const row of rows) {
    for (const dep of row.depends ?? []) {
      if (!rowIds.has(dep)) {
        result.hasIssues = true;
        result.missingDeps.push(`${row.id} depends on missing "${dep}"`);
      }
    }
  }

  // Validate args for each row
  for (const row of rows) {
    const rowSchema = schema?.[row.id];
    const validation = validateArgs(row.args, rowSchema);
    if (!validation.valid || validation.warnings.length > 0) {
      result.argsErrors.push({
        id: row.id,
        errors: validation.errors,
        warnings: validation.warnings,
      });
      if (!validation.valid) {
        result.hasIssues = true;
      }
    }
  }

  return result;
}

const STORE_RELATIVE = '.topdown/config.json';

function getWorkspaceRoot(): vscode.Uri | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri;
}

async function readStore(): Promise<ConfigStoreV1> {
  const root = getWorkspaceRoot();
  if (!root) return { version: 1, rows: [], history: [] };

  const uri = vscode.Uri.joinPath(root, STORE_RELATIVE);
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const raw = Buffer.from(bytes).toString('utf8');
    const parsed = JSON.parse(raw) as Partial<ConfigStoreV1>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.rows)) {
      return { version: 1, rows: [], history: [] };
    }
    return {
      version: 1,
      rows: parsed.rows.filter((r): r is ConfigRow => !!r && typeof (r as any).id === 'string'),
      playheadIndex: typeof parsed.playheadIndex === 'number' ? parsed.playheadIndex : undefined,
      history: Array.isArray(parsed.history)
        ? parsed.history.filter((h) => h && typeof (h as any).label === 'string')
        : [],
    };
  } catch {
    return { version: 1, rows: [], history: [] };
  }
}

// Auto-backup settings
const AUTO_BACKUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_AUTO_BACKUPS = 10;

async function writeStore(store: ConfigStoreV1): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) return;

  const dir = vscode.Uri.joinPath(root, '.topdown');
  const uri = vscode.Uri.joinPath(root, STORE_RELATIVE);

  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // ignore
  }

  // Check if auto-backup is needed
  const now = Date.now();
  const lastBackup = store.lastBackup ?? 0;
  if (now - lastBackup > AUTO_BACKUP_INTERVAL_MS) {
    await createAutoBackup(root, store);
    store.lastBackup = now;
  }

  const text = JSON.stringify(store, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

async function createAutoBackup(root: vscode.Uri, store: ConfigStoreV1): Promise<void> {
  try {
    const backupsDir = vscode.Uri.joinPath(root, '.topdown', 'backups', 'auto');
    await vscode.workspace.fs.createDirectory(backupsDir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = vscode.Uri.joinPath(backupsDir, `config-${timestamp}.json`);

    const text = JSON.stringify(store, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(backupFile, Buffer.from(text, 'utf8'));

    // Clean up old auto-backups
    await cleanupAutoBackups(backupsDir, MAX_AUTO_BACKUPS);
  } catch (err) {
    console.error('Top-Down: Failed to create auto-backup:', err);
  }
}

async function cleanupAutoBackups(backupsDir: vscode.Uri, maxBackups: number): Promise<void> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(backupsDir);
    const backupFiles = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.startsWith('config-') && name.endsWith('.json'))
      .map(([name]) => name)
      .sort()
      .reverse();

    // Delete oldest backups if we have too many
    if (backupFiles.length > maxBackups) {
      for (const name of backupFiles.slice(maxBackups)) {
        const fileUri = vscode.Uri.joinPath(backupsDir, name);
        await vscode.workspace.fs.delete(fileUri);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

function isLikelyRowId(s: string): boolean {
  const t = (s || '').trim();
  if (!t) return false;
  // Keep this permissive; IDs are user-defined (e.g. func12).
  // Allow dots for sub-IDs (e.g. func3.7) and hyphens (e.g. func-3).
  return /^[A-Za-z_][A-Za-z0-9_.-]{1,64}$/.test(t);
}

function escapeRegExp(s: string): string {
  return (s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nextVariantId(fromId: string, existingIds: Set<string>): string {
  const trimmed = (fromId || '').trim();
  const m = /^(.*?)-(\d+)$/.exec(trimmed);
  const base = m ? m[1] : trimmed;
  const pattern = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  let maxN = -1;
  for (const id of existingIds) {
    const mm = pattern.exec(id);
    if (!mm) continue;
    const n = Number(mm[1]);
    if (Number.isFinite(n)) maxN = Math.max(maxN, Math.trunc(n));
  }

  const next = maxN >= 0 ? maxN + 1 : existingIds.has(base) ? 2 : 1;
  return `${base}-${next}`;
}

async function pickRow(store?: ConfigStoreV1): Promise<ConfigRow | undefined> {
  const s = store ?? (await readStore());
  const rows = (s.rows ?? []).slice();
  if (rows.length === 0) {
    vscode.window.showInformationMessage('No rows yet. Add one in the Top-Down Config panel.');
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    rows
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({
        label: r.id,
        description: r.locked ? 'locked' : undefined,
        detail: [r.name, r.args].filter(Boolean).join(' '),
        row: r,
      })),
    { title: 'Top-Down: Insert Row ID' }
  );
  return picked?.row;
}

async function insertTextIntoActiveEditor(text: string): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Top-Down: No active editor. Open a file first.');
    return false;
  }

  await editor.edit((b) => {
    const sel = editor.selection;
    if (!sel.isEmpty) b.replace(sel, text);
    else b.insert(sel.active, text);
  });
  return true;
}

function getLinePrefix(document: vscode.TextDocument, position: vscode.Position, maxChars = 64): string {
  const line = document.lineAt(position.line).text;
  const upto = line.slice(0, position.character);
  return upto.length > maxChars ? upto.slice(upto.length - maxChars) : upto;
}

class ConfigPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'topdown.configPanel';

  private view?: vscode.WebviewView;
  private changedSourceRows: Set<string> = new Set();

  constructor(private readonly context: vscode.ExtensionContext) {}

  notifySourceChange(rowIds: string[]): void {
    for (const id of rowIds) {
      this.changedSourceRows.add(id);
    }
    // Send message to webview to highlight changed rows
    if (this.view) {
      this.view.webview.postMessage({
        type: 'sourceChanged',
        rowIds: Array.from(this.changedSourceRows),
      });
    }
  }

  clearSourceChanges(): void {
    this.changedSourceRows.clear();
    if (this.view) {
      this.view.webview.postMessage({ type: 'sourceChanged', rowIds: [] });
    }
  }

  private popOutPanel?: vscode.WebviewPanel;

  async createPopOutPanel(): Promise<void> {
    // If panel already exists, reveal it
    if (this.popOutPanel) {
      this.popOutPanel.reveal();
      return;
    }

    // Create a new WebviewPanel that can be dragged out
    this.popOutPanel = vscode.window.createWebviewPanel(
      'topdown.popOutPanel',
      'Top-Down Config',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      }
    );

    // Set up the panel with the same content as the view
    await this.renderPopOutPanel();

    // Handle messages from the pop-out panel
    this.popOutPanel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      // Forward to the main view's message handler by triggering a refresh
      if (this.view) {
        this.view.webview.postMessage(msg);
      }
      // Handle save, add, delete etc. directly
      const m = msg as { type?: string; rows?: ConfigRow[]; id?: string; from?: number; to?: number };
      if (m.type === 'save' && Array.isArray(m.rows)) {
        const store = await readStore();
        store.rows = m.rows;
        await writeStore(store);
        await this.renderPopOutPanel();
        // Sync main view
        if (this.view) {
          this.view.webview.postMessage({ type: 'refresh' });
        }
      } else if (m.type === 'addRow') {
        const store = await readStore();
        const existingIds = new Set((store.rows ?? []).map(r => r.id));
        const newId = nextVariantId('row', existingIds);
        const newRow: ConfigRow = { id: newId, locked: false, name: '', args: '', expr: '' };
        store.rows = [...(store.rows ?? []), newRow];
        await writeStore(store);
        await this.renderPopOutPanel();
      } else if (m.type === 'deleteRow' && typeof m.id === 'string') {
        const store = await readStore();
        store.rows = (store.rows ?? []).filter(r => r.id !== m.id);
        await writeStore(store);
        await this.renderPopOutPanel();
      } else if (m.type === 'reorder' && typeof m.from === 'number' && typeof m.to === 'number') {
        const store = await readStore();
        const rows = [...(store.rows ?? [])];
        const [moved] = rows.splice(m.from, 1);
        rows.splice(m.to, 0, moved);
        store.rows = rows;
        await writeStore(store);
        await this.renderPopOutPanel();
      }
    });

    // Clean up when panel is closed
    this.popOutPanel.onDidDispose(() => {
      this.popOutPanel = undefined;
    });
  }

  private async renderPopOutPanel(): Promise<void> {
    if (!this.popOutPanel) return;

    const store = await readStore();
    const rows = store.rows ?? [];
    const nonce = String(Math.random()).slice(2);
    const webview = this.popOutPanel.webview;

    // Simplified HTML for pop-out (shares styles with main view)
    webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Top-Down Config</title>
  <style>
    :root {
      --td-bg: var(--vscode-editor-background);
      --td-text: var(--vscode-editor-foreground);
      --td-text-muted: var(--vscode-descriptionForeground);
      --td-accent: #7c3aed;
      --td-card-bg: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      --td-card-border: var(--vscode-editorWidget-border, var(--vscode-panel-border));
      --td-card-hover: var(--vscode-list-hoverBackground);
      --td-success: #22c55e;
      --td-warning: #f59e0b;
      --td-error: #ef4444;
      --td-radius: 8px;
      --td-radius-sm: 4px;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      margin: 0;
      padding: 16px;
      background: var(--td-bg);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--td-card-border);
    }
    .title {
      font-size: 18px;
      font-weight: 600;
      color: var(--td-accent);
    }
    .stats {
      font-size: 12px;
      color: var(--td-text-muted);
    }
    .btn {
      padding: 6px 12px;
      border: none;
      border-radius: var(--td-radius-sm);
      cursor: pointer;
      font-size: 12px;
    }
    .btn-primary {
      background: var(--td-accent);
      color: white;
    }
    .btn-secondary {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      color: var(--td-text);
    }
    .rows-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .row-card {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      padding: 12px;
    }
    .row-card.locked {
      opacity: 0.7;
      border-left: 3px solid var(--td-warning);
    }
    .row-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .row-id {
      font-family: monospace;
      font-weight: 600;
      color: var(--td-accent);
    }
    .row-badges {
      display: flex;
      gap: 4px;
    }
    .badge {
      padding: 2px 6px;
      font-size: 10px;
      border-radius: 4px;
      background: var(--td-card-border);
    }
    .badge.locked {
      background: var(--td-warning);
      color: white;
    }
    .row-fields {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .field.full {
      grid-column: span 2;
    }
    .field-label {
      font-size: 10px;
      color: var(--td-text-muted);
      text-transform: uppercase;
    }
    .field-input {
      padding: 6px 8px;
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      background: var(--td-bg);
      color: var(--td-text);
      font-size: 12px;
    }
    .field-input:disabled {
      opacity: 0.6;
    }
    .row-actions {
      display: flex;
      gap: 8px;
      margin-top: 8px;
    }
    .btn-icon {
      padding: 4px 8px;
      background: transparent;
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      color: var(--td-text-muted);
      cursor: pointer;
      font-size: 11px;
    }
    .btn-icon:hover {
      background: var(--td-card-hover);
    }
    .btn-icon.danger:hover {
      background: var(--td-error);
      color: white;
    }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--td-text-muted);
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="title">⚡ Top-Down Config</span>
    <span class="stats">${rows.length} rows${rows.filter(r => r.locked).length > 0 ? ` • ${rows.filter(r => r.locked).length} locked` : ''}</span>
  </div>
  <div style="margin-bottom: 12px;">
    <button class="btn btn-primary" id="addRow">+ Add Row</button>
    <button class="btn btn-secondary" id="saveAll">Save All</button>
  </div>
  <div class="rows-list">
    ${rows.length === 0 ? '<div class="empty-state">No config rows yet. Click "+ Add Row" to create one.</div>' : ''}
    ${rows.map((r, i) => `
      <div class="row-card ${r.locked ? 'locked' : ''}" data-index="${i}">
        <div class="row-header">
          <span class="row-id">${escapeHtml(r.id)}</span>
          <div class="row-badges">
            ${r.locked ? '<span class="badge locked">Locked</span>' : ''}
            ${r.scope ? `<span class="badge">${escapeHtml(r.scope)}</span>` : ''}
          </div>
        </div>
        <div class="row-fields">
          <div class="field">
            <label class="field-label">Name</label>
            <input class="field-input" data-field="name" value="${escapeHtml(r.name ?? '')}" ${r.locked ? 'disabled' : ''} />
          </div>
          <div class="field">
            <label class="field-label">Args</label>
            <input class="field-input" data-field="args" value="${escapeHtml(r.args ?? '')}" ${r.locked ? 'disabled' : ''} />
          </div>
          <div class="field full">
            <label class="field-label">Expression</label>
            <input class="field-input" data-field="expr" value="${escapeHtml(r.expr ?? '')}" ${r.locked ? 'disabled' : ''} />
          </div>
        </div>
        <div class="row-actions">
          <button class="btn-icon" data-lock="${r.id}">${r.locked ? '🔓 Unlock' : '🔒 Lock'}</button>
          <button class="btn-icon danger" data-delete="${r.id}">🗑 Delete</button>
        </div>
      </div>
    `).join('')}
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function getRows() {
      const rows = [];
      document.querySelectorAll('.row-card').forEach(card => {
        const id = card.querySelector('.row-id').textContent;
        const locked = card.classList.contains('locked');
        const name = card.querySelector('[data-field="name"]').value;
        const args = card.querySelector('[data-field="args"]').value;
        const expr = card.querySelector('[data-field="expr"]').value;
        rows.push({ id, locked, name, args, expr });
      });
      return rows;
    }

    document.getElementById('addRow')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'addRow' });
    });

    document.getElementById('saveAll')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'save', rows: getRows() });
    });

    document.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-delete');
        if (confirm('Delete row ' + id + '?')) {
          vscode.postMessage({ type: 'deleteRow', id });
        }
      });
    });

    document.querySelectorAll('[data-lock]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-lock');
        const card = btn.closest('.row-card');
        const isLocked = card.classList.contains('locked');
        card.classList.toggle('locked');
        card.querySelectorAll('.field-input').forEach(input => {
          input.disabled = !isLocked;
        });
        btn.textContent = isLocked ? '🔒 Lock' : '🔓 Unlock';
      });
    });
  </script>
</body>
</html>`;
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: unknown };

      if (m.type === 'runCommand') {
        const payload = msg as { command?: unknown };
        const command = typeof payload.command === 'string' ? payload.command : '';
        const allowed = new Set<string>([
          'topdown.ingestWorkspace',
          'topdown.restoreBackup',
          'topdown.generateShippableDefs',
        ]);
        if (!allowed.has(command)) return;
        try {
          await vscode.commands.executeCommand(command);
        } catch {
          // Command implementations show their own errors.
        }
        return;
      }

      if (m.type === 'setPlayhead') {
        const payload = msg as { idx?: unknown };
        const idx = typeof payload.idx === 'number' ? payload.idx : Number(payload.idx);
        if (!Number.isFinite(idx)) return;
        const store = await readStore();
        const total = store.history?.length ?? 0;
        store.playheadIndex = Math.max(-1, Math.min(total - 1, Math.trunc(idx)));
        await writeStore(store);
        await this.render();
        return;
      }

      // Speculative validation - validate changes before saving
      if (m.type === 'speculativeValidate') {
        const payload = msg as { rows?: unknown };
        if (!Array.isArray(payload.rows)) return;

        const rows: ConfigRow[] = [];
        for (const r of payload.rows) {
          if (!r || typeof r !== 'object') continue;
          const o = r as any;
          if (typeof o.id !== 'string' || !o.id.trim()) continue;

          let depends: string[] = [];
          if (Array.isArray(o.depends)) {
            depends = o.depends.filter((d: unknown) => typeof d === 'string' && d.trim()).map((d: string) => d.trim());
          } else if (typeof o.depends === 'string') {
            depends = o.depends.split(',').map((s: string) => s.trim()).filter(Boolean);
          }

          rows.push({
            id: o.id.trim(),
            locked: !!o.locked,
            name: typeof o.name === 'string' ? o.name : '',
            args: typeof o.args === 'string' ? o.args : '',
            expr: typeof o.expr === 'string' ? o.expr : '',
            depends: depends.length > 0 ? depends : undefined,
          });
        }

        const store = await readStore();
        const validation = speculativeValidate(rows, store.schema);

        // Send validation results back to webview
        this.view?.webview.postMessage({
          type: 'validationResult',
          validation,
        });
        return;
      }

      // Restore to a specific playhead position
      if (m.type === 'restorePlayhead') {
        const payload = msg as { idx?: unknown };
        const idx = typeof payload.idx === 'number' ? payload.idx : Number(payload.idx);
        if (!Number.isFinite(idx)) return;

        const store = await readStore();
        const history = store.history ?? [];
        const targetEntry = history[idx];

        if (!targetEntry) {
          vscode.window.showErrorMessage('Top-Down: Invalid history index.');
          return;
        }

        // Restore rows snapshot if available
        if (targetEntry.rowsSnapshot) {
          const confirm = await vscode.window.showWarningMessage(
            `Restore config to "${targetEntry.label}"? This will overwrite current rows.`,
            'Yes, Restore',
            'Cancel'
          );
          if (confirm !== 'Yes, Restore') return;

          store.rows = targetEntry.rowsSnapshot;
          store.playheadIndex = idx;

          // Add history entry for the restore action
          store.history = store.history ?? [];
          store.history.push({
            ts: Date.now(),
            kind: 'playhead.restore',
            label: `Restored to: ${targetEntry.label}`,
            rowsSnapshot: [...store.rows],
          });

          await writeStore(store);
          await this.render();

          vscode.window.showInformationMessage(`Top-Down: Restored to "${targetEntry.label}".`);
        } else {
          vscode.window.showInformationMessage('Top-Down: No snapshot available for this step. Snapshots are saved for newer entries.');
        }
        return;
      }

      // Compare current state with a historical snapshot
      if (m.type === 'comparePlayhead') {
        const payload = msg as { idx?: unknown };
        const idx = typeof payload.idx === 'number' ? payload.idx : Number(payload.idx);
        if (!Number.isFinite(idx)) return;

        const store = await readStore();
        const history = store.history ?? [];
        const targetEntry = history[idx];

        if (!targetEntry || !targetEntry.rowsSnapshot) {
          vscode.window.showInformationMessage('Top-Down: No snapshot available for this step.');
          return;
        }

        // Compute diff between current rows and snapshot
        const currentRows = store.rows ?? [];
        const snapshotRows = targetEntry.rowsSnapshot;

        const currentIds = new Set(currentRows.map(r => r.id));
        const snapshotIds = new Set(snapshotRows.map(r => r.id));

        const added: Array<{ id: string; name: string }> = [];
        const removed: Array<{ id: string; name: string }> = [];
        const modified: Array<{ id: string; name: string; changes: string[] }> = [];

        // Find added rows (in current but not in snapshot)
        for (const row of currentRows) {
          if (!snapshotIds.has(row.id)) {
            added.push({ id: row.id, name: row.name ?? '' });
          }
        }

        // Find removed rows (in snapshot but not in current)
        for (const row of snapshotRows) {
          if (!currentIds.has(row.id)) {
            removed.push({ id: row.id, name: row.name ?? '' });
          }
        }

        // Find modified rows
        for (const currentRow of currentRows) {
          const snapshotRow = snapshotRows.find(r => r.id === currentRow.id);
          if (snapshotRow) {
            const changes: string[] = [];
            if (currentRow.name !== snapshotRow.name) changes.push('name');
            if (currentRow.args !== snapshotRow.args) changes.push('args');
            if (currentRow.expr !== snapshotRow.expr) changes.push('expr');
            if (currentRow.locked !== snapshotRow.locked) changes.push('locked');
            if (JSON.stringify(currentRow.depends ?? []) !== JSON.stringify(snapshotRow.depends ?? [])) changes.push('depends');
            if (JSON.stringify(currentRow.sources ?? []) !== JSON.stringify(snapshotRow.sources ?? [])) changes.push('sources');
            if (changes.length > 0) {
              modified.push({ id: currentRow.id, name: currentRow.name ?? '', changes });
            }
          }
        }

        // Send diff result to webview
        webviewView.webview.postMessage({
          type: 'showDiff',
          label: targetEntry.label,
          diff: { added, removed, modified },
        });
        return;
      }

      if (m.type === 'clearPlayhead') {
        const store = await readStore();
        store.playheadIndex = (store.history?.length ?? 0) - 1;
        await writeStore(store);
        await this.render();
        return;
      }

      if (m.type === 'stepActions') {
        const payload = msg as { idx?: unknown };
        const idxRaw = typeof payload.idx === 'number' ? payload.idx : Number(payload.idx);
        if (!Number.isFinite(idxRaw)) return;
        const idx = Math.trunc(idxRaw);

        const store = await readStore();
        const history = store.history ?? [];
        const step = idx >= 0 && idx < history.length ? history[idx] : undefined;

        const items: Array<vscode.QuickPickItem & { action: 'set' | 'clear' | 'copyLabel' | 'copyKind' }> = [
          { label: 'Set playhead here', action: 'set' },
          { label: 'Clear playhead (latest)', action: 'clear' },
          { label: 'Copy step label', action: 'copyLabel' },
          { label: 'Copy step kind', action: 'copyKind' },
        ];
        const picked = await vscode.window.showQuickPick(items, { title: step ? `Top-Down: Step #${idx + 1}` : 'Top-Down: Step actions' });
        if (!picked) return;

        if (picked.action === 'set') {
          store.playheadIndex = Math.max(-1, Math.min(history.length - 1, idx));
          await writeStore(store);
          await this.render();
          return;
        }
        if (picked.action === 'clear') {
          store.playheadIndex = history.length - 1;
          await writeStore(store);
          await this.render();
          return;
        }
        if (picked.action === 'copyLabel') {
          if (!step) return;
          await vscode.env.clipboard.writeText(step.label);
          return;
        }
        if (picked.action === 'copyKind') {
          if (!step) return;
          await vscode.env.clipboard.writeText(step.kind);
          return;
        }
      }

      if (m.type === 'rowActions') {
        const payload = msg as { id?: unknown };
        const id = typeof payload.id === 'string' ? payload.id.trim() : '';
        if (!id) return;

        const store = await readStore();
        const rows = store.rows ?? [];
        const row = rows.find((r) => r.id === id);
        if (!row) return;

        // Build dependency graph to get impact info
        const graph = buildDependencyGraph(rows);
        const affected = getAffectedDownstream(graph, id);
        const impactLabel = affected.length > 0
          ? `Show impact analysis (${affected.length} affected)`
          : 'Show impact analysis (no dependents)';

        const items: Array<vscode.QuickPickItem & { action: 'variant' | 'insertId' | 'copyId' | 'impact' }> = [
          { label: impactLabel, description: 'What changes if this row changes?', action: 'impact' },
          { label: 'Duplicate as variant', description: 'Creates a new -N ID (e.g. cla7-2)', action: 'variant' },
          { label: 'Insert ID into editor', action: 'insertId' },
          { label: 'Copy ID', action: 'copyId' },
        ];
        const picked = await vscode.window.showQuickPick(items, { title: `Top-Down: ${id}` });
        if (!picked) return;

        if (picked.action === 'variant') {
          const existingIds = new Set(rows.map((r) => (r.id || '').trim()).filter(Boolean));
          const newId = nextVariantId(id, existingIds);
          const variant: ConfigRow = { ...row, id: newId, locked: false };
          store.rows = rows.concat([variant]);
          store.history = store.history ?? [];
          store.history.push({
            ts: Date.now(),
            kind: 'row.variant',
            label: `+ ${newId} (from ${id})`,
            rowsSnapshot: store.rows.map(r => ({ ...r })),
          });
          await writeStore(store);
          await this.render();
          return;
        }

        if (picked.action === 'insertId') {
          await insertTextIntoActiveEditor(id);
          return;
        }

        if (picked.action === 'copyId') {
          await vscode.env.clipboard.writeText(id);
          return;
        }

        if (picked.action === 'impact') {
          // Group by level for propagation chain
          const levels: string[][] = [];
          const visited = new Set<string>([id]);
          let currentLevel = new Set<string>([id]);

          while (currentLevel.size > 0) {
            const nextLevel = new Set<string>();
            for (const nodeId of currentLevel) {
              const node = graph.get(nodeId);
              if (node) {
                for (const depId of node.dependents) {
                  if (!visited.has(depId)) {
                    visited.add(depId);
                    nextLevel.add(depId);
                  }
                }
              }
            }
            if (nextLevel.size > 0) {
              levels.push(Array.from(nextLevel).sort());
            }
            currentLevel = nextLevel;
          }

          // Build the message
          const lines: string[] = [
            `IMPACT ANALYSIS: ${id}`,
            `${'─'.repeat(50)}`,
            ``,
            `Source: ${id}`,
            `  ${row.name || '(no name)'}`,
            ``,
          ];

          if (levels.length === 0) {
            lines.push('No downstream dependents.');
            lines.push('Changes to this row won\'t affect other rows.');
          } else {
            lines.push(`Total affected: ${affected.length} rows across ${levels.length} levels`);
            lines.push('');

            for (let i = 0; i < levels.length; i++) {
              lines.push(`Level ${i + 1} (${levels[i].length} rows):`);
              for (const affId of levels[i].slice(0, 10)) {
                const affRow = rows.find(r => r.id === affId);
                const locked = affRow?.locked ? ' [LOCKED]' : '';
                lines.push(`  → ${affId}${locked}`);
              }
              if (levels[i].length > 10) {
                lines.push(`  ... and ${levels[i].length - 10} more`);
              }
              lines.push('');
            }

            lines.push(`${'─'.repeat(50)}`);
            lines.push(`If you change "${id}", all ${affected.length} rows above`);
            lines.push(`would need to be recomputed/rebuilt.`);
          }

          // Show in output channel or information message
          const output = vscode.window.createOutputChannel('Top-Down Impact');
          output.clear();
          output.appendLine(lines.join('\n'));
          output.show(true);
          return;
        }
      }

      if (m.type === 'saveRows') {
        const payload = msg as { rows?: unknown };
        if (!Array.isArray(payload.rows)) return;
        const rows: ConfigRow[] = [];
        for (const r of payload.rows) {
          if (!r || typeof r !== 'object') continue;
          const o = r as any;
          if (typeof o.id !== 'string' || !o.id.trim()) continue;

          // Parse depends - can be array or comma-separated string
          let depends: string[] = [];
          if (Array.isArray(o.depends)) {
            depends = o.depends.filter((d: unknown) => typeof d === 'string' && d.trim()).map((d: string) => d.trim());
          } else if (typeof o.depends === 'string') {
            depends = o.depends.split(',').map((s: string) => s.trim()).filter(Boolean);
          }

          rows.push({
            id: o.id.trim(),
            locked: !!o.locked,
            name: typeof o.name === 'string' ? o.name : '',
            args: typeof o.args === 'string' ? o.args : '',
            expr: typeof o.expr === 'string' ? o.expr : '',
            scope: typeof o.scope === 'string' ? o.scope : undefined,
            depends: depends.length > 0 ? depends : undefined,
          });
        }

        // Validate dependencies and detect cycles
        const graph = buildDependencyGraph(rows);
        const cycles = detectCycles(graph);

        if (cycles.length > 0) {
          const cycleStr = cycles.map(c => c.join(' -> ')).join('; ');
          vscode.window.showWarningMessage(`Top-Down: Circular dependencies detected: ${cycleStr}`);
        }

        const store = await readStore();
        store.rows = rows;
        store.history = store.history ?? [];
        // Save a snapshot of rows for timeline restore
        store.history.push({
          ts: Date.now(),
          kind: 'table.save',
          label: `Saved ${rows.length} row(s)`,
          rowsSnapshot: rows.map(r => ({ ...r })),  // Deep copy of rows
        });
        await writeStore(store);
        await this.render();
        return;
      }

      if (m.type === 'addRow') {
        const store = await readStore();
        const n = (store.rows?.length ?? 0) + 1;
        const id = `node${n}`;
        store.rows = store.rows ?? [];
        store.rows.push({ id, locked: false, name: '', args: '', expr: '' });
        store.history = store.history ?? [];
        store.history.push({
          ts: Date.now(),
          kind: 'row.add',
          label: `+ ${id}`,
          rowsSnapshot: store.rows.map(r => ({ ...r })),
        });
        await writeStore(store);
        await this.render();
      }

      // Add row from template
      if (m.type === 'addRowFromTemplate') {
        const payload = msg as { templateId?: unknown };
        const templateId = typeof payload.templateId === 'string' ? payload.templateId : 'empty';

        const template = BUILTIN_TEMPLATES.find(t => t.id === templateId) ?? BUILTIN_TEMPLATES[0];
        const store = await readStore();
        const n = (store.rows?.length ?? 0) + 1;
        const id = `node${n}`;

        const newRow: ConfigRow = {
          id,
          locked: template.row.locked ?? false,
          name: template.row.name ?? '',
          args: template.row.args ?? '',
          expr: template.row.expr ?? '',
          scope: template.row.scope,
          depends: template.row.depends,
          sources: template.row.sources,
        };

        store.rows = store.rows ?? [];
        store.rows.push(newRow);
        store.history = store.history ?? [];
        store.history.push({
          ts: Date.now(),
          kind: 'row.add.template',
          label: `+ ${id} (from ${template.name})`,
          rowsSnapshot: store.rows.map(r => ({ ...r })),
        });
        await writeStore(store);
        await this.render();
      }

      // Show template picker
      if (m.type === 'showTemplatePicker') {
        const items = BUILTIN_TEMPLATES.map(t => ({
          label: t.name,
          description: t.description,
          templateId: t.id,
        }));

        const picked = await vscode.window.showQuickPick(items, {
          title: 'Select Row Template',
          placeHolder: 'Choose a template for the new row',
        });

        if (picked) {
          // Send message back to add the row with the selected template
          this.view?.webview.postMessage({
            type: 'templateSelected',
            templateId: picked.templateId,
          });
        }
      }

      // Toggle pin state for a row
      if (m.type === 'togglePin') {
        const payload = msg as { id?: unknown };
        const id = typeof payload.id === 'string' ? payload.id.trim() : '';
        if (!id) return;

        const store = await readStore();
        const rows = store.rows ?? [];
        const row = rows.find(r => r.id === id);
        if (!row) return;

        row.pinned = !row.pinned;
        store.history = store.history ?? [];
        store.history.push({
          ts: Date.now(),
          kind: row.pinned ? 'row.pin' : 'row.unpin',
          label: `${row.pinned ? 'Pinned' : 'Unpinned'} ${id}`,
          rowsSnapshot: rows.map(r => ({ ...r })),
        });
        await writeStore(store);
        await this.render();
      }

      // Bulk actions (lock/unlock/pin/unpin/delete)
      if (m.type === 'bulkAction') {
        const payload = msg as { action?: unknown; ids?: unknown };
        const action = typeof payload.action === 'string' ? payload.action : '';
        const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === 'string') : [];
        if (!action || ids.length === 0) return;

        const store = await readStore();
        let rows = store.rows ?? [];
        const idSet = new Set(ids);

        if (action === 'delete') {
          rows = rows.filter(r => !idSet.has(r.id));
          store.rows = rows;
          store.history = store.history ?? [];
          store.history.push({
            ts: Date.now(),
            kind: 'bulk.delete',
            label: `Deleted ${ids.length} row(s)`,
            rowsSnapshot: rows.map(r => ({ ...r })),
          });
        } else {
          for (const row of rows) {
            if (!idSet.has(row.id)) continue;
            if (action === 'lock') row.locked = true;
            else if (action === 'unlock') row.locked = false;
            else if (action === 'pin') row.pinned = true;
            else if (action === 'unpin') row.pinned = false;
          }
          store.history = store.history ?? [];
          store.history.push({
            ts: Date.now(),
            kind: `bulk.${action}`,
            label: `${action.charAt(0).toUpperCase() + action.slice(1)}ed ${ids.length} row(s)`,
            rowsSnapshot: rows.map(r => ({ ...r })),
          });
        }

        await writeStore(store);
        await this.render();
      }

      // Reorder rows (drag and drop)
      if (m.type === 'reorderRows') {
        const payload = msg as { fromId?: unknown; toId?: unknown };
        const fromId = typeof payload.fromId === 'string' ? payload.fromId.trim() : '';
        const toId = typeof payload.toId === 'string' ? payload.toId.trim() : '';
        if (!fromId || !toId || fromId === toId) return;

        const store = await readStore();
        const rows = store.rows ?? [];
        const fromIdx = rows.findIndex(r => r.id === fromId);
        const toIdx = rows.findIndex(r => r.id === toId);
        if (fromIdx === -1 || toIdx === -1) return;

        // Remove from old position and insert at new position
        const [moved] = rows.splice(fromIdx, 1);
        rows.splice(toIdx, 0, moved);
        store.rows = rows;

        store.history = store.history ?? [];
        store.history.push({
          ts: Date.now(),
          kind: 'row.reorder',
          label: `Moved ${fromId} ${fromIdx < toIdx ? 'down' : 'up'}`,
          rowsSnapshot: rows.map(r => ({ ...r })),
        });
        await writeStore(store);
        await this.render();
      }

      // Export config in different formats
      if (m.type === 'exportConfig') {
        const payload = msg as { format?: unknown };
        const format = typeof payload.format === 'string' ? payload.format : 'json';

        const store = await readStore();
        const rows = store.rows ?? [];
        let content = '';
        let ext = 'json';

        if (format === 'yaml') {
          ext = 'yaml';
          content = '# Top-Down Configuration\n# Generated: ' + new Date().toISOString() + '\n\nrows:\n';
          for (const row of rows) {
            content += `  - id: "${row.id}"\n`;
            content += `    locked: ${row.locked}\n`;
            if (row.name) content += `    name: "${row.name}"\n`;
            if (row.args) content += `    args: "${row.args}"\n`;
            if (row.expr) content += `    expr: "${row.expr}"\n`;
            if (row.scope) content += `    scope: "${row.scope}"\n`;
            if (row.depends && row.depends.length > 0) {
              content += `    depends:\n`;
              for (const dep of row.depends) {
                content += `      - "${dep}"\n`;
              }
            }
            if (row.pinned) content += `    pinned: true\n`;
          }
        } else if (format === 'toml') {
          ext = 'toml';
          content = '# Top-Down Configuration\n# Generated: ' + new Date().toISOString() + '\n\n';
          for (const row of rows) {
            content += `[[rows]]\n`;
            content += `id = "${row.id}"\n`;
            content += `locked = ${row.locked}\n`;
            if (row.name) content += `name = "${row.name}"\n`;
            if (row.args) content += `args = "${row.args}"\n`;
            if (row.expr) content += `expr = "${row.expr}"\n`;
            if (row.scope) content += `scope = "${row.scope}"\n`;
            if (row.depends && row.depends.length > 0) {
              content += `depends = [${row.depends.map(d => `"${d}"`).join(', ')}]\n`;
            }
            if (row.pinned) content += `pinned = true\n`;
            content += '\n';
          }
        } else if (format === 'mermaid') {
          ext = 'md';
          content = '# Top-Down Dependency Graph\n\n```mermaid\ngraph LR\n';
          for (const row of rows) {
            const label = row.name ? `${row.id}["${row.id}\\n${row.name}"]` : row.id;
            content += `    ${label}\n`;
            for (const dep of row.depends ?? []) {
              content += `    ${row.id} --> ${dep}\n`;
            }
          }
          content += '```\n';
        } else if (format === 'dot') {
          ext = 'dot';
          content = '// Top-Down Dependency Graph\n// Generated: ' + new Date().toISOString() + '\n\n';
          content += 'digraph TopDown {\n';
          content += '    rankdir=LR;\n';
          content += '    node [shape=box, style=rounded];\n\n';
          for (const row of rows) {
            const label = row.name ? `${row.id}\\n${row.name}` : row.id;
            const style = row.locked ? ', style="rounded,filled", fillcolor="#fff3cd"' : '';
            content += `    "${row.id}" [label="${label}"${style}];\n`;
          }
          content += '\n';
          for (const row of rows) {
            for (const dep of row.depends ?? []) {
              content += `    "${row.id}" -> "${dep}";\n`;
            }
          }
          content += '}\n';
        } else {
          content = JSON.stringify({ rows }, null, 2);
        }

        // Show save dialog
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`topdown-config.${ext}`),
          filters: {
            [format.toUpperCase()]: [ext],
            'All Files': ['*'],
          },
        });

        if (uri) {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
          vscode.window.showInformationMessage(`Exported config to ${uri.fsPath}`);
        }
      }

      // Undo - restore from previous history entry
      if (m.type === 'undo') {
        const store = await readStore();
        const history = store.history ?? [];
        if (history.length < 2) {
          vscode.window.showInformationMessage('Nothing to undo');
          return;
        }

        // Find the previous snapshot (second to last entry with snapshot)
        let restoreFrom: HistoryEntry | undefined;
        for (let i = history.length - 2; i >= 0; i--) {
          const entry = history[i] as HistoryEntry;
          if (entry.rowsSnapshot) {
            restoreFrom = entry;
            break;
          }
        }

        if (!restoreFrom || !restoreFrom.rowsSnapshot) {
          vscode.window.showInformationMessage('No previous state to restore');
          return;
        }

        store.rows = restoreFrom.rowsSnapshot.map(r => ({ ...r }));
        store.history = store.history ?? [];
        store.history.push({
          ts: Date.now(),
          kind: 'undo',
          label: `Undo to: ${restoreFrom.label}`,
          rowsSnapshot: store.rows.map(r => ({ ...r })),
        });
        await writeStore(store);
        await this.render();
        vscode.window.showInformationMessage(`Undid changes - restored to: ${restoreFrom.label}`);
      }

      // Import config from file
      if (m.type === 'importConfig') {
        const payload = msg as { format?: unknown };
        const format = typeof payload.format === 'string' ? payload.format : 'json';

        if (format === 'clipboard') {
          const text = await vscode.env.clipboard.readText();
          if (!text.trim()) {
            vscode.window.showErrorMessage('Clipboard is empty');
            return;
          }
          try {
            const parsed = JSON.parse(text);
            const newRows: ConfigRow[] = parsed.rows || [];
            if (newRows.length === 0) {
              vscode.window.showWarningMessage('No rows found in clipboard data');
              return;
            }
            const store = await readStore();
            store.rows = store.rows ?? [];
            store.rows.push(...newRows);
            store.history = store.history ?? [];
            store.history.push({
              ts: Date.now(),
              kind: 'import.clipboard',
              label: `Imported ${newRows.length} row(s) from clipboard`,
              rowsSnapshot: store.rows.map(r => ({ ...r })),
            });
            await writeStore(store);
            await this.render();
            vscode.window.showInformationMessage(`Imported ${newRows.length} rows from clipboard`);
          } catch {
            vscode.window.showErrorMessage('Failed to parse clipboard content as JSON');
          }
          return;
        }

        const filters: Record<string, string[]> = {
          json: ['json'],
          yaml: ['yaml', 'yml'],
          toml: ['toml'],
        };
        const uri = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { [format.toUpperCase()]: filters[format] || ['*'] },
        });
        if (!uri || uri.length === 0) return;

        const content = await vscode.workspace.fs.readFile(uri[0]);
        const text = Buffer.from(content).toString('utf-8');

        try {
          let newRows: ConfigRow[] = [];
          if (format === 'json') {
            const parsed = JSON.parse(text);
            newRows = parsed.rows || [];
          } else if (format === 'yaml') {
            // Simple YAML parser for rows
            const lines = text.split('\n');
            let current: Partial<ConfigRow> | null = null;
            for (const line of lines) {
              if (line.match(/^\s*-\s*id:/)) {
                if (current && current.id) newRows.push(current as ConfigRow);
                current = { id: line.split(':')[1]?.trim().replace(/"/g, '') || '', locked: false, name: '', args: '', expr: '' };
              } else if (current && line.match(/^\s+\w+:/)) {
                const [key, ...vals] = line.trim().split(':');
                const val = vals.join(':').trim().replace(/"/g, '');
                if (key === 'locked') current.locked = val === 'true';
                else if (key === 'name') current.name = val;
                else if (key === 'args') current.args = val;
                else if (key === 'expr') current.expr = val;
                else if (key === 'scope') current.scope = val;
              }
            }
            if (current && current.id) newRows.push(current as ConfigRow);
          } else if (format === 'toml') {
            // Simple TOML parser for [[rows]]
            const sections = text.split(/\[\[rows\]\]/g).slice(1);
            for (const section of sections) {
              const row: Partial<ConfigRow> = { locked: false, name: '', args: '', expr: '' };
              for (const line of section.split('\n')) {
                const match = line.match(/^(\w+)\s*=\s*(.+)$/);
                if (match) {
                  const [, key, val] = match;
                  const cleanVal = val.trim().replace(/^"|"$/g, '');
                  if (key === 'id') row.id = cleanVal;
                  else if (key === 'locked') row.locked = cleanVal === 'true';
                  else if (key === 'name') row.name = cleanVal;
                  else if (key === 'args') row.args = cleanVal;
                  else if (key === 'expr') row.expr = cleanVal;
                  else if (key === 'scope') row.scope = cleanVal;
                }
              }
              if (row.id) newRows.push(row as ConfigRow);
            }
          }

          if (newRows.length === 0) {
            vscode.window.showWarningMessage('No rows found in imported file');
            return;
          }

          const store = await readStore();
          store.rows = store.rows ?? [];
          store.rows.push(...newRows);
          store.history = store.history ?? [];
          store.history.push({
            ts: Date.now(),
            kind: `import.${format}`,
            label: `Imported ${newRows.length} row(s) from ${format.toUpperCase()}`,
            rowsSnapshot: store.rows.map(r => ({ ...r })),
          });
          await writeStore(store);
          await this.render();
          vscode.window.showInformationMessage(`Imported ${newRows.length} rows from ${format.toUpperCase()}`);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to parse ${format.toUpperCase()} file: ${err}`);
        }
      }

      // Add bookmark
      if (m.type === 'addBookmark') {
        const name = await vscode.window.showInputBox({
          prompt: 'Enter bookmark name',
          placeHolder: 'My Bookmark',
        });
        if (!name) return;

        const store = await readStore();
        store.bookmarks = store.bookmarks ?? [];
        store.bookmarks.push({
          id: `bm-${Date.now()}`,
          name,
          ts: Date.now(),
          rowsSnapshot: (store.rows ?? []).map(r => ({ ...r })),
        });
        await writeStore(store);
        await this.render();
        vscode.window.showInformationMessage(`Bookmark "${name}" created`);
      }

      // Restore bookmark
      if (m.type === 'restoreBookmark') {
        const payload = msg as { id?: unknown };
        const id = typeof payload.id === 'string' ? payload.id : '';
        if (!id) return;

        const store = await readStore();
        const bookmark = (store.bookmarks ?? []).find(b => b.id === id);
        if (!bookmark || !bookmark.rowsSnapshot) {
          vscode.window.showErrorMessage('Bookmark not found');
          return;
        }

        store.rows = bookmark.rowsSnapshot.map(r => ({ ...r }));
        store.history = store.history ?? [];
        store.history.push({
          ts: Date.now(),
          kind: 'bookmark.restore',
          label: `Restored bookmark: ${bookmark.name}`,
          rowsSnapshot: store.rows.map(r => ({ ...r })),
        });
        await writeStore(store);
        await this.render();
        vscode.window.showInformationMessage(`Restored bookmark: ${bookmark.name}`);
      }

      // Delete bookmark
      if (m.type === 'deleteBookmark') {
        const payload = msg as { id?: unknown };
        const id = typeof payload.id === 'string' ? payload.id : '';
        if (!id) return;

        const store = await readStore();
        store.bookmarks = (store.bookmarks ?? []).filter(b => b.id !== id);
        await writeStore(store);
        await this.render();
      }

      // Run health check
      if (m.type === 'runHealthCheck') {
        const store = await readStore();
        const rows = store.rows ?? [];
        const rowIds = new Set(rows.map(r => r.id));
        const issues: Array<{ type: string; message: string }> = [];

        // Check for missing dependencies
        for (const row of rows) {
          for (const dep of row.depends ?? []) {
            if (!rowIds.has(dep)) {
              issues.push({ type: 'warning', message: `Row "${row.id}" depends on "${dep}" which doesn't exist` });
            }
          }
        }

        // Check for orphaned rows (no dependents, no dependencies)
        const graph = buildDependencyGraph(rows);
        for (const row of rows) {
          const node = graph.get(row.id);
          if (node && node.depends.length === 0 && node.dependents.length === 0 && rows.length > 1) {
            issues.push({ type: 'info', message: `Row "${row.id}" is isolated (no dependencies or dependents)` });
          }
        }

        // Check for circular dependencies
        const cycles = detectCycles(graph);
        for (const cycle of cycles) {
          issues.push({ type: 'warning', message: `Circular dependency: ${cycle.join(' → ')}` });
        }

        // Check for empty rows
        for (const row of rows) {
          if (!row.name && !row.args && !row.expr) {
            issues.push({ type: 'info', message: `Row "${row.id}" has no name, args, or expr` });
          }
        }

        this.view?.webview.postMessage({ type: 'healthCheckResult', issues });
      }

      // Compare rows
      if (m.type === 'compareRows') {
        const payload = msg as { ids?: unknown };
        const ids = Array.isArray(payload.ids) ? payload.ids.filter((id): id is string => typeof id === 'string') : [];
        if (ids.length !== 2) return;

        const store = await readStore();
        const rows = (store.rows ?? []).filter(r => ids.includes(r.id));
        this.view?.webview.postMessage({ type: 'showComparison', rows });
      }

      // Update notes
      if (m.type === 'updateNotes') {
        const payload = msg as { id?: unknown; notes?: unknown };
        const id = typeof payload.id === 'string' ? payload.id.trim() : '';
        const notes = typeof payload.notes === 'string' ? payload.notes : '';
        if (!id) return;

        const store = await readStore();
        const row = (store.rows ?? []).find(r => r.id === id);
        if (!row) return;

        row.notes = notes;
        await writeStore(store);
        // Don't re-render to avoid losing focus
      }
    });

    await this.render();
  }

  async render(): Promise<void> {
    if (!this.view) return;
    const webview = this.view.webview;
    const store = await readStore();

    const nonce = String(Math.random()).slice(2);

    const history = store.history ?? [];
    const playhead = typeof store.playheadIndex === 'number' ? store.playheadIndex : history.length - 1;

    const stepsNewestFirst = history
      .map((h, idx) => ({
        idx,
        ts: h.ts,
        kind: h.kind,
        label: h.label,
        hasSnapshot: !!(h as HistoryEntry).rowsSnapshot,
      }))
      .slice()
      .sort((a, b) => b.idx - a.idx);

    // Build dependency graph for visualization
    const graph = buildDependencyGraph(store.rows ?? []);
    const cycles = detectCycles(graph);
    const cycleIds = new Set(cycles.flat());

    // Generate DAG layout data for visual rendering
    const { sorted: topoOrder, hasCycle } = topologicalSort(graph);
    const dagNodes: Array<{ id: string; x: number; y: number; level: number; hasCycle: boolean }> = [];
    const dagEdges: Array<{ from: string; to: string; fromX: number; fromY: number; toX: number; toY: number }> = [];

    // Calculate levels for each node (topological depth)
    const nodeLevel = new Map<string, number>();
    const levelNodes = new Map<number, string[]>();

    if (!hasCycle && topoOrder.length > 0) {
      for (const id of topoOrder) {
        const node = graph.get(id);
        if (!node) continue;

        // Level is 1 + max level of dependencies
        let maxDepLevel = -1;
        for (const dep of node.depends) {
          const depLevel = nodeLevel.get(dep);
          if (depLevel !== undefined && depLevel > maxDepLevel) {
            maxDepLevel = depLevel;
          }
        }
        const level = maxDepLevel + 1;
        nodeLevel.set(id, level);

        if (!levelNodes.has(level)) levelNodes.set(level, []);
        levelNodes.get(level)!.push(id);
      }
    } else {
      // Fallback for cycles - just position in order
      let idx = 0;
      for (const [id] of graph) {
        nodeLevel.set(id, idx % 5);
        const level = idx % 5;
        if (!levelNodes.has(level)) levelNodes.set(level, []);
        levelNodes.get(level)!.push(id);
        idx++;
      }
    }

    // Position nodes in a grid layout
    const nodeWidth = 120;
    const nodeHeight = 40;
    const levelSpacing = 100;
    const nodeSpacing = 60;
    const nodePositions = new Map<string, { x: number; y: number }>();

    for (const [level, nodes] of levelNodes) {
      const levelX = 60 + level * (nodeWidth + levelSpacing);
      const startY = 40;
      nodes.forEach((id, idx) => {
        const y = startY + idx * (nodeHeight + nodeSpacing);
        nodePositions.set(id, { x: levelX, y });
        dagNodes.push({
          id: escapeHtml(id),
          x: levelX,
          y,
          level,
          hasCycle: cycleIds.has(id),
        });
      });
    }

    // Generate edges
    for (const [id, node] of graph) {
      const fromPos = nodePositions.get(id);
      if (!fromPos) continue;

      for (const dep of node.depends) {
        const toPos = nodePositions.get(dep);
        if (!toPos) continue;

        dagEdges.push({
          from: escapeHtml(id),
          to: escapeHtml(dep),
          fromX: fromPos.x,
          fromY: fromPos.y + nodeHeight / 2,
          toX: toPos.x + nodeWidth,
          toY: toPos.y + nodeHeight / 2,
        });
      }
    }

    const dagWidth = Math.max(400, (levelNodes.size) * (nodeWidth + levelSpacing) + 100);
    const maxNodesInLevel = Math.max(1, ...Array.from(levelNodes.values()).map(n => n.length));
    const dagHeight = Math.max(200, maxNodesInLevel * (nodeHeight + nodeSpacing) + 60);

    const rows = (store.rows ?? []).map((r) => {
      const node = graph.get(r.id);
      const dependents = node?.dependents ?? [];
      const depends = r.depends ?? [];
      const hasCycle = cycleIds.has(r.id);
      // Compute transitive impact count (all affected downstream)
      const impactCount = getAffectedDownstream(graph, r.id).length;
      const sourcesCount = (r.sources ?? []).length;

      return {
        id: escapeHtml(r.id),
        locked: !!r.locked,
        pinned: !!r.pinned,
        name: escapeHtml(r.name ?? ''),
        args: escapeHtml(r.args ?? ''),
        expr: escapeHtml(r.expr ?? ''),
        scope: escapeHtml(r.scope ?? ''),
        notes: escapeHtml(r.notes ?? ''),
        depends: depends.map(d => escapeHtml(d)),
        dependents: dependents.map(d => escapeHtml(d)),
        impactCount,
        sourcesCount,
        status: hasCycle ? 'error' : (r.status ?? 'ok'),
        statusMessage: hasCycle ? 'Circular dependency detected' : (r.statusMessage ?? ''),
      };
    }).sort((a, b) => {
      // Pinned rows first
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return 0;
    });

    const rowCount = rows.length;
    const lockedCount = rows.filter(r => r.locked).length;
    const errorCount = rows.filter(r => r.status === 'error').length;
    const pinnedCount = rows.filter(r => r.pinned).length;

    // Compute statistics
    const scopeCounts: Record<string, number> = {};
    for (const r of rows) {
      const scope = r.scope || '(No Scope)';
      scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
    }
    const uniqueScopes = Object.keys(scopeCounts).length;
    const maxDependencyDepth = computeMaxDepth(graph);
    const totalDependencies = rows.reduce((sum, r) => sum + r.depends.length, 0);

    // Group rows by scope for collapsible sections
    const scopeGroups = new Map<string, typeof rows>();
    for (const r of rows) {
      const scopeKey = r.scope || '(No Scope)';
      if (!scopeGroups.has(scopeKey)) {
        scopeGroups.set(scopeKey, []);
      }
      scopeGroups.get(scopeKey)!.push(r);
    }
    const sortedScopes = Array.from(scopeGroups.keys()).sort((a, b) => {
      if (a === '(No Scope)') return 1;
      if (b === '(No Scope)') return -1;
      return a.localeCompare(b);
    });
    const hasMultipleScopes = sortedScopes.length > 1 || (sortedScopes.length === 1 && sortedScopes[0] !== '(No Scope)');

    // Helper to render a single row card - collapsed by default
    const renderRowCard = (r: typeof rows[0]) => `
      <div class="row-card ${r.locked ? 'locked' : ''} ${r.pinned ? 'pinned' : ''} ${r.status === 'error' ? 'error' : ''}" data-row="${r.id}" data-scope="${r.scope || ''}" draggable="true" tabindex="0">
        <div class="row-compact">
          <button class="expand-btn" data-expand="${r.id}" title="Expand to edit">
            <svg viewBox="0 0 16 16" style="width:10px;height:10px;"><path d="M4 6l4 4 4-4"/></svg>
          </button>
          <span class="row-id">${r.id}</span>
          <input class="compact-input name-input" data-name value="${r.name}" placeholder="Name" ${r.locked ? 'disabled' : ''} title="Name" />
          <input class="compact-input args-input" data-args value="${r.args}" placeholder="Args" ${r.locked ? 'disabled' : ''} title="Args" />
          <input class="compact-input expr-input" data-expr value="${r.expr}" placeholder="Expression" ${r.locked ? 'disabled' : ''} title="Expression" />
          <div class="compact-actions">
            <input type="checkbox" class="lock-checkbox" data-lock="${r.id}" ${r.locked ? 'checked' : ''} title="Lock row" />
            <button class="more-btn" data-row-more="${r.id}" title="More actions">
              <svg viewBox="0 0 16 16" style="width:12px;height:12px;"><circle cx="3" cy="8" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="13" cy="8" r="1.5"/></svg>
            </button>
          </div>
        </div>
        <div class="row-expanded" style="display:none;" data-expanded="${r.id}">
          <div class="expanded-fields">
            <div class="field-row">
              <label>Dependencies</label>
              <input class="field-input" data-depends value="${r.depends.join(', ')}" placeholder="comma-separated IDs" ${r.locked ? 'disabled' : ''} />
            </div>
            ${(r.depends.length > 0 || r.dependents.length > 0) ? `
            <div class="deps-chips">
              ${r.depends.length > 0 ? `<span class="deps-label">Needs:</span> ${r.depends.map(d => `<span class="dep-chip" data-goto="${d}">${d}</span>`).join(' ')}` : ''}
              ${r.dependents.length > 0 ? `<span class="deps-label" style="margin-left:12px;">Used by:</span> ${r.dependents.map(d => `<span class="dep-chip downstream" data-goto="${d}">${d}</span>`).join(' ')}` : ''}
            </div>` : ''}
            <div class="expanded-actions">
              <button class="action-btn" data-pin="${r.id}">${r.pinned ? '📌 Unpin' : '📌 Pin'}</button>
              <button class="action-btn" data-copy="${r.id}">📋 Copy ID</button>
              <button class="action-btn" data-toggle-notes="${r.id}">📝 Notes</button>
              <button class="action-btn danger" data-delete="${r.id}">🗑 Delete</button>
            </div>
          </div>
          <div class="notes-section" style="${r.notes ? '' : 'display:none;'}" data-notes-section="${r.id}">
            <textarea class="notes-input" data-notes="${r.id}" placeholder="Notes..." ${r.locked ? 'disabled' : ''}>${r.notes}</textarea>
          </div>
        </div>
        <input type="hidden" data-id value="${r.id}" />
      </div>`;

    webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Top-Down</title>
  <style>
    :root {
      --td-accent: #7c3aed;
      --td-accent-hover: #6d28d9;
      --td-success: #10b981;
      --td-warning: #f59e0b;
      --td-error: #ef4444;
      --td-card-bg: var(--vscode-editor-background);
      --td-card-border: var(--vscode-panel-border);
      --td-card-hover: var(--vscode-list-hoverBackground);
      --td-radius: 8px;
      --td-radius-sm: 4px;
    }

    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: 13px;
      color: var(--vscode-foreground);
      margin: 0;
      padding: 8px;
      background: transparent;
      line-height: 1.4;
      zoom: 0.75;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: linear-gradient(135deg, rgba(124, 58, 237, 0.1) 0%, rgba(124, 58, 237, 0.05) 100%);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      margin-bottom: 16px;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 15px;
      color: var(--td-accent);
    }

    .logo svg {
      width: 20px;
      height: 20px;
      fill: var(--td-accent);
    }

    .stats {
      display: flex;
      gap: 16px;
      font-size: 12px;
      opacity: 0.8;
    }

    .stat {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .stat-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }

    .stat-dot.ok { background: var(--td-success); }
    .stat-dot.locked { background: var(--td-warning); }
    .stat-dot.error { background: var(--td-error); }

    .header-actions {
      display: flex;
      gap: 8px;
    }

    /* Search */
    .search-container {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--td-card-border);
      background: var(--td-bg);
    }

    .search-input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      background: var(--td-card-bg);
      color: var(--td-text);
      font-size: 12px;
      outline: none;
    }

    .search-input:focus {
      border-color: var(--td-accent);
    }

    .search-input::placeholder {
      color: var(--td-text-muted);
    }

    .search-count {
      font-size: 11px;
      color: var(--td-text-muted);
      white-space: nowrap;
    }

    .quick-add-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      background: var(--td-accent);
      color: white;
      border: none;
      border-radius: var(--td-radius-sm);
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }

    .quick-add-btn:hover {
      opacity: 0.9;
    }

    /* Scope Groups */
    .scope-group {
      margin-bottom: 8px;
    }

    .scope-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      cursor: pointer;
      user-select: none;
    }

    .scope-header:hover {
      background: var(--td-card-hover);
    }

    .scope-toggle {
      transition: transform 0.2s ease;
    }

    .scope-group.collapsed .scope-toggle {
      transform: rotate(-90deg);
    }

    .scope-name {
      font-weight: 500;
      font-size: 12px;
    }

    .scope-count {
      font-size: 11px;
      color: var(--td-text-muted);
    }

    .scope-content {
      padding-left: 8px;
      margin-top: 4px;
    }

    .scope-group.collapsed .scope-content {
      display: none;
    }

    /* Copy button */
    .copy-btn {
      padding: 2px 6px;
      font-size: 10px;
      background: transparent;
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      color: var(--td-text-muted);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .row-card:hover .copy-btn {
      opacity: 1;
    }

    .copy-btn:hover {
      background: var(--td-card-hover);
      color: var(--td-text);
    }

    .copy-btn.copied {
      background: var(--td-success);
      color: white;
      border-color: var(--td-success);
    }

    /* Hidden rows when filtered */
    .row-card.filtered-out {
      display: none;
    }

    /* Bulk Selection */
    .bulk-select-checkbox {
      width: 16px;
      height: 16px;
      margin-right: 8px;
      cursor: pointer;
      accent-color: var(--td-accent);
    }

    .bulk-toolbar {
      display: none;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--td-accent);
      color: white;
      border-radius: var(--td-radius-sm);
      margin-bottom: 12px;
      font-size: 12px;
    }

    .bulk-toolbar.visible {
      display: flex;
    }

    .bulk-toolbar .bulk-count {
      font-weight: 600;
    }

    .bulk-toolbar .bulk-btn {
      padding: 4px 8px;
      background: rgba(255,255,255,0.2);
      border: none;
      border-radius: var(--td-radius-sm);
      color: white;
      cursor: pointer;
      font-size: 11px;
    }

    .bulk-toolbar .bulk-btn:hover {
      background: rgba(255,255,255,0.3);
    }

    .bulk-toolbar .bulk-btn.danger:hover {
      background: var(--td-error);
    }

    .row-card.selected {
      outline: 2px solid var(--td-accent);
      outline-offset: -2px;
    }

    /* Drag & Drop */
    .row-card.dragging {
      opacity: 0.5;
      transform: scale(0.98);
    }

    .row-card.drag-over {
      border-top: 3px solid var(--td-accent);
    }

    .drag-handle {
      cursor: grab;
      padding: 4px;
      color: var(--td-text-muted);
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .row-card:hover .drag-handle {
      opacity: 1;
    }

    .drag-handle:active {
      cursor: grabbing;
    }

    /* Pin Button */
    .pin-btn {
      padding: 2px 4px;
      background: transparent;
      border: none;
      cursor: pointer;
      color: var(--td-text-muted);
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .row-card:hover .pin-btn {
      opacity: 1;
    }

    .pin-btn.pinned {
      opacity: 1;
      color: var(--td-warning);
    }

    .row-card.pinned {
      border-left: 3px solid var(--td-warning);
    }

    /* Statistics Panel */
    .stats-panel {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      padding: 12px;
      margin-bottom: 12px;
      display: none;
    }

    .stats-panel.visible {
      display: block;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
      gap: 12px;
    }

    .stat-item {
      text-align: center;
    }

    .stat-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--td-accent);
    }

    .stat-label {
      font-size: 10px;
      color: var(--td-text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Inline Validation */
    .field-input.invalid {
      border-color: var(--td-error);
      background: rgba(239, 68, 68, 0.05);
    }

    .field-error-msg {
      font-size: 10px;
      color: var(--td-error);
      margin-top: 2px;
    }

    /* Keyboard Navigation */
    .row-card.focused {
      outline: 2px solid var(--td-accent);
      outline-offset: 2px;
    }

    .row-card:focus-within {
      outline: none;
    }

    /* Undo/Redo Buttons */
    .undo-redo-group {
      display: flex;
      gap: 2px;
    }

    .undo-redo-group .btn-icon {
      width: 28px;
      height: 28px;
    }

    .undo-redo-group .btn-icon:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    /* Export Button */
    .export-menu {
      position: relative;
    }

    .export-dropdown {
      position: absolute;
      top: 100%;
      right: 0;
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      display: none;
      z-index: 100;
      min-width: 120px;
    }

    .export-dropdown.visible {
      display: block;
    }

    .export-option {
      display: block;
      width: 100%;
      padding: 8px 12px;
      background: none;
      border: none;
      text-align: left;
      cursor: pointer;
      font-size: 12px;
      color: var(--td-text);
    }

    .export-option:hover {
      background: var(--td-card-hover);
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 14px;
      font-size: 12px;
      font-weight: 500;
      border: none;
      border-radius: var(--td-radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .btn-primary {
      background: var(--td-accent);
      color: white;
    }

    .btn-primary:hover {
      background: var(--td-accent-hover);
      transform: translateY(-1px);
    }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .btn-icon {
      width: 32px;
      height: 32px;
      padding: 0;
      background: transparent;
      border: 1px solid var(--td-card-border);
      color: var(--vscode-foreground);
      border-radius: var(--td-radius-sm);
    }

    .btn-icon:hover {
      background: var(--td-card-hover);
      border-color: var(--td-accent);
    }

    .btn-icon svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    /* Layout */
    .layout {
      display: grid;
      grid-template-columns: 220px 1fr;
      gap: 16px;
      min-height: calc(100vh - 120px);
    }

    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .sidebar {
        display: none;
      }
    }

    /* Sidebar / Timeline */
    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .timeline-card {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      overflow: hidden;
    }

    .timeline-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px;
      border-bottom: 1px solid var(--td-card-border);
      background: rgba(124, 58, 237, 0.05);
    }

    .timeline-title {
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }

    .timeline-list {
      max-height: 400px;
      overflow-y: auto;
      padding: 8px;
    }

    .timeline-item {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 10px;
      margin-bottom: 4px;
      border-radius: var(--td-radius-sm);
      cursor: pointer;
      transition: all 0.15s ease;
      border: 1px solid transparent;
    }

    .timeline-item:hover {
      background: var(--td-card-hover);
    }

    .timeline-item.active {
      background: rgba(124, 58, 237, 0.15);
      border-color: var(--td-accent);
    }

    .timeline-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--td-card-border);
      margin-top: 4px;
      flex-shrink: 0;
    }

    .timeline-item.active .timeline-dot {
      background: var(--td-accent);
      box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.2);
    }

    .timeline-content {
      flex: 1;
      min-width: 0;
    }

    .timeline-label {
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .timeline-meta {
      font-size: 10px;
      opacity: 0.6;
      margin-top: 2px;
    }

    .timeline-empty {
      padding: 20px;
      text-align: center;
      opacity: 0.5;
      font-size: 12px;
    }

    /* Main Content */
    .main {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    /* Row Cards */
    .rows-grid {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* Compact Row Card */
    .row-card {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      transition: all 0.15s ease;
    }

    .row-card:hover {
      border-color: rgba(124, 58, 237, 0.3);
    }

    .row-card.locked {
      border-left: 3px solid var(--td-warning);
    }

    .row-card.error {
      border-left: 3px solid var(--td-error);
    }

    .row-card.expanded {
      background: var(--td-card-hover);
    }

    /* Compact Row - Single Line */
    .row-compact {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
    }

    .expand-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      padding: 0;
      background: transparent;
      border: none;
      cursor: pointer;
      color: var(--vscode-foreground);
      opacity: 0.5;
      transition: transform 0.15s ease, opacity 0.15s ease;
    }

    .expand-btn:hover {
      opacity: 1;
    }

    .row-card.expanded .expand-btn {
      transform: rotate(180deg);
      opacity: 1;
    }

    .row-id {
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 11px;
      font-weight: 600;
      color: var(--td-accent);
      min-width: 60px;
      flex-shrink: 0;
    }

    .compact-input {
      flex: 1;
      min-width: 0;
      padding: 3px 6px;
      font-size: 11px;
      border: 1px solid transparent;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground);
    }

    .compact-input:hover:not(:disabled) {
      border-color: var(--td-card-border);
    }

    .compact-input:focus {
      outline: none;
      border-color: var(--td-accent);
      background: var(--td-card-bg);
    }

    .compact-input:disabled {
      opacity: 0.5;
    }

    .name-input { flex: 1.5; }
    .args-input { flex: 1; }
    .expr-input { flex: 2; }

    .compact-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .lock-checkbox {
      width: 14px;
      height: 14px;
      cursor: pointer;
      accent-color: var(--td-warning);
    }

    .more-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;
      color: var(--vscode-foreground);
      opacity: 0.5;
    }

    .more-btn:hover {
      opacity: 1;
      background: var(--td-card-hover);
      border-color: var(--td-card-border);
    }

    /* Expanded Section */
    .row-expanded {
      padding: 8px 10px 10px 32px;
      border-top: 1px solid var(--td-card-border);
      background: rgba(0,0,0,0.03);
    }

    .expanded-fields {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .field-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .field-row label {
      font-size: 10px;
      font-weight: 500;
      color: var(--vscode-foreground);
      opacity: 0.7;
      min-width: 80px;
    }

    .field-row .field-input {
      flex: 1;
      padding: 4px 8px;
      font-size: 11px;
      border: 1px solid var(--td-card-border);
      border-radius: 3px;
      background: var(--td-card-bg);
      color: var(--vscode-foreground);
    }

    .deps-chips {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      font-size: 10px;
    }

    .deps-label {
      color: var(--vscode-foreground);
      opacity: 0.6;
    }

    .dep-chip {
      padding: 2px 6px;
      font-size: 10px;
      background: rgba(124, 58, 237, 0.1);
      color: var(--td-accent);
      border-radius: 3px;
      cursor: pointer;
    }

    .dep-chip:hover {
      background: rgba(124, 58, 237, 0.2);
    }

    .dep-chip.downstream {
      background: rgba(16, 185, 129, 0.1);
      color: var(--td-success);
    }

    .expanded-actions {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }

    .action-btn {
      padding: 4px 8px;
      font-size: 10px;
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: 3px;
      cursor: pointer;
      color: var(--vscode-foreground);
    }

    .action-btn:hover {
      background: var(--td-card-hover);
    }

    .action-btn.danger:hover {
      background: rgba(239, 68, 68, 0.15);
      border-color: var(--td-error);
      color: var(--td-error);
    }

    .notes-section {
      margin-top: 8px;
    }

    .notes-input {
      width: 100%;
      padding: 6px 8px;
      font-size: 11px;
      border: 1px solid var(--td-card-border);
      border-radius: 3px;
      background: var(--td-card-bg);
      color: var(--vscode-foreground);
      resize: vertical;
      min-height: 40px;
    }

    /* Legacy badge styles for compatibility */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 6px;
      font-size: 9px;
      font-weight: 500;
      border-radius: 10px;
      background: rgba(124, 58, 237, 0.1);
      color: var(--td-accent);
    }

    .badge.locked {
      background: rgba(245, 158, 11, 0.15);
      color: var(--td-warning);
    }

    .badge.error {
      background: rgba(239, 68, 68, 0.15);
      color: var(--td-error);
    }

    /* Source file change highlighting */
    .row-card.source-changed {
      border-left: 3px solid #f59e0b;
      background: rgba(245, 158, 11, 0.08);
    }

    .source-change-notification {
      position: fixed;
      bottom: 10px;
      left: 50%;
      transform: translateX(-50%) translateY(100px);
      background: rgba(245, 158, 11, 0.95);
      color: #000;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      opacity: 0;
      transition: transform 0.3s ease, opacity 0.3s ease;
      z-index: 1000;
    }

    .source-change-notification.visible {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }

    /* Hidden - keeping for compatibility */
    .row-actions { display: none; }
    .row-body { display: none; }
    .row-header { display: none; }
    .row-id-group { display: none; }
    .row-badges { display: none; }
    .field { display: none; }
    .field-label { display: none;
    }

    .field-input {
      width: 100%;
      padding: 8px 10px;
      font-size: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: var(--td-radius-sm);
      transition: border-color 0.15s ease;
    }

    .field-input:focus {
      outline: none;
      border-color: var(--td-accent);
    }

    .field-input:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .field-full {
      grid-column: 1 / -1;
    }

    /* Dependencies Section */
    .deps-section {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px dashed var(--td-card-border);
    }

    .deps-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .deps-label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.6;
      min-width: 60px;
    }

    .dep-chip {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family), monospace;
      background: rgba(124, 58, 237, 0.1);
      color: var(--td-accent);
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .dep-chip:hover {
      background: rgba(124, 58, 237, 0.2);
    }

    .dep-chip.downstream {
      background: rgba(16, 185, 129, 0.1);
      color: var(--td-success);
    }

    /* Empty State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      text-align: center;
      background: var(--td-card-bg);
      border: 2px dashed var(--td-card-border);
      border-radius: var(--td-radius);
    }

    .empty-icon {
      width: 48px;
      height: 48px;
      margin-bottom: 16px;
      opacity: 0.3;
      fill: currentColor;
    }

    .empty-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .empty-desc {
      font-size: 13px;
      opacity: 0.7;
      margin-bottom: 20px;
      max-width: 300px;
    }

    /* Scrollbar */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }

    ::-webkit-scrollbar-track {
      background: transparent;
    }

    ::-webkit-scrollbar-thumb {
      background: var(--td-card-border);
      border-radius: 3px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: var(--td-accent);
    }

    /* Checkbox styling */
    .checkbox-wrapper {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--td-accent);
      cursor: pointer;
    }

    /* Tab Navigation */
    .view-tabs {
      display: flex;
      gap: 4px;
      margin-bottom: 12px;
      border-bottom: 1px solid var(--td-card-border);
      padding-bottom: 8px;
    }

    .view-tab {
      padding: 8px 16px;
      font-size: 12px;
      font-weight: 500;
      background: transparent;
      border: 1px solid transparent;
      border-bottom: 2px solid transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      border-radius: var(--td-radius-sm) var(--td-radius-sm) 0 0;
      opacity: 0.7;
      transition: all 0.15s ease;
    }

    .view-tab:hover {
      opacity: 1;
      background: var(--td-card-hover);
    }

    .view-tab.active {
      opacity: 1;
      border-bottom-color: var(--td-accent);
      color: var(--td-accent);
    }

    .view-content {
      display: none;
    }

    .view-content.active {
      display: block;
    }

    /* DAG View */
    .dag-container {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      padding: 16px;
      overflow: auto;
      min-height: 300px;
    }

    .dag-svg {
      display: block;
    }

    .dag-node {
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .dag-node:hover rect {
      stroke: var(--td-accent);
      stroke-width: 2;
    }

    .dag-node rect {
      fill: var(--td-card-bg);
      stroke: var(--td-card-border);
      stroke-width: 1;
      rx: 6;
    }

    .dag-node.cycle rect {
      fill: rgba(239, 68, 68, 0.1);
      stroke: var(--td-error);
    }

    .dag-node text {
      fill: var(--vscode-foreground);
      font-size: 11px;
      font-family: var(--vscode-editor-font-family), monospace;
    }

    .dag-edge {
      stroke: var(--td-card-border);
      stroke-width: 1.5;
      fill: none;
      marker-end: url(#arrowhead);
    }

    .dag-edge.highlighted {
      stroke: var(--td-accent);
      stroke-width: 2;
    }

    /* Speculative Preview Panel */
    .preview-panel {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      margin-bottom: 12px;
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .preview-panel.hidden {
      display: none;
    }

    .preview-panel.has-issues {
      border-color: var(--td-warning);
      background: rgba(245, 158, 11, 0.05);
    }

    .preview-panel.has-errors {
      border-color: var(--td-error);
      background: rgba(239, 68, 68, 0.05);
    }

    .preview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--td-card-border);
      background: rgba(124, 58, 237, 0.05);
    }

    .preview-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 12px;
    }

    .preview-title svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }

    .preview-body {
      padding: 12px 14px;
      max-height: 200px;
      overflow-y: auto;
    }

    .preview-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 0;
      font-size: 12px;
      border-bottom: 1px dashed var(--td-card-border);
    }

    .preview-item:last-child {
      border-bottom: none;
    }

    .preview-icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .preview-icon.error { color: var(--td-error); }
    .preview-icon.warning { color: var(--td-warning); }

    .preview-message {
      flex: 1;
    }

    .preview-message code {
      background: rgba(124, 58, 237, 0.1);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family), monospace;
    }

    /* Timeline restore button */
    .timeline-restore {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      font-size: 10px;
      background: var(--td-accent);
      color: white;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .timeline-item:hover .timeline-restore {
      opacity: 1;
    }

    .timeline-item .timeline-restore.has-snapshot {
      opacity: 0.6;
    }

    .timeline-item:hover .timeline-restore.has-snapshot {
      opacity: 1;
    }

    .timeline-actions {
      display: flex;
      gap: 4px;
      margin-top: 4px;
    }

    .timeline-compare {
      display: inline-flex;
      align-items: center;
      padding: 3px 8px;
      font-size: 10px;
      background: var(--td-card-bg);
      color: var(--td-text);
      border: 1px solid var(--td-card-border);
      border-radius: 10px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .timeline-item:hover .timeline-compare {
      opacity: 1;
    }

    .timeline-compare:hover {
      background: var(--td-card-hover);
      border-color: var(--td-accent);
    }

    /* Diff Panel */
    .diff-panel {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 1000;
      padding: 20px;
      overflow: auto;
    }

    .diff-panel.visible {
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }

    .diff-content {
      background: var(--td-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      max-width: 700px;
      width: 100%;
      max-height: 80vh;
      overflow: auto;
    }

    .diff-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--td-card-border);
      background: var(--td-card-bg);
      position: sticky;
      top: 0;
      z-index: 1;
    }

    .diff-title {
      font-weight: 600;
      color: var(--td-text);
    }

    .diff-close {
      background: none;
      border: none;
      color: var(--td-text-muted);
      cursor: pointer;
      padding: 4px;
      font-size: 18px;
    }

    .diff-close:hover {
      color: var(--td-text);
    }

    .diff-body {
      padding: 16px;
    }

    .diff-section {
      margin-bottom: 16px;
    }

    .diff-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--td-text-muted);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .diff-section-title .count {
      background: var(--td-accent);
      color: white;
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 10px;
    }

    .diff-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: var(--td-radius-sm);
      margin-bottom: 4px;
      font-size: 12px;
    }

    .diff-row.added {
      background: rgba(16, 185, 129, 0.15);
      border-left: 3px solid var(--td-success);
    }

    .diff-row.removed {
      background: rgba(239, 68, 68, 0.15);
      border-left: 3px solid var(--td-error);
    }

    .diff-row.modified {
      background: rgba(245, 158, 11, 0.15);
      border-left: 3px solid var(--td-warning);
    }

    .diff-row-id {
      font-weight: 500;
      font-family: var(--td-mono);
    }

    .diff-row-detail {
      color: var(--td-text-muted);
      font-size: 11px;
    }

    .diff-empty {
      color: var(--td-text-muted);
      font-style: italic;
      padding: 8px;
    }

    .diff-summary {
      background: var(--td-card-bg);
      border-radius: var(--td-radius-sm);
      padding: 12px;
      display: flex;
      gap: 16px;
      margin-bottom: 16px;
    }

    .diff-stat {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .diff-stat-value {
      font-weight: 600;
      font-size: 18px;
    }

    .diff-stat-label {
      font-size: 11px;
      color: var(--td-text-muted);
    }

    .diff-stat.added .diff-stat-value { color: var(--td-success); }
    .diff-stat.removed .diff-stat-value { color: var(--td-error); }
    .diff-stat.modified .diff-stat-value { color: var(--td-warning); }

    /* Inline validation indicators */
    .field-input.has-error {
      border-color: var(--td-error);
      background: rgba(239, 68, 68, 0.05);
    }

    .field-input.has-warning {
      border-color: var(--td-warning);
      background: rgba(245, 158, 11, 0.05);
    }

    .field-error {
      font-size: 10px;
      color: var(--td-error);
      margin-top: 4px;
    }

    .field-warning {
      font-size: 10px;
      color: var(--td-warning);
      margin-top: 4px;
    }

    /* Bookmarks Panel */
    .bookmarks-card {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      overflow: hidden;
      margin-top: 12px;
    }

    .bookmarks-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--td-card-border);
      background: rgba(16, 185, 129, 0.05);
    }

    .bookmarks-title {
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--td-success);
    }

    .bookmarks-list {
      max-height: 200px;
      overflow-y: auto;
      padding: 8px;
    }

    .bookmark-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: var(--td-radius-sm);
      cursor: pointer;
      font-size: 12px;
    }

    .bookmark-item:hover {
      background: var(--td-card-hover);
    }

    .bookmark-icon {
      color: var(--td-success);
    }

    .bookmark-name {
      flex: 1;
      font-weight: 500;
    }

    .bookmark-date {
      font-size: 10px;
      color: var(--td-text-muted);
    }

    .bookmark-delete {
      opacity: 0;
      background: none;
      border: none;
      color: var(--td-error);
      cursor: pointer;
      padding: 2px;
    }

    .bookmark-item:hover .bookmark-delete {
      opacity: 1;
    }

    .bookmarks-empty {
      padding: 16px;
      text-align: center;
      color: var(--td-text-muted);
      font-size: 11px;
    }

    /* Import Menu */
    .import-menu {
      position: relative;
    }

    .import-dropdown {
      position: absolute;
      top: 100%;
      right: 0;
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      display: none;
      z-index: 100;
      min-width: 140px;
    }

    .import-dropdown.visible {
      display: block;
    }

    .import-option {
      display: block;
      width: 100%;
      padding: 8px 12px;
      background: none;
      border: none;
      text-align: left;
      cursor: pointer;
      font-size: 12px;
      color: var(--td-text);
    }

    .import-option:hover {
      background: var(--td-card-hover);
    }

    /* Add Row Menu with Template Button */
    .add-row-menu {
      display: flex;
      gap: 2px;
    }

    .add-row-menu .btn {
      border-radius: 0;
    }

    .add-row-menu .btn:first-child {
      border-radius: var(--td-radius-sm) 0 0 var(--td-radius-sm);
    }

    .add-row-menu .btn:last-child {
      border-radius: 0 var(--td-radius-sm) var(--td-radius-sm) 0;
    }

    .add-template-btn {
      padding: 6px 8px !important;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .add-template-btn svg {
      fill: currentColor;
    }

    /* Health Check Panel */
    .health-panel {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      margin-bottom: 12px;
      display: none;
    }

    .health-panel.visible {
      display: block;
    }

    .health-panel.has-issues {
      border-color: var(--td-warning);
    }

    .health-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      border-bottom: 1px solid var(--td-card-border);
      background: rgba(16, 185, 129, 0.05);
    }

    .health-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 12px;
      color: var(--td-success);
    }

    .health-panel.has-issues .health-title {
      color: var(--td-warning);
    }

    .health-panel.has-issues .health-header {
      background: rgba(245, 158, 11, 0.05);
    }

    .health-body {
      padding: 12px;
      max-height: 200px;
      overflow-y: auto;
    }

    .health-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 0;
      font-size: 12px;
      border-bottom: 1px dashed var(--td-card-border);
    }

    .health-item:last-child {
      border-bottom: none;
    }

    .health-icon {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
    }

    .health-icon.warning { color: var(--td-warning); }
    .health-icon.info { color: var(--td-accent); }
    .health-icon.success { color: var(--td-success); }

    /* Row Notes */
    .notes-section {
      padding: 8px 12px;
      border-top: 1px dashed var(--td-card-border);
      background: rgba(124, 58, 237, 0.02);
    }

    .notes-label {
      font-size: 10px;
      color: var(--td-text-muted);
      text-transform: uppercase;
      margin-bottom: 4px;
    }

    .notes-input {
      width: 100%;
      padding: 6px 8px;
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      color: var(--td-text);
      font-size: 11px;
      resize: vertical;
      min-height: 40px;
    }

    .notes-input:focus {
      border-color: var(--td-accent);
      outline: none;
    }

    .notes-toggle {
      font-size: 10px;
      color: var(--td-text-muted);
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 6px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .row-card:hover .notes-toggle {
      opacity: 1;
    }

    .notes-toggle:hover {
      color: var(--td-accent);
    }

    /* Timeline Search */
    .timeline-search {
      padding: 8px;
      border-bottom: 1px solid var(--td-card-border);
    }

    .timeline-search-input {
      width: 100%;
      padding: 6px 8px;
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      color: var(--td-text);
      font-size: 11px;
    }

    .timeline-search-input:focus {
      border-color: var(--td-accent);
      outline: none;
    }

    .timeline-item.filtered-out {
      display: none;
    }

    /* Row Compare Modal */
    .compare-panel {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.7);
      z-index: 1000;
      padding: 20px;
      overflow: auto;
    }

    .compare-panel.visible {
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }

    .compare-content {
      background: var(--td-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius);
      max-width: 900px;
      width: 100%;
      max-height: 80vh;
      overflow: auto;
    }

    .compare-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--td-card-border);
      background: var(--td-card-bg);
      position: sticky;
      top: 0;
      z-index: 1;
    }

    .compare-title {
      font-weight: 600;
    }

    .compare-close {
      background: none;
      border: none;
      color: var(--td-text-muted);
      cursor: pointer;
      padding: 4px;
      font-size: 18px;
    }

    .compare-body {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 16px;
    }

    .compare-column {
      background: var(--td-card-bg);
      border: 1px solid var(--td-card-border);
      border-radius: var(--td-radius-sm);
      padding: 12px;
    }

    .compare-column-title {
      font-weight: 600;
      font-size: 12px;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--td-card-border);
    }

    .compare-field {
      margin-bottom: 8px;
    }

    .compare-field-label {
      font-size: 10px;
      color: var(--td-text-muted);
      text-transform: uppercase;
    }

    .compare-field-value {
      font-size: 12px;
      padding: 4px 0;
    }

    .compare-field-value.different {
      background: rgba(245, 158, 11, 0.1);
      padding: 4px 8px;
      border-radius: var(--td-radius-sm);
      border-left: 2px solid var(--td-warning);
    }

    /* DAG Path Highlighting */
    .dag-node.highlighted rect {
      stroke: var(--td-accent);
      stroke-width: 2;
      fill: rgba(124, 58, 237, 0.1);
    }

    .dag-edge.path-highlighted {
      stroke: var(--td-accent);
      stroke-width: 2.5;
      opacity: 1;
    }

    .dag-edge.dimmed {
      opacity: 0.2;
    }

    .dag-node.dimmed rect {
      opacity: 0.3;
    }

    .dag-node.dimmed text {
      opacity: 0.3;
    }
  </style>
</head>
<body>
  <!-- Source change notification -->
  <div id="sourceChangeNotification" class="source-change-notification"></div>

  <!-- Diff Panel Modal -->
  <div id="diffPanel" class="diff-panel">
    <div class="diff-content">
      <div class="diff-header">
        <span class="diff-title">History Comparison</span>
        <button class="diff-close" id="diffClose">&times;</button>
      </div>
      <div class="diff-body" id="diffBody">
        <!-- Diff content will be inserted here -->
      </div>
    </div>
  </div>

  <!-- Header -->
  <header class="header">
    <div class="header-left">
      <div class="logo">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        Top-Down
      </div>
      <div class="stats">
        <span class="stat"><span class="stat-dot ok"></span> ${rowCount} rows</span>
        ${lockedCount > 0 ? `<span class="stat"><span class="stat-dot locked"></span> ${lockedCount} locked</span>` : ''}
        ${errorCount > 0 ? `<span class="stat"><span class="stat-dot error"></span> ${errorCount} errors</span>` : ''}
      </div>
    </div>
    <div class="header-actions">
      <div class="undo-redo-group">
        <button class="btn-icon" id="undo" title="Undo (Cmd+Z)" ${(store.history?.length ?? 0) <= 1 ? 'disabled' : ''}>
          <svg viewBox="0 0 16 16"><path d="M4.5 3.5L1 7l3.5 3.5M1.5 7h11a3 3 0 0 1 0 6H9"/></svg>
        </button>
        <button class="btn-icon" id="redo" title="Redo" disabled>
          <svg viewBox="0 0 16 16"><path d="M11.5 3.5L15 7l-3.5 3.5M14.5 7h-11a3 3 0 0 0 0 6H7"/></svg>
        </button>
      </div>
      <button class="btn-icon" id="toggleStats" title="Toggle statistics panel - view row counts, locked items, and error summary">
        <svg viewBox="0 0 16 16"><path d="M1 14h14M3 10v4M6 7v7M9 4v10M12 1v13"/></svg>
      </button>
      <button class="btn-icon" id="ingest" title="Scan workspace - discover symbols and markers in your codebase">
        <svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 7 7 .75.75 0 0 0-1.5 0 5.5 5.5 0 1 1-1.65-3.9H10a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 .75-.75v-3a.75.75 0 0 0-1.5 0V3.2A6.97 6.97 0 0 0 8 1Z"/></svg>
      </button>
      <button class="btn-icon" id="restore" title="Restore from backup - recover previous config states from auto-saved backups">
        <svg viewBox="0 0 16 16"><path d="M8 2a6 6 0 1 0 6 6 .75.75 0 0 0-1.5 0A4.5 4.5 0 1 1 8 3.5c1.07 0 2.06.38 2.83 1.02H10a.75.75 0 0 0 0 1.5h3a.75.75 0 0 0 .75-.75v-3a.75.75 0 0 0-1.5 0v.97A5.96 5.96 0 0 0 8 2Z"/><path d="M7.25 5.25c0-.41.34-.75.75-.75s.75.34.75.75v2.44l1.72 1.03a.75.75 0 1 1-.77 1.28l-2.08-1.25a.75.75 0 0 1-.37-.64V5.25Z"/></svg>
      </button>
      <button class="btn-icon" id="codegen" title="Generate definitions - create shippable config files from your rows">
        <svg viewBox="0 0 16 16"><path d="M6.5 1.5h3v1.2c.47.12.92.31 1.33.56l.85-.85 2.12 2.12-.85.85c.25.41.44.86.56 1.33H15.5v3h-1.99c-.12.47-.31.92-.56 1.33l.85.85-2.12 2.12-.85-.85c-.41.25-.86.44-1.33.56V15.5h-3v-1.99c-.47-.12-.92-.31-1.33-.56l-.85.85-2.12-2.12.85-.85c-.25-.41-.44-.86-.56-1.33H.5v-3h1.99c.12-.47.31-.92.56-1.33l-.85-.85L4.32 2.21l.85.85c.41-.25.86-.44 1.33-.56V1.5Zm1.5 4.25A2.75 2.75 0 1 0 10.75 8 2.75 2.75 0 0 0 8 5.75Z"/></svg>
      </button>
      <div class="export-menu">
        <button class="btn-icon" id="exportBtn" title="Export config - save your configuration to various formats">
          <svg viewBox="0 0 16 16"><path d="M8 1v10M4 7l4 4 4-4M2 13h12v2H2z"/></svg>
        </button>
        <div class="export-dropdown" id="exportDropdown">
          <button class="export-option" data-format="json" title="Export as JSON file">Export JSON</button>
          <button class="export-option" data-format="yaml" title="Export as YAML file">Export YAML</button>
          <button class="export-option" data-format="toml" title="Export as TOML file">Export TOML</button>
          <button class="export-option" data-format="mermaid" title="Export as Mermaid diagram for documentation">Export Mermaid</button>
          <button class="export-option" data-format="dot" title="Export as DOT format for Graphviz visualization">Export DOT/Graphviz</button>
        </div>
      </div>
      <div class="import-menu">
        <button class="btn-icon" id="importBtn" title="Import config - load configuration from files or clipboard">
          <svg viewBox="0 0 16 16"><path d="M8 11V1M4 5l4-4 4 4M2 13h12v2H2z"/></svg>
        </button>
        <div class="import-dropdown" id="importDropdown">
          <button class="import-option" data-import="json" title="Import from JSON file">Import JSON</button>
          <button class="import-option" data-import="yaml" title="Import from YAML file">Import YAML</button>
          <button class="import-option" data-import="toml" title="Import from TOML file">Import TOML</button>
          <button class="import-option" data-import="clipboard" title="Import from clipboard contents">Paste from Clipboard</button>
        </div>
      </div>
      <button class="btn-icon" id="healthCheck" title="Dependency health check - detect cycles, missing dependencies, and validation errors">
        <svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.5 3.5a.5.5 0 0 1 1 0v4a.5.5 0 0 1-1 0v-4zm.5 7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z"/></svg>
      </button>
      <button class="btn-icon" id="addBookmark" title="Create bookmark - save current state as a named snapshot you can restore later">
        <svg viewBox="0 0 16 16"><path d="M3 1h10a1 1 0 0 1 1 1v13l-6-3-6 3V2a1 1 0 0 1 1-1z"/></svg>
      </button>
      <div class="add-row-menu">
        <button class="btn btn-secondary" id="add" title="Add a new empty configuration row">+ Add Row</button>
        <button class="btn btn-secondary add-template-btn" id="addFromTemplate" title="Add from template - choose from predefined row templates">
          <svg viewBox="0 0 16 16" style="width:12px;height:12px;"><path d="M2 4.5A2.5 2.5 0 0 1 4.5 2h7A2.5 2.5 0 0 1 14 4.5v.5H2v-.5zM2 6h12v5.5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 11.5V6zm3 2a.5.5 0 0 0 0 1h6a.5.5 0 0 0 0-1H5zm0 2a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H5z"/></svg>
        </button>
      </div>
      <button class="btn btn-primary" id="save" title="Save all changes to config file">Save Changes</button>
    </div>
  </header>

  <div class="layout">
    <!-- Sidebar / Timeline -->
    <aside class="sidebar">
      <div class="timeline-card">
        <div class="timeline-header">
          <span class="timeline-title" title="View and navigate change history - click any entry to preview that state">Timeline</span>
          <button class="btn-icon" id="clearPlayhead" title="Jump to latest - clear playhead and show current state" style="width:24px;height:24px;">
            <svg viewBox="0 0 16 16" style="width:12px;height:12px;"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.5 7.5h-7a.5.5 0 0 1 0-1h7a.5.5 0 0 1 0 1z"/></svg>
          </button>
        </div>
        <div class="timeline-search">
          <input type="text" class="timeline-search-input" id="timelineSearch" placeholder="Search history..." title="Filter timeline entries by label or description" />
        </div>
        <div class="timeline-list">
          ${stepsNewestFirst.length === 0
            ? `<div class="timeline-empty">No history yet</div>`
            : stepsNewestFirst.map((s) => {
                const isActive = s.idx === playhead;
                return `
                <div class="timeline-item ${isActive ? 'active' : ''}" data-step-idx="${s.idx}" data-step-label="${escapeHtml(s.label)}" data-step-kind="${escapeHtml(s.kind)}" data-step-ts="${s.ts}">
                  <div class="timeline-dot"></div>
                  <div class="timeline-content">
                    <div class="timeline-label">${escapeHtml(s.label)}</div>
                    <div class="timeline-meta">${escapeHtml(s.kind)}</div>
                    <div class="timeline-actions">
                      ${s.hasSnapshot ? `<button class="timeline-restore has-snapshot" data-restore-idx="${s.idx}">Restore</button>` : ''}
                      ${s.hasSnapshot ? `<button class="timeline-compare" data-compare-idx="${s.idx}" title="Compare with current">Diff</button>` : ''}
                    </div>
                  </div>
                </div>`;
              }).join('')
          }
        </div>
      </div>

      <!-- Bookmarks Panel -->
      <div class="bookmarks-card">
        <div class="bookmarks-header">
          <span class="bookmarks-title">Bookmarks</span>
        </div>
        <div class="bookmarks-list">
          ${(store.bookmarks ?? []).length === 0
            ? `<div class="bookmarks-empty">No bookmarks yet. Click the bookmark icon to save the current state.</div>`
            : (store.bookmarks ?? []).map((b: Bookmark) => `
              <div class="bookmark-item" data-bookmark-id="${escapeHtml(b.id)}">
                <span class="bookmark-icon">📌</span>
                <span class="bookmark-name">${escapeHtml(b.name)}</span>
                <span class="bookmark-date">${new Date(b.ts).toLocaleDateString()}</span>
                <button class="bookmark-delete" data-delete-bookmark="${escapeHtml(b.id)}" title="Delete bookmark">&times;</button>
              </div>
            `).join('')
          }
        </div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main">
      <!-- View Tabs -->
      <div class="view-tabs">
        <button class="view-tab active" data-view="table" title="Table View - edit config rows in a list format">Table View</button>
        <button class="view-tab" data-view="dag" title="DAG View - visualize dependencies as a directed graph">DAG View</button>
      </div>

      <!-- Search Bar -->
      <div class="search-container">
        <input type="text" class="search-input" id="searchInput" placeholder="Search rows by ID, name, or args..." title="Filter rows - type to search by ID, name, args, or expression" />
        <span class="search-count" id="searchCount" title="Number of matching rows"></span>
        <button class="quick-add-btn" id="quickAdd" title="Quick add - create a new config row at the bottom of the list">+</button>
      </div>

      <!-- Statistics Panel -->
      <div class="stats-panel" id="statsPanel">
        <div class="stats-grid">
          <div class="stat-item">
            <div class="stat-value">${rowCount}</div>
            <div class="stat-label">Total Rows</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${lockedCount}</div>
            <div class="stat-label">Locked</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${pinnedCount}</div>
            <div class="stat-label">Pinned</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${uniqueScopes}</div>
            <div class="stat-label">Scopes</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${maxDependencyDepth}</div>
            <div class="stat-label">Max Depth</div>
          </div>
          <div class="stat-item">
            <div class="stat-value">${totalDependencies}</div>
            <div class="stat-label">Dependencies</div>
          </div>
        </div>
      </div>

      <!-- Bulk Selection Toolbar -->
      <div class="bulk-toolbar" id="bulkToolbar">
        <span class="bulk-count"><span id="bulkCount">0</span> selected</span>
        <button class="bulk-btn" id="bulkLock">Lock All</button>
        <button class="bulk-btn" id="bulkUnlock">Unlock All</button>
        <button class="bulk-btn" id="bulkPin">Pin All</button>
        <button class="bulk-btn" id="bulkUnpin">Unpin All</button>
        <button class="bulk-btn" id="bulkCompare">Compare</button>
        <button class="bulk-btn danger" id="bulkDelete">Delete</button>
        <button class="bulk-btn" id="bulkClear">Clear Selection</button>
      </div>

      <!-- Health Check Panel -->
      <div class="health-panel" id="healthPanel">
        <div class="health-header">
          <div class="health-title">
            <svg viewBox="0 0 16 16" style="width:14px;height:14px;fill:currentColor;"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.5 3.5a.5.5 0 0 1 1 0v4a.5.5 0 0 1-1 0v-4zm.5 7a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z"/></svg>
            <span>Dependency Health</span>
          </div>
          <button class="btn-icon" id="closeHealth" style="width:20px;height:20px;">&times;</button>
        </div>
        <div class="health-body" id="healthBody">
          <!-- Health issues will be inserted here -->
        </div>
      </div>

      <!-- Row Comparison Modal -->
      <div id="comparePanel" class="compare-panel">
        <div class="compare-content">
          <div class="compare-header">
            <span class="compare-title">Compare Rows</span>
            <button class="compare-close" id="compareClose">&times;</button>
          </div>
          <div class="compare-body" id="compareBody">
            <!-- Comparison content will be inserted here -->
          </div>
        </div>
      </div>

      <!-- Speculative Preview Panel -->
      <div class="preview-panel hidden" id="previewPanel">
        <div class="preview-header">
          <div class="preview-title">
            <svg viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 3.5zm0 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/></svg>
            <span>Preview Changes</span>
          </div>
          <span id="previewCount">0 issues</span>
        </div>
        <div class="preview-body" id="previewBody">
          <!-- Validation issues will be inserted here -->
        </div>
      </div>

      <!-- Table View -->
      <div class="view-content active" id="tableView">
      ${rows.length === 0
        ? `
        <div class="empty-state">
          <svg class="empty-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
          <div class="empty-title">No rows yet</div>
          <div class="empty-desc">Add your first row to start tracking code elements with Top-Down's parametric config system.</div>
          <button class="btn btn-primary" id="addFirst">+ Add First Row</button>
        </div>`
        : `
        <div class="rows-grid">
          ${hasMultipleScopes
            ? sortedScopes.map(scope => `
              <div class="scope-group" data-scope="${escapeHtml(scope)}">
                <div class="scope-header" data-toggle-scope="${escapeHtml(scope)}">
                  <span class="scope-toggle">▼</span>
                  <span class="scope-name">${escapeHtml(scope)}</span>
                  <span class="scope-count">${scopeGroups.get(scope)!.length}</span>
                </div>
                <div class="scope-content">
                  ${scopeGroups.get(scope)!.map(renderRowCard).join('')}
                </div>
              </div>
            `).join('')
            : rows.map(renderRowCard).join('')
          }
        </div>`
      }
      </div>

      <!-- DAG View -->
      <div class="view-content" id="dagView">
        <div class="dag-container">
          ${dagNodes.length === 0
            ? `<div class="empty-state" style="border:none;background:transparent;min-height:200px;">
                <svg class="empty-icon" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
                <div class="empty-title">No dependencies</div>
                <div class="empty-desc">Add dependencies between rows to see the graph.</div>
              </div>`
            : `<svg class="dag-svg" width="${dagWidth}" height="${dagHeight}" viewBox="0 0 ${dagWidth} ${dagHeight}">
                <defs>
                  <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
                    <polygon points="0 0, 10 3.5, 0 7" fill="var(--td-card-border)"/>
                  </marker>
                </defs>
                <!-- Edges -->
                ${dagEdges.map(e => `
                  <path class="dag-edge" data-from="${e.from}" data-to="${e.to}"
                    d="M ${e.fromX} ${e.fromY} C ${e.fromX - 40} ${e.fromY}, ${e.toX + 40} ${e.toY}, ${e.toX} ${e.toY}" />
                `).join('')}
                <!-- Nodes -->
                ${dagNodes.map(n => `
                  <g class="dag-node ${n.hasCycle ? 'cycle' : ''}" data-node="${n.id}" transform="translate(${n.x}, ${n.y})">
                    <rect width="120" height="40" />
                    <text x="60" y="24" text-anchor="middle">${n.id.length > 14 ? n.id.slice(0, 12) + '...' : n.id}</text>
                  </g>
                `).join('')}
              </svg>`
          }
        </div>
      </div>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Button handlers
    document.getElementById('ingest')?.addEventListener('click', () => vscode.postMessage({ type: 'runCommand', command: 'topdown.ingestWorkspace' }));
    document.getElementById('restore')?.addEventListener('click', () => vscode.postMessage({ type: 'runCommand', command: 'topdown.restoreBackup' }));
    document.getElementById('codegen')?.addEventListener('click', () => vscode.postMessage({ type: 'runCommand', command: 'topdown.generateShippableDefs' }));
    document.getElementById('add')?.addEventListener('click', () => vscode.postMessage({ type: 'addRow' }));
    document.getElementById('addFirst')?.addEventListener('click', () => vscode.postMessage({ type: 'addRow' }));
    document.getElementById('addFromTemplate')?.addEventListener('click', () => vscode.postMessage({ type: 'showTemplatePicker' }));
    document.getElementById('clearPlayhead')?.addEventListener('click', () => vscode.postMessage({ type: 'clearPlayhead' }));

    // Save button
    document.getElementById('save')?.addEventListener('click', () => {
      const cards = Array.from(document.querySelectorAll('.row-card'));
      const rows = cards.map((card) => {
        const lock = card.querySelector('input[data-lock]');
        const id = card.querySelector('input[data-id]');
        const name = card.querySelector('input[data-name]');
        const args = card.querySelector('input[data-args]');
        const expr = card.querySelector('input[data-expr]');
        const depends = card.querySelector('input[data-depends]');
        return {
          locked: !!(lock && lock.checked),
          id: id ? id.value : '',
          name: name ? name.value : '',
          args: args ? args.value : '',
          expr: expr ? expr.value : '',
          depends: depends ? depends.value.split(',').map(s => s.trim()).filter(Boolean) : []
        };
      });
      vscode.postMessage({ type: 'saveRows', rows });
    });

    // Timeline items
    for (const item of document.querySelectorAll('.timeline-item')) {
      item.addEventListener('click', () => {
        const idx = Number(item.getAttribute('data-step-idx'));
        if (Number.isFinite(idx)) {
          vscode.postMessage({ type: 'setPlayhead', idx });
        }
      });
    }

    // Expand/Collapse rows
    for (const btn of document.querySelectorAll('[data-expand]')) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.getAttribute('data-expand');
        const card = btn.closest('.row-card');
        const expanded = card.querySelector('[data-expanded="' + id + '"]');
        if (card && expanded) {
          const isExpanded = card.classList.toggle('expanded');
          expanded.style.display = isExpanded ? 'block' : 'none';
        }
      });
    }

    // Row actions (more button)
    for (const btn of document.querySelectorAll('[data-row-more]')) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = btn.getAttribute('data-row-more');
        if (id) vscode.postMessage({ type: 'rowActions', id });
      });
    }

    // Dependency chip navigation
    for (const chip of document.querySelectorAll('[data-goto]')) {
      chip.addEventListener('click', () => {
        const targetId = chip.getAttribute('data-goto');
        const targetCard = document.querySelector(\`.row-card[data-row="\${targetId}"]\`);
        if (targetCard) {
          targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          targetCard.style.boxShadow = '0 0 0 2px var(--td-accent)';
          setTimeout(() => { targetCard.style.boxShadow = ''; }, 1500);
        }
      });
    }

    // Context menu on rows
    for (const card of document.querySelectorAll('.row-card[data-row]')) {
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const id = card.getAttribute('data-row');
        if (id) vscode.postMessage({ type: 'rowActions', id });
      });
    }

    // Tab switching
    for (const tab of document.querySelectorAll('.view-tab')) {
      tab.addEventListener('click', () => {
        const view = tab.getAttribute('data-view');
        document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.view-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const targetView = document.getElementById(view + 'View');
        if (targetView) targetView.classList.add('active');
      });
    }

    // Speculative validation - debounced input handler
    let validateTimeout = null;
    function triggerValidation() {
      if (validateTimeout) clearTimeout(validateTimeout);
      validateTimeout = setTimeout(() => {
        const cards = Array.from(document.querySelectorAll('.row-card'));
        const rows = cards.map((card) => {
          const lock = card.querySelector('input[data-lock]');
          const id = card.querySelector('input[data-id]');
          const name = card.querySelector('input[data-name]');
          const args = card.querySelector('input[data-args]');
          const expr = card.querySelector('input[data-expr]');
          const depends = card.querySelector('input[data-depends]');
          return {
            locked: !!(lock && lock.checked),
            id: id ? id.value : '',
            name: name ? name.value : '',
            args: args ? args.value : '',
            expr: expr ? expr.value : '',
            depends: depends ? depends.value.split(',').map(s => s.trim()).filter(Boolean) : []
          };
        });
        vscode.postMessage({ type: 'speculativeValidate', rows });
      }, 300);
    }

    // Add input listeners for speculative validation
    for (const input of document.querySelectorAll('.field-input')) {
      input.addEventListener('input', triggerValidation);
    }

    // Handle validation results from extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'validationResult') {
        const validation = msg.validation;
        const panel = document.getElementById('previewPanel');
        const body = document.getElementById('previewBody');
        const count = document.getElementById('previewCount');

        // Clear previous field highlights
        document.querySelectorAll('.field-input').forEach(i => {
          i.classList.remove('has-error', 'has-warning');
        });
        document.querySelectorAll('.field-error, .field-warning').forEach(e => e.remove());

        const issues = [];

        // Cycle warnings
        for (const warn of validation.cycleWarnings || []) {
          issues.push({ type: 'error', message: warn });
        }

        // Missing dependencies
        for (const warn of validation.missingDeps || []) {
          issues.push({ type: 'error', message: warn });
        }

        // Args validation errors/warnings
        for (const argsErr of validation.argsErrors || []) {
          const card = document.querySelector(\`.row-card[data-row="\${argsErr.id}"]\`);
          const argsInput = card?.querySelector('input[data-args]');

          for (const err of argsErr.errors || []) {
            issues.push({ type: 'error', message: \`\${argsErr.id}: \${err}\` });
            if (argsInput) argsInput.classList.add('has-error');
          }
          for (const warn of argsErr.warnings || []) {
            issues.push({ type: 'warning', message: \`\${argsErr.id}: \${warn}\` });
            if (argsInput && !argsInput.classList.contains('has-error')) {
              argsInput.classList.add('has-warning');
            }
          }
        }

        if (issues.length > 0) {
          panel.classList.remove('hidden');
          panel.classList.toggle('has-errors', issues.some(i => i.type === 'error'));
          panel.classList.toggle('has-issues', !issues.some(i => i.type === 'error') && issues.length > 0);

          const errorCount = issues.filter(i => i.type === 'error').length;
          const warnCount = issues.filter(i => i.type === 'warning').length;
          count.textContent = \`\${errorCount} errors, \${warnCount} warnings\`;

          body.innerHTML = issues.map(issue => \`
            <div class="preview-item">
              <svg class="preview-icon \${issue.type}" viewBox="0 0 16 16">
                \${issue.type === 'error'
                  ? '<circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.2"/><path d="M8 4v5M8 11v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
                  : '<path d="M8 1l7 14H1L8 1z" fill="currentColor" opacity="0.2"/><path d="M8 6v4M8 12v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
                }
              </svg>
              <span class="preview-message">\${issue.message}</span>
            </div>
          \`).join('');
        } else {
          panel.classList.add('hidden');
          panel.classList.remove('has-errors', 'has-issues');
        }
      }

      // Handle diff display
      if (msg.type === 'showDiff') {
        const diffPanel = document.getElementById('diffPanel');
        const diffBody = document.getElementById('diffBody');
        if (!diffPanel || !diffBody) return;

        const diff = msg.diff || {};
        const added = diff.added || [];
        const removed = diff.removed || [];
        const modified = diff.modified || [];
        const total = added.length + removed.length + modified.length;

        if (total === 0) {
          diffBody.innerHTML = \`
            <div class="diff-empty">No differences found. Current state matches the snapshot.</div>
          \`;
        } else {
          let html = \`
            <div class="diff-summary">
              <div class="diff-stat added">
                <span class="diff-stat-value">\${added.length}</span>
                <span class="diff-stat-label">added</span>
              </div>
              <div class="diff-stat removed">
                <span class="diff-stat-value">\${removed.length}</span>
                <span class="diff-stat-label">removed</span>
              </div>
              <div class="diff-stat modified">
                <span class="diff-stat-value">\${modified.length}</span>
                <span class="diff-stat-label">modified</span>
              </div>
            </div>
          \`;

          if (added.length > 0) {
            html += \`
              <div class="diff-section">
                <div class="diff-section-title">
                  Added <span class="count">\${added.length}</span>
                </div>
                \${added.map(r => \`
                  <div class="diff-row added">
                    <span class="diff-row-id">\${r.id}</span>
                    \${r.name ? \`<span class="diff-row-detail">\${r.name}</span>\` : ''}
                  </div>
                \`).join('')}
              </div>
            \`;
          }

          if (removed.length > 0) {
            html += \`
              <div class="diff-section">
                <div class="diff-section-title">
                  Removed <span class="count">\${removed.length}</span>
                </div>
                \${removed.map(r => \`
                  <div class="diff-row removed">
                    <span class="diff-row-id">\${r.id}</span>
                    \${r.name ? \`<span class="diff-row-detail">\${r.name}</span>\` : ''}
                  </div>
                \`).join('')}
              </div>
            \`;
          }

          if (modified.length > 0) {
            html += \`
              <div class="diff-section">
                <div class="diff-section-title">
                  Modified <span class="count">\${modified.length}</span>
                </div>
                \${modified.map(r => \`
                  <div class="diff-row modified">
                    <span class="diff-row-id">\${r.id}</span>
                    <span class="diff-row-detail">changed: \${r.changes.join(', ')}</span>
                  </div>
                \`).join('')}
              </div>
            \`;
          }

          diffBody.innerHTML = html;
        }

        // Update title
        const diffTitle = diffPanel.querySelector('.diff-title');
        if (diffTitle) {
          diffTitle.textContent = \`Comparing: Current vs "\${msg.label}"\`;
        }

        diffPanel.classList.add('visible');
      }

      // Handle source file changes - highlight affected rows
      if (msg.type === 'sourceChanged') {
        const rowIds = msg.rowIds || [];
        // Clear previous source-changed highlights
        document.querySelectorAll('.row-card.source-changed').forEach(c => {
          c.classList.remove('source-changed');
        });
        // Add highlight to affected rows
        for (const id of rowIds) {
          const card = document.querySelector(\`.row-card[data-row="\${id}"]\`);
          if (card) {
            card.classList.add('source-changed');
          }
        }
        // Show notification if there are changes
        if (rowIds.length > 0) {
          const notification = document.getElementById('sourceChangeNotification');
          if (notification) {
            notification.textContent = \`Source files changed: \${rowIds.length} target\${rowIds.length > 1 ? 's' : ''} affected\`;
            notification.classList.add('visible');
            setTimeout(() => notification.classList.remove('visible'), 5000);
          }
        }
      }

      // Handle template selection - add row from template
      if (msg.type === 'templateSelected') {
        vscode.postMessage({ type: 'addRowFromTemplate', templateId: msg.templateId });
      }
    });

    // Timeline restore button
    for (const btn of document.querySelectorAll('.timeline-restore')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-restore-idx'));
        if (Number.isFinite(idx)) {
          vscode.postMessage({ type: 'restorePlayhead', idx });
        }
      });
    }

    // Timeline compare button - show diff panel
    for (const btn of document.querySelectorAll('.timeline-compare')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = Number(btn.getAttribute('data-compare-idx'));
        if (Number.isFinite(idx)) {
          vscode.postMessage({ type: 'comparePlayhead', idx });
        }
      });
    }

    // Diff panel close
    const diffPanel = document.getElementById('diffPanel');
    const diffClose = document.getElementById('diffClose');
    if (diffPanel && diffClose) {
      diffClose.addEventListener('click', () => {
        diffPanel.classList.remove('visible');
      });
      diffPanel.addEventListener('click', (e) => {
        if (e.target === diffPanel) {
          diffPanel.classList.remove('visible');
        }
      });
    }

    // DAG node click - navigate to row
    for (const node of document.querySelectorAll('.dag-node')) {
      node.addEventListener('click', () => {
        const id = node.getAttribute('data-node');
        if (id) {
          // Switch to table view
          document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.view-content').forEach(c => c.classList.remove('active'));
          document.querySelector('.view-tab[data-view="table"]')?.classList.add('active');
          document.getElementById('tableView')?.classList.add('active');

          // Scroll to the row
          const targetCard = document.querySelector(\`.row-card[data-row="\${id}"]\`);
          if (targetCard) {
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetCard.style.boxShadow = '0 0 0 2px var(--td-accent)';
            setTimeout(() => { targetCard.style.boxShadow = ''; }, 1500);
          }
        }
      });

      // Highlight connected edges on hover
      node.addEventListener('mouseenter', () => {
        const id = node.getAttribute('data-node');
        document.querySelectorAll(\`.dag-edge[data-from="\${id}"], .dag-edge[data-to="\${id}"]\`).forEach(e => {
          e.classList.add('highlighted');
        });
      });
      node.addEventListener('mouseleave', () => {
        document.querySelectorAll('.dag-edge.highlighted').forEach(e => {
          e.classList.remove('highlighted');
        });
      });
    }

    // Initial validation on load
    triggerValidation();

    // Search functionality
    const searchInput = document.getElementById('searchInput');
    const searchCount = document.getElementById('searchCount');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const query = searchInput.value.toLowerCase().trim();
        const cards = document.querySelectorAll('.row-card');
        let visible = 0;
        let total = cards.length;

        cards.forEach((card) => {
          if (!query) {
            card.classList.remove('filtered-out');
            visible++;
            return;
          }

          const id = (card.getAttribute('data-row') || '').toLowerCase();
          const name = (card.querySelector('input[data-name]')?.value || '').toLowerCase();
          const args = (card.querySelector('input[data-args]')?.value || '').toLowerCase();
          const expr = (card.querySelector('input[data-expr]')?.value || '').toLowerCase();

          if (id.includes(query) || name.includes(query) || args.includes(query) || expr.includes(query)) {
            card.classList.remove('filtered-out');
            visible++;
          } else {
            card.classList.add('filtered-out');
          }
        });

        if (searchCount) {
          searchCount.textContent = query ? \`\${visible}/\${total}\` : '';
        }
      });
    }

    // Quick add button
    document.getElementById('quickAdd')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'addRow' });
    });

    // Copy as code buttons
    for (const btn of document.querySelectorAll('[data-copy]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-copy');
        if (id) {
          const code = \`td("\${id}")\`;
          navigator.clipboard.writeText(code).then(() => {
            // Visual feedback
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1000);
          }).catch(() => {
            // Fallback for older webviews
            vscode.postMessage({ type: 'copyToClipboard', text: code });
          });
        }
      });
    }

    // Scope group toggle
    for (const header of document.querySelectorAll('[data-toggle-scope]')) {
      header.addEventListener('click', () => {
        const group = header.closest('.scope-group');
        if (group) {
          group.classList.toggle('collapsed');
          const toggle = header.querySelector('.scope-toggle');
          if (toggle) {
            toggle.textContent = group.classList.contains('collapsed') ? '▶' : '▼';
          }
        }
      });
    }

    // Statistics panel toggle
    document.getElementById('toggleStats')?.addEventListener('click', () => {
      document.getElementById('statsPanel')?.classList.toggle('visible');
    });

    // Export dropdown
    const exportBtn = document.getElementById('exportBtn');
    const exportDropdown = document.getElementById('exportDropdown');
    if (exportBtn && exportDropdown) {
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportDropdown.classList.toggle('visible');
      });
      document.addEventListener('click', () => {
        exportDropdown.classList.remove('visible');
      });
    }

    // Export format handlers
    for (const option of document.querySelectorAll('.export-option')) {
      option.addEventListener('click', () => {
        const format = option.getAttribute('data-format');
        if (format) {
          vscode.postMessage({ type: 'exportConfig', format });
        }
      });
    }

    // Pin button handlers
    for (const btn of document.querySelectorAll('[data-pin]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-pin');
        if (id) {
          vscode.postMessage({ type: 'togglePin', id });
        }
      });
    }

    // Undo button
    document.getElementById('undo')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'undo' });
    });

    // Bulk selection
    const selectedRows = new Set();
    function updateBulkToolbar() {
      const toolbar = document.getElementById('bulkToolbar');
      const countEl = document.getElementById('bulkCount');
      if (toolbar && countEl) {
        toolbar.classList.toggle('visible', selectedRows.size > 0);
        countEl.textContent = String(selectedRows.size);
      }
    }

    for (const checkbox of document.querySelectorAll('.bulk-select-checkbox')) {
      checkbox.addEventListener('change', (e) => {
        const id = checkbox.getAttribute('data-select');
        if (id) {
          if (checkbox.checked) {
            selectedRows.add(id);
            checkbox.closest('.row-card')?.classList.add('selected');
          } else {
            selectedRows.delete(id);
            checkbox.closest('.row-card')?.classList.remove('selected');
          }
          updateBulkToolbar();
        }
      });
    }

    // Bulk actions
    document.getElementById('bulkLock')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'bulkAction', action: 'lock', ids: Array.from(selectedRows) });
    });
    document.getElementById('bulkUnlock')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'bulkAction', action: 'unlock', ids: Array.from(selectedRows) });
    });
    document.getElementById('bulkPin')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'bulkAction', action: 'pin', ids: Array.from(selectedRows) });
    });
    document.getElementById('bulkUnpin')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'bulkAction', action: 'unpin', ids: Array.from(selectedRows) });
    });
    document.getElementById('bulkDelete')?.addEventListener('click', () => {
      if (confirm(\`Delete \${selectedRows.size} rows?\`)) {
        vscode.postMessage({ type: 'bulkAction', action: 'delete', ids: Array.from(selectedRows) });
      }
    });
    document.getElementById('bulkClear')?.addEventListener('click', () => {
      selectedRows.clear();
      document.querySelectorAll('.bulk-select-checkbox').forEach(cb => {
        cb.checked = false;
        cb.closest('.row-card')?.classList.remove('selected');
      });
      updateBulkToolbar();
    });

    // Drag and drop reordering
    let draggedRow = null;
    for (const card of document.querySelectorAll('.row-card[draggable="true"]')) {
      card.addEventListener('dragstart', (e) => {
        draggedRow = card;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        document.querySelectorAll('.row-card.drag-over').forEach(c => c.classList.remove('drag-over'));
        draggedRow = null;
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (draggedRow && draggedRow !== card) {
          card.classList.add('drag-over');
        }
      });
      card.addEventListener('dragleave', () => {
        card.classList.remove('drag-over');
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (draggedRow && draggedRow !== card) {
          const fromId = draggedRow.getAttribute('data-row');
          const toId = card.getAttribute('data-row');
          if (fromId && toId) {
            vscode.postMessage({ type: 'reorderRows', fromId, toId });
          }
        }
      });
    }

    // Keyboard navigation
    let focusedIndex = -1;
    const rowCards = Array.from(document.querySelectorAll('.row-card'));

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return; // Don't interfere with input fields

      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        focusedIndex = Math.min(focusedIndex + 1, rowCards.length - 1);
        rowCards.forEach((c, i) => c.classList.toggle('focused', i === focusedIndex));
        rowCards[focusedIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        focusedIndex = Math.max(focusedIndex - 1, 0);
        rowCards.forEach((c, i) => c.classList.toggle('focused', i === focusedIndex));
        rowCards[focusedIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (e.key === 'Enter' && focusedIndex >= 0) {
        e.preventDefault();
        const nameInput = rowCards[focusedIndex]?.querySelector('input[data-name]');
        nameInput?.focus();
      } else if (e.key === 'Escape') {
        focusedIndex = -1;
        rowCards.forEach(c => c.classList.remove('focused'));
      } else if (e.key === ' ' && focusedIndex >= 0) {
        e.preventDefault();
        const checkbox = rowCards[focusedIndex]?.querySelector('.bulk-select-checkbox');
        if (checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change'));
        }
      } else if (e.key === 'p' && focusedIndex >= 0) {
        const id = rowCards[focusedIndex]?.getAttribute('data-row');
        if (id) {
          vscode.postMessage({ type: 'togglePin', id });
        }
      }
    });

    // Import dropdown toggle
    const importBtn = document.getElementById('importBtn');
    const importDropdown = document.getElementById('importDropdown');
    if (importBtn && importDropdown) {
      importBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        importDropdown.classList.toggle('visible');
        exportDropdown?.classList.remove('visible');
      });
    }

    // Import handlers
    for (const option of document.querySelectorAll('.import-option')) {
      option.addEventListener('click', () => {
        const format = option.getAttribute('data-import');
        if (format) {
          vscode.postMessage({ type: 'importConfig', format });
        }
        importDropdown?.classList.remove('visible');
      });
    }

    // Close dropdowns on outside click
    document.addEventListener('click', () => {
      importDropdown?.classList.remove('visible');
    });

    // Add bookmark button
    document.getElementById('addBookmark')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'addBookmark' });
    });

    // Bookmark item click - restore
    for (const item of document.querySelectorAll('.bookmark-item')) {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-bookmark-id');
        if (id) {
          vscode.postMessage({ type: 'restoreBookmark', id });
        }
      });
    }

    // Bookmark delete
    for (const btn of document.querySelectorAll('[data-delete-bookmark]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-delete-bookmark');
        if (id && confirm('Delete this bookmark?')) {
          vscode.postMessage({ type: 'deleteBookmark', id });
        }
      });
    }

    // Health check button
    document.getElementById('healthCheck')?.addEventListener('click', () => {
      vscode.postMessage({ type: 'runHealthCheck' });
    });

    // Close health panel
    document.getElementById('closeHealth')?.addEventListener('click', () => {
      document.getElementById('healthPanel')?.classList.remove('visible');
    });

    // Handle health check results
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'healthCheckResult') {
        const panel = document.getElementById('healthPanel');
        const body = document.getElementById('healthBody');
        if (!panel || !body) return;

        const issues = msg.issues || [];
        panel.classList.add('visible');
        panel.classList.toggle('has-issues', issues.length > 0);

        if (issues.length === 0) {
          body.innerHTML = \`
            <div class="health-item">
              <svg class="health-icon success" viewBox="0 0 16 16"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.3 5.3l-4 4a.5.5 0 0 1-.7 0l-2-2a.5.5 0 0 1 .7-.7l1.65 1.65 3.65-3.65a.5.5 0 0 1 .7.7z" fill="currentColor"/></svg>
              <span>All dependencies are healthy! No issues found.</span>
            </div>
          \`;
        } else {
          body.innerHTML = issues.map(issue => \`
            <div class="health-item">
              <svg class="health-icon \${issue.type}" viewBox="0 0 16 16">
                \${issue.type === 'warning'
                  ? '<path d="M8 1l7 14H1L8 1z" fill="currentColor" opacity="0.2"/><path d="M8 6v4M8 12v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
                  : '<circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.2"/><path d="M8 4v5M8 11v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'}
              </svg>
              <span>\${issue.message}</span>
            </div>
          \`).join('');
        }
      }

      // Handle row comparison
      if (msg.type === 'showComparison') {
        const panel = document.getElementById('comparePanel');
        const body = document.getElementById('compareBody');
        if (!panel || !body) return;

        const rows = msg.rows || [];
        if (rows.length < 2) {
          body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--td-text-muted);">Select exactly 2 rows to compare</div>';
        } else {
          const [a, b] = rows;
          const fields = ['id', 'name', 'args', 'expr', 'scope', 'depends'];

          body.innerHTML = \`
            <div class="compare-column">
              <div class="compare-column-title">\${a.id}</div>
              \${fields.map(f => \`
                <div class="compare-field">
                  <div class="compare-field-label">\${f}</div>
                  <div class="compare-field-value \${a[f] !== b[f] ? 'different' : ''}">\${Array.isArray(a[f]) ? a[f].join(', ') : (a[f] || '(empty)')}</div>
                </div>
              \`).join('')}
            </div>
            <div class="compare-column">
              <div class="compare-column-title">\${b.id}</div>
              \${fields.map(f => \`
                <div class="compare-field">
                  <div class="compare-field-label">\${f}</div>
                  <div class="compare-field-value \${a[f] !== b[f] ? 'different' : ''}">\${Array.isArray(b[f]) ? b[f].join(', ') : (b[f] || '(empty)')}</div>
                </div>
              \`).join('')}
            </div>
          \`;
        }
        panel.classList.add('visible');
      }
    });

    // Compare panel close
    const comparePanel = document.getElementById('comparePanel');
    const compareClose = document.getElementById('compareClose');
    if (comparePanel && compareClose) {
      compareClose.addEventListener('click', () => comparePanel.classList.remove('visible'));
      comparePanel.addEventListener('click', (e) => {
        if (e.target === comparePanel) comparePanel.classList.remove('visible');
      });
    }

    // Bulk compare button
    document.getElementById('bulkCompare')?.addEventListener('click', () => {
      const ids = Array.from(selectedRows);
      if (ids.length === 2) {
        vscode.postMessage({ type: 'compareRows', ids });
      } else {
        alert('Please select exactly 2 rows to compare');
      }
    });

    // Notes toggle
    for (const btn of document.querySelectorAll('[data-toggle-notes]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-toggle-notes');
        const section = document.querySelector(\`[data-notes-section="\${id}"]\`);
        if (section) {
          section.style.display = section.style.display === 'none' ? '' : 'none';
          const textarea = section.querySelector('textarea');
          if (textarea && section.style.display !== 'none') {
            textarea.focus();
          }
        }
      });
    }

    // Notes change handler - save notes
    for (const textarea of document.querySelectorAll('[data-notes]')) {
      textarea.addEventListener('change', () => {
        const id = textarea.getAttribute('data-notes');
        const notes = textarea.value;
        if (id) {
          vscode.postMessage({ type: 'updateNotes', id, notes });
        }
      });
    }

    // Timeline search
    const timelineSearch = document.getElementById('timelineSearch');
    if (timelineSearch) {
      timelineSearch.addEventListener('input', () => {
        const query = timelineSearch.value.toLowerCase().trim();
        const items = document.querySelectorAll('.timeline-item');
        items.forEach((item) => {
          if (!query) {
            item.classList.remove('filtered-out');
            return;
          }
          const label = (item.getAttribute('data-step-label') || '').toLowerCase();
          const kind = (item.getAttribute('data-step-kind') || '').toLowerCase();
          if (label.includes(query) || kind.includes(query)) {
            item.classList.remove('filtered-out');
          } else {
            item.classList.add('filtered-out');
          }
        });
      });
    }

    // DAG path highlighting - show full dependency chain on click
    for (const node of document.querySelectorAll('.dag-node')) {
      node.addEventListener('dblclick', () => {
        const id = node.getAttribute('data-node');
        if (!id) return;

        // Clear previous highlighting
        document.querySelectorAll('.dag-node').forEach(n => {
          n.classList.remove('highlighted', 'dimmed');
        });
        document.querySelectorAll('.dag-edge').forEach(e => {
          e.classList.remove('path-highlighted', 'dimmed');
        });

        // Find all connected nodes (upstream and downstream)
        const connectedNodes = new Set([id]);
        const connectedEdges = new Set();

        // Find upstream (dependencies)
        function findUpstream(nodeId) {
          document.querySelectorAll(\`.dag-edge[data-from="\${nodeId}"]\`).forEach(edge => {
            const toId = edge.getAttribute('data-to');
            connectedEdges.add(edge);
            if (!connectedNodes.has(toId)) {
              connectedNodes.add(toId);
              findUpstream(toId);
            }
          });
        }

        // Find downstream (dependents)
        function findDownstream(nodeId) {
          document.querySelectorAll(\`.dag-edge[data-to="\${nodeId}"]\`).forEach(edge => {
            const fromId = edge.getAttribute('data-from');
            connectedEdges.add(edge);
            if (!connectedNodes.has(fromId)) {
              connectedNodes.add(fromId);
              findDownstream(fromId);
            }
          });
        }

        findUpstream(id);
        findDownstream(id);

        // Apply highlighting
        document.querySelectorAll('.dag-node').forEach(n => {
          const nId = n.getAttribute('data-node');
          if (connectedNodes.has(nId)) {
            n.classList.add('highlighted');
          } else {
            n.classList.add('dimmed');
          }
        });
        document.querySelectorAll('.dag-edge').forEach(e => {
          if (connectedEdges.has(e)) {
            e.classList.add('path-highlighted');
          } else {
            e.classList.add('dimmed');
          }
        });
      });
    }

    // Clear DAG highlighting on background click
    document.querySelector('.dag-container')?.addEventListener('click', (e) => {
      if (e.target.classList.contains('dag-container') || e.target.tagName === 'svg') {
        document.querySelectorAll('.dag-node').forEach(n => {
          n.classList.remove('highlighted', 'dimmed');
        });
        document.querySelectorAll('.dag-edge').forEach(e => {
          e.classList.remove('path-highlighted', 'dimmed');
        });
      }
    });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new ConfigPanelProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ConfigPanelProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true } })
  );

  // Status bar widget - shows row count and quick access
  const configStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  configStatusBar.command = 'topdown.openConfigPanel';
  configStatusBar.tooltip = 'Open Top-Down Config Panel (Cmd+Shift+D)';
  context.subscriptions.push(configStatusBar);

  // Update status bar when config changes
  async function updateStatusBar(): Promise<void> {
    try {
      const store = await readStore();
      const rows = store.rows ?? [];
      const lockedCount = rows.filter(r => r.locked).length;
      configStatusBar.text = `$(layers) TD: ${rows.length} rows${lockedCount > 0 ? ` (${lockedCount} locked)` : ''}`;
      configStatusBar.show();
    } catch {
      configStatusBar.text = '$(layers) Top-Down';
      configStatusBar.show();
    }
  }

  // Initial status bar update and watch for config changes
  await updateStatusBar();
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/.topdown/config.json');
  context.subscriptions.push(
    configWatcher,
    configWatcher.onDidChange(updateStatusBar),
    configWatcher.onDidCreate(updateStatusBar),
    configWatcher.onDidDelete(updateStatusBar)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.insertRowId', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Top-Down: No active editor. Open a file first.');
        return;
      }

      const store = await readStore();
      const row = await pickRow(store);
      if (!row) return;

      await editor.edit((b) => {
        const sel = editor.selection;
        if (!sel.isEmpty) b.replace(sel, row.id);
        else b.insert(sel.active, row.id);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.duplicateRowVariant', async () => {
      const store = await readStore();
      const source = await pickRow(store);
      if (!source) return;

      const rows = store.rows ?? [];
      const existingIds = new Set(rows.map((r) => (r.id || '').trim()).filter(Boolean));
      const newId = nextVariantId(source.id, existingIds);

      const variant: ConfigRow = {
        ...source,
        id: newId,
        locked: false,
      };

      store.rows = rows.concat([variant]);
      store.history = store.history ?? [];
      store.history.push({
        ts: Date.now(),
        kind: 'row.variant',
        label: `+ ${newId} (from ${source.id})`,
        rowsSnapshot: store.rows.map(r => ({ ...r })),
      });
      await writeStore(store);
      await provider.render();
    })
  );

  // Autocomplete row IDs when user types `td:` (language-agnostic, low-noise).
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { scheme: 'file' },
      {
        provideCompletionItems: async (document, position) => {
          const prefix = getLinePrefix(document, position).toLowerCase();
          if (!prefix.endsWith('td:')) return undefined;

          const store = await readStore();
          const rows = store.rows ?? [];
          return rows
            .filter((r) => isLikelyRowId(r.id))
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((r) => {
              const it = new vscode.CompletionItem(r.id, vscode.CompletionItemKind.Reference);
              it.insertText = r.id;
              it.detail = r.name ? r.name : 'Top-Down row';
              it.documentation = new vscode.MarkdownString(
                [`**${r.id}**`, r.name ? `name: ${r.name}` : '', r.args ? `args: ${r.args}` : '', r.expr ? `expr: ${r.expr}` : '']
                  .filter(Boolean)
                  .join('\n\n')
              );
              return it;
            });
        },
      },
      ':'
    )
  );

  // Hover row details when hovering an ID token.
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      provideHover: async (document, position) => {
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_.-]{1,64}/);
        if (!range) return undefined;
        const word = document.getText(range);
        if (!isLikelyRowId(word)) return undefined;
        const store = await readStore();
        const row = (store.rows ?? []).find((r) => r.id === word);
        if (!row) return undefined;

        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**Top-Down ${escapeHtml(row.id)}**\n\n`);
        if (row.locked) md.appendMarkdown(`locked: true\n\n`);
        if (row.name) md.appendMarkdown(`name: ${escapeHtml(row.name)}\n\n`);
        if (row.args) md.appendMarkdown(`args: ${escapeHtml(row.args)}\n\n`);
        if (row.expr) md.appendMarkdown(`expr: ${escapeHtml(row.expr)}\n\n`);
        return new vscode.Hover(md, range);
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.openConfigPanel', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.topdownPanel');
      await vscode.commands.executeCommand('topdown.configPanel.focus');
    })
  );

  // Pop-out panel command - creates a detachable WebviewPanel
  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.popOutPanel', async () => {
      await provider.createPopOutPanel();
    })
  );

  // -----------------------------------------------------------------------------------------
  // Diagnostics Integration - Watch for linter/TypeScript errors related to td() calls
  // -----------------------------------------------------------------------------------------

  // Track td() usage locations across the workspace
  const tdUsageMap = new Map<string, Array<{ uri: vscode.Uri; line: number }>>();

  async function scanForTdUsage(): Promise<void> {
    tdUsageMap.clear();
    const root = getWorkspaceRoot();
    if (!root) return;

    const include = '**/*.{ts,tsx,js,jsx,py}';
    const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}';
    const files = await vscode.workspace.findFiles(include, exclude, 200);

    const tdCallPattern = /\btd\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
    const tdMarkerPattern = /@td[:\s]+([a-zA-Z_][a-zA-Z0-9_.-]*)/g;

    for (const uri of files) {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        const lines = text.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          for (const pattern of [tdCallPattern, tdMarkerPattern]) {
            pattern.lastIndex = 0;
            let match;
            while ((match = pattern.exec(line)) !== null) {
              const id = match[1];
              if (!tdUsageMap.has(id)) {
                tdUsageMap.set(id, []);
              }
              tdUsageMap.get(id)!.push({ uri, line: i });
            }
          }
        }
      } catch {
        // ignore read errors
      }
    }
  }

  // Check diagnostics for files containing td() calls
  async function checkDiagnosticsForRows(): Promise<void> {
    const store = await readStore();
    const rows = store.rows ?? [];
    let hasChanges = false;

    for (const row of rows) {
      const usages = tdUsageMap.get(row.id) ?? [];
      let errorMessages: string[] = [];

      for (const usage of usages) {
        const diagnostics = vscode.languages.getDiagnostics(usage.uri);
        const relevantDiags = diagnostics.filter(
          (d) => d.severity === vscode.DiagnosticSeverity.Error &&
                 Math.abs(d.range.start.line - usage.line) <= 2
        );

        for (const diag of relevantDiags) {
          errorMessages.push(`${vscode.workspace.asRelativePath(usage.uri)}:${diag.range.start.line + 1}: ${diag.message}`);
        }
      }

      const newStatus = errorMessages.length > 0 ? 'error' : 'ok';
      const newMessage = errorMessages.slice(0, 3).join('\n');

      if (row.status !== newStatus || row.statusMessage !== newMessage) {
        row.status = newStatus as 'ok' | 'warning' | 'error';
        row.statusMessage = newMessage;
        hasChanges = true;
      }
    }

    if (hasChanges) {
      await writeStore(store);
      await provider.render();
    }
  }

  // Initial scan on activation
  setTimeout(async () => {
    await scanForTdUsage();
    await checkDiagnosticsForRows();
  }, 3000);

  // Re-scan when diagnostics change
  let diagnosticsDebounce: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => {
      if (diagnosticsDebounce) clearTimeout(diagnosticsDebounce);
      diagnosticsDebounce = setTimeout(async () => {
        await checkDiagnosticsForRows();
      }, 1000);
    })
  );

  // Re-scan when files are saved
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      // Only re-scan if it's a code file
      if (/\.(ts|tsx|js|jsx|py)$/.test(doc.fileName)) {
        await scanForTdUsage();
        await checkDiagnosticsForRows();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.timeline.clear', async () => {
      const store = await readStore();
      store.playheadIndex = (store.history?.length ?? 0) - 1;
      await writeStore(store);
      await provider.render();
    }),
    vscode.commands.registerCommand('topdown.timeline.prev', async () => {
      const store = await readStore();
      const total = store.history?.length ?? 0;
      const cur = typeof store.playheadIndex === 'number' ? store.playheadIndex : total - 1;
      store.playheadIndex = Math.max(-1, cur - 1);
      await writeStore(store);
      await provider.render();
    }),
    vscode.commands.registerCommand('topdown.timeline.next', async () => {
      const store = await readStore();
      const total = store.history?.length ?? 0;
      const cur = typeof store.playheadIndex === 'number' ? store.playheadIndex : total - 1;
      store.playheadIndex = Math.min(total - 1, cur + 1);
      await writeStore(store);
      await provider.render();
    }),
    vscode.commands.registerCommand('topdown.timeline.pick', async () => {
      const store = await readStore();
      const history = store.history ?? [];
      if (history.length === 0) {
        vscode.window.showInformationMessage('No timeline steps yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        history.map((h, idx) => ({ label: h.label, description: h.kind, idx })),
        { title: 'Top-Down: Jump to step' }
      );
      if (!picked) return;
      store.playheadIndex = picked.idx;
      await writeStore(store);
      await provider.render();
    })
  );

  // -----------------------------------------------------------------------------------------
  // Promote to Configurable - Turn any symbol into a config row
  // -----------------------------------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.promoteToConfigurable', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Top-Down: No active editor.');
        return;
      }

      const doc = editor.document;
      const selection = editor.selection;
      let symbolName = '';
      let symbolKind = 'Symbol';
      let symbolLine = selection.start.line;

      // Try to get symbol at cursor using language server
      if (selection.isEmpty) {
        // Get symbol at cursor position
        const symbols = await getSymbolsFromDocument(doc);
        const flatSymbols = flattenSymbols(symbols);

        // Find the most specific symbol containing the cursor
        const cursorLine = selection.active.line;
        const matchingSymbols = flatSymbols
          .filter(s => s.range.start.line <= cursorLine && s.range.end.line >= cursorLine)
          .sort((a, b) => {
            // Prefer more specific (smaller range) symbols
            const aSize = a.range.end.line - a.range.start.line;
            const bSize = b.range.end.line - b.range.start.line;
            return aSize - bSize;
          });

        if (matchingSymbols.length > 0) {
          const sym = matchingSymbols[0];
          symbolName = sym.name;
          symbolKind = vscode.SymbolKind[sym.kind] ?? 'Symbol';
          symbolLine = sym.range.start.line;
        } else {
          // Fall back to word at cursor
          const wordRange = doc.getWordRangeAtPosition(selection.active);
          if (wordRange) {
            symbolName = doc.getText(wordRange);
          }
        }
      } else {
        // Use selected text
        symbolName = doc.getText(selection).trim();
      }

      if (!symbolName) {
        vscode.window.showErrorMessage('Top-Down: No symbol found. Select a function/class name or position cursor on one, then try again.');
        return;
      }

      // Clean up the symbol name for use as ID
      let id = symbolName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
      if (!id || id.length < 2) {
        id = symbolName.slice(0, 20).replace(/[^a-zA-Z0-9_-]/g, '_') || 'config';
      }

      // Make unique if already exists
      const store = await readStore();
      const existingIds = new Set((store.rows ?? []).map(r => r.id));
      let finalId = id;
      if (existingIds.has(finalId)) {
        let n = 2;
        while (existingIds.has(`${id}_${n}`)) n++;
        finalId = `${id}_${n}`;
      }

      // Ask user what they want to do
      const action = await vscode.window.showQuickPick(
        [
          { label: 'Add to config only', description: 'Just add a row to the config table', action: 'config-only' },
          { label: 'Add to config + insert marker', description: 'Add row and insert @td: marker above', action: 'config-and-marker' },
          { label: 'Add to config + insert td() call', description: 'Add row and wrap with td() call', action: 'config-and-call' },
        ],
        { title: `Promote "${symbolName}" to configurable` }
      );

      if (!action) return;

      // Get scope (file:line)
      const relativePath = vscode.workspace.asRelativePath(doc.uri);
      const scope = `${relativePath}:${symbolLine + 1}`;

      // Create the new row
      const newRow: ConfigRow = {
        id: finalId,
        locked: false,
        name: `${symbolKind}: ${symbolName}`,
        args: '',
        expr: '',
        scope,
      };

      store.rows = store.rows ?? [];
      store.rows.push(newRow);
      store.history = store.history ?? [];
      store.history.push({
        ts: Date.now(),
        kind: 'row.promote',
        label: `Promoted ${finalId} from ${relativePath}`,
        rowsSnapshot: store.rows.map(r => ({ ...r })),
      });

      await writeStore(store);
      await provider.render();

      // Optionally insert marker or td() call
      if (action.action === 'config-and-marker') {
        const marker = getMarkerForLanguage(doc.languageId);
        const lineText = doc.lineAt(symbolLine).text;
        const indent = lineText.match(/^[\t ]*/)?.[0] || '';
        const markerLine = `${indent}${marker.prefix}${finalId}${marker.suffix}\n`;

        await editor.edit(editBuilder => {
          editBuilder.insert(new vscode.Position(symbolLine, 0), markerLine);
        });
      } else if (action.action === 'config-and-call') {
        // Insert td() call - wrap selected text or insert at cursor
        if (!selection.isEmpty) {
          await editor.edit(editBuilder => {
            editBuilder.replace(selection, `td("${finalId}")`);
          });
        } else {
          await editor.edit(editBuilder => {
            editBuilder.insert(selection.active, `td("${finalId}")`);
          });
        }
      }

      vscode.window.showInformationMessage(`Top-Down: Promoted "${finalId}" to configurable.`);

      // Refresh diagnostics
      await scanForTdUsage();
      await checkDiagnosticsForRows();
    })
  );

  // -----------------------------------------------------------------------------------------
  // Smart Symbol Detection & Auto-Ingest
  // -----------------------------------------------------------------------------------------

  // Status bar item to show ingest progress
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(sync~spin) Top-Down: Scanning...';
  context.subscriptions.push(statusBarItem);

  // Create backup of files before modifying
  async function createBackup(root: vscode.Uri, files: vscode.Uri[]): Promise<string | null> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const backupDir = vscode.Uri.joinPath(root, '.topdown', 'backups', timestamp);
    
    try {
      await vscode.workspace.fs.createDirectory(backupDir);
      
      for (const file of files) {
        const relativePath = file.fsPath.replace(root.fsPath, '').replace(/^[\/\\]/, '');
        const backupPath = vscode.Uri.joinPath(backupDir, relativePath);
        const parentDir = vscode.Uri.joinPath(backupDir, relativePath.split(/[\/\\]/).slice(0, -1).join('/'));
        
        try { await vscode.workspace.fs.createDirectory(parentDir); } catch { /* ignore */ }
        
        const content = await vscode.workspace.fs.readFile(file);
        await vscode.workspace.fs.writeFile(backupPath, content);
      }
      
      return timestamp;
    } catch (err) {
      console.error('Top-Down: Backup failed:', err);
      return null;
    }
  }

  // Clean up old backups
  async function cleanupOldBackups(root: vscode.Uri, maxBackups: number): Promise<void> {
    const backupsDir = vscode.Uri.joinPath(root, '.topdown', 'backups');
    try {
      const entries = await vscode.workspace.fs.readDirectory(backupsDir);
      const dirs = entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name).sort().reverse();
      for (let i = maxBackups; i < dirs.length; i++) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(backupsDir, dirs[i]), { recursive: true });
      }
    } catch { /* ignore */ }
  }

  // Get marker style based on language
  function getMarkerForLanguage(langId: string): { prefix: string; suffix: string } {
    const pyStyle = ['python', 'ruby', 'shellscript', 'bash', 'r', 'julia', 'perl', 'yaml', 'toml', 'dockerfile'];
    const cStyle = ['c', 'sql', 'css'];
    
    if (pyStyle.includes(langId)) return { prefix: '# @td:', suffix: '' };
    if (cStyle.includes(langId)) return { prefix: '/* @td:', suffix: ' */' };
    return { prefix: '// @td:', suffix: '' };
  }

  // Use VS Code's document symbols API (powered by language servers/linters)
  async function getSymbolsFromDocument(doc: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri
      );
      return symbols ?? [];
    } catch {
      return [];
    }
  }

  // Flatten nested symbols
  function flattenSymbols(symbols: vscode.DocumentSymbol[], depth = 0): Array<vscode.DocumentSymbol & { depth: number }> {
    const result: Array<vscode.DocumentSymbol & { depth: number }> = [];
    for (const sym of symbols) {
      result.push({ ...sym, depth });
      if (sym.children?.length) {
        result.push(...flattenSymbols(sym.children, depth + 1));
      }
    }
    return result;
  }

  // Check if a symbol should be tracked
  function shouldTrackSymbol(sym: vscode.DocumentSymbol): boolean {
    const trackableKinds = [
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Interface,
      vscode.SymbolKind.Constructor,
      vscode.SymbolKind.Module,
      vscode.SymbolKind.Namespace,
    ];
    
    if (!trackableKinds.includes(sym.kind)) return false;
    
    // Skip common names we don't want to track
    const skipNames = ['constructor', '__init__', 'toString', 'valueOf', 'setup', 'teardown', 'main', 'init'];
    if (skipNames.includes(sym.name.toLowerCase())) return false;
    
    // Skip private/dunder methods in Python
    if (sym.name.startsWith('__') && sym.name.endsWith('__')) return false;
    
    // Skip very short names
    if (sym.name.length < 2) return false;
    
    return true;
  }

  // Check if line already has a marker
  function lineHasMarker(text: string): boolean {
    return text.includes('@td:') || /\btd\s*\(/.test(text);
  }

  // Inject markers using document symbols from language server
  async function injectMarkersIntoDocument(doc: vscode.TextDocument, existingIds: Set<string>): Promise<{ injected: string[]; edits: vscode.TextEdit[] }> {
    const symbols = await getSymbolsFromDocument(doc);
    const flatSymbols = flattenSymbols(symbols);
    const edits: vscode.TextEdit[] = [];
    const injected: string[] = [];
    const marker = getMarkerForLanguage(doc.languageId);
    
    // Process symbols from bottom to top to maintain line numbers
    const sortedSymbols = flatSymbols
      .filter(shouldTrackSymbol)
      .sort((a, b) => b.range.start.line - a.range.start.line);
    
    for (const sym of sortedSymbols) {
      const lineNum = sym.range.start.line;
      const lineText = doc.lineAt(lineNum).text;
      const prevLineText = lineNum > 0 ? doc.lineAt(lineNum - 1).text : '';
      
      // Skip if already has marker
      if (lineHasMarker(lineText) || lineHasMarker(prevLineText)) continue;
      
      // Generate ID from symbol name
      let id = sym.name;
      
      // Make unique if already exists
      if (existingIds.has(id)) {
        let n = 2;
        while (existingIds.has(`${sym.name}_${n}`)) n++;
        id = `${sym.name}_${n}`;
      }
      
      // Create the marker line
      const indent = lineText.match(/^[\t ]*/)?.[0] || '';
      const markerLine = `${indent}${marker.prefix}${id}${marker.suffix}\n`;
      
      // Insert before the symbol
      const insertPos = new vscode.Position(lineNum, 0);
      edits.push(vscode.TextEdit.insert(insertPos, markerLine));
      
      injected.push(id);
      existingIds.add(id);
    }
    
    return { injected, edits };
  }

  // Main ingest function
  async function ingestWorkspace(showProgress = true): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) {
      if (showProgress) vscode.window.showErrorMessage('Top-Down: No workspace folder open. Open a folder with File > Open Folder.');
      return;
    }

    if (showProgress) {
      statusBarItem.text = '$(sync~spin) Top-Down: Scanning workspace...';
      statusBarItem.show();
    }

    // Find files to scan
    const include = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,pyw,go,rs,java,kt,kts,c,cpp,cc,h,hpp,cs,rb,php,swift,lua,sh,bash}';
    const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/.venv-*/**,**/venv/**,**/vendor/**,**/target/**,**/__pycache__/**,**/site-packages/**}';
    
    const files = await vscode.workspace.findFiles(include, exclude, 500);
    
    if (files.length === 0) {
      if (showProgress) {
        statusBarItem.hide();
        vscode.window.showInformationMessage('Top-Down: No code files found to ingest.');
      }
      return;
    }

    if (showProgress) {
      statusBarItem.text = `$(sync~spin) Top-Down: Creating backup...`;
    }

    // Create backup first
    const backupTimestamp = await createBackup(root, files);
    if (backupTimestamp) {
      await cleanupOldBackups(root, 5);
      if (showProgress) {
        vscode.window.showInformationMessage(`Top-Down: Backup created at .topdown/backups/${backupTimestamp}`);
      }
    }

    // Get existing IDs
    const store = await readStore();
    const existingIds = new Set((store.rows ?? []).map((r) => r.id));
    
    let totalInjected = 0;
    const allInjectedIds: string[] = [];
    let filesProcessed = 0;

    for (const uri of files) {
      filesProcessed++;
      if (showProgress && filesProcessed % 10 === 0) {
        statusBarItem.text = `$(sync~spin) Top-Down: Processing ${filesProcessed}/${files.length}...`;
      }

      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const { injected, edits } = await injectMarkersIntoDocument(doc, existingIds);
        
        if (edits.length > 0) {
          const edit = new vscode.WorkspaceEdit();
          edit.set(uri, edits);
          await vscode.workspace.applyEdit(edit);
          await doc.save();
          
          totalInjected += injected.length;
          allInjectedIds.push(...injected);
        }
      } catch (err) {
        console.error(`Top-Down: Error processing ${uri.fsPath}:`, err);
      }
    }

    // Add new rows to the store
    if (allInjectedIds.length > 0) {
      const newRows: ConfigRow[] = allInjectedIds.map(id => ({
        id,
        locked: false,
        name: '',
        args: '',
        expr: ''
      }));
      store.rows = (store.rows ?? []).concat(newRows);
      store.history = store.history ?? [];
      store.history.push({
        ts: Date.now(),
        kind: 'auto.ingest',
        label: `Injected ${totalInjected} markers`,
        rowsSnapshot: store.rows.map(r => ({ ...r })),
      });
      await writeStore(store);
      await provider.render();
    }

    if (showProgress) {
      statusBarItem.hide();
      if (totalInjected > 0) {
        vscode.window.showInformationMessage(`Top-Down: Injected ${totalInjected} markers into ${filesProcessed} files. Check .topdown/backups/ to restore.`);
      } else {
        vscode.window.showInformationMessage(`Top-Down: Scanned ${filesProcessed} files. No new symbols found to mark.`);
      }
    }
  }

  // Register ingest command
  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.ingestWorkspace', async () => {
      const result = await vscode.window.showWarningMessage(
        'Top-Down: This will inject @td markers into your code at function/class definitions. A backup will be created first. Continue?',
        'Yes, Inject Markers',
        'Cancel'
      );
      if (result !== 'Yes, Inject Markers') return;
      await ingestWorkspace(true);
    })
  );

  // Register restore backup command
  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.restoreBackup', async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        vscode.window.showErrorMessage('Top-Down: No workspace folder open. Open a folder with File > Open Folder.');
        return;
      }

      const backupsDir = vscode.Uri.joinPath(root, '.topdown', 'backups');
      
      try {
        const entries = await vscode.workspace.fs.readDirectory(backupsDir);
        const backups = entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name).sort().reverse();

        if (backups.length === 0) {
          vscode.window.showInformationMessage('Top-Down: No backups found.');
          return;
        }

        const picked = await vscode.window.showQuickPick(
          backups.map(b => ({ label: b, description: 'Backup timestamp' })),
          { title: 'Top-Down: Select backup to restore' }
        );
        if (!picked) return;

        const confirm = await vscode.window.showWarningMessage(
          `Top-Down: Restore backup from ${picked.label}? This will overwrite current files.`,
          'Yes, Restore',
          'Cancel'
        );
        if (confirm !== 'Yes, Restore') return;

        const backupDir = vscode.Uri.joinPath(backupsDir, picked.label);
        
        async function restoreDir(sourceDir: vscode.Uri, targetDir: vscode.Uri): Promise<number> {
          let restored = 0;
          const items = await vscode.workspace.fs.readDirectory(sourceDir);
          for (const [name, type] of items) {
            const sourceUri = vscode.Uri.joinPath(sourceDir, name);
            const targetUri = vscode.Uri.joinPath(targetDir, name);
            if (type === vscode.FileType.Directory) {
              restored += await restoreDir(sourceUri, targetUri);
            } else {
              const content = await vscode.workspace.fs.readFile(sourceUri);
              await vscode.workspace.fs.writeFile(targetUri, content);
              restored++;
            }
          }
          return restored;
        }

        const restoredCount = await restoreDir(backupDir, root);
        vscode.window.showInformationMessage(`Top-Down: Restored ${restoredCount} files from backup.`);
        
      } catch (err) {
        vscode.window.showErrorMessage(`Top-Down: Failed to restore backup: ${err}`);
      }
    })
  );

  // -----------------------------------------------------------------------------------------
  // Codegen: generate shippable defs (no runtime config read)
  // -----------------------------------------------------------------------------------------

  async function generateShippableDefs(): Promise<void> {
    const root = getWorkspaceRoot();
    if (!root) {
      vscode.window.showErrorMessage('Top-Down: No workspace folder open. Open a folder with File > Open Folder.');
      return;
    }

    const store = await readStore();
    const rows = (store.rows ?? [])
      .filter((r) => r && typeof r.id === 'string' && isLikelyRowId(r.id))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({
        id: String(r.id),
        locked: !!r.locked,
        name: String(r.name ?? ''),
        args: String(r.args ?? ''),
        expr: String(r.expr ?? ''),
        scope: typeof r.scope === 'string' ? r.scope : undefined,
      }));

    const outDir = vscode.Uri.joinPath(root, '.topdown', 'generated');
    await vscode.workspace.fs.createDirectory(outDir);

    const rowsJson = JSON.stringify(rows, null, 2);

    const tsText =
      `// Generated by Top-Down (do not edit by hand)\n` +
      `export type TopDownRow = {\n` +
      `  id: string;\n` +
      `  locked: boolean;\n` +
      `  name: string;\n` +
      `  args: string;\n` +
      `  expr: string;\n` +
      `  scope?: string;\n` +
      `};\n\n` +
      `export const TOPDOWN_ROWS: TopDownRow[] = ${rowsJson} as any;\n\n` +
      `export const TOPDOWN_BY_ID = new Map<string, TopDownRow>(TOPDOWN_ROWS.map((r) => [r.id, r]));\n\n` +
      `export function td(id: string): TopDownRow {\n` +
      `  const row = TOPDOWN_BY_ID.get(id);\n` +
      `  if (!row) throw new Error(\`Top-Down id not found: \${id}\`);\n` +
      `  return row;\n` +
      `}\n`;

    const jsText =
      `// Generated by Top-Down (do not edit by hand)\n` +
      `const TOPDOWN_ROWS = ${rowsJson};\n` +
      `const TOPDOWN_BY_ID = new Map(TOPDOWN_ROWS.map((r) => [r.id, r]));\n` +
      `function td(id) {\n` +
      `  const row = TOPDOWN_BY_ID.get(id);\n` +
      `  if (!row) throw new Error('Top-Down id not found: ' + id);\n` +
      `  return row;\n` +
      `}\n` +
      `module.exports = { TOPDOWN_ROWS, TOPDOWN_BY_ID, td };\n`;

    const jsonText = rowsJson + '\n';

    const tsUri = vscode.Uri.joinPath(outDir, 'topdown_defs.ts');
    const jsUri = vscode.Uri.joinPath(outDir, 'topdown_defs.js');
    const jsonUri = vscode.Uri.joinPath(outDir, 'topdown_rows.json');

    await vscode.workspace.fs.writeFile(tsUri, Buffer.from(tsText, 'utf8'));
    await vscode.workspace.fs.writeFile(jsUri, Buffer.from(jsText, 'utf8'));
    await vscode.workspace.fs.writeFile(jsonUri, Buffer.from(jsonText, 'utf8'));

    vscode.window.showInformationMessage(`Top-Down: Generated shippable defs in ${outDir.fsPath}`);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.generateShippableDefs', async () => {
      await generateShippableDefs();
    })
  );

  const output = vscode.window.createOutputChannel('Top-Down');
  context.subscriptions.push(output);

  function log(msg: string): void {
    output.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }

  // -----------------------------------------------------------------------------------------
  // Automatic Initial Scan - Build config table on first workspace open
  // -----------------------------------------------------------------------------------------

  async function autoInitializeWorkspace(root: vscode.Uri): Promise<void> {
    const key = `topdown.initialized:${root.fsPath}`;
    const alreadyInitialized = context.workspaceState.get<boolean>(key, false);
    if (alreadyInitialized) {
      log(`Workspace already initialized: ${root.fsPath}`);
      return;
    }

    // Check if config already exists
    const configUri = vscode.Uri.joinPath(root, STORE_RELATIVE);
    try {
      await vscode.workspace.fs.stat(configUri);
      log(`Found existing config at ${configUri.fsPath}; skipping auto-init.`);
      await context.workspaceState.update(key, true);
      return;
    } catch {
      // No config - proceed with auto-initialization
    }

    log(`Starting automatic initialization for ${root.fsPath}`);

    // Show progress notification
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Top-Down: Initializing workspace...',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Discovering code symbols...', increment: 0 });

        // Find all code files
        const include = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,pyw,go,rs,java,kt,kts,c,cpp,cc,h,hpp,cs,rb,php,swift,lua,sh,bash}';
        const exclude = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/.venv-*/**,**/venv/**,**/vendor/**,**/target/**,**/__pycache__/**,**/site-packages/**}';
        const files = await vscode.workspace.findFiles(include, exclude, 300);

        if (files.length === 0) {
          log('No code files found');
          await context.workspaceState.update(key, true);
          return;
        }

        progress.report({ message: `Scanning ${files.length} files...`, increment: 10 });

        const discoveredRows: ConfigRow[] = [];
        const seenIds = new Set<string>();
        let filesProcessed = 0;

        // Process files and extract symbols using language server
        for (const uri of files) {
          filesProcessed++;
          if (filesProcessed % 20 === 0) {
            progress.report({
              message: `Analyzing symbols... (${filesProcessed}/${files.length})`,
              increment: (filesProcessed / files.length) * 70,
            });
          }

          try {
            const doc = await vscode.workspace.openTextDocument(uri);

            // Get symbols from language server (autocomplete/linter data)
            const symbols = await getSymbolsFromDocument(doc);
            const flatSymbols = flattenSymbols(symbols);

            // Filter to trackable symbols (functions, classes, methods, etc.)
            const trackable = flatSymbols.filter(shouldTrackSymbol);

            for (const sym of trackable) {
              let id = sym.name;

              // Make unique if already seen
              if (seenIds.has(id)) {
                let n = 2;
                while (seenIds.has(`${sym.name}_${n}`)) n++;
                id = `${sym.name}_${n}`;
              }
              seenIds.add(id);

              // Get symbol kind as readable string
              const kindName = vscode.SymbolKind[sym.kind] ?? 'Symbol';

              // Get relative file path for scope
              const relativePath = vscode.workspace.asRelativePath(uri);
              const scope = `${relativePath}:${sym.range.start.line + 1}`;

              discoveredRows.push({
                id,
                locked: false,
                name: `${kindName}: ${sym.name}`,
                args: '',
                expr: '',
                scope,
              });
            }
          } catch (err) {
            // Skip files that can't be processed
            log(`Error processing ${uri.fsPath}: ${err}`);
          }
        }

        progress.report({ message: 'Building config table...', increment: 90 });

        if (discoveredRows.length > 0) {
          // Sort rows by ID for consistent ordering
          discoveredRows.sort((a, b) => a.id.localeCompare(b.id));

          // Create initial store with discovered rows
          const store: ConfigStoreV1 = {
            version: 1,
            rows: discoveredRows,
            playheadIndex: 0,
            history: [
              {
                ts: Date.now(),
                kind: 'init.scan',
                label: `Initial scan: discovered ${discoveredRows.length} symbols`,
              },
            ],
          };

          await writeStore(store);
          await provider.render();

          log(`Auto-init complete: discovered ${discoveredRows.length} symbols from ${filesProcessed} files`);

          // Show completion message with action to open panel
          const action = await vscode.window.showInformationMessage(
            `Top-Down: Discovered ${discoveredRows.length} symbols. Your config table is ready!`,
            'Open Config Panel'
          );

          if (action === 'Open Config Panel') {
            await vscode.commands.executeCommand('topdown.openConfigPanel');
          }
        } else {
          // Create empty store
          const store: ConfigStoreV1 = {
            version: 1,
            rows: [],
            history: [
              {
                ts: Date.now(),
                kind: 'init.empty',
                label: 'Workspace initialized (no symbols found)',
              },
            ],
          };
          await writeStore(store);
          await provider.render();

          log('Auto-init complete: no symbols found');
          vscode.window.showInformationMessage(
            'Top-Down: Workspace initialized. Add rows manually or run "Ingest Workspace" to inject markers.'
          );
        }

        // Kick off diagnostics scan
        await scanForTdUsage();
        await checkDiagnosticsForRows();

        progress.report({ message: 'Done!', increment: 100 });
      }
    );

    await context.workspaceState.update(key, true);
  }

  // Also provide a command to re-scan and rebuild the config
  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.rescanWorkspace', async () => {
      const root = getWorkspaceRoot();
      if (!root) {
        vscode.window.showErrorMessage('Top-Down: No workspace folder open. Open a folder with File > Open Folder.');
        return;
      }

      // Clear the initialized flag to allow re-scan
      const key = `topdown.initialized:${root.fsPath}`;
      await context.workspaceState.update(key, false);

      // Confirm with user since this will rebuild the config
      const confirm = await vscode.window.showWarningMessage(
        'Top-Down: This will re-scan the workspace and merge newly discovered symbols. Continue?',
        'Yes, Re-scan',
        'Cancel'
      );

      if (confirm !== 'Yes, Re-scan') return;

      await autoInitializeWorkspace(root);
    })
  );

  // Auto-initialize on startup (with delay to let language servers warm up)
  setTimeout(async () => {
    const root = getWorkspaceRoot();
    if (!root) {
      log('No workspace root on startup (yet).');
      return;
    }
    log('Starting auto-initialization...');
    await autoInitializeWorkspace(root);
  }, 2500);  // Delay to allow language servers to start

  // Also react when a folder is added (multi-root workspaces)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async (e) => {
      for (const f of e.added) {
        log(`Workspace folder added: ${f.uri.fsPath}`);
        // Small delay for language server to recognize new folder
        setTimeout(() => autoInitializeWorkspace(f.uri), 1500);
      }
    })
  );

  // -----------------------------------------------------------------------------------------
  // Source File Watching - Detect file changes and map to affected rows
  // -----------------------------------------------------------------------------------------

  // Track which files map to which row IDs
  const fileToRowsMap = new Map<string, Set<string>>();
  const changedRowIds = new Set<string>();
  let fileWatchDebounce: NodeJS.Timeout | undefined;

  async function rebuildFileMapping(): Promise<void> {
    fileToRowsMap.clear();
    const store = await readStore();
    const rows = store.rows ?? [];
    const root = getWorkspaceRoot();
    if (!root) return;

    for (const row of rows) {
      const sources = row.sources ?? [];
      for (const pattern of sources) {
        // Expand glob patterns
        const globPattern = new vscode.RelativePattern(root, pattern);
        const files = await vscode.workspace.findFiles(globPattern, '**/node_modules/**', 500);
        for (const file of files) {
          const key = file.fsPath;
          if (!fileToRowsMap.has(key)) {
            fileToRowsMap.set(key, new Set());
          }
          fileToRowsMap.get(key)!.add(row.id);
        }
      }
    }
    log(`File mapping rebuilt: ${fileToRowsMap.size} files tracked`);
  }

  function findAffectedRows(changedFile: string): string[] {
    const directlyAffected = fileToRowsMap.get(changedFile) ?? new Set();
    if (directlyAffected.size === 0) return [];

    // Include downstream dependents
    const allAffected = new Set(directlyAffected);
    return Array.from(allAffected);
  }

  async function handleFileChange(uri: vscode.Uri): Promise<void> {
    const affectedRows = findAffectedRows(uri.fsPath);
    if (affectedRows.length === 0) return;

    for (const rowId of affectedRows) {
      changedRowIds.add(rowId);
    }

    // Debounce to batch rapid changes
    if (fileWatchDebounce) clearTimeout(fileWatchDebounce);
    fileWatchDebounce = setTimeout(async () => {
      if (changedRowIds.size > 0) {
        log(`Source files changed, affected rows: ${Array.from(changedRowIds).join(', ')}`);
        // Notify the panel about changed rows
        provider.notifySourceChange(Array.from(changedRowIds));
        changedRowIds.clear();
      }
    }, 500);
  }

  // Watch all common source files
  const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{c,h,cpp,hpp,py,ts,tsx,js,jsx,go,rs,java}');
  context.subscriptions.push(
    sourceWatcher,
    sourceWatcher.onDidChange(handleFileChange),
    sourceWatcher.onDidCreate(async (uri) => {
      await rebuildFileMapping();
      await handleFileChange(uri);
    }),
    sourceWatcher.onDidDelete(async () => {
      await rebuildFileMapping();
    })
  );

  // Initial file mapping build (delayed to allow workspace to settle)
  setTimeout(rebuildFileMapping, 3000);
}

export function deactivate(): void {
  // no-op
}
