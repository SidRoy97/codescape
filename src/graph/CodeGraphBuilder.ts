import * as vscode from 'vscode';
import * as path from 'path';
import { LanguageParser } from './LanguageParser';
import { CodeGraph, CodeNode, CodeEdge } from './CodeGraphTypes';

// File patterns to scan and folders to ignore.
const FILE_GLOB   = '**/*.{js,jsx,ts,tsx,py,java}';
const IGNORE_GLOB = '{**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/*.min.js}';

// Single job: build a CodeGraph for the workspace by parsing every
// supported file and connecting calls to the symbols they reference.
// It depends on LanguageParser (injected) and the data types — nothing else.
export class CodeGraphBuilder {
  // The most recently built graph, cached for callers to read.
  private graph: CodeGraph = { nodes: [], edges: [] };

  constructor(private readonly parser: LanguageParser) {}

  // Build the graph across the whole workspace and cache it.
  async build(): Promise<CodeGraph> {
    const root = this.workspaceRoot();
    if (!root) {
      this.graph = { nodes: [], edges: [] };
      return this.graph;
    }

    const allUris = await vscode.workspace.findFiles(FILE_GLOB, IGNORE_GLOB);
    const sourceUris = this.dropCompiledSiblings(allUris);

    const nodes: CodeNode[] = [];
    // Records "this symbol calls something named X" before we resolve X to an id.
    // The receiver (what the call was made on) is kept so resolution can tell
    // this.foo() and store.get() apart from any other foo/get in the project.
    const pendingCalls: Array<{ fromId: string; calleeName: string; receiver: string | null }> = [];
    // Maps a bare symbol name to the node ids that declare it,
    // used to resolve call names back to real nodes.
    const nameToIds = new Map<string, string[]>();

    for (const uri of sourceUris) {
      // Security: never read a file that resolves outside the workspace.
      if (!this.isInsideWorkspace(uri.fsPath, root)) continue;

      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue; // unreadable file — skip, never crash the build
      }

      const relFile = path.relative(root, uri.fsPath);
      const result  = await this.parser.parse(document);

      // Turn each declared symbol into a node.
      for (const symbol of result.symbols) {
        const id = `${relFile}::${symbol.name}`;
        nodes.push({ id, name: symbol.name, kind: symbol.kind, file: relFile, line: symbol.line });

        const existing = nameToIds.get(symbol.name) ?? [];
        existing.push(id);
        nameToIds.set(symbol.name, existing);
      }

      // Record each call, attributing it to the nearest enclosing symbol.
      for (const call of result.calls) {
        const fromId = this.enclosingSymbolId(result.symbols, call.line, relFile);
        if (fromId) {
          pendingCalls.push({ fromId, calleeName: call.calleeName, receiver: call.receiver });
        }
      }
    }

    // Class names in the project, used to match a receiver variable to a type
    // by convention (e.g. receiver "analyzer" → class "ImpactAnalyzer",
    // receiver "store" → class "ResultStore"). This is a heuristic, not full
    // type inference, but it resolves most same-named methods correctly.
    const classNames = nodes.filter(n => n.kind === 'class').map(n => n.name);
    const edges = this.resolveEdges(pendingCalls, nameToIds, classNames);

