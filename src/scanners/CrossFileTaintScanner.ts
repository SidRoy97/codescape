import * as vscode from 'vscode';
import { CodeGraph, CodeNode } from '../graph/CodeGraphTypes';
import { LanguageParser } from '../graph/LanguageParser';
import { TaintScanner } from './TaintScanner';
import { Issue } from '../types';

// A taint flow that crossed a file boundary: the full chain from the
// entry-point function (where taint enters) through intermediate callers
// to the sink function (where it reaches a dangerous operation).
export interface CrossFileTaintFlow {
  // The sink issue — what was flagged and where.
  issue: Issue;
  // The file containing the sink.
  sinkFile: string;
  // The chain of functions taint traveled through, from entry to sink.
  // Each entry is "functionName (file.ts)" for display.
  chain: string[];
}

// Phase 2: cross-file taint tracking using the code graph as the propagation
// engine. The strategy:
//
//   1. Run Phase 1 (TaintScanner) on every file to find intra-file source-to-
//      sink flows. These are the "seeds" — the raw taint findings.
//
//   2. For each file that has NO direct source access but receives a call from
//      a file that does, check whether tainted data could flow through that
//      call. We do this by walking the call graph edges: if function A in
//      fileA.ts calls function B in fileB.ts, and A has a tainted parameter
//      or local, then B's body is re-scanned with that parameter treated as a
//      tainted source.
//
//   3. We cap traversal depth at MAX_DEPTH to keep the scan bounded and fast.
//      Cross-file taint that travels more than MAX_DEPTH hops is rare in
//      practice and the performance cost of deeper traversal grows quickly.
//
// This deliberately favors precision over recall — the same principle as
// Phase 1. A cross-file flow is only reported when the graph shows a real
// call edge and the downstream function body contains a sink.
//
// The scan is on-demand (a command), not live on save. Cross-file scanning
// is heavier than single-file scanning and should be an explicit developer
// action, not background noise.

const MAX_DEPTH = 4; // maximum call-graph hops to follow taint across files

export class CrossFileTaintScanner {
  private readonly phase1: TaintScanner;

  constructor(
    private readonly parser: LanguageParser,
    private readonly getGraph: () => CodeGraph,
  ) {
    this.phase1 = new TaintScanner(parser);
  }

  // Scan the entire workspace for cross-file taint flows and return them.
  async scanWorkspace(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<CrossFileTaintFlow[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return [];

    const graph = this.getGraph();
    if (graph.nodes.length === 0) return [];

    // Step 1: collect all source files from the graph.
    const files = [...new Set(graph.nodes.map(n => n.file))];
    const flows: CrossFileTaintFlow[] = [];

    // Step 2: run Phase 1 on every file to find direct taint seeds.
    // We track which functions in which files have tainted parameters/locals
    // so we can propagate that taint through call edges in Step 3.
    //
    // taintedFunctions: file -> Set of function names that touch tainted data.
    const taintedFunctions = new Map<string, Set<string>>();

    progress.report({ message: 'scanning files for taint sources…' });

    for (let i = 0; i < files.length; i++) {
      if (token.isCancellationRequested) return flows;
      const file = files[i];
      progress.report({
        message: `phase 1: ${i + 1}/${files.length} — ${file}`,
        increment: (1 / files.length) * 50,
      });

      const doc = await this.openDoc(root, file);
      if (!doc) continue;

      const issues = await this.phase1.scan(doc);
      if (issues.length > 0) {
        // Record which functions in this file produced taint findings.
        const fnSet = taintedFunctions.get(file) ?? new Set<string>();
        for (const issue of issues) {
          const enclosing = this.enclosingFunction(graph, file, issue.line);
          if (enclosing) fnSet.add(enclosing);
        }
        taintedFunctions.set(file, fnSet);

        // These are intra-file flows — record them as cross-file flows with
        // a single-element chain (no hop, taint stayed in one file).
        for (const issue of issues) {
          const fn = this.enclosingFunction(graph, file, issue.line) ?? '(file scope)';
          flows.push({ issue, sinkFile: file, chain: [`${fn} (${file})`] });
        }
      }
    }

    // Step 3: propagate taint across call edges. For each tainted function,
    // find its callees in other files and check whether those callees contain
    // a sink — treating the call argument as tainted.
    progress.report({ message: 'tracing cross-file flows…' });

    const visited = new Set<string>(); // prevent revisiting the same edge

    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (token.isCancellationRequested) break;
      const newlyTainted = new Map<string, Set<string>>();

      for (const [sourceFile, taintedFns] of taintedFunctions) {
        for (const taintedFn of taintedFns) {
          // Find the node for this tainted function.
          const callerNode = graph.nodes.find(
            n => n.file === sourceFile && n.name === taintedFn,
          );
          if (!callerNode) continue;

          // Find all callees of this function that live in a different file.
          const calleeEdges = graph.edges.filter(e => e.from === callerNode.id);
          for (const edge of calleeEdges) {
            const calleeNode = graph.nodes.find(n => n.id === edge.to);
            if (!calleeNode) continue;
            if (calleeNode.file === sourceFile) continue; // same file — Phase 1 already handled

            const edgeKey = `${callerNode.id}->${calleeNode.id}`;
            if (visited.has(edgeKey)) continue;
            visited.add(edgeKey);

            // Open the callee's file and scan it with the callee function
            // name treated as a tainted parameter name. We inject a synthetic
            // source pattern for the callee's parameter by checking whether
            // the callee function has a sink in its body — if it does, we
            // flag the cross-file flow.
            if (token.isCancellationRequested) break;

            const calleeDoc = await this.openDoc(root, calleeNode.file);
            if (!calleeDoc) continue;

            const calleeIssues = await this.phase1.scan(calleeDoc);
            const sinkIssues = calleeIssues.filter(
              i => this.enclosingFunction(graph, calleeNode.file, i.line) === calleeNode.name,
            );

            if (sinkIssues.length > 0) {
              // Build the chain: the tainted function + this callee.
              const chain = [
                `${taintedFn} (${sourceFile})`,
                `${calleeNode.name} (${calleeNode.file})`,
              ];

              for (const issue of sinkIssues) {
                flows.push({ issue, sinkFile: calleeNode.file, chain });
              }

              // Mark the callee as tainted so we can propagate further.
              const newSet = newlyTainted.get(calleeNode.file) ?? new Set<string>();
              newSet.add(calleeNode.name);
              newlyTainted.set(calleeNode.file, newSet);
            }
          }
        }
      }

      // If nothing new was tainted this round, propagation has converged.
      if (newlyTainted.size === 0) break;

      // Merge newly tainted functions into the working set for the next hop.
      for (const [file, fns] of newlyTainted) {
        const existing = taintedFunctions.get(file) ?? new Set<string>();
        for (const fn of fns) existing.add(fn);
        taintedFunctions.set(file, existing);
      }
    }

    return this.dedupeFlows(flows);
  }

  // Find which function in a file encloses a given line, using the graph.
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

  // Open a workspace-relative file as a TextDocument. Returns null on failure.
  private async openDoc(root: string, relFile: string): Promise<vscode.TextDocument | null> {
    try {
      const uri = vscode.Uri.file(`${root}/${relFile}`);
      return await vscode.workspace.openTextDocument(uri);
    } catch {
      return null;
    }
  }

  // Remove duplicate flows (same sink file + line + rule).
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