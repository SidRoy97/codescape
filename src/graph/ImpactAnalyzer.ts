import { CodeGraph, CodeNode, ImpactResult } from './CodeGraphTypes';

// Symbol names that are invoked by VS Code or the language runtime rather
// than by code we can see in the graph. These must never be reported as
// unused, or every extension entry point would be a false positive.
const ENTRY_POINTS = new Set([
  'activate', 'deactivate', 'constructor',
  'provideCodeActions', 'provideCodeLenses', 'resolveWebviewView',
  'dispose',
]);

// answer impact questions by traversing an existing graph.
// Pure logic — it reads a CodeGraph and returns nodes. It does no file I/O,
// no parsing, and no UI work, so it has no security surface of its own.
export class ImpactAnalyzer {
  constructor(private readonly graph: CodeGraph) {}

  // Full impact of changing one symbol: its direct callers, direct callees,
  // and everything affected transitively up the caller chain.
  analyze(nodeId: string): ImpactResult | null {
    const target = this.findNode(nodeId);
    if (!target) return null;

    return {
      target,
      directCallers: this.callersOf(nodeId),
      directCallees: this.calleesOf(nodeId),
      affected:      this.affectedBy(nodeId),
    };
  }

  // Count of distinct files affected if this symbol changes.
  // This is the "blast radius" number shown in the status bar,
  // computed from the same graph as everything else.
  blastRadiusForFile(file: string): number {
    const fileNodeIds = this.graph.nodes
      .filter(n => n.file === file)
      .map(n => n.id);

    const affectedFiles = new Set<string>();
    for (const id of fileNodeIds) {
      for (const node of this.affectedBy(id)) {
        if (node.file !== file) affectedFiles.add(node.file);
      }
    }
    return affectedFiles.size;
  }

  // Symbols that nothing else calls — candidates for dead code.
  // Excludes framework entry points (activate, dispose, etc.) since those
  // are invoked by VS Code, not by code we can see. Also excludes classes
  // and constructors: these are reached via `new ClassName()`, which v1 does
  // not track as a call edge, so reporting them would be a false positive.
  // Treat the result as "review these", not "delete these": exported API
  // used by other projects and dynamic calls (obj[name]()) can still appear.
  findUnusedSymbols(): CodeNode[] {
    const calledIds = new Set(this.graph.edges.map(e => e.to));

    return this.graph.nodes.filter(node => {
      if (node.kind === 'class') return false;        // reached via `new`, not tracked
      if (node.name === 'constructor') return false;  // runs on instantiation
      if (calledIds.has(node.id)) return false;        // something calls it
      if (ENTRY_POINTS.has(node.name)) return false;   // framework entry point
      return true;
    });
  }

  // Symbols that directly call or import the given symbol.
  private callersOf(nodeId: string): CodeNode[] {
    const callerIds = this.graph.edges
      .filter(e => e.to === nodeId)
      .map(e => e.from);
    return this.nodesByIds(callerIds);
  }

  // Symbols the given symbol directly calls or imports.
  private calleesOf(nodeId: string): CodeNode[] {
    const calleeIds = this.graph.edges
      .filter(e => e.from === nodeId)
      .map(e => e.to);
    return this.nodesByIds(calleeIds);
  }

  // Every symbol affected if the given symbol changes, found by walking
  // caller relationships recursively (a breaks → its callers break → ...).
  private affectedBy(nodeId: string): CodeNode[] {
    const affected = new Set<string>();
    const queue = [nodeId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of this.graph.edges) {
        if (edge.to === current && !affected.has(edge.from)) {
          affected.add(edge.from);
          queue.push(edge.from);
        }
      }
    }

    return this.nodesByIds(Array.from(affected));
  }

  private findNode(nodeId: string): CodeNode | null {
    return this.graph.nodes.find(n => n.id === nodeId) ?? null;
  }

  private nodesByIds(ids: string[]): CodeNode[] {
    const unique = Array.from(new Set(ids));
    const result: CodeNode[] = [];
    for (const id of unique) {
      const node = this.findNode(id);
      if (node) result.push(node);
    }
    return result;
  }
}