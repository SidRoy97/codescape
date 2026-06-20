import * as vscode from 'vscode';
import * as path from 'path';
import { ResultStore } from '../ResultStore';
import { FileAnalysisResult, IssueCategory, IssueSeverity } from '../types';

// What the dashboard is currently showing: every analyzed file, or just one.
type ViewScope = { kind: 'workspace' } | { kind: 'file'; uri: string };

// Single job: render the sidebar dashboard webview. It shows summary stats,
// a grouped action toolbar, a category breakdown, and a per-file issue list.
// Buttons post a message that maps to an existing command via executeCommand —
// the dashboard holds no feature logic itself, so there is exactly one
// implementation of each feature.
//
// The dashboard can be scoped: "This File" shows only the active file's
// issues, "Workspace" shows everything. In file scope it follows the active
// editor, so switching files updates the view.
export class DashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'codescape.dashboard';
  private view?: vscode.WebviewView;
  private scope: ViewScope = { kind: 'workspace' };
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: ResultStore) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.buildHtml();

    // Treat every incoming message as untrusted: only a known command id
    // from our fixed allowlist is ever executed.
    this.disposables.push(
      view.webview.onDidReceiveMessage(message => this.handleMessage(message)),
    );

    // When in file scope, follow the active editor so the view always matches
    // the file the user is looking at.
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (this.scope.kind === 'file' && editor && editor.document.uri.scheme === 'file') {
          this.scope = { kind: 'file', uri: editor.document.uri.toString() };
          this.refresh();
        }
      }),
    );
  }

  refresh(): void {
    if (this.view) {
      this.view.webview.html = this.buildHtml();
    }
  }

  // Switch the dashboard to show only the active file. Called when the user
  // runs "This File". If no file is open, fall back to workspace scope.
  scopeToActiveFile(): void {
    const editor = vscode.window.activeTextEditor
      ?? vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
    if (editor && editor.document.uri.scheme === 'file') {
      this.scope = { kind: 'file', uri: editor.document.uri.toString() };
    } else {
      this.scope = { kind: 'workspace' };
    }
    this.refresh();
  }

  // Switch the dashboard to show every analyzed file. Called when the user
  // runs "Workspace".
  scopeToWorkspace(): void {
    this.scope = { kind: 'workspace' };
    this.refresh();
  }

  // Map a button message to a real command. The allowlist is the security
  // boundary — anything not listed is ignored. The two analyze buttons also
  // set the view scope so the display matches what was just analyzed.
  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;

    if (msg.type === 'command' && typeof msg.id === 'string') {
      const allowed = new Set([
        'codescape.analyzeFile',
        'codescape.analyzeWorkspace',
        'codescape.clearIssues',
        'codescape.showBlastRadius',
        'codescape.findUnused',
        'codescape.exportGraph',
        'codescape.generateUnderstanding',
        'codescape.reportIssues',
        'codescape.generateConfig',
      ]);
      if (allowed.has(msg.id)) {
        // Set scope before running, so the refresh after analysis shows the
        // right slice.
        if (msg.id === 'codescape.analyzeFile') this.scopeToActiveFile();
        if (msg.id === 'codescape.analyzeWorkspace') this.scopeToWorkspace();
        if (msg.id === 'codescape.clearIssues') this.scope = { kind: 'workspace' };
        vscode.commands.executeCommand(msg.id);
      }
      return;
    }

    if (msg.type === 'openSettings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'codescape');
      return;
    }

    if (msg.type === 'goToFile' && typeof msg.uri === 'string' && typeof msg.line === 'number') {
      try {
        const uri = vscode.Uri.parse(msg.uri);
        vscode.window.showTextDocument(uri, {
          selection: new vscode.Range(msg.line, 0, msg.line, 0),
        });
      } catch {
        // Ignore malformed uris.
      }
    }
  }

  // The results currently in scope: one file, or all of them.
  private scopedResults(): FileAnalysisResult[] {
    const all = this.store.getAll();
    if (this.scope.kind === 'file') {
      const wanted = this.scope.uri;
      return all.filter(r => r.uri.toString() === wanted);
    }
    return all;
  }

  private buildHtml(): string {
    const results = this.scopedResults();
    const summary = this.computeSummary(results);

    // A short label describing what the user is looking at.
    const scopeLabel = this.scope.kind === 'file'
      ? `This file: ${path.basename(vscode.Uri.parse(this.scope.uri).fsPath)}`
      : 'Whole workspace';

    const fileCards = results
      .filter(r => r.issues.length > 0)
      .sort((a, b) => b.issues.length - a.issues.length)
      .slice(0, 30)
      .map(r => this.buildFileCard(r))
      .join('');

    const categoryChart = Object.entries(summary.byCategory)
      .filter(([, count]) => count > 0)
      .map(([cat, count]) => `
        <div class="chart-row">
          <span class="chart-label">${this.catLabel(cat as IssueCategory)}</span>
          <div class="chart-bar-wrap">
            <div class="chart-bar cat-${cat}" style="width:${Math.min(100, (count / (summary.totalIssues || 1)) * 100)}%"></div>
          </div>
          <span class="chart-count">${count}</span>
        </div>
      `).join('');

    const hasIssues = summary.totalIssues > 0;
    const fileScopeActive = this.scope.kind === 'file';

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --fg: var(--vscode-foreground);
    --border: var(--vscode-panel-border);
    --card-bg: var(--vscode-editor-background);
    --accent: var(--vscode-button-background);
    --accent-fg: var(--vscode-button-foreground);
    --accent-hover: var(--vscode-button-hoverBackground);
    --error: var(--vscode-editorError-foreground, #f44);
    --warn: var(--vscode-editorWarning-foreground, #fa0);
    --info: var(--vscode-editorInfo-foreground, #4af);
    --ok: var(--vscode-gitDecoration-addedResourceForeground, #4c4);
    --purple: #a78bfa;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--fg); padding: 10px; }

  .brand { display: flex; align-items: center; gap: 7px; margin-bottom: 14px; }
  .brand-logo { width: 18px; height: 18px; border-radius: 5px;
    background: linear-gradient(135deg, var(--purple), var(--info)); flex-shrink: 0; }
  .brand-name { font-size: 14px; font-weight: 700; letter-spacing: 0.2px; }

  .group { margin-bottom: 13px; }
  .group-title { font-size: 9px; font-weight: 700; opacity: 0.45; text-transform: uppercase;
    letter-spacing: 0.7px; margin-bottom: 6px; }
  .btn-row { display: flex; gap: 5px; flex-wrap: wrap; }
  .btn { padding: 6px 10px; border: 1px solid var(--border); background: var(--card-bg);
    color: var(--fg); cursor: pointer; border-radius: 6px; font-size: 11px; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 5px; transition: all 0.12s; }
  .btn:hover { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .btn.active { background: var(--accent); color: var(--accent-fg); border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent); font-weight: 700; }
  .btn-primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
  .btn .ic { font-size: 12px; }

  .scope-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 10px;
    padding: 3px 9px; border-radius: 12px; background: rgba(124,58,237,0.15); color: var(--purple);
    margin-bottom: 12px; font-weight: 600; }

  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 6px 0 14px; }
  .stat { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 9px 6px; text-align: center; }
  .stat-num { font-size: 20px; font-weight: 800; line-height: 1; }
  .stat-num.red { color: var(--error); } .stat-num.yellow { color: var(--warn); }
  .stat-num.blue { color: var(--info); } .stat-num.green { color: var(--ok); }
  .stat-label { font-size: 9px; opacity: 0.65; margin-top: 4px; }

  .section-title { font-size: 10px; font-weight: 700; opacity: 0.55; text-transform: uppercase;
    letter-spacing: 0.6px; margin: 14px 0 7px; }

  .chart-row { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; font-size: 10px; }
  .chart-label { width: 95px; flex-shrink: 0; opacity: 0.85; }
  .chart-bar-wrap { flex: 1; background: var(--border); border-radius: 4px; height: 7px; overflow: hidden; }
  .chart-bar { height: 100%; border-radius: 4px; min-width: 2px; }
  .cat-security { background: var(--error); } .cat-code-smell { background: var(--warn); }
  .cat-complexity { background: var(--info); } .cat-duplicate { background: var(--purple); }
  .cat-ai { background: #34d399; }
  .chart-count { width: 26px; text-align: right; opacity: 0.7; }

  .file-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px;
    margin-bottom: 7px; overflow: hidden; }
  .file-header { display: flex; align-items: center; padding: 8px 9px; gap: 7px; cursor: pointer; }
  .file-header:hover { background: rgba(128,128,128,0.08); }
  .file-name { flex: 1; font-size: 11px; font-weight: 600; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .badges { display: flex; gap: 4px; flex-shrink: 0; }
  .badge { font-size: 9px; padding: 1px 6px; border-radius: 10px; font-weight: 700; }
  .badge-error { background: rgba(244,68,68,0.18); color: var(--error); }
  .badge-warn { background: rgba(250,166,0,0.18); color: var(--warn); }

  .issue-list { border-top: 1px solid var(--border); }
  .issue-list.hidden { display: none; }
  .issue-item { display: flex; align-items: baseline; gap: 6px; padding: 5px 11px; cursor: pointer;
    font-size: 10px; border-bottom: 1px solid rgba(128,128,128,0.08); }
  .issue-item:hover { background: rgba(128,128,128,0.08); }
  .issue-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
  .issue-line { flex-shrink: 0; opacity: 0.5; font-family: monospace; }
  .sev-error .dot { color: var(--error); } .sev-warning .dot { color: var(--warn); }
  .sev-info .dot { color: var(--info); } .sev-hint .dot { opacity: 0.5; }
  .more { padding: 5px 11px; font-size: 9px; opacity: 0.5; }

  .empty { text-align: center; padding: 28px 14px; opacity: 0.55; }
  .empty-icon { font-size: 30px; margin-bottom: 8px; }
</style>
</head>
<body>

<div class="brand">
  <div class="brand-logo"></div>
  <div class="brand-name">Codescape</div>
</div>

<div class="group">
  <div class="group-title">Analyze</div>
  <div class="btn-row">
    <button class="btn ${fileScopeActive ? 'btn-primary' : ''}" data-cmd="codescape.analyzeFile"><span class="ic">⚡</span>This File</button>
    <button class="btn ${!fileScopeActive ? 'btn-primary' : ''}" data-cmd="codescape.analyzeWorkspace"><span class="ic">📂</span>Workspace</button>
    <button class="btn" data-cmd="codescape.clearIssues"><span class="ic">🗑</span>Clear</button>
  </div>
</div>

<div class="group">
  <div class="group-title">Understand Code</div>
  <div class="btn-row">
    <button class="btn" data-cmd="codescape.showBlastRadius"><span class="ic">💥</span>Blast Radius</button>
    <button class="btn" data-cmd="codescape.findUnused"><span class="ic">🔍</span>Unused</button>
  </div>
</div>

<div class="group">
  <div class="group-title">For AI / LLMs</div>
  <div class="btn-row">
    <button class="btn" data-cmd="codescape.generateUnderstanding"><span class="ic">📖</span>Understanding Doc</button>
  </div>
</div>

<div class="group">
  <div class="group-title">Reports &amp; Config</div>
  <div class="btn-row">
    <button class="btn" data-cmd="codescape.reportIssues"><span class="ic">📊</span>Problems Report</button>
    <button class="btn" data-cmd="codescape.exportGraph"><span class="ic">📤</span>Export Graph</button>
    <button class="btn" data-cmd="codescape.generateConfig"><span class="ic">⚙️</span>Config</button>
    <button class="btn" data-settings="1"><span class="ic">🔧</span>Settings</button>
  </div>
</div>

<div class="scope-pill">👁 ${this.esc(scopeLabel)}</div>

<div class="summary-grid">
  <div class="stat"><div class="stat-num red">${summary.bySeverity.error ?? 0}</div><div class="stat-label">Errors</div></div>
  <div class="stat"><div class="stat-num yellow">${summary.bySeverity.warning ?? 0}</div><div class="stat-label">Warnings</div></div>
  <div class="stat"><div class="stat-num blue">${summary.totalIssues}</div><div class="stat-label">Total</div></div>
  <div class="stat"><div class="stat-num ${summary.avgComplexity > 10 ? 'yellow' : 'green'}">${summary.avgComplexity}</div><div class="stat-label">Avg Cx</div></div>
</div>

${hasIssues ? `
<div class="section-title">By Category</div>
${categoryChart}
<div class="section-title">Files (${results.filter(r => r.issues.length > 0).length})</div>
${fileCards}
` : `
<div class="empty">
  <div class="empty-icon">✅</div>
  <div>${this.scope.kind === 'file' ? 'No issues in this file.' : 'No issues found yet.'}</div>
  <div style="margin-top:7px;font-size:10px">Click "This File" or "Workspace" to analyze.</div>
</div>
`}

<script>
  const vscode = acquireVsCodeApi();

  document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.settings) {
        vscode.postMessage({ type: 'openSettings' });
        return;
      }
      const id = btn.dataset.cmd;
      if (!id) return;
      vscode.postMessage({ type: 'command', id });
    });
  });

  function goTo(uri, line) { vscode.postMessage({ type: 'goToFile', uri, line }); }
  function toggleFile(header) { header.nextElementSibling.classList.toggle('hidden'); }
