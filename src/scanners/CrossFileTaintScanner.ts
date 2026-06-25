import * as vscode from 'vscode';
import { Node } from 'web-tree-sitter';
import { CodeGraph, CodeNode } from '../graph/CodeGraphTypes';
import { CodeGraphBuilder } from '../graph/CodeGraphBuilder';
import { LanguageParser } from '../graph/LanguageParser';
import { TaintScanner, SOURCE_PATTERNS, SANITIZERS } from './TaintScanner';
import { Issue } from '../types';

// A taint flow that crossed a file boundary.
export interface CrossFileTaintFlow {
  issue:    Issue;
  sinkFile: string;
  // Full call chain from entry-point to sink function.
  // Each entry is "functionName (file)" for display.
  chain:    string[];
}

// Represents a function whose parameters are known to carry tainted data,
// and which specific parameter names are tainted.
interface TaintedCallee {
  file:         string;
  functionName: string;
  // The parameter names that are tainted at this call site.
  taintedParams: Set<string>;
  // The call chain that produced this taint (for reporting).
  chain:        string[];
}

// Maximum number of cross-file hops to follow taint.
// 4 is enough for real-world patterns without blowing up on large codebases.
const MAX_DEPTH = 4;

// Grammar names the AST parser returns per language ID.
const LANG_TO_GRAMMAR: Record<string, string> = {
  javascript:      'javascript',
  javascriptreact: 'javascript',
  typescript:      'typescript',
  typescriptreact: 'typescript',
  python:          'python',
  java:            'java',
};

