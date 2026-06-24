import * as vscode from 'vscode';
import * as path from 'path';

// Analysis pipeline
import { ConfigManager }        from './config/ConfigManager';
import { ResultStore }          from './ResultStore';
import { StaticScanner }        from './scanners/StaticScanner';
import { ComplexityScanner }    from './scanners/ComplexityScanner';
import { DuplicateScanner }     from './scanners/DuplicateScanner';
import { AiScanner }            from './scanners/AiScanner';
import { TaintScanner }         from './scanners/TaintScanner';
import { AnalysisOrchestrator } from './AnalysisOrchestrator';

// UI publishers
import { DiagnosticsPublisher } from './publishers/DiagnosticsPublisher';
import { StatusBarManager }     from './publishers/StatusBarManager';

// Providers
import { DashboardProvider }    from './providers/DashboardProvider';
import { CodeActionsProvider }  from './providers/CodeActionsProvider';

// Context / AI assist
import { FileSummarizer }       from './context/FileSummarizer';

// Code graph feature
import { LanguageParser }       from './graph/LanguageParser';
import { CodeGraphBuilder }     from './graph/CodeGraphBuilder';
import { ImpactAnalyzer }       from './graph/ImpactAnalyzer';
import { GraphPanel }           from './graph/GraphPanel';
import { ImpactCodeLens }       from './graph/ImpactCodeLens';
import { SymbolLocator }        from './graph/SymbolLocator';
import { LiveImpactBar }        from './graph/LiveImpactBar';
import { FlowTracer }           from './graph/FlowTracer';
import { SafetyChecker }        from './graph/SafetyChecker';

// Reports
import { ProblemsReporter }     from './reports/ProblemsReporter';
import { UnderstandingGenerator } from './reports/UnderstandingGenerator';
import { ListPanel }            from './graph/ListPanel';
import { ListRow }              from './graph/ListPanel';

import { FileAnalysisResult }   from './types';

// Languages CodeReach analyzes and graphs.
const SUPPORTED_LANGUAGES = [
  'javascript', 'javascriptreact',
  'typescript', 'typescriptreact',
  'python', 'java',
];

// Files CodeReach writes to the workspace root. Opening them triggers
// onDidChangeActiveTextEditor — we skip the graph traversal for these so
// we don't spike CPU right after the Understanding Doc or Problems Report
// is generated.
const CODEREACH_OUTPUT_FILES = new Set([
  'codereach.json',
  'codereach-understanding.json',
  'codereach-issues.md',
  'codereach-issues.json',
]);

const isCoderReachOutput = (fsPath: string): boolean => {
  const fname = path.basename(fsPath);
  return fname.startsWith('codereach-') || CODEREACH_OUTPUT_FILES.has(fname);
};

