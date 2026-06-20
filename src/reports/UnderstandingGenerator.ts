import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CodeGraph, CodeNode } from '../graph/CodeGraphTypes';
import { ImpactAnalyzer } from '../graph/ImpactAnalyzer';
import { FileSummarizer } from '../context/FileSummarizer';
import { AiScanner } from '../scanners/AiScanner';

// One method inside a class, with its relationships from the graph.
interface MethodEntry {
  name: string;
  summary: string;
  line: number;        // 1-based
  callers: string[];   // names of symbols that call this
  callees: string[];   // names of symbols this calls
}

// One top-level symbol in a file (function or class). Classes carry methods.
interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'method';
  summary: string;
  line: number;        // 1-based
  callers: string[];
  callees: string[];
  methods?: MethodEntry[];
}

// One file's understanding.
interface FileEntry {
  summary: string;
  symbols: SymbolEntry[];
}

// The whole document.
interface UnderstandingDoc {
  project: string;
  generated: string;
  globalContext: string;
  files: Record<string, FileEntry>;
}

// What the AI returns for one file: a map of symbol name -> short summary.
type AiSummaryMap = Record<string, string>;

const FILE_PROMPT =
  'You are documenting code for another AI to understand quickly. ' +
  'For each named symbol I list, write one concise sentence describing what it does and why it exists. ' +
  'Reply ONLY with a JSON object mapping each symbol name to its one-sentence summary. No prose, no code fences.';

const GLOBAL_PROMPT =
  'You are summarizing a software project for another AI. ' +
  'Given the list of files and their summaries, write one short paragraph (3-4 sentences) ' +
  'describing what the project is, its architecture, and how the pieces fit. Reply with plain text only.';

// Common built-in / global method names that are not project symbols. I drop
// these from callers/callees so the relationships only show real functions
// defined in this codebase, not standard-library calls like JSON.parse.
//
// I keep this list conservative: it only includes names that are almost never
// used as project method names (Array/Promise/JSON built-ins). Names like
// "get", "show", "clear", "add", "remove" are intentionally NOT filtered,
// because they are real method names in this project and filtering them would
// drop legitimate edges. The trade-off is that a few true built-in calls with
// those names may remain, which is the safer error.
const BUILTIN_NAMES = new Set([
  'parse', 'stringify',
  'push', 'pop', 'shift', 'unshift', 'map', 'filter', 'reduce', 'forEach',
  'find', 'some', 'every', 'sort', 'join', 'split', 'slice', 'splice',
  'concat', 'includes', 'indexOf', 'keys', 'values', 'entries',
  'then', 'catch', 'finally',
  'toString', 'valueOf', 'call', 'apply', 'bind',
]);

// Single job: build the structured code-understanding document. It reads the
// graph (for symbols + relationships) and the file summaries, asks the AI for
// a one-line summary per symbol (batched one call per file), and writes a
// nested JSON document an LLM can read to understand the whole codebase.
export class UnderstandingGenerator {
  constructor(
    private readonly getGraph: () => CodeGraph,
    private readonly summarizer: FileSummarizer,
    private readonly ai: AiScanner,
  ) {}

  async generate(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      vscode.window.showWarningMessage('Codescape: No workspace open.');
      return;
    }

    const graph = this.getGraph();
    if (graph.nodes.length === 0) {
      vscode.window.showWarningMessage('Codescape: No code symbols found to document.');
      return;
    }

    const analyzer = new ImpactAnalyzer(graph);

    // If file summaries have never been generated, run them now so the
    // file-level summary fields are populated instead of falling back.
    let fileSummaries = this.summarizer.getSummaries();
    if (fileSummaries.size === 0) {
      await this.summarizer.summarizeWorkspace();
      fileSummaries = this.summarizer.getSummaries();
    }

    // Probe the AI once up front. If it returns nothing, the provider is not
    // reachable (e.g. Ollama not running) and every summary would silently be
    // a structural fallback — so warn and let the user fix it first.
    const aiReady = await this.probeAi();
    if (!aiReady) {
      const choice = await vscode.window.showWarningMessage(
        'Codescape: No AI response. The document will contain structure only, not AI summaries. ' +
        'For Ollama: install it, run "ollama pull llama3.2", and make sure "ollama serve" is running. ' +
        'You can also pick a different provider in Settings.',
        'Continue anyway', 'Cancel',
      );
      if (choice !== 'Continue anyway') return;
    }

    // Group nodes by file so each file becomes one AI call.
    const byFile = this.groupByFile(graph.nodes);

