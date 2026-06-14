import * as vscode from 'vscode';
import * as path from 'path';

// Analysis pipeline
import { ConfigManager }        from './config/ConfigManager';
import { ResultStore }          from './ResultStore';
import { StaticScanner }        from './scanners/StaticScanner';
import { ComplexityScanner }    from './scanners/ComplexityScanner';
import { DuplicateScanner }     from './scanners/DuplicateScanner';
import { AiScanner }            from './scanners/AiScanner';
import { AnalysisOrchestrator } from './AnalysisOrchestrator';

// UI publishers
import { DiagnosticsPublisher } from './publishers/DiagnosticsPublisher';
import { StatusBarManager }     from './publishers/StatusBarManager';

// Providers
import { DashboardProvider }    from './providers/DashboardProvider';
import { CodeActionsProvider }  from './providers/CodeActionsProvider';

// Context / AI assist
import { FileSummarizer }       from './context/FileSummarizer';
import { ContextPicker }        from './context/ContextPicker';
import { AiContextGenerator }   from './context/AiContextGenerator';

// Code graph feature
import { LanguageParser }       from './graph/LanguageParser';
import { CodeGraphBuilder }     from './graph/CodeGraphBuilder';
import { ImpactAnalyzer }       from './graph/ImpactAnalyzer';
import { GraphPanel }           from './graph/GraphPanel';
import { ImpactCodeLens }       from './graph/ImpactCodeLens';

import { FileAnalysisResult }   from './types';

// Languages Codescape analyzes and graphs.
const SUPPORTED_LANGUAGES = [
  'javascript', 'javascriptreact',
  'typescript', 'typescriptreact',
  'python', 'java',
];

export function activate(context: vscode.ExtensionContext): void {
  console.log('Codescape: activating…');
  try {
    activateInternal(context);
    console.log('Codescape: activated successfully');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Codescape: activation failed —', msg);
    vscode.window.showErrorMessage(`Codescape failed to start: ${msg}`);
  }
}