// Function-definition node types per grammar, matching TaintScanner's list.
const FN_TYPES: Record<string, string[]> = {
  javascript: ['function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
  typescript: ['function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
  python:     ['function_definition'],
  java:       ['method_declaration', 'constructor_declaration'],
};

export class CrossFileTaintScanner {
  private readonly phase1: TaintScanner;

  constructor(
    private readonly parser: LanguageParser,
    private readonly getGraph: () => CodeGraph,
    private readonly graphBuilder: CodeGraphBuilder,
  ) {
    this.phase1 = new TaintScanner(parser);
  }

  async scanWorkspace(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token:    vscode.CancellationToken,
  ): Promise<CrossFileTaintFlow[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];

    // Build the graph if it hasn't been built yet — the taint scan must
    // never depend on the user having manually triggered graph export first.
    let graph = this.getGraph();
    if (graph.nodes.length === 0) {
      progress.report({ message: 'building code graph…' });
      graph = await this.graphBuilder.build();
    }

    // Skip static assets, vendor files and minified bundles.
    const SKIP_PATTERNS = [
      /[\/\\]static[\/\\]/,
      /[\/\\]vendor[\/\\]/,
      /[\/\\]assets[\/\\]/,
      /[\/\\]node_modules[\/\\]/,
      /[\/\\]target[\/\\]/,
      /[\/\\]__pycache__[\/\\]/,
      /[\/\\]venv[\/\\]/,
      /[\/\\]\.venv[\/\\]/,
      /[\/\\]env[\/\\]/,
      /[\/\\]migrations[\/\\]/,
      /[\/\\]generated[\/\\]/,
      /[\/\\]\.next[\/\\]/,
      /[\/\\]coverage[\/\\]/,
      /\.min\.[jt]s$/,
      /\.bundle\.[jt]s$/,
      /\.chunk\.[jt]s$/,
      /\.pyc$/,
    ];
    const isSkipped = (f: string) => SKIP_PATTERNS.some(p => p.test(f));

    // Phase 0: scan ALL workspace files for intra-file taint, regardless of
    // whether the graph has an entry for them. This way taint is never
    // invisible just because a file has no outgoing calls.
    const allUris = await vscode.workspace.findFiles(
      '**/*.{js,jsx,ts,tsx,py,java}',
      '{**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/target/**,**/static/**,**/vendor/**,**/assets/**,**/__pycache__/**,**/venv/**,**/.venv/**,**/env/**,**/migrations/**,**/generated/**,**/generated-sources/**,**/.next/**,**/.nuxt/**,**/coverage/**,**/__generated__/**,**/*.min.js,**/*.bundle.js,**/*.chunk.js,**/*.pyc}',
    );
    const allFiles = allUris.map(u => {
      const rel = vscode.workspace.asRelativePath(u);
      return { uri: u, rel };
    }).filter(f => !isSkipped(f.rel));

    const graphFiles = [...new Set(graph.nodes.map(n => n.file))].filter(f => !isSkipped(f));
    // Merge: use graph files + any additional files found by glob
    const allRelFiles = [...new Set([
      ...graphFiles,
      ...allFiles.map(f => f.rel),
    ])];

    const files = allRelFiles;
    const flows: CrossFileTaintFlow[] = [];

    // ── Phase 1 pass: find all intra-file flows and record which functions
    //    touch tainted data so Phase 2 can propagate across file boundaries. ──

    // file → { functionName → Set<tainted variable names at the call site> }
    // We track which variables are tainted at each call in the source function
    // so we can match them to the callee's parameter positions.
    const taintedCallerVars = new Map<string, Map<string, Set<string>>>();

    progress.report({ message: 'scanning files for taint sources…' });

    for (let i = 0; i < files.length; i++) {
      if (token.isCancellationRequested) return flows;
      const file = files[i];
      progress.report({
        message:   `phase 1: ${i + 1}/${files.length} — ${file}`,
        increment: (1 / files.length) * 50,
      });

      const doc = await this.openDoc(root, file);
      if (!doc) continue;

      // Standard Phase 1 — catches all intra-file flows.
      const issues = await this.phase1.scan(doc);
      for (const issue of issues) {
        const fn = this.enclosingFunction(graph, file, issue.line) ?? '(file scope)';
        flows.push({ issue, sinkFile: file, chain: [`${fn} (${file})`] });
      }

      // Also extract which variables are tainted inside each function so
      // Phase 2 can determine which call arguments carry taint.
      const parsed = await this.parser.parseTree(doc);
      if (!parsed) continue;
      const grammar = LANG_TO_GRAMMAR[doc.languageId];
      if (!grammar) continue;
      const fnTypes = FN_TYPES[grammar] ?? [];

      const fileVarMap = new Map<string, Set<string>>();
      this.parser.walk(parsed.root, node => {
        if (!fnTypes.includes(node.type)) return;
        const nameNode = node.childForFieldName('name');
        if (!nameNode) return;
        const fnName = nameNode.text;
        const taintedVars = this.collectTaintedVars(node);
        if (taintedVars.size > 0) {
          fileVarMap.set(fnName, taintedVars);
        }
      });

      if (fileVarMap.size > 0) {
        taintedCallerVars.set(file, fileVarMap);
      }
    }

    // ── Phase 2: propagate taint across file boundaries. ──
    // For each function that has tainted variables, find its cross-file
    // callees. Extract the callee's parameter names from the AST and check
    // whether the tainted variables are passed as arguments at the call site.
    // If so, seed those parameters as tainted in the callee and scan its body.

    progress.report({ message: 'tracing cross-file taint flows…' });

    // Work queue of callees that need to be scanned with tainted seeds.
    const queue: TaintedCallee[] = [];
    const visitedEdge = new Set<string>(); // prevent infinite loops

    // Seed the queue from Phase 1's tainted-var map.
    for (const [sourceFile, fnMap] of taintedCallerVars) {
      for (const [fnName, taintedVars] of fnMap) {
        const callerNode = graph.nodes.find(
          n => n.file === sourceFile && n.name === fnName,
        );
        if (!callerNode) continue;

        // Find cross-file callees.
        for (const edge of graph.edges.filter(e => e.from === callerNode.id)) {
          const calleeNode = graph.nodes.find(n => n.id === edge.to);
          if (!calleeNode || calleeNode.file === sourceFile) continue;

          const edgeKey = `${callerNode.id}->${calleeNode.id}:${[...taintedVars].sort().join(',')}`;
          if (visitedEdge.has(edgeKey)) continue;
          visitedEdge.add(edgeKey);

          queue.push({
            file:          calleeNode.file,
            functionName:  calleeNode.name,
            taintedParams: taintedVars,
            chain:         [`${fnName} (${sourceFile})`],
          });
        }
      }
    }

    // BFS over the queue up to MAX_DEPTH hops.
    for (let depth = 0; depth < MAX_DEPTH && queue.length > 0; depth++) {
      if (token.isCancellationRequested) break;
      const currentBatch = [...queue];
      queue.length = 0;

      for (const callee of currentBatch) {
        if (token.isCancellationRequested) break;

        const calleeDoc = await this.openDoc(root, callee.file);
        if (!calleeDoc) continue;

        const grammar = LANG_TO_GRAMMAR[calleeDoc.languageId];
        if (!grammar) continue;

        // Extract the callee's parameter names from the AST so we can
        // determine which parameters correspond to the tainted arguments.
        const seeds = await this.resolveSeeds(
          calleeDoc, callee.functionName, callee.taintedParams, grammar,
        );

        if (seeds.size === 0) continue;

        // Scan the callee body with those parameters pre-seeded as tainted.
        const issues = await this.phase1.scanWithSeeds(
          calleeDoc, seeds, callee.functionName,
        );

        for (const issue of issues) {
          const chain = [...callee.chain, `${callee.functionName} (${callee.file})`];
          flows.push({ issue, sinkFile: callee.file, chain });
        }

        // If the callee itself calls further functions, propagate taint onward.
        if (issues.length > 0) {
          const calleeNode = graph.nodes.find(
            n => n.file === callee.file && n.name === callee.functionName,
          );
          if (!calleeNode) continue;

          for (const edge of graph.edges.filter(e => e.from === calleeNode.id)) {
            const nextCallee = graph.nodes.find(n => n.id === edge.to);
            if (!nextCallee || nextCallee.file === callee.file) continue;

            const edgeKey = `${calleeNode.id}->${nextCallee.id}:${[...seeds].sort().join(',')}`;
            if (visitedEdge.has(edgeKey)) continue;
            visitedEdge.add(edgeKey);

            queue.push({
              file:          nextCallee.file,
              functionName:  nextCallee.name,
              taintedParams: seeds,
              chain:         [...callee.chain, `${callee.functionName} (${callee.file})`],
            });
          }
        }
      }
    }

    return this.dedupeFlows(flows);
  }

  // Collect the names of all variables in a function body that become tainted
  // (assigned from a source or from another tainted variable).
  // Used to know which variables might be passed as tainted arguments to callees.
  private collectTaintedVars(fnNode: Node): Set<string> {
    const tainted   = new Set<string>();
    const statements: Node[] = [];
    this.collectStatements(fnNode, statements);

    for (const stmt of statements) {
      const text = stmt.text;

      // Check if this statement assigns a source or a tainted var to a new var.
      const assignMatch = text.match(
        /^\s*(?:const|let|var|await\s+)?\s*([\w$]+)\s*=\s*(.+)$/s,
      );
      if (assignMatch) {
        const lhs = assignMatch[1];
        const rhs = assignMatch[2];
        const isTainted =
          SOURCE_PATTERNS.some(p => p.test(rhs)) ||
          [...tainted].some(v =>
            new RegExp(`(?<![\\w$])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`).test(rhs),
          );
        if (isTainted && !SANITIZERS.some(s => s.test(rhs))) {
          tainted.add(lhs);
        }
      }
    }

    return tainted;
  }

  // Given a callee document and function name, look up its parameter names
  // from the AST and return the subset that correspond to tainted arguments.
  //
  // Strategy: since we don't have a full call-site argument parser, we use
  // a conservative approximation — if ANY tainted vars exist at the call
  // site, we seed ALL parameters of the callee as tainted. This favors
  // recall over precision for cross-file flows, where the alternative is
  // missing real vulnerabilities entirely.
  //
  // A stricter version would parse the call expression to match argument
  // positions to parameter indices, but that requires full expression AST
  // traversal which is complex and grammar-specific.
  private async resolveSeeds(
    doc:          vscode.TextDocument,
    functionName: string,
    _taintedArgs: Set<string>,
    grammar:      string,
  ): Promise<Set<string>> {
    const parsed = await this.parser.parseTree(doc);
    if (!parsed) return new Set();

    const fnTypes = FN_TYPES[grammar] ?? [];
    const seeds   = new Set<string>();

    this.parser.walk(parsed.root, node => {
      if (!fnTypes.includes(node.type)) return;
      const nameNode = node.childForFieldName('name');
      if (!nameNode || nameNode.text !== functionName) return;

      // Extract all parameter names from this function definition.
      const params = this.phase1.extractParams(node, grammar);
      for (const p of params) seeds.add(p);

      // Also handle Python's `self` and aiohttp's `request` parameter —
      // these are not tainted themselves but their fields (request.match_info)
      // are sources already handled by Phase 1 SOURCE_PATTERNS.
      // We skip 'self' and 'cls' to avoid seeding them.
    });

    // Remove 'self', 'cls', 'this' — these are never user-controlled.
    seeds.delete('self');
    seeds.delete('cls');
    seeds.delete('this');

    return seeds;
  }

  // Collect statement nodes from a function, not descending into nested fns.
  private collectStatements(node: Node, out: Node[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      out.push(child);
      const isNestedFn =
        child.type.includes('function') ||
        child.type === 'method_definition' ||
        child.type === 'arrow_function';
      if (!isNestedFn) this.collectStatements(child, out);
    }
  }

  // Find which function in a file encloses a given line number.
  private enclosingFunction(graph: CodeGraph, file: string, line: number): string | null {
    let best: CodeNode | null = null;
    for (const node of graph.nodes) {
      if (node.file !== file) continue;
      if (node.line <= line) {
        if (!best || node.line > best.line) best = node;
      }
    }
    return best ? best.name : null;
  }

  private async openDoc(root: string, relFile: string): Promise<vscode.TextDocument | null> {
    try {
      const uri = vscode.Uri.file(`${root}/${relFile}`);
      return await vscode.workspace.openTextDocument(uri);
    } catch {
      return null;
    }
  }

  private dedupeFlows(flows: CrossFileTaintFlow[]): CrossFileTaintFlow[] {
    const seen = new Set<string>();
    return flows.filter(f => {
      const key = `${f.sinkFile}:${f.issue.line}:${f.issue.rule}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}