</script>
</body>
</html>`;
  }

  private buildFileCard(r: FileAnalysisResult): string {
    const fname = path.basename(r.uri.fsPath);
    const errors = r.issues.filter(i => i.severity === 'error').length;
    const warnings = r.issues.filter(i => i.severity === 'warning').length;
    const uriStr = r.uri.toString();

    const issueList = r.issues.slice(0, 6).map(i => `
      <div class="issue-item sev-${i.severity}" onclick="goTo('${uriStr}', ${i.line})">
        <span class="dot">${this.sevDot(i.severity)}</span>
        <span class="issue-msg">${this.esc(i.message.slice(0, 90))}</span>
        <span class="issue-line">L${i.line + 1}</span>
      </div>
    `).join('');

    return `
      <div class="file-card">
        <div class="file-header" onclick="toggleFile(this)">
          <span class="file-name" title="${this.esc(r.uri.fsPath)}">${this.esc(fname)}</span>
          <div class="badges">
            ${errors > 0 ? `<span class="badge badge-error">${errors}</span>` : ''}
            ${warnings > 0 ? `<span class="badge badge-warn">${warnings}</span>` : ''}
          </div>
        </div>
        <div class="issue-list hidden">
          ${issueList}
          ${r.issues.length > 6 ? `<div class="more">+${r.issues.length - 6} more — see Problems panel</div>` : ''}
        </div>
      </div>
    `;
  }

  private computeSummary(results: FileAnalysisResult[]) {
    const byCategory: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    let totalIssues = 0;

    for (const r of results) {
      for (const i of r.issues) {
        byCategory[i.category] = (byCategory[i.category] ?? 0) + 1;
        bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;
        totalIssues++;
      }
    }

    const avgComplexity = results.length
      ? Math.round(results.reduce((s, r) => s + r.complexity, 0) / results.length)
      : 0;

    return { totalIssues, byCategory, bySeverity, avgComplexity };
  }

  private catLabel(cat: IssueCategory): string {
    return {
      'code-smell': '🧹 Code Smells', security: '🔒 Security',
      complexity: '📊 Complexity', duplicate: '📋 Duplicate', ai: '🤖 AI',
    }[cat] ?? cat;
  }

  private sevDot(sev: IssueSeverity): string {
    return { error: '●', warning: '▲', info: 'ℹ', hint: '·' }[sev] ?? '·';
  }

  private esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}