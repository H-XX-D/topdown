import * as vscode from 'vscode';

type ConfigRow = {
  id: string;
  locked: boolean;
  name: string;
  args: string;
  expr: string;
  scope?: string;
};

type ConfigStoreV1 = {
  version: 1;
  rows: ConfigRow[];
  playheadIndex?: number;
  history?: Array<{ ts: number; kind: string; label: string }>;
};

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

  const text = JSON.stringify(store, null, 2) + '\n';
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
}

function isLikelyRowId(s: string): boolean {
  const t = (s || '').trim();
  if (!t) return false;
  // Keep this permissive; IDs are user-defined (e.g. func12).
  return /^[A-Za-z_][A-Za-z0-9_-]{1,64}$/.test(t);
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

function getLinePrefix(document: vscode.TextDocument, position: vscode.Position, maxChars = 64): string {
  const line = document.lineAt(position.line).text;
  const upto = line.slice(0, position.character);
  return upto.length > maxChars ? upto.slice(upto.length - maxChars) : upto;
}

class ConfigPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'topdown.configPanel';

  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: unknown };

      if (m.type === 'saveRows') {
        const payload = msg as { rows?: unknown };
        if (!Array.isArray(payload.rows)) return;
        const rows: ConfigRow[] = [];
        for (const r of payload.rows) {
          if (!r || typeof r !== 'object') continue;
          const o = r as any;
          if (typeof o.id !== 'string' || !o.id.trim()) continue;
          rows.push({
            id: o.id.trim(),
            locked: !!o.locked,
            name: typeof o.name === 'string' ? o.name : '',
            args: typeof o.args === 'string' ? o.args : '',
            expr: typeof o.expr === 'string' ? o.expr : '',
            scope: typeof o.scope === 'string' ? o.scope : undefined,
          });
        }
        const store = await readStore();
        store.rows = rows;
        store.history = store.history ?? [];
        store.history.push({ ts: Date.now(), kind: 'table.save', label: `Saved ${rows.length} row(s)` });
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
        store.history.push({ ts: Date.now(), kind: 'row.add', label: `+ ${id}` });
        await writeStore(store);
        await this.render();
      }
    });

    await this.render();
  }

  async render(): Promise<void> {
    if (!this.view) return;
    const webview = this.view.webview;
    const store = await readStore();

    const nonce = String(Math.random()).slice(2);

    const rows = (store.rows ?? []).map((r) => ({
      id: escapeHtml(r.id),
      locked: !!r.locked,
      name: escapeHtml(r.name ?? ''),
      args: escapeHtml(r.args ?? ''),
      expr: escapeHtml(r.expr ?? ''),
      scope: escapeHtml(r.scope ?? ''),
    }));

    webview.html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Top-Down Config</title>
  <style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
    .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 6px 10px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }

    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    th { text-align: left; }

    input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 6px; }

    .lockCol { width: 64px; }
    .idCol { width: 140px; }
    .exprCol { width: 40%; }

    details > summary { cursor: pointer; user-select: none; }
    details > summary { list-style: none; }
    details > summary::-webkit-details-marker { display: none; }

    .hint { margin-top: 8px; opacity: 0.8; }
  </style>