    this.graph = { nodes, edges };
    return this.graph;
  }

  // Return the cached graph without rebuilding.
  getGraph(): CodeGraph {
    return this.graph;
  }

  // Write the current graph to codescape.json at the workspace root.
  // This file is shareable with new developers and AI tools.
  async exportToFile(): Promise<vscode.Uri | null> {
    const root = this.workspaceRoot();
    if (!root) return null;

    const dest = vscode.Uri.file(path.join(root, 'codescape.json'));
    const json = JSON.stringify(this.graph, null, 2);
    await vscode.workspace.fs.writeFile(dest, Buffer.from(json, 'utf8'));
    return dest;
  }

  // Skip a compiled .js/.jsx file when a .ts/.tsx sibling exists.
  // This avoids indexing build output sitting next to source, which would
  // otherwise add duplicate nodes and TypeScript's async helper functions
  // (adopt, fulfilled, rejected, step, verb) as noise.
  private dropCompiledSiblings(uris: vscode.Uri[]): vscode.Uri[] {
    const allPaths = new Set(uris.map(u => u.fsPath));
    return uris.filter(uri => {
      const p = uri.fsPath;
      if (p.endsWith('.js'))  return !allPaths.has(p.replace(/\.js$/,  '.ts'));
      if (p.endsWith('.jsx')) return !allPaths.has(p.replace(/\.jsx$/, '.tsx'));
      return true;
    });
  }

  // Find which declared symbol a call belongs to, by line position.
  // The enclosing symbol is the last one declared at or before the call line.
  private enclosingSymbolId(
    symbols: Array<{ name: string; line: number }>,
    callLine: number,
    relFile: string,
  ): string | null {
    let best: { name: string; line: number } | null = null;
    for (const symbol of symbols) {
      if (symbol.line <= callLine) {
        if (!best || symbol.line > best.line) best = symbol;
      }
    }
    return best ? `${relFile}::${best.name}` : null;
  }

  // Turn recorded calls into edges by matching callee names to node ids.
  // Resolution is receiver-aware: when a call is this.foo() or store.get(),
  // the receiver narrows which same-named symbol is meant, instead of linking
  // to every foo/get in the project. Falls back to same-file preference when
  // the receiver gives no signal. Unresolved names (library calls) are dropped.
  private resolveEdges(
    pendingCalls: Array<{ fromId: string; calleeName: string; receiver: string | null }>,
    nameToIds: Map<string, string[]>,
    classNames: string[],
  ): CodeEdge[] {
    const edges: CodeEdge[] = [];
    const seen = new Set<string>();

    // Receivers that are language/runtime built-ins or config objects, never
    // project classes. A call like JSON.parse() or cfg.get() has one of these
    // as its receiver, so I drop it instead of linking it to a project symbol
    // of the same name (e.g. our own ResultStore.get or LanguageParser.parse).
    const BUILTIN_RECEIVERS = new Set([
      'json', 'object', 'array', 'math', 'console', 'promise', 'date',
      'number', 'string', 'boolean', 'map', 'set', 'symbol', 'reflect',
      'window', 'document', 'process', 'cfg', 'config',
    ]);

    // Map a lowercased receiver variable to a class name by naming convention:
    // "analyzer" → "ImpactAnalyzer", "store" → "ResultStore", "dashboard" →
    // "DashboardProvider". A class matches if its lowercased name contains the
    // receiver, or the receiver contains a meaningful chunk of the class name.
    const classFor = (receiver: string): string | null => {
      const r = receiver.toLowerCase();
      // Exact-ish: class name lowercased equals or contains the receiver.
      let best: string | null = null;
      for (const cls of classNames) {
        const c = cls.toLowerCase();
        if (c === r || c.includes(r) || r.includes(c)) {
          // Prefer the longest class name match (most specific).
          if (!best || cls.length > best.length) best = cls;
        }
      }
      return best;
    };

    for (const call of pendingCalls) {
      // Skip calls on known built-in/runtime receivers — these are library
      // calls (JSON.parse, Map.get, cfg.get), not calls into project symbols.
      if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver.toLowerCase())) continue;

      const targetIds = nameToIds.get(call.calleeName);
      if (!targetIds) continue;

      const callerFile = call.fromId.split('::')[0];
      let chosen: string[];

      if (call.receiver === 'this') {
        // this.method() — the target almost always lives in the same file as
        // the caller (the same class). Restrict to that, which removes nearly
        // all cross-class collisions for common names.
        const sameFile = targetIds.filter(id => id.split('::')[0] === callerFile);
        chosen = sameFile.length > 0 ? sameFile : targetIds;
      } else if (call.receiver && classFor(call.receiver)) {
        // store.get() — resolve to the matched class's method if one exists.
        const cls = classFor(call.receiver)!;
        const inClass = targetIds.filter(id => this.fileDeclaresClass(id, cls, nameToIds));
        // If we can locate the class's file, prefer targets in that file.
        const classFiles = new Set(
          (nameToIds.get(cls) ?? []).map(id => id.split('::')[0]),
        );
        const inClassFile = targetIds.filter(id => classFiles.has(id.split('::')[0]));
        chosen = inClass.length > 0 ? inClass
               : inClassFile.length > 0 ? inClassFile
               : targetIds;
      } else {
        // No useful receiver — keep the previous same-file preference.
        const sameFile = targetIds.filter(id => id.split('::')[0] === callerFile);
        chosen = sameFile.length > 0 ? sameFile : targetIds;
      }

      for (const toId of chosen) {
        if (toId === call.fromId) continue; // ignore self-calls

        const key = `${call.fromId}->${toId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        edges.push({ from: call.fromId, to: toId, relation: 'calls' });
      }
    }

    return edges;
  }

  // True when the node id sits in the same file where the given class is
  // declared — used to keep receiver-resolved calls inside the class's file.
  private fileDeclaresClass(nodeId: string, className: string, nameToIds: Map<string, string[]>): boolean {
    const nodeFile = nodeId.split('::')[0];
    const classIds = nameToIds.get(className) ?? [];
    return classIds.some(id => id.split('::')[0] === nodeFile);
  }

  // Security guard: a resolved path must sit inside the workspace root.
  // Blocks path traversal (e.g. "../../etc/passwd").
  private isInsideWorkspace(filePath: string, root: string): boolean {
    const resolved = path.resolve(filePath);
    const base     = path.resolve(root) + path.sep;
    return resolved.startsWith(base);
  }

  private workspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : null;
  }
}