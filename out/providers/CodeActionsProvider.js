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
exports.CodeActionsProvider = void 0;
const vscode = __importStar(require("vscode"));
// System prompt for fix: return only replacement code, no explanation
const FIX_PROMPT = `You are an expert software engineer.
You will receive a code snippet and a specific issue to fix.
Return ONLY the corrected replacement code.
Preserve original indentation exactly.
Change ONLY what is necessary to fix the stated issue.`;
// System prompt for explanation: teach a junior dev what is wrong and why
const EXPLAIN_PROMPT = `You are a senior engineer mentoring a junior developer.
Explain the code issue clearly:
1. What is wrong and why it matters
2. What could go wrong at runtime (give a concrete example)
3. How to fix it with a short before/after code snippet
Keep it under 250 words. Use markdown.`;
// Single job: provide Fix and Explain as lightbulb code actions on flagged lines
class CodeActionsProvider {
    constructor(store, scanner) {
        this.store = store;
        this.scanner = scanner;
        this.disposables = [];
        // Register the fix command — fires when user clicks "Apply Fix"
        this.disposables.push(vscode.commands.registerCommand('codescape.fixWithAi', (doc, issue, range) => this.applyFix(doc, issue, range)));
        // Register the explain command — opens a side panel
        this.disposables.push(vscode.commands.registerCommand('codescape.explainIssue', (doc, issue) => this.explainIssue(doc, issue)));
    }
    // VS Code calls this to populate the lightbulb menu for a flagged line
    provideCodeActions(document, _range, context) {
        const actions = [];
        for (const diag of context.diagnostics) {
            // Only handle diagnostics that Codescape created
            if (!diag.source?.startsWith('Codescape'))
                continue;
            // Find the matching Issue object for this diagnostic line
            const result = this.store.get(document.uri);
            const issue = result?.issues.find(i => i.line === diag.range.start.line);
            if (!issue)
                continue;
            // Fix action — marked preferred so it shows first in the lightbulb
            const fix = new vscode.CodeAction(`🔧 Fix: ${issue.message.slice(0, 55)}…`, vscode.CodeActionKind.QuickFix);
            fix.command = { command: 'codescape.fixWithAi', title: 'Fix with AI', arguments: [document, issue, diag.range] };
            fix.diagnostics = [diag];
            fix.isPreferred = true;
            actions.push(fix);
            // Explain action — opens a webview panel beside the editor
            const explain = new vscode.CodeAction('💡 Explain: Why is this an issue?', vscode.CodeActionKind.Empty);
            explain.command = { command: 'codescape.explainIssue', title: 'Explain issue', arguments: [document, issue] };
            explain.diagnostics = [diag];
            actions.push(explain);
        }
        return actions;
    }
    // Ask the AI to rewrite the problematic lines, then let the user confirm before applying
    async applyFix(doc, issue, _range) {
        // Grab a few lines of context around the issue for better AI output
        const start = Math.max(0, issue.line - 3);
        const end = Math.min(doc.lineCount - 1, (issue.endLine ?? issue.line) + 3);
        const ctxRange = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
        const snippet = doc.getText(ctxRange);
        const prompt = [
            `Language: ${doc.languageId}`,
            `Issue on line ${issue.line + 1}: ${issue.message}`,
            issue.suggestion ? `Hint: ${issue.suggestion}` : '',
            `Code (lines ${start + 1}–${end + 1}):`,
            '```', snippet, '```',
        ].filter(Boolean).join('\n');
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Codescape: Generating fix…', cancellable: false }, async () => {
            const fixed = await this.scanner.generateText(FIX_PROMPT, prompt);
            if (!fixed) {
                vscode.window.showWarningMessage('Codescape: AI could not generate a fix.');
                return;
            }
            // Always ask before touching code
            const editor = await vscode.window.showTextDocument(doc);
            const choice = await vscode.window.showInformationMessage('Codescape: Fix ready — apply it?', 'Apply Fix', 'Preview Diff');
            if (choice === 'Apply Fix') {
                await editor.edit(b => b.replace(ctxRange, fixed));
                vscode.window.showInformationMessage('Codescape: ✅ Fix applied.');
            }
            else if (choice === 'Preview Diff') {
                await this.showDiff(doc, snippet, fixed, start);
            }
        });
    }
    // Open a VS Code diff editor so the user can see exactly what changed
    async showDiff(doc, before, after, line) {
        const scheme = 'codeSec-diff';
        const origUri = vscode.Uri.parse(`${scheme}:original/${doc.fileName}?l=${line}`);
        const fixedUri = vscode.Uri.parse(`${scheme}:fixed/${doc.fileName}?l=${line}`);
        // One-shot content provider to serve the before/after text to the diff editor
        const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
            provideTextDocumentContent: (uri) => uri.path.startsWith('/original') ? before : after,
        });
        await vscode.commands.executeCommand('vscode.diff', origUri, fixedUri, `Codescape Fix Preview — ${doc.fileName.split('/').pop()}`);
        // Clean up the content provider after 30 seconds
        setTimeout(() => provider.dispose(), 30000);
    }
    // Ask the AI to explain the issue, then show the explanation in a side panel
    async explainIssue(doc, issue) {
        const start = Math.max(0, issue.line - 2);
        const end = Math.min(doc.lineCount - 1, (issue.endLine ?? issue.line) + 2);
        const snippet = doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
        const prompt = [
            `Language: ${doc.languageId}`,
            `Issue: ${issue.message}`,
            `Rule: ${issue.rule ?? ''}`,
            '```', snippet, '```',
        ].join('\n');
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Codescape: Generating explanation…', cancellable: false }, async () => {
            const text = await this.scanner.generateText(EXPLAIN_PROMPT, prompt);
            if (!text) {
                vscode.window.showWarningMessage('Codescape: Could not generate explanation.');
                return;
            }
            ExplainPanel.show(issue, text);
        });
    }
    dispose() {
        this.disposables.forEach(d => d.dispose());
    }
}
exports.CodeActionsProvider = CodeActionsProvider;
// Reusable side panel — reuses the same panel instead of opening a new one each time
class ExplainPanel {
    static show(issue, markdown) {
        // Reuse existing panel if already open
        if (this.panel) {
            this.panel.reveal();
        }
        else {
            this.panel = vscode.window.createWebviewPanel('codescape.explain', 'Codescape: Explanation', vscode.ViewColumn.Beside, { enableScripts: false });
            this.panel.onDidDispose(() => { this.panel = undefined; });
        }
        // Color per severity for the left border of the header card
        const color = {
            error: '#ef4444', warning: '#f59e0b', info: '#3b82f6', hint: '#6b7280',
        };
        this.panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); padding: 20px 24px; line-height: 1.6; }
  .hdr { border-left: 3px solid ${color[issue.severity] ?? '#6b7280'}; padding: 8px 12px; margin-bottom: 16px; background: rgba(128,128,128,.08); border-radius: 0 6px 6px 0; }
  .sev { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: ${color[issue.severity] ?? '#6b7280'}; font-weight: 700; }
  .rule { font-size: 10px; opacity: .5; font-family: monospace; margin-top: 2px; }
  h1,h2,h3 { font-size: 14px; margin: 14px 0 6px; }
  code { background: rgba(128,128,128,.15); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  pre  { background: var(--vscode-editor-background); border: 1px solid rgba(128,128,128,.2); border-radius: 6px; padding: 12px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  p { margin: 8px 0; }
  strong { font-weight: 600; }
</style>
</head>
<body>
  <div class="hdr">
    <div class="sev">${issue.severity} · ${issue.category}</div>
    <div style="font-weight:600;margin:4px 0">${issue.message.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
    <div class="rule">${issue.rule ?? ''}</div>
  </div>
  ${this.mdToHtml(markdown)}
</body>
</html>`;
    }
    // Minimal markdown → HTML converter for the explanation panel
    static mdToHtml(md) {
        return md
            .replace(/^### (.+)$/gm, '<h3>$1</h3>')
            .replace(/^## (.+)$/gm, '<h2>$1</h2>')
            .replace(/^# (.+)$/gm, '<h1>$1</h1>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
            .replace(/\n\n/g, '</p><p>')
            .replace(/^(?!<[hp])(.+)$/gm, '<p>$1</p>');
    }
}