</head>
<body>
  <div class="bar">
    <button id="add">+ Row</button>
    <button id="save">Save</button>
  </div>

  <table>
    <thead>
      <tr>
        <th class="lockCol">Lock</th>
        <th class="idCol">ID</th>
        <th>Name</th>
        <th>Args</th>
        <th class="exprCol">Expression</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(
          (r) => `
        <tr data-row="${r.id}">
          <td style="text-align:center"><input type="checkbox" data-lock="${r.id}" ${r.locked ? 'checked' : ''} /></td>
          <td><input data-id value="${r.id}" /></td>
          <td><input data-name value="${r.name}" ${r.locked ? 'disabled' : ''} /></td>
          <td><input data-args value="${r.args}" ${r.locked ? 'disabled' : ''} /></td>
          <td>
            <details>
              <summary>expr</summary>
              <div style="margin-top:6px"><input data-expr value="${r.expr}" ${r.locked ? 'disabled' : ''} /></div>
            </details>
          </td>
        </tr>`
        )
        .join('')}
    </tbody>
  </table>

  <div class="hint">This panel is the source of truth. Locked rows are not editable from the table.</div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('add').addEventListener('click', () => {
      vscode.postMessage({ type: 'addRow' });
    });

    document.getElementById('save').addEventListener('click', () => {
      const trs = Array.from(document.querySelectorAll('tbody tr'));
      const rows = trs.map((tr) => {
        const lock = tr.querySelector('input[data-lock]');
        const id = tr.querySelector('input[data-id]');
        const name = tr.querySelector('input[data-name]');
        const args = tr.querySelector('input[data-args]');
        const expr = tr.querySelector('input[data-expr]');
        return {
          locked: !!(lock && lock.checked),
          id: id ? id.value : '',
          name: name ? name.value : '',
          args: args ? args.value : '',
          expr: expr ? expr.value : ''
        };
      });
      vscode.postMessage({ type: 'saveRows', rows });
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

class TimelineStatusBar {
  private readonly left: vscode.StatusBarItem;
  private readonly main: vscode.StatusBarItem;
  private readonly right: vscode.StatusBarItem;
  private readonly clear: vscode.StatusBarItem;

  private steps: Array<{ label: string; kind: string }> = [];
  private playhead: number = -1;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.left = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    this.main = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.right = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.clear = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);

    this.left.command = 'topdown.timeline.prev';
    this.right.command = 'topdown.timeline.next';
    this.main.command = 'topdown.timeline.pick';
    this.clear.command = 'topdown.timeline.clear';

    this.left.text = '$(chevron-left)';
    this.right.text = '$(chevron-right)';
    this.clear.text = '$(close)';

    this.left.tooltip = 'Top-Down: Previous step';
    this.right.tooltip = 'Top-Down: Next step';
    this.main.tooltip = 'Top-Down: Jump to step';
    this.clear.tooltip = 'Top-Down: Clear playhead';

    this.left.show();
    this.main.show();
    this.right.show();
    this.clear.show();
  }

  async refreshFromStore(): Promise<void> {
    const store = await readStore();
    const history = store.history ?? [];
    this.steps = history.map((h) => ({ label: h.label, kind: h.kind }));
    this.playhead = typeof store.playheadIndex === 'number' ? store.playheadIndex : this.steps.length - 1;
    this.render();
  }

  private render(): void {
    const total = this.steps.length;
    const ph = Math.max(-1, Math.min(this.playhead, total - 1));
    const filled = ph >= 0 ? ph + 1 : 0;

    const barLen = 10;
    const filledBars = total === 0 ? 0 : Math.min(barLen, Math.round((filled / Math.max(1, total)) * barLen));
    const emptyBars = Math.max(0, barLen - filledBars);

    const bar = '▮'.repeat(filledBars) + '▯'.repeat(emptyBars);
    this.main.text = `Top-Down ${bar} ${filled}/${total}`;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new ConfigPanelProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ConfigPanelProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true } })
  );

  const timeline = new TimelineStatusBar(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.insertRowId', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor.');
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
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_-]{1,64}/);
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

  context.subscriptions.push(
    vscode.commands.registerCommand('topdown.timeline.clear', async () => {
      const store = await readStore();
      store.playheadIndex = (store.history?.length ?? 0) - 1;
      await writeStore(store);
      await timeline.refreshFromStore();
    }),
    vscode.commands.registerCommand('topdown.timeline.prev', async () => {
      const store = await readStore();
      const total = store.history?.length ?? 0;
      const cur = typeof store.playheadIndex === 'number' ? store.playheadIndex : total - 1;
      store.playheadIndex = Math.max(-1, cur - 1);
      await writeStore(store);
      await timeline.refreshFromStore();
    }),
    vscode.commands.registerCommand('topdown.timeline.next', async () => {
      const store = await readStore();
      const total = store.history?.length ?? 0;
      const cur = typeof store.playheadIndex === 'number' ? store.playheadIndex : total - 1;
      store.playheadIndex = Math.min(total - 1, cur + 1);
      await writeStore(store);
      await timeline.refreshFromStore();
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
      await timeline.refreshFromStore();
    })
  );

  // Initial render.
  await timeline.refreshFromStore();
}

export function deactivate(): void {
  // no-op
}
