"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
// Single job: build and display the Activity Bar sidebar dashboard
class DashboardProvider {
    constructor(store) {
        this.store = store;
    }
    // VS Code calls this when the panel first becomes visible
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        // retainContextWhenHidden keeps the webview alive when the panel is hidden
        // Without this, every time the user switches tabs the panel loses its state
        webviewView.webview.options = {
            enableScripts: true,
        };
        // Re-render when the panel becomes visible again after being hidden
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible)
                this.render();
        });
        this.render();
        // Handle button clicks and navigation from inside the webview
        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.command === 'analyzeFile')
                vscode.commands.executeCommand('codescape.analyzeFile');
            if (msg.command === 'analyzeWorkspace')
                vscode.commands.executeCommand('codescape.analyzeWorkspace');
            if (msg.command === 'clearAll')
                vscode.commands.executeCommand('codescape.clearIssues');
            if (msg.command === 'openSettings')
                vscode.commands.executeCommand('workbench.action.openSettings', 'codeSec');
            if (msg.command === 'generateConfig')
                vscode.commands.executeCommand('codescape.generateConfig');
            // Jump to the exact line where the issue was found
            if (msg.command === 'goToLine') {
                const uri = vscode.Uri.parse(msg.uri);
                vscode.window.showTextDocument(uri, {
                    selection: new vscode.Range(msg.line, 0, msg.line, 0),
                });
            }
        });
    }
    // Called by onComplete after every analysis — always re-renders the full HTML
    refresh() {
        // Only render if the panel is currently visible — no-op otherwise
        if (this.view?.visible) {
            this.render();
        }
    }
    render() {
        if (!this.view)
            return;
        // Replace the full HTML every time — ensures fresh data always shows
        this.view.webview.html = this.buildHtml();
    }
    buildHtml() {
        const results = this.store.getAll();
        // Count totals for the stats grid
        const errors = results.reduce((n, r) => n + r.issues.filter(i => i.severity === 'error').length, 0);
        const warnings = results.reduce((n, r) => n + r.issues.filter(i => i.severity === 'warning').length, 0);
        const total = results.reduce((n, r) => n + r.issues.length, 0);
        const avgComp = results.length
            ? Math.round(results.reduce((n, r) => n + r.complexity, 0) / results.length)
            : 0;
        // Count per category for the bar chart
        const byCat = {};
        results.forEach(r => r.issues.forEach(i => {
            byCat[i.category] = (byCat[i.category] ?? 0) + 1;
        }));
        // File cards sorted by most issues first
        const fileCards = results
            .sort((a, b) => b.issues.length - a.issues.length)
            .slice(0, 15)
            .map(r => this.buildFileCard(r))
            .join('');
        // Category breakdown bars
        const chartRows = Object.entries(byCat)
            .filter(([, n]) => n > 0)
            .map(([cat, n]) => `
        <div class="chart-row">
          <span class="chart-label">${this.catLabel(cat)}</span>
          <div class="bar-track">
            <div class="bar cat-${cat}" style="width:${total > 0 ? Math.round((n / total) * 100) : 0}%"></div>
          </div>
          <span class="chart-n">${n}</span>
        </div>`)
            .join('');
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root {
    --fg:     var(--vscode-foreground);
    --border: var(--vscode-panel-border);
    --card:   var(--vscode-editor-background);
    --accent: var(--vscode-button-background);
    --red:    var(--vscode-editorError-foreground,   #f44);
    --yellow: var(--vscode-editorWarning-foreground, #fa0);
    --blue:   var(--vscode-editorInfo-foreground,    #4af);
    --green:  var(--vscode-gitDecoration-addedResourceForeground, #4c4);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--fg); padding: 8px; }

  .toolbar { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
  .btn { padding: 3px 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; border-radius: 4px; font-size: 10px; }
  .btn:hover { background: var(--accent); color: #fff; }
  .btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }

  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 8px; text-align: center; }
  .stat-n { font-size: 20px; font-weight: 700; }
  .stat-n.red    { color: var(--red);    }
  .stat-n.yellow { color: var(--yellow); }
  .stat-n.blue   { color: var(--blue);   }
  .stat-n.green  { color: var(--green);  }
  .stat-l { font-size: 10px; opacity: .6; margin-top: 2px; }

  .section { font-size: 10px; font-weight: 600; opacity: .5; text-transform: uppercase; letter-spacing: .5px; margin: 10px 0 5px; }

  .chart-row { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; font-size: 10px; }
  .chart-label { width: 85px; flex-shrink: 0; opacity: .8; }
  .bar-track { flex: 1; background: var(--border); border-radius: 3px; height: 5px; }
  .bar { height: 100%; border-radius: 3px; min-width: 2px; }
  .cat-security   { background: var(--red);    }
  .cat-code-smell { background: var(--yellow); }
  .cat-complexity { background: var(--blue);   }
  .cat-duplicate  { background: #a78bfa;       }
  .cat-ai         { background: #34d399;       }
  .chart-n { width: 20px; text-align: right; opacity: .6; }

  .file-card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 5px; overflow: hidden; }
  .file-hdr  { display: flex; align-items: center; gap: 5px; padding: 6px 8px; cursor: pointer; }
  .file-hdr:hover { background: rgba(128,128,128,.1); }
  .file-name { flex: 1; font-size: 11px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 9px; padding: 1px 5px; border-radius: 10px; font-weight: 600; }
  .b-err  { background: rgba(244,68,68,.2); color: var(--red);    }
  .b-warn { background: rgba(250,166,0,.2); color: var(--yellow); }
  .b-ok   { background: rgba(68,200,68,.2); color: var(--green);  }
  .comp-badge { font-size: 9px; opacity: .4; }

  .issue-list { border-top: 1px solid var(--border); display: none; }
  .issue-row  { display: flex; align-items: baseline; gap: 4px; padding: 4px 10px; cursor: pointer; font-size: 10px; border-bottom: 1px solid rgba(128,128,128,.08); }
  .issue-row:hover { background: rgba(128,128,128,.1); }
  .issue-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
  .issue-ln  { flex-shrink: 0; opacity: .45; font-family: monospace; }
  .sev-error   .dot { color: var(--red);    }
  .sev-warning .dot { color: var(--yellow); }
  .sev-info    .dot { color: var(--blue);   }
  .sev-hint    .dot { opacity: .4;          }

  .empty      { text-align: center; padding: 30px 16px; opacity: .45; }
  .empty-icon { font-size: 28px; margin-bottom: 8px; }

  /* Timestamp shown at bottom so user knows when data was last updated */
  .last-updated { font-size: 9px; opacity: .3; text-align: center; margin-top: 10px; }
</style>
</head>
<body>

<div class="toolbar">
  <button class="btn btn-primary" onclick="send('analyzeFile')">⚡ Analyze File</button>
  <button class="btn" onclick="send('analyzeWorkspace')">📁 Workspace</button>
  <button class="btn" onclick="send('clearAll')">🗑 Clear</button>
  <button class="btn" onclick="send('openSettings')">⚙ Settings</button>
</div>

<div class="stats">
  <div class="stat"><div class="stat-n red">${errors}</div><div class="stat-l">Errors</div></div>
  <div class="stat"><div class="stat-n yellow">${warnings}</div><div class="stat-l">Warnings</div></div>
  <div class="stat"><div class="stat-n blue">${total}</div><div class="stat-l">Total Issues</div></div>
  <div class="stat"><div class="stat-n ${avgComp > 10 ? 'yellow' : 'green'}">${avgComp}</div><div class="stat-l">Avg Complexity</div></div>
</div>

${total > 0 ? `
  <div class="section">By Category</div>
  ${chartRows}
  <div class="section">Files (${results.length})</div>
  ${fileCards}
` : `
  <div class="empty">
    <div class="empty-icon">✅</div>
    <div>No issues found yet.</div>
    <div style="margin-top:6px;font-size:10px">Save a file or click Analyze File to start.</div>
  </div>
`}

<!-- Shows when the dashboard was last updated so user knows it's live -->
<div class="last-updated">Last updated: ${new Date().toLocaleTimeString()}</div>

<script>
  const vsc = acquireVsCodeApi();
  function send(cmd) { vsc.postMessage({ command: cmd }); }
  function goTo(uri, line) { vsc.postMessage({ command: 'goToLine', uri, line }); }
  function toggle(el) {
    const list = el.nextElementSibling;
    list.style.display = list.style.display === 'block' ? 'none' : 'block';
  }
</script>
</body>
</html>`;
    }
    buildFileCard(r) {
        const fname = path.basename(r.uri.fsPath);
        const errors = r.issues.filter(i => i.severity === 'error').length;
        const warnings = r.issues.filter(i => i.severity === 'warning').length;
        const uriStr = r.uri.toString();
        const issueRows = r.issues.slice(0, 6).map(i => `
      <div class="issue-row sev-${i.severity}" onclick="goTo('${uriStr}', ${i.line})">
        <span class="dot">●</span>
        <span class="issue-msg">${this.esc(i.message.slice(0, 80))}</span>
        <span class="issue-ln">L${i.line + 1}</span>
      </div>`).join('');
        return `
      <div class="file-card">
        <div class="file-hdr" onclick="toggle(this)">
          <span class="file-name" title="${r.uri.fsPath}">${fname}</span>
          ${errors > 0 ? `<span class="badge b-err">${errors}e</span>` : ''}
          ${warnings > 0 ? `<span class="badge b-warn">${warnings}w</span>` : ''}
          ${r.issues.length === 0 ? `<span class="badge b-ok">✓</span>` : ''}
          <span class="comp-badge">⚙${r.complexity}</span>
        </div>
        <div class="issue-list">
          ${issueRows}
          ${r.issues.length > 6
            ? `<div style="padding:4px 10px;font-size:9px;opacity:.4">+${r.issues.length - 6} more — see Problems panel (Cmd+Shift+M)</div>`
            : ''}
        </div>
      </div>`;
    }
    catLabel(cat) {
        const labels = {
            'code-smell': '🧹 Code Smell',
            security: '🔒 Security',
            complexity: '📊 Complexity',
            duplicate: '📋 Duplicate',
            ai: '🤖 AI',
        };
        return labels[cat] ?? cat;
    }
    esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    dispose() {
        this.view = undefined;
    }
}
exports.DashboardProvider = DashboardProvider;
DashboardProvider.viewId = 'codescape.dashboard';
