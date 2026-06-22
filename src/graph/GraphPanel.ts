import * as vscode from 'vscode';
import * as path from 'path';
import { ImpactAnalyzer } from './ImpactAnalyzer';
import { CodeGraph } from './CodeGraphTypes';

// Single job: show the impact of one symbol as an interactive graph.
// This file owns every cross-site-scripting defence in the feature:
//   1. A strict Content Security Policy with a per-render nonce.
//   2. Code data is sent as a postMessage payload, never baked into HTML,
//      and the webview builds nodes with the Cytoscape API (no innerHTML).
//   3. Incoming messages are validated against the real graph, so the
//      webview can never make the extension act on an arbitrary symbol id.
export class GraphPanel {
  private panel?: vscode.WebviewPanel;
  private pendingNodeId?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getGraph: () => CodeGraph,
  ) {}

  // Open (or reveal) the panel and show the impact of one symbol.
  show(nodeId: string): void {
    this.pendingNodeId = nodeId;

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'codescape.graph',
        'Codescape',
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          // Security: the webview may only load files from the extension folder.
          localResourceRoots: [this.extensionUri],
        },
      );

      this.panel.onDidDispose(() => { this.panel = undefined; });

      // Security: treat every message from the webview as untrusted.
      this.panel.webview.onDidReceiveMessage(message => {
        this.handleMessage(message);
      });

      // Set the HTML once. The webview posts "ready" when its script has
      // loaded, and only then do we send the data — this avoids a race where
      // the render message arrives before the listener exists.
      this.panel.webview.html = this.buildHtml(this.panel.webview);
    } else {
      // Panel already exists and its listener is live, so render immediately.
      this.renderImpact(nodeId);
    }

    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  // Compute the impact for a symbol and send it to the webview as data.
  private renderImpact(nodeId: string): void {
    if (!this.panel) return;

    const graph = this.getGraph();

    // Diagnose the two silent-failure cases instead of just returning. I send
    // a clear status to the webview so the panel never sits on the placeholder
    // without explanation, and log details for the dev console.
    if (graph.nodes.length === 0) {
      console.warn('[Codescape] Impact: graph is empty when rendering', nodeId);
      this.panel.webview.postMessage({
        type: 'status',
        text: 'The code graph is empty. Run an analysis or reopen the file, then click again.',
      });
      return;
    }

    const analyzer = new ImpactAnalyzer(graph);
    const impact   = analyzer.analyze(nodeId);
    if (!impact) {
      console.warn('[Codescape] Impact: node id not found in graph:', nodeId,
        '\nAvailable ids sample:', graph.nodes.slice(0, 10).map(n => n.id));
      this.panel.webview.postMessage({
        type: 'status',
        text: `Could not find "${nodeId}" in the current graph. The graph may have been rebuilt — reopen the file and click again.`,
      });
      return;
    }

    // Data travels as a structured message — never concatenated into HTML.
    this.panel.webview.postMessage({ type: 'render', impact });
  }

  // Validate and act on a message from the webview.
  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;

    // The webview finished loading and is listening. Render whatever symbol
    // was requested when the panel was opened.
    if (msg.type === 'ready') {
      if (this.pendingNodeId) this.renderImpact(this.pendingNodeId);
      return;
    }

    // Re-center on another node the user clicked.
    if (msg.type === 'focus' && typeof msg.nodeId === 'string') {
      // Security: only act if the id is a real node in the current graph.
      // This stops a compromised webview from passing an arbitrary string.
      const exists = this.getGraph().nodes.some(n => n.id === msg.nodeId);
      if (exists) {
        this.renderImpact(msg.nodeId);
      }
      return;
    }

    // Open the file for a node, scrolled to its definition line.
    if (msg.type === 'open' && typeof msg.nodeId === 'string') {
      // Security: resolve the line/file from our own graph, never from the
      // message, so the webview can only open real, known nodes.
      const node = this.getGraph().nodes.find(n => n.id === msg.nodeId);
      if (!node) return;

      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;

      const uri = vscode.Uri.file(path.join(root, node.file));
      vscode.window.showTextDocument(uri, {
        selection: new vscode.Range(node.line, 0, node.line, 0),
        viewColumn: vscode.ViewColumn.One,
      }).then(editor => {
        editor.revealRange(
          new vscode.Range(node.line, 0, node.line, 0),
          vscode.TextEditorRevealType.InCenter,
        );
      });
    }
  }

  // Build the webview HTML shell. Contains no code data — only the
  // CSP, the Cytoscape script tag, and the rendering script. All data
  // arrives later by message and is rendered via the Cytoscape API.
  private buildHtml(webview: vscode.Webview): string {
    const nonce = this.makeNonce();

    // Load Cytoscape from the bundled copy in node_modules, not a CDN, so the
    // graph works offline and never depends on network access.
    const cytoscapeUrl = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js'),
    );

    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
      // Inline style attributes (e.g. display:none) cannot carry a nonce. The
      // webview HTML is fully controlled by us and no user content is injected
      // as markup, so allowing inline styles here is safe.
      `style-src 'nonce-${nonce}' 'unsafe-inline'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style nonce="${nonce}">
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  #title { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--vscode-panel-border); }
  #graph { width: 100%; height: calc(100vh - 42px); }
  #empty { padding: 20px; opacity: 0.6; font-size: 12px; }
</style>
</head>
<body>
<div id="title">Select a function to see its impact</div>
<div id="graph"></div>
<div id="empty" style="display:none">No impact data for this symbol.</div>

<script nonce="${nonce}" src="${cytoscapeUrl}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let cy = null;
  let pendingImpact = null;

  // All rendering goes through the Cytoscape API. We never set innerHTML
  // with code data, so a malicious symbol name cannot inject markup.
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message) return;
    // The extension can send a plain status string for the error/empty cases.
    if (message.type === 'status') {
      document.getElementById('title').textContent = message.text;
      return;
    }
    if (message.type !== 'render') return;
    // Hold the data until the Cytoscape library is actually loaded, then draw.
    pendingImpact = message.impact;
    tryRender();
  });

  // Cytoscape loads as a separate bundled <script>. It may not be ready the
  // instant this inline script runs, so I only signal "ready" and render once
  // the library is present. I poll briefly for it.
  let waited = 0;
  function waitForCytoscape() {
    if (typeof cytoscape !== 'undefined') {
      vscode.postMessage({ type: 'ready' });
      tryRender();
      return;
    }
    waited += 100;
    if (waited > 5000) {
      // The library never loaded. Tell the user instead of leaving the
      // placeholder sitting there silently.
      document.getElementById('title').textContent =
        'Could not load the graph library. Try reopening the panel.';
      return;
    }
    setTimeout(waitForCytoscape, 100);
  }
  waitForCytoscape();

  // Draw the held impact, if any, once the library is available.
  function tryRender() {
    if (!pendingImpact || typeof cytoscape === 'undefined') return;
    try {
      renderImpact(pendingImpact);
      pendingImpact = null;
    } catch (e) {
      document.getElementById('title').textContent = 'Could not render the graph: ' + e;
    }
  }

  function renderImpact(impact) {
    const elements = [];

    // Build a two-line label: symbol name on top, file basename below.
    // I use fromCharCode(10) for the line break so this template literal does
    // not emit a raw newline into the webview script (which breaks the string).
    function labelFor(node) {
      const base = node.file ? node.file.split('/').pop() : '';
      return node.name + (base ? String.fromCharCode(10) + base : '');
    }

    // Centre node — the symbol being changed.
    elements.push({ data: { id: impact.target.id, label: labelFor(impact.target), role: 'target' } });

    // Direct callers and callees as neighbours.
    for (const node of impact.directCallers) {
      elements.push({ data: { id: node.id, label: labelFor(node), role: 'caller' } });
      elements.push({ data: { source: node.id, target: impact.target.id } });
    }
    for (const node of impact.directCallees) {
      elements.push({ data: { id: node.id, label: labelFor(node), role: 'callee' } });
      elements.push({ data: { source: impact.target.id, target: node.id } });
    }

    document.getElementById('title').textContent =
      'Changing ' + impact.target.name + '() affects ' + impact.affected.length +
      ' symbol(s) — click to re-center, double-click to open the file';

    if (cy) cy.destroy();
    cy = cytoscape({
      container: document.getElementById('graph'),
      elements,
      layout: { name: 'breadthfirst', directed: true, padding: 20 },
      style: [
        { selector: 'node', style: {
            'label': 'data(label)',
            'color': '#ddd',
            'background-color': '#555',
            'font-size': '10px',
            'text-valign': 'center',
            'text-halign': 'center',
            'text-wrap': 'wrap',
            'text-justification': 'center',
            'line-height': 1.3,
            'width': 'label',
            'height': 'label',
            'padding': '9px',
            'shape': 'round-rectangle',
        }},
        { selector: 'node[role="target"]', style: { 'background-color': '#7c3aed' } },
        { selector: 'node[role="caller"]', style: { 'background-color': '#a32d2d' } },
        { selector: 'node[role="callee"]', style: { 'background-color': '#185fa5' } },
        { selector: 'edge', style: {
            'width': 1.5,
            'line-color': '#888',
            'target-arrow-color': '#888',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
        }},
      ],
    });

    // Cytoscape has no real double-click event, so I detect it myself: two
    // taps on the same node within 300ms open the file; a single tap recenters.
    let lastTapId = null;
    let lastTapTime = 0;

    cy.on('tap', 'node', evt => {
      const id = evt.target.id();
      const now = Date.now();

      if (id === lastTapId && now - lastTapTime < 300) {
        // Second quick tap on the same node — open its file.
        vscode.postMessage({ type: 'open', nodeId: id });
        lastTapId = null;
        lastTapTime = 0;
        return;
      }

      // First tap — re-center, and remember it so a quick second tap counts.
      lastTapId = id;
      lastTapTime = now;
      vscode.postMessage({ type: 'focus', nodeId: id });
    });
  }
</script>
</body>
</html>`;
  }

  // A random nonce ties the CSP to exactly the scripts we emit.
  private makeNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
      text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
  }
}