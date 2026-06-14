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
    const pendingCalls: Array<{ fromId: string; calleeName: string }> = [];
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
          pendingCalls.push({ fromId, calleeName: call.calleeName });
        }
      }
    }

    const edges = this.resolveEdges(pendingCalls, nameToIds);

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
  // When a name resolves to several files, prefer a definition in the same
  // file as the caller — this removes most false edges from common method
  // names like get, clear, dispose, render, show. Unresolved names (calls to
  // library code we never parsed) are dropped.
  private resolveEdges(
    pendingCalls: Array<{ fromId: string; calleeName: string }>,
    nameToIds: Map<string, string[]>,
  ): CodeEdge[] {
    const edges: CodeEdge[] = [];
    const seen = new Set<string>();

    for (const call of pendingCalls) {
      const targetIds = nameToIds.get(call.calleeName);
      if (!targetIds) continue;

      const callerFile = call.fromId.split('::')[0];
      const sameFile = targetIds.filter(id => id.split('::')[0] === callerFile);
      const chosen = sameFile.length > 0 ? sameFile : targetIds;

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