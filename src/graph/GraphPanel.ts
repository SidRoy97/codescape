import * as vscode from 'vscode';
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getGraph: () => CodeGraph,
  ) {}

  // Open (or reveal) the panel and show the impact of one symbol.
  show(nodeId: string): void {
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
    }

    this.panel.webview.html = this.buildHtml();
    this.renderImpact(nodeId);
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  // Compute the impact for a symbol and send it to the webview as data.
  private renderImpact(nodeId: string): void {
    if (!this.panel) return;

    const analyzer = new ImpactAnalyzer(this.getGraph());
    const impact   = analyzer.analyze(nodeId);
    if (!impact) return;

    // Data travels as a structured message — never concatenated into HTML.
    this.panel.webview.postMessage({ type: 'render', impact });
  }

  // Validate and act on a message from the webview.
  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const msg = message as Record<string, unknown>;

    // The only action: re-center on another node the user clicked.
    if (msg.type === 'focus' && typeof msg.nodeId === 'string') {
      // Security: only act if the id is a real node in the current graph.
      // This stops a compromised webview from passing an arbitrary string.
      const exists = this.getGraph().nodes.some(n => n.id === msg.nodeId);
      if (exists) {
        this.renderImpact(msg.nodeId);
      }
    }
  }

  // Build the webview HTML shell. Contains no code data — only the
  // CSP, the Cytoscape script tag, and the rendering script. All data
  // arrives later by message and is rendered via the Cytoscape API.
  private buildHtml(): string {
    const nonce = this.makeNonce();
    const cytoscapeUrl = 'https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js';

    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com`,
      `style-src 'nonce-${nonce}'`,
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

  // All rendering goes through the Cytoscape API. We never set innerHTML
  // with code data, so a malicious symbol name cannot inject markup.
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'render') return;
    renderImpact(message.impact);
  });

  function renderImpact(impact) {
    const elements = [];

    // Centre node — the symbol being changed.
    elements.push({ data: { id: impact.target.id, label: impact.target.name, role: 'target' } });

    // Direct callers and callees as neighbours.
    for (const node of impact.directCallers) {
      elements.push({ data: { id: node.id, label: node.name, role: 'caller' } });
      elements.push({ data: { source: node.id, target: impact.target.id } });
    }
    for (const node of impact.directCallees) {
      elements.push({ data: { id: node.id, label: node.name, role: 'callee' } });
      elements.push({ data: { source: impact.target.id, target: node.id } });
    }

    document.getElementById('title').textContent =
      'Changing ' + impact.target.name + '() affects ' + impact.affected.length + ' symbol(s)';

    if (cy) cy.destroy();
    cy = cytoscape({
      container: document.getElementById('graph'),
      elements,
      layout: { name: 'breadthfirst', directed: true, padding: 20 },
      style: [
        { selector: 'node', style: {
            'label': 'data(label)',
            'color': '#ccc',
            'background-color': '#555',
            'font-size': '11px',
            'text-valign': 'center',
            'text-halign': 'center',
            'width': 'label',
            'padding': '8px',
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

    // Clicking a node asks the extension to re-center. The extension
    // validates the id before acting, so this round trip is safe.
    cy.on('tap', 'node', evt => {
      vscode.postMessage({ type: 'focus', nodeId: evt.target.id() });
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