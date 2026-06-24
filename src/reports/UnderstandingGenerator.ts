import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodeGraph, CodeNode } from '../graph/CodeGraphTypes';
import { ImpactAnalyzer } from '../graph/ImpactAnalyzer';
import { PreciseRelationships } from '../graph/PreciseRelationships';
import { FileSummarizer } from '../context/FileSummarizer';
import { AiScanner } from '../scanners/AiScanner';

interface Relation {
  name: string;
  file: string;
}

interface MethodEntry {
  name: string;
  summary: string;
  line: number;
  callers: Relation[];
  callees: Relation[];
}

interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable';
  summary: string;
  line: number;
  callers: Relation[];
  callees: Relation[];
  methods?: MethodEntry[];
  // For variables: the raw value excerpt so the doc shows what it holds.
  value?: string;
  exported?: boolean;
}

interface FileEntry {
  summary: string;
  symbols: SymbolEntry[];
}

interface UnderstandingDoc {
  project: string;
  generated: string;
  globalContext: string;
  files: Record<string, FileEntry>;
}

type AiSummaryMap = Record<string, string>;

const FILE_PROMPT =
  'You are documenting code for another AI to understand quickly. ' +
  'For each named symbol I list, write one concise sentence describing what it does and why it exists. ' +
  'For variables/constants, describe what the value represents and how it is used. ' +
  'Reply ONLY with a JSON object mapping each symbol name to its one-sentence summary. No prose, no code fences.';

const GLOBAL_PROMPT =
  'You are summarizing a software project for another AI. ' +
  'Given the list of files and their summaries, write one short paragraph (3-4 sentences) ' +
  'describing what the project is, its architecture, and how the pieces fit. Reply with plain text only.';

const FILE_SUMMARY_PROMPT =
  'In exactly ONE sentence under 20 words, describe what this file does. ' +
  'Start with a verb. Focus on the single responsibility. ' +
  'Return only the sentence — no filename, no markdown, no extra text.';

const BUILTIN_NAMES = new Set([
  'parse', 'stringify',
  'push', 'pop', 'shift', 'unshift', 'map', 'filter', 'reduce', 'forEach',
  'find', 'some', 'every', 'sort', 'join', 'split', 'slice', 'splice',
  'concat', 'includes', 'indexOf', 'keys', 'values', 'entries',
  'then', 'catch', 'finally',
  'toString', 'valueOf', 'call', 'apply', 'bind',
]);

const SYMBOL_CONTEXT_LINES = 80;

export class UnderstandingGenerator {
  constructor(
    private readonly getGraph: () => CodeGraph,
    private readonly summarizer: FileSummarizer,
    private readonly ai: AiScanner,
  ) {}

  async generate(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      vscode.window.showWarningMessage('CodeReach: No workspace open.');
      return;
    }

    const graph = this.getGraph();
    if (graph.nodes.length === 0) {
      vscode.window.showWarningMessage('CodeReach: No code symbols found to document.');
      return;
    }

    const analyzer = new ImpactAnalyzer(graph);

    const usePrecise = vscode.workspace
      .getConfiguration('codereach')
      .get<boolean>('preciseRelationships', false);
    const precise = usePrecise ? new PreciseRelationships(root) : null;

    const fileSummaries = this.summarizer.getSummaries();
    const byFile = this.groupByFile(graph.nodes);

    const doc: UnderstandingDoc = {
      project: path.basename(root),
      generated: new Date().toISOString(),
      globalContext: '',
      files: {},
    };