export function activate(context: vscode.ExtensionContext): void {
  console.log('CodeReach: activating…');
  try {
    activateInternal(context);
    console.log('CodeReach: activated successfully');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('CodeReach: activation failed —', msg);
    vscode.window.showErrorMessage(`CodeReach failed to start: ${msg}`);
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
    try { diagPub.present(result); } catch (e) { console.error('CodeReach diagPub error', e); }
    try { statusBar.render();      } catch (e) { console.error('CodeReach statusBar error', e); }
    try { dashboard.refresh();     } catch (e) { console.error('CodeReach dashboard error', e); }
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

  // --- Impact intelligence features (all graph-backed, no AI needed) ---
  const getRoot       = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const symbolLocator = new SymbolLocator(() => graphBuilder.getGraph());
  const liveImpactBar = new LiveImpactBar(() => graphBuilder.getGraph(), getRoot);
  const flowTracer    = new FlowTracer(() => graphBuilder.getGraph());
  const safetyChecker = new SafetyChecker(() => graphBuilder.getGraph());

  // --- Context / AI assist (now graph-backed) ---
  const summarizer   = new FileSummarizer(ai, context);

  // Problems report writer (reads ResultStore, names functions via the graph)
  const problemsReporter = new ProblemsReporter(store, () => graphBuilder.getGraph());

  // One reusable list panel for Build Graph / Find Unused / Blast Radius / Taint.
  const listPanel = new ListPanel(context.extensionUri);

  // Structured project-understanding document generator.
  const understanding = new UnderstandingGenerator(
    () => graphBuilder.getGraph(), summarizer, ai,
  );

  // On-demand intra-file taint scanner (Phase 1 — source-to-sink within one file).
  const taintScanner = new TaintScanner(parser);

  // Blast-radius status bar item (now computed from the graph).
  const blastBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  blastBar.command = 'codereach.showBlastRadius';
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
      console.error('CodeReach analysis error', e);
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
    vscode.commands.registerCommand('codereach.analyzeFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { vscode.window.showWarningMessage('CodeReach: Open a file first.'); return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CodeReach: Analyzing…' },
        async () => {
          const result = await orchestrator.analyze(editor.document);
          if (!result) {
            vscode.window.showInformationMessage(`CodeReach: ${editor.document.languageId} is not supported.`);
            return;
          }
          const n = result.issues.length;
          const file = vscode.workspace.asRelativePath(editor.document.uri);
          vscode.window.showInformationMessage(
            n === 0 ? `CodeReach: No issues in ${file}` : `CodeReach: ${n} issue(s) in ${file}`,
          );
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.analyzeWorkspace', async () => {
      const exts = config.getLanguages().flatMap(langToExts).join(',');
      const uris = await vscode.workspace.findFiles(
        `**/*.{${exts}}`, '{**/node_modules/**,**/dist/**,**/out/**}',
      );
      if (!uris.length) { vscode.window.showWarningMessage('CodeReach: No supported files found.'); return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `CodeReach: Scanning ${uris.length} files…`, cancellable: true },
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
          vscode.window.showInformationMessage(`CodeReach: Done — ${total} issue(s) in ${store.getAll().length} files`);
        },
      );
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.clearIssues', () => {
      store.clear();
      diagPub.clearAll();
      statusBar.render();
      dashboard.refresh();
      vscode.window.showInformationMessage('CodeReach: All issues cleared.');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.openDashboard', () => {
      vscode.commands.executeCommand('workbench.view.extension.codereach');
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.generateConfig', () => {
      generateProjectConfig();
    }),
  );

  // --- Code graph (internal) ---
  // The graph is built on activation. This helper rebuilds it on demand if it
  // is somehow empty, so the features that read it (Blast Radius, Find Unused,
  // Understanding Doc) always have data without a user-facing "build" step.
  const ensureGraph = async (): Promise<void> => {
    if (graphBuilder.getGraph().nodes.length === 0) {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CodeReach: Building code graph…' },
        async () => {
          await graphBuilder.build();
          codeLens.refresh();
        },
      );
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.exportGraph', async () => {
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
    vscode.commands.registerCommand('codereach.showImpact', (nodeId: string) => {
      graphPanel.show(nodeId);
    }),
  );

  // Write a project-wide problems report (markdown + json).
  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.reportIssues', async () => {
      try {
        await problemsReporter.generate();
      } catch (e) {
        vscode.window.showErrorMessage(`CodeReach: Report failed — ${e}`);
      }
    }),
  );

  // Show which files depend on the active file, as a clickable list.
  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.showBlastRadius', async () => {
      // When this runs from a dashboard button, the webview holds focus and
      // activeTextEditor is undefined, so I fall back to the first visible
      // file editor before giving up.
      const editor = vscode.window.activeTextEditor
        ?? vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
      if (!editor) { vscode.window.showWarningMessage('CodeReach: Open a file in the editor first.'); return; }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) return;

      await ensureGraph();
      const relFile = path.relative(root, editor.document.uri.fsPath);
      const graph   = graphBuilder.getGraph();

      // Symbols defined in this file.
      const ownIds = new Set(graph.nodes.filter(n => n.file === relFile).map(n => n.id));

      // Symbols in other files that call into this file's symbols.
      const dependents = graph.nodes.filter(node => {
        if (node.file === relFile) return false;
        return graph.edges.some(e => e.from === node.id && ownIds.has(e.to));
      });

      const rows: ListRow[] = dependents.map(node => ({
        label: node.name,
        detail: `${node.kind} · ${node.file}:${node.line + 1}`,
        file: node.file,
        line: node.line,
        tone: 'danger' as const,
      }));

      listPanel.show({
        title: `Blast Radius — ${path.basename(relFile)}`,
        intro: dependents.length === 0
          ? 'No other file depends on this one — safe to change.'
          : `${dependents.length} symbol(s) in other files depend on this file. Review before changing.`,
        rows,
      });
    }),
  );

  // List symbols that nothing calls — possible dead code. Each row opens
  // the symbol. Entry points and dynamic calls may be false positives, so
  // this is framed as "review", not "delete".
  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.findUnused', async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) { vscode.window.showWarningMessage('CodeReach: No workspace open.'); return; }

      await ensureGraph();
      const unused = new ImpactAnalyzer(graphBuilder.getGraph()).findUnusedSymbols();

      const rows: ListRow[] = unused.map(node => ({
        label: node.name,
        detail: `${node.kind} · ${node.file}:${node.line + 1}`,
        file: node.file,
        line: node.line,
        tone: 'warn' as const,
      }));

      listPanel.show({
        title: 'Possibly Unused Symbols',
        intro: unused.length === 0
          ? 'No unused symbols found.'
          : `${unused.length} symbol(s) have no callers in the graph. Entry points and dynamic calls may be false positives — review before deleting.`,
        rows,
      });
    }),
  );

  // --- Impact intelligence commands ---

  // I find the symbol the cursor is in, building the graph first if needed.
  const symbolUnderCursor = async (): Promise<{ id: string; name: string } | null> => {
    const editor = vscode.window.activeTextEditor;
    const root = getRoot();
    if (!editor || !root) { vscode.window.showWarningMessage('CodeReach: Open a file first.'); return null; }

    await ensureGraph();
    const relFile = path.relative(root, editor.document.uri.fsPath);
    const node = symbolLocator.findEnclosing(relFile, editor.selection.active.line);
    if (!node) { vscode.window.showInformationMessage('CodeReach: Place the cursor inside a function or method.'); return null; }
    return { id: node.id, name: node.name };
  };

  // Feature 1 click target: open the impact graph for the cursor's symbol.
  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.showImpactForCursor', async () => {
      const sym = await symbolUnderCursor();
      if (sym) graphPanel.show(sym.id);
    }),
  );

  // Feature 2: trace the flow downward from the cursor's symbol.
  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.traceFlow', async () => {
      const sym = await symbolUnderCursor();
      if (!sym) return;

      const rows = flowTracer.trace(sym.id);
      listPanel.show({
        title: `Flow from ${sym.name}`,
        intro: rows.length <= 1
          ? `${sym.name} does not call any tracked symbols.`
          : `${rows.length} step(s) downstream from ${sym.name}, in call order. Click any step to open it.`,
        rows,
      });
    }),
  );

  // Feature 3: safety check — what breaks if the cursor's symbol changes.
  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.safetyCheck', async () => {
      const sym = await symbolUnderCursor();
      if (!sym) return;

      const rows = safetyChecker.check(sym.id);
      const crossFile = rows.filter(r => r.badge === 'cross-file').length;
      listPanel.show({
        title: `Safety check: ${sym.name}`,
        intro: rows.length === 0
          ? `Nothing calls ${sym.name}. Changing it looks safe.`
          : `${rows.length} call site(s) would be affected (${crossFile} cross-file, higher risk). Review these before changing ${sym.name}.`,
        rows,
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.generateUnderstanding', async () => {
      try {
        await ensureGraph();
        await understanding.generate();
      } catch (e) {
        vscode.window.showErrorMessage(`CodeReach: Understanding doc failed — ${e}`);
      }
    }),
  );

  // On-demand taint scan for the active file — finds source-to-sink data flows
  // (e.g. req.body reaching innerHTML without sanitization). Runs the
  // intra-file Phase 1 engine and shows results in the ListPanel.
  // Kept separate from the save-triggered pipeline because AST taint walking
  // is heavier than regex rules and should be an explicit developer action.
  context.subscriptions.push(
    vscode.commands.registerCommand('codereach.taintScan', async () => {
      const editor = vscode.window.activeTextEditor
        ?? vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
      if (!editor) {
        vscode.window.showWarningMessage('CodeReach: Open a file first.');
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'CodeReach: Running taint scan…' },
        async () => {
          let issues: Awaited<ReturnType<typeof taintScanner.scan>>;
          try {
            issues = await taintScanner.scan(editor.document);
          } catch (e) {
            vscode.window.showErrorMessage(`CodeReach: Taint scan failed — ${e}`);
            return;
          }

          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const relFile = root
            ? path.relative(root, editor.document.uri.fsPath)
            : editor.document.uri.fsPath;

          const rows: ListRow[] = issues.map(issue => ({
            label:  issue.message,
            detail: `${relFile}:${issue.line + 1}  —  ${issue.suggestion ?? ''}`,
            file:   relFile,
            line:   issue.line,
            tone:   'danger' as const,
          }));

          listPanel.show({
            title: `Taint Scan — ${path.basename(editor.document.uri.fsPath)}`,
            intro: rows.length === 0
              ? 'No source-to-sink flows found in this file.'
              : `${rows.length} taint flow(s) found. Click a row to jump to the sink line.`,
            rows,
          });
        },
      );
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
      if (!editor) { blastBar.hide(); liveImpactBar.update(undefined); return; }

      // Skip CodeReach's own output files — opening them would trigger a full
      // graph traversal for no reason, causing a CPU spike after the
      // Understanding Doc or Problems Report is generated.
      if (isCoderReachOutput(editor.document.uri.fsPath)) {
        blastBar.hide();
        return;
      }

      await analyzeDocument(editor.document);
      updateBlastBar(editor.document);
      liveImpactBar.update(editor);
    }),
  );

  // Update the live impact bar as the cursor moves between symbols.
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      liveImpactBar.update(e.textEditor);
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
        liveImpactBar.update(active);
      })
      .catch(() => {});
  }, 2500);

  context.subscriptions.push(diagPub, statusBar, dashboard, codeActions, orchestrator, liveImpactBar);
}

export function deactivate(): void {
  console.log('CodeReach: deactivated');
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

// Write a starter .codereach.json to the workspace root.
async function generateProjectConfig(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { vscode.window.showWarningMessage('CodeReach: No workspace open.'); return; }

  const fs   = await import('fs');
  const path = await import('path');
  const dest = path.join(root, '.codereach.json');

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
  vscode.window.showInformationMessage('CodeReach: .codereach.json created.');
}