function activateInternal(context: vscode.ExtensionContext): void {

  // --- Analysis pipeline ---
  const config     = new ConfigManager();
  const store      = new ResultStore();
  const static_    = new StaticScanner();
  const complexity = new ComplexityScanner(config);
  const duplicate  = new DuplicateScanner(config);
  const ai         = new AiScanner(config);
  const diagPub    = new DiagnosticsPublisher();
  const statusBar  = new StatusBarManager(store);
  const dashboard  = new DashboardProvider(store);

  // After every analysis: update squiggles, status bar, dashboard.
  const onComplete = (result: FileAnalysisResult): void => {
    try { diagPub.present(result); } catch (e) { console.error('Codescape diagPub error', e); }
    try { statusBar.render();      } catch (e) { console.error('Codescape statusBar error', e); }
    try { dashboard.refresh();     } catch (e) { console.error('Codescape dashboard error', e); }
  };

  const orchestrator = new AnalysisOrchestrator(
    store, config, static_, complexity, duplicate, ai, onComplete,
  );

  const codeActions = new CodeActionsProvider(store, ai);

  // --- Code graph feature ---
  const parser       = new LanguageParser(context.extensionPath);
  const graphBuilder = new CodeGraphBuilder(parser);
  const graphPanel   = new GraphPanel(context.extensionUri, () => graphBuilder.getGraph());
  const codeLens     = new ImpactCodeLens(() => graphBuilder.getGraph());

  // --- Context / AI assist (now graph-backed) ---
  const summarizer   = new FileSummarizer(ai, context);
  const contextPicker = new ContextPicker(() => graphBuilder.getGraph(), summarizer);
  const aiContextGen  = new AiContextGenerator(() => graphBuilder.getGraph(), summarizer);

  // Blast-radius status bar item (now computed from the graph).
  const blastBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  blastBar.command = 'codescape.showBlastRadius';
  blastBar.tooltip = 'Click to see what depends on this file';
  context.subscriptions.push(blastBar);

  // --- Register providers ---
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewId, dashboard),
  );

  const languageSelector = SUPPORTED_LANGUAGES.map(language => ({ language }));

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      languageSelector,
      codeActions,
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty] },
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(languageSelector, codeLens),
  );

  // --- Helper: analyze a document if it is a supported file ---
  const analyzeDocument = async (document: vscode.TextDocument, debounceMs = 0): Promise<void> => {
    if (document.uri.scheme !== 'file') return;
    if (!SUPPORTED_LANGUAGES.includes(document.languageId)) return;
    try {
      await orchestrator.analyze(document, debounceMs);
    } catch (e) {
      console.error('Codescape analysis error', e);
    }
  };

  // --- Helper: update the blast-radius bar from the graph ---
  const updateBlastBar = (document: vscode.TextDocument): void => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || document.uri.scheme !== 'file') { blastBar.hide(); return; }

    const relFile  = path.relative(root, document.uri.fsPath);
    const analyzer = new ImpactAnalyzer(graphBuilder.getGraph());
    const count    = analyzer.blastRadiusForFile(relFile);

    if (count === 0) {
      blastBar.text = '$(check) No dependents';
      blastBar.backgroundColor = undefined;
    } else if (count <= 3) {
      blastBar.text = `$(info) ${count} dependent(s)`;
      blastBar.backgroundColor = undefined;
    } else if (count <= 8) {
      blastBar.text = `$(warning) ${count} dependents`;
      blastBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      blastBar.text = `$(error) HIGH: ${count} dependents`;
      blastBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    blastBar.show();
  };

  // --- Analysis commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.analyzeFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Codescape: Open a file first.'); return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Codescape: Analyzing…' },
        async () => {
          const result = await orchestrator.analyze(editor.document);
          if (!result) {
            vscode.window.showInformationMessage(`Codescape: ${editor.document.languageId} is not supported.`);
            return;
          }
          const n = result.issues.length;
          const file = vscode.workspace.asRelativePath(editor.document.uri);
          vscode.window.showInformationMessage(
            n === 0 ? `Codescape: No issues in ${file}` : `Codescape: ${n} issue(s) in ${file}`,
          );
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.analyzeWorkspace', async () => {
      const exts = config.getLanguages().flatMap(langToExts).join(',');
      const uris = await vscode.workspace.findFiles(
        `**/*.{${exts}}`, '{**/node_modules/**,**/dist/**,**/out/**}',
      );
      if (!uris.length) { vscode.window.showWarningMessage('Codescape: No supported files found.'); return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Codescape: Scanning ${uris.length} files…`, cancellable: true },
        async (progress, token) => {
          for (let i = 0; i < uris.length; i++) {
            if (token.isCancellationRequested) break;
            try {
              const doc = await vscode.workspace.openTextDocument(uris[i]);
              await orchestrator.analyze(doc);
            } catch { /* skip unreadable files */ }
            progress.report({ message: `${i + 1}/${uris.length}`, increment: (1 / uris.length) * 100 });
          }
          const total = store.getAll().reduce((n, r) => n + r.issues.length, 0);
          vscode.window.showInformationMessage(`Codescape: Done — ${total} issue(s) in ${store.getAll().length} files`);
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.clearIssues', () => {
      store.clear();
      diagPub.clearAll();
      statusBar.render();
      dashboard.refresh();
      vscode.window.showInformationMessage('Codescape: All issues cleared.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.openDashboard', () => {
      vscode.commands.executeCommand('workbench.view.extension.codescape');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.generateConfig', () => {
      generateProjectConfig();
    }),
  );

  // --- Context / AI assist commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.summarizeFiles', async () => {
      try { await summarizer.summarizeWorkspace(); }
      catch (e) { vscode.window.showErrorMessage(`Codescape: Summarize failed — ${e}`); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.generateAiContext', async () => {
      try { await aiContextGen.generate(); }
      catch (e) { vscode.window.showErrorMessage(`Codescape: AI context generation failed — ${e}`); }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.copyAiContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Codescape: Open a file first.'); return; }
      try {
        const text = await contextPicker.buildContext(editor);
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage(`Codescape: Context copied (~${Math.round(text.length / 4)} tokens).`);
      } catch (e) {
        vscode.window.showErrorMessage(`Codescape: Context build failed — ${e}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.copyLightContext', async () => {
      try {
        const text = await contextPicker.buildLightContext();
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage(`Codescape: Light context copied (~${Math.round(text.length / 4)} tokens).`);
      } catch (e) {
        vscode.window.showErrorMessage(`Codescape: Light context failed — ${e}`);
      }
    }),
  );

  // --- Code graph commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.buildGraph', async () => {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Codescape: Building code graph…' },
        async () => {
          await graphBuilder.build();
          codeLens.refresh();
        },
      );
      const n = graphBuilder.getGraph().nodes.length;
      vscode.window.showInformationMessage(`Codescape: Code graph ready — ${n} symbol(s) indexed.`);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.exportGraph', async () => {
      await graphBuilder.build();
      const uri = await graphBuilder.exportToFile();
      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
      }
    }),
  );

  // Opened by the CodeLens above each function.
  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.showImpact', (nodeId: string) => {
      graphPanel.show(nodeId);
    }),
  );

  // Show which files depend on the active file.
  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.showBlastRadius', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('Codescape: Open a file first.'); return; }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;

      const relFile  = path.relative(root, editor.document.uri.fsPath);
      const analyzer = new ImpactAnalyzer(graphBuilder.getGraph());
      const count    = analyzer.blastRadiusForFile(relFile);

      vscode.window.showInformationMessage(
        count === 0
          ? `Codescape: "${path.basename(relFile)}" has no dependents — safe to change.`
          : `Codescape: changing "${path.basename(relFile)}" affects ${count} other file(s).`,
      );
    }),
  );

  // List symbols that nothing calls — possible dead code. Clicking one
  // jumps to its definition. Entry points and dynamic calls may be false
  // positives, so this is framed as "review", not "delete".
  context.subscriptions.push(
    vscode.commands.registerCommand('codescape.findUnused', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('Codescape: No workspace open.'); return; }

      const unused = new ImpactAnalyzer(graphBuilder.getGraph()).findUnusedSymbols();
      if (unused.length === 0) {
        vscode.window.showInformationMessage('Codescape: No unused symbols found.');
        return;
      }

      const items = unused.map(node => ({
        label: node.name,
        description: `${node.kind} · ${node.file}:${node.line + 1}`,
        node,
      }));

      const pick = await vscode.window.showQuickPick(items, {
        title: `${unused.length} possibly-unused symbol(s) — review before deleting`,
        placeHolder: 'No callers found in the graph. Entry points and dynamic calls may be false positives.',
      });

      if (pick) {
        const uri = vscode.Uri.file(path.join(root, pick.node.file));
        const editor = await vscode.window.showTextDocument(uri);
        const pos = new vscode.Position(pick.node.line, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
  );

  // --- Event listeners ---
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async doc => {
      if (config.shouldAnalyzeOnSave()) await analyzeDocument(doc);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async e => {
      if (e.contentChanges.length === 0) return;
      await analyzeDocument(e.document, 1500);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(async doc => {
      setTimeout(() => analyzeDocument(doc), 300);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async editor => {
      if (!editor) { blastBar.hide(); return; }
      await analyzeDocument(editor.document);
      updateBlastBar(editor.document);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(async editors => {
      for (const editor of editors) {
        if (!store.get(editor.document.uri)) await analyzeDocument(editor.document);
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      store.remove(doc.uri);
      diagPub.clear(doc.uri);
      statusBar.render();
      dashboard.refresh();
    }),
  );

  // --- Startup ---
  // Analyze already-open files shortly after load.
  setTimeout(() => {
    for (const editor of vscode.window.visibleTextEditors) {
      analyzeDocument(editor.document).catch(() => {});
    }
    const active = vscode.window.activeTextEditor;
    if (active) updateBlastBar(active.document);
  }, 200);

  // Build the code graph in the background, then refresh the CodeLens
  // and the blast bar so they show real numbers.
  setTimeout(() => {
    graphBuilder.build()
      .then(() => {
        codeLens.refresh();
        const active = vscode.window.activeTextEditor;
        if (active) updateBlastBar(active.document);
      })
      .catch(() => {});
  }, 2500);

  context.subscriptions.push(diagPub, statusBar, dashboard, codeActions, orchestrator);
}

export function deactivate(): void {
  console.log('Codescape: deactivated');
}

// Map VS Code language ids to file extensions for workspace scan globs.
function langToExts(lang: string): string[] {
  const map: Record<string, string[]> = {
    javascript:      ['js', 'mjs'],
    javascriptreact: ['jsx'],
    typescript:      ['ts'],
    typescriptreact: ['tsx'],
    python:          ['py'],
    java:            ['java'],
  };
  return map[lang] ?? [lang];
}

// Write a starter .codescape.json to the workspace root.
async function generateProjectConfig(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { vscode.window.showWarningMessage('Codescape: No workspace open.'); return; }

  const fs   = await import('fs');
  const path = await import('path');
  const dest = path.join(root, '.codescape.json');

  const starter = {
    aiProvider:             'ollama',
    aiModel:                'qwen2.5-coder:7b',
    complexityThreshold:    10,
    duplicateLineThreshold: 6,
    languages:              ['javascript', 'typescript', 'python', 'java'],
    ignorePatterns:         ['**/node_modules/**', '**/dist/**', '**/*.min.js'],
    disabledRules:          [],
  };

  fs.writeFileSync(dest, JSON.stringify(starter, null, 2));
  const doc = await vscode.workspace.openTextDocument(dest);
  await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage('Codescape: .codescape.json created.');
}