    const doc: UnderstandingDoc = {
      project: path.basename(root),
      generated: new Date().toISOString(),
      globalContext: '',
      files: {},
    };

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Codescape: Building understanding…', cancellable: true },
      async (progress, token) => {
        const files = Array.from(byFile.keys());

        for (let i = 0; i < files.length; i++) {
          if (token.isCancellationRequested) break;
          const file = files[i];
          const nodes = byFile.get(file)!;

          const aiSummaries = await this.summarizeFileSymbols(root, file, nodes);
          doc.files[file] = this.buildFileEntry(file, nodes, graph, analyzer, fileSummaries, aiSummaries);

          progress.report({ message: `${i + 1}/${files.length}`, increment: (1 / files.length) * 100 });
        }
      },
    );

    doc.globalContext = await this.buildGlobalContext(doc);

    const outUri = vscode.Uri.file(path.join(root, 'codescape-understanding.json'));
    await vscode.workspace.fs.writeFile(outUri, Buffer.from(JSON.stringify(doc, null, 2), 'utf8'));

    const opened = await vscode.workspace.openTextDocument(outUri);
    await vscode.window.showTextDocument(opened);

    const symbolCount = Object.values(doc.files).reduce((n, f) => n + f.symbols.length, 0);
    vscode.window.showInformationMessage(
      `Codescape: codescape-understanding.json written — ${symbolCount} symbol(s) across ${Object.keys(doc.files).length} file(s).`,
    );
  }

  // A tiny test call to see if the AI provider is reachable. Returns true
  // only when we get a non-empty reply.
  private async probeAi(): Promise<boolean> {
    try {
      const reply = await this.ai.generateText('Reply with the single word: ok', 'ping');
      return !!(reply && reply.trim());
    } catch {
      return false;
    }
  }

  // Group every node under its file path.
  private groupByFile(nodes: CodeNode[]): Map<string, CodeNode[]> {
    const map = new Map<string, CodeNode[]>();
    for (const node of nodes) {
      const list = map.get(node.file) ?? [];
      list.push(node);
      map.set(node.file, list);
    }
    return map;
  }

  // Ask the AI for one-line summaries of every symbol in one file, in a single
  // call. Returns an empty map if the AI is unavailable — callers then fall
  // back to a structural description.
  private async summarizeFileSymbols(root: string, file: string, nodes: CodeNode[]): Promise<AiSummaryMap> {
    let code = '';
    try {
      // I read a generous slice of the file so symbols near the bottom of
      // longer files still get accurate summaries. Very large files are still
      // capped to keep each AI call within a reasonable size.
      code = fs.readFileSync(path.join(root, file), 'utf8').slice(0, 14000);
    } catch {
      return {};
    }

    const symbolList = nodes.map(n => `${n.kind} ${n.name} (line ${n.line + 1})`).join('\n');
    const user = `File: ${file}\nSymbols:\n${symbolList}\n\nCode:\n\`\`\`\n${code}\n\`\`\``;

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

  // Assemble one file's entry: top-level functions and classes, with methods
  // nested under their class by file + line proximity.
  private buildFileEntry(
    file: string,
    nodes: CodeNode[],
    graph: CodeGraph,
    analyzer: ImpactAnalyzer,
    fileSummaries: Map<string, string>,
    aiSummaries: AiSummaryMap,
  ): FileEntry {
    const classes = nodes.filter(n => n.kind === 'class').sort((a, b) => a.line - b.line);
    const functions = nodes.filter(n => n.kind === 'function');
    const methods = nodes.filter(n => n.kind === 'method');

    const symbols: SymbolEntry[] = [];

    // Functions are standalone top-level symbols.
    for (const fn of functions) {
      symbols.push(this.toSymbolEntry(fn, graph, analyzer, aiSummaries));
    }

    // Classes own the methods that fall between this class and the next.
    for (let i = 0; i < classes.length; i++) {
      const cls = classes[i];
      const nextLine = i + 1 < classes.length ? classes[i + 1].line : Number.MAX_SAFE_INTEGER;
      const owned = methods.filter(m => m.line >= cls.line && m.line < nextLine);

      const entry = this.toSymbolEntry(cls, graph, analyzer, aiSummaries);
      entry.methods = owned
        .sort((a, b) => a.line - b.line)
        .map(m => {
          const rel = this.relationships(m, graph, analyzer);
          return {
            name: m.name,
            summary: aiSummaries[m.name] ?? this.fallbackSummary(m),
            line: m.line + 1,
            callers: rel.callers,
            callees: rel.callees,
          };
        });
      symbols.push(entry);
    }

    return {
      summary: fileSummaries.get(file) ?? 'No file summary available — run Summarize Project Files.',
      symbols,
    };
  }

  // Turn a node into a symbol entry with its relationships and summary.
  private toSymbolEntry(node: CodeNode, graph: CodeGraph, analyzer: ImpactAnalyzer, ai: AiSummaryMap): SymbolEntry {
    const rel = this.relationships(node, graph, analyzer);
    return {
      name: node.name,
      kind: node.kind,
      summary: ai[node.name] ?? this.fallbackSummary(node),
      line: node.line + 1,
      callers: rel.callers,
      callees: rel.callees,
    };
  }

  // Caller and callee names for a node, read straight from the graph edges.
  // I filter out built-in/global method names (Map.get, JSON.parse, etc.) so
  // the relationships only list real symbols defined in this project.
  private relationships(node: CodeNode, graph: CodeGraph, analyzer: ImpactAnalyzer): { callers: string[]; callees: string[] } {
    const clean = (names: string[]) => names.filter(n => !BUILTIN_NAMES.has(n));

    const result = analyzer.analyze(node.id);
    if (result) {
      return {
        callers: clean(result.directCallers.map(n => n.name)),
        callees: clean(result.directCallees.map(n => n.name)),
      };
    }
    // Fallback to raw edge scan if analyze returns null.
    const callers = graph.edges.filter(e => e.to === node.id)
      .map(e => graph.nodes.find(n => n.id === e.from)?.name).filter((n): n is string => !!n);
    const callees = graph.edges.filter(e => e.from === node.id)
      .map(e => graph.nodes.find(n => n.id === e.to)?.name).filter((n): n is string => !!n);
    return { callers: clean(callers), callees: clean(callees) };
  }

  // A plain description used when the AI gives nothing, so the document is
  // always populated and useful even offline.
  private fallbackSummary(node: CodeNode): string {
    return `${node.kind} "${node.name}" defined in ${node.file} at line ${node.line + 1}.`;
  }

  // One paragraph describing the whole project. Falls back to a file count
  // when the AI is unavailable.
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