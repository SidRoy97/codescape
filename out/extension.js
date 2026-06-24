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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
// Analysis pipeline
const ConfigManager_1 = require("./config/ConfigManager");
const ResultStore_1 = require("./ResultStore");
const StaticScanner_1 = require("./scanners/StaticScanner");
const ComplexityScanner_1 = require("./scanners/ComplexityScanner");
const DuplicateScanner_1 = require("./scanners/DuplicateScanner");
const AiScanner_1 = require("./scanners/AiScanner");
const TaintScanner_1 = require("./scanners/TaintScanner");
const CrossFileTaintScanner_1 = require("./scanners/CrossFileTaintScanner");
const CommentGenerator_1 = require("./reports/CommentGenerator");
const AnalysisOrchestrator_1 = require("./AnalysisOrchestrator");
// UI publishers
const DiagnosticsPublisher_1 = require("./publishers/DiagnosticsPublisher");
const StatusBarManager_1 = require("./publishers/StatusBarManager");
// Providers
const DashboardProvider_1 = require("./providers/DashboardProvider");
const CodeActionsProvider_1 = require("./providers/CodeActionsProvider");
// Context / AI assist
const FileSummarizer_1 = require("./context/FileSummarizer");
// Code graph feature
const LanguageParser_1 = require("./graph/LanguageParser");
const CodeGraphBuilder_1 = require("./graph/CodeGraphBuilder");
const ImpactAnalyzer_1 = require("./graph/ImpactAnalyzer");
const GraphPanel_1 = require("./graph/GraphPanel");
const ImpactCodeLens_1 = require("./graph/ImpactCodeLens");
const SymbolLocator_1 = require("./graph/SymbolLocator");
const LiveImpactBar_1 = require("./graph/LiveImpactBar");
const FlowTracer_1 = require("./graph/FlowTracer");
const SafetyChecker_1 = require("./graph/SafetyChecker");
// Reports
const ProblemsReporter_1 = require("./reports/ProblemsReporter");
const UnderstandingGenerator_1 = require("./reports/UnderstandingGenerator");
const ListPanel_1 = require("./graph/ListPanel");
const SUPPORTED_LANGUAGES = [
    'javascript', 'javascriptreact',
    'typescript', 'typescriptreact',
    'python', 'java',
];
const CODEREACH_OUTPUT_FILES = new Set([
    'codereach.json',
    'codereach-understanding.json',
    'codereach-issues.md',
    'codereach-issues.json',
]);
const isCoderReachOutput = (fsPath) => {
    const fname = path.basename(fsPath);
    return fname.startsWith('codereach-') || CODEREACH_OUTPUT_FILES.has(fname);
};
function activate(context) {
    console.log('CodeReach: activating…');
    try {
        activateInternal(context);
        console.log('CodeReach: activated successfully');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('CodeReach: activation failed —', msg);
        vscode.window.showErrorMessage(`CodeReach failed to start: ${msg}`);
    }
}
function activateInternal(context) {
    // --- Analysis pipeline ---
    const config = new ConfigManager_1.ConfigManager();
    const store = new ResultStore_1.ResultStore();
    const static_ = new StaticScanner_1.StaticScanner();
    const complexity = new ComplexityScanner_1.ComplexityScanner(config);
    const duplicate = new DuplicateScanner_1.DuplicateScanner(config);
    const ai = new AiScanner_1.AiScanner(config);
    const diagPub = new DiagnosticsPublisher_1.DiagnosticsPublisher();
    const statusBar = new StatusBarManager_1.StatusBarManager(store);
    const dashboard = new DashboardProvider_1.DashboardProvider(store);
    const onComplete = (result) => {
        try {
            diagPub.present(result);
        }
        catch (e) {
            console.error('CodeReach diagPub error', e);
        }
        try {
            statusBar.render();
        }
        catch (e) {
            console.error('CodeReach statusBar error', e);
        }
        try {
            dashboard.refresh();
        }
        catch (e) {
            console.error('CodeReach dashboard error', e);
        }
    };
    const orchestrator = new AnalysisOrchestrator_1.AnalysisOrchestrator(store, config, static_, complexity, duplicate, ai, onComplete);
    const codeActions = new CodeActionsProvider_1.CodeActionsProvider(store, ai);
    // --- Code graph feature ---
    const parser = new LanguageParser_1.LanguageParser(context.extensionPath);
    const graphBuilder = new CodeGraphBuilder_1.CodeGraphBuilder(parser);
    const graphPanel = new GraphPanel_1.GraphPanel(context.extensionUri, () => graphBuilder.getGraph());
    const codeLens = new ImpactCodeLens_1.ImpactCodeLens(() => graphBuilder.getGraph());
    // --- Impact intelligence features ---
    const getRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const symbolLocator = new SymbolLocator_1.SymbolLocator(() => graphBuilder.getGraph());
    const liveImpactBar = new LiveImpactBar_1.LiveImpactBar(() => graphBuilder.getGraph(), getRoot);
    const flowTracer = new FlowTracer_1.FlowTracer(() => graphBuilder.getGraph());
    const safetyChecker = new SafetyChecker_1.SafetyChecker(() => graphBuilder.getGraph());
    // --- Context / AI assist ---
    const summarizer = new FileSummarizer_1.FileSummarizer(ai, context);
    const problemsReporter = new ProblemsReporter_1.ProblemsReporter(store, () => graphBuilder.getGraph());
    const listPanel = new ListPanel_1.ListPanel(context.extensionUri);
    const understanding = new UnderstandingGenerator_1.UnderstandingGenerator(() => graphBuilder.getGraph(), summarizer, ai);
    // --- Taint scanners ---
    // Phase 1: intra-file, on-demand.
    const taintScanner = new TaintScanner_1.TaintScanner(parser);
    // Phase 2: cross-file via the code graph, on-demand.
    const crossFileTaint = new CrossFileTaintScanner_1.CrossFileTaintScanner(parser, () => graphBuilder.getGraph());
    // Auto-comment generator — inserts JSDoc/docstrings above uncommented functions.
    const commentGenerator = new CommentGenerator_1.CommentGenerator(parser, ai);
    // Blast-radius status bar item.
    const blastBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    blastBar.command = 'codereach.showBlastRadius';
    blastBar.tooltip = 'Click to see what depends on this file';
    context.subscriptions.push(blastBar);
    // --- Register providers ---
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(DashboardProvider_1.DashboardProvider.viewId, dashboard));
    const languageSelector = SUPPORTED_LANGUAGES.map(language => ({ language }));
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider(languageSelector, codeActions, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Empty] }));
    context.subscriptions.push(vscode.languages.registerCodeLensProvider(languageSelector, codeLens));
    // --- Helper: analyze a document if it is a supported file ---
    const analyzeDocument = async (document, debounceMs = 0) => {
        if (document.uri.scheme !== 'file')
            return;
        if (!SUPPORTED_LANGUAGES.includes(document.languageId))
            return;
        try {
            await orchestrator.analyze(document, debounceMs);
        }
        catch (e) {
            console.error('CodeReach analysis error', e);
        }
    };
    // --- Helper: update the blast-radius bar ---
    const updateBlastBar = (document) => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root || document.uri.scheme !== 'file') {
            blastBar.hide();
            return;
        }
        const relFile = path.relative(root, document.uri.fsPath);
        const analyzer = new ImpactAnalyzer_1.ImpactAnalyzer(graphBuilder.getGraph());
        const count = analyzer.blastRadiusForFile(relFile);
        if (count === 0) {
            blastBar.text = '$(check) No dependents';
            blastBar.backgroundColor = undefined;
        }
        else if (count <= 3) {
            blastBar.text = `$(info) ${count} dependent(s)`;
            blastBar.backgroundColor = undefined;
        }
        else if (count <= 8) {
            blastBar.text = `$(warning) ${count} dependents`;
            blastBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        else {
            blastBar.text = `$(error) HIGH: ${count} dependents`;
            blastBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        }
        blastBar.show();
    };
    // --- Analysis commands ---
    context.subscriptions.push(vscode.commands.registerCommand('codereach.analyzeFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('CodeReach: Open a file first.');
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'CodeReach: Analyzing…' }, async () => {
            const result = await orchestrator.analyze(editor.document);
            if (!result) {
                vscode.window.showInformationMessage(`CodeReach: ${editor.document.languageId} is not supported.`);
                return;
            }
            const n = result.issues.length;
            const file = vscode.workspace.asRelativePath(editor.document.uri);
            vscode.window.showInformationMessage(n === 0 ? `CodeReach: No issues in ${file}` : `CodeReach: ${n} issue(s) in ${file}`);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.analyzeWorkspace', async () => {
        const exts = config.getLanguages().flatMap(langToExts).join(',');
        const uris = await vscode.workspace.findFiles(`**/*.{${exts}}`, '{**/node_modules/**,**/dist/**,**/out/**}');
        if (!uris.length) {
            vscode.window.showWarningMessage('CodeReach: No supported files found.');
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `CodeReach: Scanning ${uris.length} files…`, cancellable: true }, async (progress, token) => {
            for (let i = 0; i < uris.length; i++) {
                if (token.isCancellationRequested)
                    break;
                try {
                    const doc = await vscode.workspace.openTextDocument(uris[i]);
                    await orchestrator.analyze(doc);
                }
                catch { /* skip unreadable files */ }
                progress.report({ message: `${i + 1}/${uris.length}`, increment: (1 / uris.length) * 100 });
            }
            const total = store.getAll().reduce((n, r) => n + r.issues.length, 0);
            vscode.window.showInformationMessage(`CodeReach: Done — ${total} issue(s) in ${store.getAll().length} files`);
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.clearIssues', () => {
        store.clear();
        diagPub.clearAll();
        statusBar.render();
        dashboard.refresh();
        vscode.window.showInformationMessage('CodeReach: All issues cleared.');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.openDashboard', () => {
        vscode.commands.executeCommand('workbench.view.extension.codereach');
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.generateConfig', () => {
        generateProjectConfig();
    }));
    // --- Code graph ---
    const ensureGraph = async () => {
        if (graphBuilder.getGraph().nodes.length === 0) {
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'CodeReach: Building code graph…' }, async () => {
                await graphBuilder.build();
                codeLens.refresh();
            });
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('codereach.exportGraph', async () => {
        await graphBuilder.build();
        const uri = await graphBuilder.exportToFile();
        if (uri) {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.showImpact', (nodeId) => {
        graphPanel.show(nodeId);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.reportIssues', async () => {
        try {
            await problemsReporter.generate();
        }
        catch (e) {
            vscode.window.showErrorMessage(`CodeReach: Report failed — ${e}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.showBlastRadius', async () => {
        const editor = vscode.window.activeTextEditor
            ?? vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
        if (!editor) {
            vscode.window.showWarningMessage('CodeReach: Open a file in the editor first.');
            return;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root)
            return;
        await ensureGraph();
        const relFile = path.relative(root, editor.document.uri.fsPath);
        const graph = graphBuilder.getGraph();
        const ownIds = new Set(graph.nodes.filter(n => n.file === relFile).map(n => n.id));
        const dependents = graph.nodes.filter(node => {
            if (node.file === relFile)
                return false;
            return graph.edges.some(e => e.from === node.id && ownIds.has(e.to));
        });
        const rows = dependents.map(node => ({
            label: node.name,
            detail: `${node.kind} · ${node.file}:${node.line + 1}`,
            file: node.file,
            line: node.line,
            tone: 'danger',
        }));
        listPanel.show({
            title: `Blast Radius — ${path.basename(relFile)}`,
            intro: dependents.length === 0
                ? 'No other file depends on this one — safe to change.'
                : `${dependents.length} symbol(s) in other files depend on this file. Review before changing.`,
            rows,
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.findUnused', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
            vscode.window.showWarningMessage('CodeReach: No workspace open.');
            return;
        }
        await ensureGraph();
        const unused = new ImpactAnalyzer_1.ImpactAnalyzer(graphBuilder.getGraph()).findUnusedSymbols();
        const rows = unused.map(node => ({
            label: node.name,
            detail: `${node.kind} · ${node.file}:${node.line + 1}`,
            file: node.file,
            line: node.line,
            tone: 'warn',
        }));
        listPanel.show({
            title: 'Possibly Unused Symbols',
            intro: unused.length === 0
                ? 'No unused symbols found.'
                : `${unused.length} symbol(s) have no callers in the graph. Entry points and dynamic calls may be false positives — review before deleting.`,
            rows,
        });
    }));
    // --- Impact intelligence commands ---
    const symbolUnderCursor = async () => {
        const editor = vscode.window.activeTextEditor;
        const root = getRoot();
        if (!editor || !root) {
            vscode.window.showWarningMessage('CodeReach: Open a file first.');
            return null;
        }
        await ensureGraph();
        const relFile = path.relative(root, editor.document.uri.fsPath);
        const node = symbolLocator.findEnclosing(relFile, editor.selection.active.line);
        if (!node) {
            vscode.window.showInformationMessage('CodeReach: Place the cursor inside a function or method.');
            return null;
        }
        return { id: node.id, name: node.name };
    };
    context.subscriptions.push(vscode.commands.registerCommand('codereach.showImpactForCursor', async () => {
        const sym = await symbolUnderCursor();
        if (sym)
            graphPanel.show(sym.id);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.traceFlow', async () => {
        const sym = await symbolUnderCursor();
        if (!sym)
            return;
        const rows = flowTracer.trace(sym.id);
        listPanel.show({
            title: `Flow from ${sym.name}`,
            intro: rows.length <= 1
                ? `${sym.name} does not call any tracked symbols.`
                : `${rows.length} step(s) downstream from ${sym.name}, in call order. Click any step to open it.`,
            rows,
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.safetyCheck', async () => {
        const sym = await symbolUnderCursor();
        if (!sym)
            return;
        const rows = safetyChecker.check(sym.id);
        const crossFile = rows.filter(r => r.badge === 'cross-file').length;
        listPanel.show({
            title: `Safety check: ${sym.name}`,
            intro: rows.length === 0
                ? `Nothing calls ${sym.name}. Changing it looks safe.`
                : `${rows.length} call site(s) would be affected (${crossFile} cross-file, higher risk). Review these before changing ${sym.name}.`,
            rows,
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codereach.generateUnderstanding', async () => {
        try {
            await ensureGraph();
            await understanding.generate();
        }
        catch (e) {
            vscode.window.showErrorMessage(`CodeReach: Understanding doc failed — ${e}`);
        }
    }));
    // Auto-comment: insert JSDoc/docstrings above uncommented functions in the active file.
    context.subscriptions.push(vscode.commands.registerCommand('codereach.generateComments', async () => {
        const editor = vscode.window.activeTextEditor
            ?? vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
        if (!editor) {
            vscode.window.showWarningMessage('CodeReach: Open a file first.');
            return;
        }
        try {
            await commentGenerator.generateForFile(editor.document);
        }
        catch (e) {
            vscode.window.showErrorMessage(`CodeReach: Comment generation failed — ${e}`);
        }
    }));
    // --- Taint scan commands ---
    // Phase 1: intra-file on-demand taint scan.
    context.subscriptions.push(vscode.commands.registerCommand('codereach.taintScan', async () => {
        const editor = vscode.window.activeTextEditor
            ?? vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
        if (!editor) {
            vscode.window.showWarningMessage('CodeReach: Open a file first.');
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'CodeReach: Running taint scan…' }, async () => {
            let issues;
            try {
                issues = await taintScanner.scan(editor.document);
            }
            catch (e) {
                vscode.window.showErrorMessage(`CodeReach: Taint scan failed — ${e}`);
                return;
            }
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const relFile = root
                ? path.relative(root, editor.document.uri.fsPath)
                : editor.document.uri.fsPath;
            const rows = issues.map(issue => ({
                label: issue.message,
                detail: `${relFile}:${issue.line + 1}  —  ${issue.suggestion ?? ''}`,
                file: relFile,
                line: issue.line,
                tone: 'danger',
            }));
            listPanel.show({
                title: `Taint Scan — ${path.basename(editor.document.uri.fsPath)}`,
                intro: rows.length === 0
                    ? 'No source-to-sink flows found in this file.'
                    : `${rows.length} taint flow(s) found. Click a row to jump to the sink line.`,
                rows,
            });
        });
    }));
    // Phase 2: cross-file workspace taint scan using the code graph.
    context.subscriptions.push(vscode.commands.registerCommand('codereach.taintScanWorkspace', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'CodeReach: Cross-file taint scan…',
            cancellable: true,
        }, async (progress, token) => {
            // Ensure the graph is built before scanning — Phase 2 needs edges.
            await ensureGraph();
            let flows;
            try {
                flows = await crossFileTaint.scanWorkspace(progress, token);
            }
            catch (e) {
                vscode.window.showErrorMessage(`CodeReach: Cross-file taint scan failed — ${e}`);
                return;
            }
            if (token.isCancellationRequested)
                return;
            const rows = flows.map(flow => ({
                label: flow.issue.message,
                detail: `${flow.sinkFile}:${flow.issue.line + 1}  ·  ${flow.chain.join(' → ')}`,
                file: flow.sinkFile,
                line: flow.issue.line,
                tone: 'danger',
                badge: flow.chain.length > 1 ? 'cross-file' : 'intra-file',
            }));
            // Sort cross-file flows first — they are the novel Phase 2 findings.
            rows.sort((a, b) => {
                if (a.badge === 'cross-file' && b.badge !== 'cross-file')
                    return -1;
                if (b.badge === 'cross-file' && a.badge !== 'cross-file')
                    return 1;
                return 0;
            });
            const crossFileCount = rows.filter(r => r.badge === 'cross-file').length;
            const intraCount = rows.filter(r => r.badge === 'intra-file').length;
            listPanel.show({
                title: 'Cross-File Taint Scan',
                intro: rows.length === 0
                    ? 'No taint flows found across the workspace.'
                    : `${rows.length} flow(s) found: ${crossFileCount} cross-file, ${intraCount} intra-file. Click a row to jump to the sink.`,
                rows,
            });
        });
    }));
    // --- Event listeners ---
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (config.shouldAnalyzeOnSave())
            await analyzeDocument(doc);
    }));
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async (e) => {
        if (e.contentChanges.length === 0)
            return;
        await analyzeDocument(e.document, 1500);
    }));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(async (doc) => {
        setTimeout(() => analyzeDocument(doc), 300);
    }));
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(async (editor) => {
        if (!editor) {
            blastBar.hide();
            liveImpactBar.update(undefined);
            return;
        }
        if (isCoderReachOutput(editor.document.uri.fsPath)) {
            blastBar.hide();
            return;
        }
        await analyzeDocument(editor.document);
        updateBlastBar(editor.document);
        liveImpactBar.update(editor);
    }));
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
        liveImpactBar.update(e.textEditor);
    }));
    context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(async (editors) => {
        for (const editor of editors) {
            if (!store.get(editor.document.uri))
                await analyzeDocument(editor.document);
        }
    }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => {
        store.remove(doc.uri);
        diagPub.clear(doc.uri);
        statusBar.render();
        dashboard.refresh();
    }));
    // --- Startup ---
    setTimeout(() => {
        for (const editor of vscode.window.visibleTextEditors) {
            analyzeDocument(editor.document).catch(() => { });
        }
        const active = vscode.window.activeTextEditor;
        if (active)
            updateBlastBar(active.document);
    }, 200);
    setTimeout(() => {
        graphBuilder.build()
            .then(() => {
            codeLens.refresh();
            const active = vscode.window.activeTextEditor;
            if (active)
                updateBlastBar(active.document);
            liveImpactBar.update(active);
        })
            .catch(() => { });
    }, 2500);
    context.subscriptions.push(diagPub, statusBar, dashboard, codeActions, orchestrator, liveImpactBar);
}
function deactivate() {
    console.log('CodeReach: deactivated');
}
function langToExts(lang) {
    const map = {
        javascript: ['js', 'mjs'],
        javascriptreact: ['jsx'],
        typescript: ['ts'],
        typescriptreact: ['tsx'],
        python: ['py'],
        java: ['java'],
    };
    return map[lang] ?? [lang];
}
async function generateProjectConfig() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
        vscode.window.showWarningMessage('CodeReach: No workspace open.');
        return;
    }
    const fs = await Promise.resolve().then(() => __importStar(require('fs')));
    const path = await Promise.resolve().then(() => __importStar(require('path')));
    const dest = path.join(root, '.codereach.json');
    const starter = {
        aiProvider: 'ollama',
        aiModel: 'qwen2.5-coder:7b',
        complexityThreshold: 10,
        duplicateLineThreshold: 6,
        languages: ['javascript', 'typescript', 'python', 'java'],
        ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/*.min.js'],
        disabledRules: [],
    };
    fs.writeFileSync(dest, JSON.stringify(starter, null, 2));
    const doc = await vscode.workspace.openTextDocument(dest);
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage('CodeReach: .codereach.json created.');
}