    let aiReady = true;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CodeReach: Building understanding…', cancellable: true },
      async (progress, token) => {
        progress.report({ message: 'checking AI provider…' });
        aiReady = await this.probeAi();
        if (!aiReady) return;

        const files = Array.from(byFile.keys());

        for (let i = 0; i < files.length; i++) {
          if (token.isCancellationRequested) break;
          const file  = files[i];
          const nodes = byFile.get(file)!;

          const detail = precise ? ' (precise)' : '';
          progress.report({ message: `summarizing file ${i + 1} of ${files.length}${detail}…`, increment: (1 / files.length) * 100 });

          const fullSource  = this.readFile(root, file);
          const sourceLines = fullSource.split('\n');

          const aiSummaries = await this.summarizeFileSymbols(file, nodes, sourceLines);

          const fileSummary = fileSummaries.get(file)
            ?? await this.deriveFileSummary(file, nodes, sourceLines)
            ?? this.structuralFileSummary(file, nodes);

          doc.files[file] = await this.buildFileEntry(
            file, nodes, graph, analyzer, fileSummary, aiSummaries, precise,
          );
        }

        if (token.isCancellationRequested) return;
        progress.report({ message: 'filling in any gaps…' });
        await this.retryFallbacks(root, byFile, doc, token, progress);

        if (token.isCancellationRequested) return;
        progress.report({ message: 'summarizing the whole project…' });
        doc.globalContext = await this.buildGlobalContext(doc);
      },
    );

    if (!aiReady) {
      const choice = await vscode.window.showWarningMessage(
        'CodeReach: No AI response. The document will contain structure only, not AI summaries. ' +
        'For Ollama: pull a model first ("ollama pull llama3.2"), then start the server ("ollama serve"). ' +
        'You can also pick a different provider in Settings.',
        'Build structure-only', 'Cancel',
      );
      if (choice !== 'Build structure-only') return;

      for (const [file, nodes] of byFile) {
        const fileSummary = this.summarizer.getSummaries().get(file)
          ?? this.structuralFileSummary(file, nodes);
        doc.files[file] = await this.buildFileEntry(
          file, nodes, graph, analyzer, fileSummary, {}, precise,
        );
      }
    }

    const outUri = vscode.Uri.file(path.join(root, 'codereach-understanding.json'));
    await vscode.workspace.fs.writeFile(outUri, Buffer.from(JSON.stringify(doc, null, 2), 'utf8'));

    const opened = await vscode.workspace.openTextDocument(outUri);
    await vscode.window.showTextDocument(opened);

    const symbolCount = Object.values(doc.files).reduce((n, f) => n + f.symbols.length, 0);
    vscode.window.showInformationMessage(
      `CodeReach: codereach-understanding.json written — ${symbolCount} symbol(s) across ${Object.keys(doc.files).length} file(s).`,
    );
  }

  private async probeAi(): Promise<boolean> {
    try {
      const reply = await this.ai.generateText('Reply with the single word: ok', 'ping');
      return !!(reply && reply.trim());
    } catch {
      return false;
    }
  }

  private groupByFile(nodes: CodeNode[]): Map<string, CodeNode[]> {
    const map = new Map<string, CodeNode[]>();
    for (const node of nodes) {
      const list = map.get(node.file) ?? [];
      list.push(node);
      map.set(node.file, list);
    }
    return map;
  }

  private readFile(root: string, relFile: string): string {
    try {
      return fs.readFileSync(path.join(root, relFile), 'utf8');
    } catch {
      return '';
    }
  }

  private symbolSlice(sourceLines: string[], symbolLine: number): string {
    const start = Math.max(0, symbolLine - 3);
    const end   = Math.min(sourceLines.length, start + SYMBOL_CONTEXT_LINES);
    return sourceLines.slice(start, end).join('\n');
  }

  // Ask the AI for one-line summaries of every symbol in one file.
  // Variables get their value excerpt included in the prompt so the AI
  // can describe what the constant actually holds.
  private async summarizeFileSymbols(
    file: string,
    nodes: CodeNode[],
    sourceLines: string[],
  ): Promise<AiSummaryMap> {
    if (sourceLines.length === 0) return {};

    const symbolSections = nodes.map(n => {
      // For variables, include the value directly in the prompt rather than
      // a code slice — the value IS the important context for a constant.
      if (n.kind === 'variable' && (n as any).value) {
        return `### variable ${n.name} (line ${n.line + 1})\nValue: \`${(n as any).value}\``;
      }
      const slice = this.symbolSlice(sourceLines, n.line);
      return `### ${n.kind} ${n.name} (line ${n.line + 1})\n\`\`\`\n${slice}\n\`\`\``;
    }).join('\n\n');

    const user = `File: ${file}\n\nSymbols to document:\n${symbolSections}`.slice(0, 12000);

    try {
      const reply = await this.ai.generateText(FILE_PROMPT, user);
      if (!reply || !reply.trim()) return {};
      const cleaned = reply.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      return (parsed && typeof parsed === 'object') ? parsed as AiSummaryMap : {};
    } catch {
      return {};
    }
  }

  private async deriveFileSummary(
    file: string,
    nodes: CodeNode[],
    sourceLines: string[],
  ): Promise<string | null> {
    if (sourceLines.length === 0) return null;
    const snippet    = sourceLines.slice(0, 60).join('\n');
    const symbolList = nodes.map(n => `${n.kind} ${n.name}`).join(', ');
    const user = `File: ${file}\nSymbols: ${symbolList}\n\`\`\`\n${snippet}\n\`\`\``;
    try {
      const reply = await this.ai.generateText(FILE_SUMMARY_PROMPT, user);
      if (reply && reply.trim()) return reply.trim();
    } catch {
      // fall through
    }
    return null;
  }

  private structuralFileSummary(file: string, nodes: CodeNode[]): string {
    const classes   = nodes.filter(n => n.kind === 'class').map(n => n.name);
    const functions = nodes.filter(n => n.kind === 'function').map(n => n.name);
    const variables = nodes.filter(n => n.kind === 'variable').map(n => n.name);
    const basename  = path.basename(file, path.extname(file));

    if (classes.length > 0) {
      return `Defines ${classes.join(', ')} — ${basename} class${classes.length > 1 ? 'es' : ''} with ${nodes.length} symbol(s).`;
    }
    if (functions.length > 0) {
      return `Exports ${functions.slice(0, 3).join(', ')}${functions.length > 3 ? ` and ${functions.length - 3} more` : ''} from ${basename}.`;
    }
    if (variables.length > 0) {
      return `Defines constants ${variables.slice(0, 3).join(', ')}${variables.length > 3 ? ` and ${variables.length - 3} more` : ''} in ${basename}.`;
    }
    return `${basename} module with ${nodes.length} symbol(s).`;
  }

  private async retryFallbacks(
    root: string,
    byFile: Map<string, CodeNode[]>,
    doc: UnderstandingDoc,
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
  ): Promise<void> {
    const filesToRetry: Array<{ file: string; names: Set<string> }> = [];
    for (const [file, entry] of Object.entries(doc.files)) {
      const missing = new Set<string>();
      for (const sym of entry.symbols) {
        if (this.isFallback(sym.summary)) missing.add(sym.name);
        for (const m of sym.methods ?? []) {
          if (this.isFallback(m.summary)) missing.add(m.name);
        }
      }
      if (missing.size > 0) filesToRetry.push({ file, names: missing });
    }

    if (filesToRetry.length === 0) return;

    for (let i = 0; i < filesToRetry.length; i++) {
      if (token.isCancellationRequested) return;
      const { file, names } = filesToRetry[i];
      const allNodes = byFile.get(file);
      if (!allNodes) continue;

      const missingNodes = allNodes.filter(n => names.has(n.name));
      const sourceLines  = this.readFile(root, file).split('\n');
      const retry = await this.summarizeFileSymbols(file, missingNodes, sourceLines);

      const entry = doc.files[file];
      for (const sym of entry.symbols) {
        if (this.isFallback(sym.summary) && retry[sym.name]?.trim()) {
          sym.summary = retry[sym.name];
        }
        for (const m of sym.methods ?? []) {
          if (this.isFallback(m.summary) && retry[m.name]?.trim()) {
            m.summary = retry[m.name];
          }
        }
      }

      progress.report({ message: `retry ${i + 1}/${filesToRetry.length}` });
    }
  }

  private async buildFileEntry(
    _file: string,
    nodes: CodeNode[],
    graph: CodeGraph,
    analyzer: ImpactAnalyzer,
    fileSummary: string,
    aiSummaries: AiSummaryMap,
    precise: PreciseRelationships | null,
  ): Promise<FileEntry> {
    const classes   = nodes.filter(n => n.kind === 'class').sort((a, b) => a.line - b.line);
    const functions = nodes.filter(n => n.kind === 'function');
    const methods   = nodes.filter(n => n.kind === 'method');
    const variables = nodes.filter(n => n.kind === 'variable');

    const symbols: SymbolEntry[] = [];

    // Module-level variables/constants — listed first so they provide
    // context for the functions and classes that follow.
    for (const v of variables) {
      const summary = aiSummaries[v.name] ?? this.variableFallbackSummary(v);
      symbols.push({
        name:     v.name,
        kind:     'variable',
        summary,
        line:     v.line + 1,
        callers:  [],
        callees:  [],
        value:    (v as any).value,
        exported: (v as any).exported,
      });
    }

    // Standalone top-level functions.
    for (const fn of functions) {
      symbols.push(await this.toSymbolEntry(fn, graph, analyzer, aiSummaries, precise));
    }

    // Classes own the methods that fall between this class and the next.
    for (let i = 0; i < classes.length; i++) {
      const cls      = classes[i];
      const nextLine = i + 1 < classes.length ? classes[i + 1].line : Number.MAX_SAFE_INTEGER;
      const owned    = methods.filter(m => m.line >= cls.line && m.line < nextLine);

      const entry       = await this.toSymbolEntry(cls, graph, analyzer, aiSummaries, precise);
      const ownedSorted = owned.sort((a, b) => a.line - b.line);
      const methodEntries: MethodEntry[] = [];

      for (const m of ownedSorted) {
        const rel = await this.relationships(m, graph, analyzer, precise);
        methodEntries.push({
          name:    m.name,
          summary: aiSummaries[m.name] ?? this.fallbackSummary(m),
          line:    m.line + 1,
          callers: rel.callers,
          callees: rel.callees,
        });
      }
      entry.methods = methodEntries;
      symbols.push(entry);
    }

    return { summary: fileSummary, symbols };
  }

  private async toSymbolEntry(
    node: CodeNode,
    graph: CodeGraph,
    analyzer: ImpactAnalyzer,
    ai: AiSummaryMap,
    precise: PreciseRelationships | null,
  ): Promise<SymbolEntry> {
    const rel = await this.relationships(node, graph, analyzer, precise);
    return {
      name:    node.name,
      kind:    node.kind as SymbolEntry['kind'],
      summary: ai[node.name] ?? this.fallbackSummary(node),
      line:    node.line + 1,
      callers: rel.callers,
      callees: rel.callees,
    };
  }

  private async relationships(
    node: CodeNode,
    graph: CodeGraph,
    analyzer: ImpactAnalyzer,
    precise: PreciseRelationships | null,
  ): Promise<{ callers: Relation[]; callees: Relation[] }> {
    if (precise) {
      const result = await precise.forNode(node);
      if (result) {
        const filterBuiltins = (rels: Relation[]) => rels.filter(r => !BUILTIN_NAMES.has(r.name));
        return {
          callers: filterBuiltins(result.callers),
          callees: filterBuiltins(result.callees),
        };
      }
    }

    const clean = (nodes: CodeNode[]): Relation[] => {
      const seen = new Set<string>();
      const out: Relation[] = [];
      for (const n of nodes) {
        if (BUILTIN_NAMES.has(n.name)) continue;
        const key = `${n.file}:${n.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name: n.name, file: n.file });
      }
      return out;
    };

    const result = analyzer.analyze(node.id);
    if (result) {
      return {
        callers: clean(result.directCallers),
        callees: clean(result.directCallees),
      };
    }
    const callerNodes = graph.edges.filter(e => e.to === node.id)
      .map(e => graph.nodes.find(n => n.id === e.from)).filter((n): n is CodeNode => !!n);
    const calleeNodes = graph.edges.filter(e => e.from === node.id)
      .map(e => graph.nodes.find(n => n.id === e.to)).filter((n): n is CodeNode => !!n);
    return { callers: clean(callerNodes), callees: clean(calleeNodes) };
  }

  // Fallback for functions/classes/methods when AI gives nothing.
  private fallbackSummary(node: CodeNode): string {
    return `${node.kind} "${node.name}" defined in ${node.file} at line ${node.line + 1}.`;
  }

  // Fallback for variables — include the value excerpt so the doc is
  // never blank even without AI, which is especially useful for constants
  // like SUPPORTED_LANGUAGES or SOURCE_PATTERNS.
  private variableFallbackSummary(node: CodeNode): string {
    const value = (node as any).value;
    const exported = (node as any).exported ? 'Exported constant' : 'Module-level constant';
    if (value) {
      return `${exported} "${node.name}" = ${value.slice(0, 80)}`;
    }
    return `${exported} "${node.name}" defined at line ${node.line + 1}.`;
  }

  private isFallback(summary: string): boolean {
    return / defined in .+ at line \d+\.$/.test(summary)
        || / defined at line \d+\.$/.test(summary);
  }

  private async buildGlobalContext(doc: UnderstandingDoc): Promise<string> {
    const lines = Object.entries(doc.files)
      .map(([file, entry]) => `${file}: ${entry.summary}`)
      .join('\n');

    try {
      const reply = await this.ai.generateText(GLOBAL_PROMPT, lines);
      if (reply && reply.trim()) return reply.trim();
    } catch {
      // fall through
    }
    return `Project "${doc.project}" with ${Object.keys(doc.files).length} analyzed file(s). ` +
           `Run Summarize Project Files and ensure an AI provider is configured for richer context.`;
  }
}