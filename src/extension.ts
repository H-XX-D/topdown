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
    vscode.window.showErrorMessage('No active editor.');
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

        const items: Array<vscode.QuickPickItem & { action: 'variant' | 'insertId' | 'copyId' }> = [
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
          store.history.push({ ts: Date.now(), kind: 'row.variant', label: `+ ${newId} (from ${id})` });
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
      }

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

    const history = store.history ?? [];
    const playhead = typeof store.playheadIndex === 'number' ? store.playheadIndex : history.length - 1;

    const stepsNewestFirst = history
      .map((h, idx) => ({ idx, ts: h.ts, kind: h.kind, label: h.label }))
      .slice()
      .sort((a, b) => b.idx - a.idx);

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

    .layout { display: flex; gap: 12px; }
    .timeline { position: relative; width: 240px; min-width: 200px; max-width: 280px; border-right: 1px solid var(--vscode-panel-border); padding-right: 12px; }
    .timelineHeader { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .timelineHeader .title { font-weight: 600; }
    .timelineList { max-height: calc(100vh - 140px); overflow: auto; padding-right: 6px; }
    .stepRow { display: flex; gap: 6px; align-items: stretch; margin: 0 0 6px 0; }
    .stepMain { flex: 1; display: block; width: 100%; text-align: left; padding: 6px 8px; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
    .stepMain:hover { background: var(--vscode-list-hoverBackground); }
    .stepMain.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: var(--vscode-focusBorder); }
    .stepMain .meta { opacity: 0.75; font-size: 0.9em; margin-top: 2px; }
    .stepMore { width: 32px; padding: 0; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
    .stepMore:hover { background: var(--vscode-list-hoverBackground); }

    .drawer { position: absolute; top: 0; left: 0; right: 12px; bottom: 0; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); color: var(--vscode-foreground); padding: 10px; box-sizing: border-box; display: none; }
    .drawer.open { display: block; }
    .drawerHeader { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .drawerHeader .title { font-weight: 600; }
    .drawer pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); padding: 8px; border: 1px solid var(--vscode-panel-border); }

    .main { flex: 1; min-width: 600px; }

    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
    th { text-align: left; }

    input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 4px 6px; }

    .lockCol { width: 64px; }
    .idCol { width: 140px; }
    .exprCol { width: 40%; }
    .actionsCol { width: 44px; }
  .rowMore { width: 32px; padding: 0; border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); cursor: pointer; }
  .rowMore:hover { background: var(--vscode-list-hoverBackground); }

    details > summary { cursor: pointer; user-select: none; }
    details > summary { list-style: none; }
    details > summary::-webkit-details-marker { display: none; }

    .hint { margin-top: 8px; opacity: 0.8; }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="timeline" aria-label="Timeline">
      <div class="timelineHeader">
        <div class="title">Timeline</div>
        <button id="clearPlayhead" title="Clear playhead (jump to latest)">Clear</button>
      </div>
      <div class="timelineList" role="list">
        ${stepsNewestFirst
          .map((s) => {
            const isActive = s.idx === playhead;
            const label = escapeHtml(s.label);
            const kind = escapeHtml(s.kind);
            const ts = typeof s.ts === 'number' ? String(s.ts) : '';
            return `
          <div class="stepRow" role="listitem" data-step-idx="${s.idx}" data-step-label="${label}" data-step-kind="${kind}" data-step-ts="${ts}">
            <button class="stepMain ${isActive ? 'active' : ''}" data-step-main="${s.idx}" title="${kind}">
              <div>${label}</div>
              <div class="meta">#${s.idx + 1} • ${kind}</div>
            </button>
            <button class="stepMore" data-step-more="${s.idx}" title="Actions">⋯</button>
          </div>`;
          })
          .join('')}
        ${stepsNewestFirst.length === 0 ? `<div class="hint">No steps yet.</div>` : ''}
      </div>

      <div id="drawer" class="drawer" aria-hidden="true">
        <div class="drawerHeader">
          <div class="title">Step</div>
          <button id="drawerClose" title="Close">Close</button>
        </div>
        <div id="drawerBody"></div>
      </div>
    </aside>

    <main class="main">
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
            <th class="actionsCol"></th>
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
              <td style="text-align:center"><button class="rowMore" data-row-more="${r.id}" title="Row actions">⋯</button></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>

      <div class="hint">This panel is the source of truth. Locked rows are not editable from the table.</div>
    </main>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const drawer = document.getElementById('drawer');
    const drawerBody = document.getElementById('drawerBody');

    function openDrawer(step) {
      const d = new Date(Number(step.ts || 0));
      const when = Number.isFinite(d.getTime()) && Number(step.ts) > 0 ? d.toLocaleString() : '';
      const lines = [];
      lines.push('label: ' + step.label);
      lines.push('kind: ' + step.kind);
      if (when) lines.push('time: ' + when);
      lines.push('index: ' + step.idx);
      drawerBody.innerHTML = '';
      const pre = document.createElement('pre');
      pre.textContent = lines.join('\n');
      drawerBody.appendChild(pre);
      drawer.classList.add('open');
      drawer.setAttribute('aria-hidden', 'false');
    }

    function closeDrawer() {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
    }

    document.getElementById('drawerClose').addEventListener('click', closeDrawer);

    document.getElementById('clearPlayhead').addEventListener('click', () => {
      vscode.postMessage({ type: 'clearPlayhead' });
    });

    for (const row of Array.from(document.querySelectorAll('[data-step-idx]'))) {
      const idx = Number(row.getAttribute('data-step-idx'));
      const step = {
        idx,
        label: row.getAttribute('data-step-label') || '',
        kind: row.getAttribute('data-step-kind') || '',
        ts: row.getAttribute('data-step-ts') || '0',
      };

      const main = row.querySelector('[data-step-main]');
      const more = row.querySelector('[data-step-more]');

      if (main) {
        main.addEventListener('click', () => {
          if (!Number.isFinite(idx)) return;
          vscode.postMessage({ type: 'setPlayhead', idx });
        });
        main.addEventListener('dblclick', () => {
          if (!Number.isFinite(idx)) return;
          openDrawer(step);
        });
        main.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (!Number.isFinite(idx)) return;
          vscode.postMessage({ type: 'stepActions', idx });
        });
      }

      if (more) {
        more.addEventListener('click', (ev) => {
          ev.preventDefault();
          if (!Number.isFinite(idx)) return;
          vscode.postMessage({ type: 'stepActions', idx });
        });
        more.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (!Number.isFinite(idx)) return;
          vscode.postMessage({ type: 'stepActions', idx });
        });
      }
    }

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

    for (const btn of Array.from(document.querySelectorAll('[data-row-more]'))) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const id = e.currentTarget.getAttribute('data-row-more');
        if (!id) return;
        vscode.postMessage({ type: 'rowActions', id });
      });
    }

    for (const tr of Array.from(document.querySelectorAll('tbody tr[data-row]'))) {
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const id = tr.getAttribute('data-row');
        if (!id) return;
        vscode.postMessage({ type: 'rowActions', id });
      });
    }
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
      store.history.push({ ts: Date.now(), kind: 'row.variant', label: `+ ${newId} (from ${source.id})` });
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
}

export function deactivate(): void {
  // no-op
}
