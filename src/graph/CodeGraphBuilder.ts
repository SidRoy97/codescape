import * as vscode from 'vscode';
import * as path from 'path';
import { LanguageParser } from './LanguageParser';
import { CodeGraph, CodeNode, CodeEdge } from './CodeGraphTypes';

// File patterns to scan and folders to ignore.
// vendor/ and *.min.js/.bundle.js added so third-party assets (materialize,
// jquery, etc.) don't pollute the graph with single-letter functions and
// false caller/callee relationships.
const FILE_GLOB   = '**/*.{js,jsx,ts,tsx,py,java}';
const IGNORE_GLOB = '{**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/target/**,**/static/**,**/vendor/**,**/assets/**,**/__pycache__/**,**/venv/**,**/.venv/**,**/env/**,**/migrations/**,**/generated/**,**/generated-sources/**,**/.next/**,**/.nuxt/**,**/coverage/**,**/__generated__/**,**/*.min.js,**/*.bundle.js,**/*.chunk.js,**/*.pyc}';

export class CodeGraphBuilder {
  private graph: CodeGraph = { nodes: [], edges: [] };

  constructor(private readonly parser: LanguageParser) {}

  async build(): Promise<CodeGraph> {
    const root = this.workspaceRoot();
    if (!root) {
      this.graph = { nodes: [], edges: [] };
      return this.graph;
    }

    const allUris = await vscode.workspace.findFiles(FILE_GLOB, IGNORE_GLOB);
    const sourceUris = this.dropCompiledSiblings(allUris);

    const nodes: CodeNode[] = [];
    const pendingCalls: Array<{ fromId: string; calleeName: string; receiver: string | null }> = [];
    const nameToIds = new Map<string, string[]>();

    for (const uri of sourceUris) {
      if (!this.isInsideWorkspace(uri.fsPath, root)) continue;

      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }

      const relFile = path.relative(root, uri.fsPath);
      const result  = await this.parser.parse(document);

      for (const symbol of result.symbols) {
        const id = `${relFile}::${symbol.name}`;
        nodes.push({
          id,
          name:       symbol.name,
          kind:       symbol.kind,
          file:       relFile,
          line:       symbol.line,
          nameColumn: symbol.nameColumn,
          // Variable-specific fields
          value:    (symbol as any).value,
          exported: (symbol as any).exported,
        });

        const existing = nameToIds.get(symbol.name) ?? [];
        existing.push(id);
        nameToIds.set(symbol.name, existing);
      }

      for (const call of result.calls) {
        const fromId = this.enclosingSymbolId(result.symbols, call.line, relFile);
        if (fromId) {
          pendingCalls.push({ fromId, calleeName: call.calleeName, receiver: call.receiver });
        }
      }
    }

    const classNames = nodes.filter(n => n.kind === 'class').map(n => n.name);
    const edges = this.resolveEdges(pendingCalls, nameToIds, classNames);

    this.graph = { nodes, edges };
    return this.graph;
  }

  getGraph(): CodeGraph {
    return this.graph;
  }

  async exportToFile(): Promise<vscode.Uri | null> {
    const root = this.workspaceRoot();
    if (!root) return null;

    const dest = vscode.Uri.file(path.join(root, 'codereach.json'));
    const json = JSON.stringify(this.graph, null, 2);
    await vscode.workspace.fs.writeFile(dest, Buffer.from(json, 'utf8'));
    return dest;
  }

  // Skip a compiled .js/.jsx file when a .ts/.tsx sibling exists.
  private dropCompiledSiblings(uris: vscode.Uri[]): vscode.Uri[] {
    const allPaths = new Set(uris.map(u => u.fsPath));
    return uris.filter(uri => {
      const p = uri.fsPath;
      if (p.endsWith('.js'))  return !allPaths.has(p.replace(/\.js$/,  '.ts'));
      if (p.endsWith('.jsx')) return !allPaths.has(p.replace(/\.jsx$/, '.tsx'));
      return true;
    });
  }

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

  private resolveEdges(
    pendingCalls: Array<{ fromId: string; calleeName: string; receiver: string | null }>,
    nameToIds: Map<string, string[]>,
    classNames: string[],
  ): CodeEdge[] {
    const edges: CodeEdge[] = [];
    const seen = new Set<string>();

    // Known language/runtime built-in receivers — calls on these are library
    // calls, not calls into project symbols. Covers JS/TS, Python, and Java.
    const BUILTIN_RECEIVERS = new Set([
      // JavaScript / TypeScript
      'json', 'object', 'array', 'math', 'console', 'promise', 'date',
      'number', 'string', 'boolean', 'map', 'set', 'symbol', 'reflect',
      'window', 'document', 'process', 'cfg', 'config', 'module', 'exports',
      // Python
      'os', 'sys', 're', 'io', 'json', 'logging', 'collections', 'itertools',
      'functools', 'typing', 'super', 'math', 'random', 'datetime', 'pathlib',
      'subprocess', 'threading', 'asyncio', 'abc', 'enum', 'uuid', 'hashlib',
      // Java
      'system', 'collections', 'objects', 'arrays', 'optional', 'stream',
      'list', 'integer', 'long', 'double', 'character', 'string', 'math',
      'thread', 'runtime', 'class', 'object',
    ]);

    // Self-reference receivers across languages.
    const SELF_RECEIVERS = new Set(['this', 'self', 'cls']);

    const classFor = (receiver: string): string | null => {
      const r = receiver.toLowerCase();
      let best: string | null = null;
      for (const cls of classNames) {
        const c = cls.toLowerCase();
        if (c === r || c.includes(r) || r.includes(c)) {
          if (!best || cls.length > best.length) best = cls;
        }
      }
      return best;
    };

    for (const call of pendingCalls) {
      if (call.receiver === '<computed>') continue;
      if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver.toLowerCase())) continue;

      const targetIds = nameToIds.get(call.calleeName);
      if (!targetIds) continue;

      const callerFile = call.fromId.split('::')[0];
      let chosen: string[];

      if (call.receiver && SELF_RECEIVERS.has(call.receiver)) {
        const sameFile = targetIds.filter(id => id.split('::')[0] === callerFile);
        chosen = sameFile.length > 0 ? sameFile : targetIds;
      } else if (call.receiver && classFor(call.receiver)) {
        const cls = classFor(call.receiver)!;
        const inClass = targetIds.filter(id => this.fileDeclaresClass(id, cls, nameToIds));
        const classFiles = new Set(
          (nameToIds.get(cls) ?? []).map(id => id.split('::')[0]),
        );
        const inClassFile = targetIds.filter(id => classFiles.has(id.split('::')[0]));
        chosen = inClass.length > 0 ? inClass
               : inClassFile.length > 0 ? inClassFile
               : targetIds;
      } else {
        const sameFile = targetIds.filter(id => id.split('::')[0] === callerFile);
        chosen = sameFile.length > 0 ? sameFile : targetIds;
      }

      for (const toId of chosen) {
        if (toId === call.fromId) continue;
        const key = `${call.fromId}->${toId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: call.fromId, to: toId, relation: 'calls' });
      }
    }

    return edges;
  }

  private fileDeclaresClass(nodeId: string, className: string, nameToIds: Map<string, string[]>): boolean {
    const nodeFile = nodeId.split('::')[0];
    const classIds = nameToIds.get(className) ?? [];
    return classIds.some(id => id.split('::')[0] === nodeFile);
  }

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