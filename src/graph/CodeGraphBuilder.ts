import * as vscode from 'vscode';
import * as path from 'path';
import { LanguageParser, ParsedImport } from './LanguageParser';
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
    // Maps relFile → list of imports declared in that file.
    // Used to resolve ambiguous call names (e.g. a no-receiver 'get' call that
    // was explicitly imported from a specific file).
    const fileImports = new Map<string, ParsedImport[]>();

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

      // Store imports for import-aware resolution below.
      if (result.imports && result.imports.length > 0) {
        fileImports.set(relFile, result.imports);
      }
    }

    const classNames = nodes.filter(n => n.kind === 'class').map(n => n.name);
    const edges = this.resolveEdges(pendingCalls, nameToIds, classNames, fileImports);

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
    fileImports: Map<string, ParsedImport[]>,
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
      'app', 'request', 'response', 'session', 'conn', 'cur', 'cursor', 'db',
      // Java
      'system', 'collections', 'objects', 'arrays', 'optional', 'stream',
      'list', 'integer', 'long', 'double', 'character', 'string', 'math',
      'thread', 'runtime', 'class', 'object', 'logger', 'log',
    ]);

    // Self-reference receivers across languages.
    const SELF_RECEIVERS = new Set(['this', 'self', 'cls']);

    // Ambiguous method names that appear on many different types across
    // all languages. Without a typed receiver we cannot know which class
    // owns them, so we never resolve these cross-file — doing so produces
    // false edges (e.g. csrf_middleware → student.get because both have
    // a symbol named "get"). Same-file links are still allowed.
    const AMBIGUOUS_NAMES = new Set([
      // Universal CRUD / data-access
      'get', 'set', 'create', 'update', 'delete', 'remove', 'find', 'fetch',
      'save', 'load', 'read', 'write', 'run', 'execute', 'query',
      // Collection / iteration
      'add', 'push', 'pop', 'append', 'extend', 'insert', 'clear',
      'contains', 'has', 'exists', 'count', 'size', 'length',
      // Lifecycle
      'init', 'start', 'stop', 'close', 'open', 'connect', 'disconnect',
      'setup', 'teardown', 'reset', 'refresh', 'build', 'destroy',
      // I/O / serialization
      'parse', 'format', 'encode', 'decode', 'serialize', 'deserialize',
      'send', 'receive', 'emit', 'handle', 'process', 'validate',
      // Python DAO patterns
      'from_raw', 'to_dict', 'to_json', 'from_dict', 'from_json',
      // Java patterns
      'getInstance', 'getClass', 'toString', 'equals', 'hashCode',
      'compareTo', 'clone', 'copy',
    ]);

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

    // How many distinct files declare a given symbol name — used to decide
    // whether a no-receiver call is too ambiguous to resolve cross-file.
    const fileCountForName = (name: string): number => {
      const ids = nameToIds.get(name) ?? [];
      return new Set(ids.map(id => id.split('::')[0])).size;
    };

    for (const call of pendingCalls) {
      if (call.receiver === '<computed>') continue;
      if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver.toLowerCase())) continue;

      const targetIds = nameToIds.get(call.calleeName);
      if (!targetIds) continue;

      const callerFile = call.fromId.split('::')[0];
      let chosen: string[];

      if (call.receiver && SELF_RECEIVERS.has(call.receiver)) {
        // this.x / self.x / cls.x — always same-file
        const sameFile = targetIds.filter(id => id.split('::')[0] === callerFile);
        chosen = sameFile.length > 0 ? sameFile : [];

      } else if (call.receiver && classFor(call.receiver)) {
        // store.get(), Student.create() — receiver names a known class
        const cls = classFor(call.receiver)!;
        const inClass = targetIds.filter(id => this.fileDeclaresClass(id, cls, nameToIds));
        const classFiles = new Set(
          (nameToIds.get(cls) ?? []).map(id => id.split('::')[0]),
        );
        const inClassFile = targetIds.filter(id => classFiles.has(id.split('::')[0]));
        chosen = inClass.length > 0 ? inClass
               : inClassFile.length > 0 ? inClassFile
               : [];

      } else if (call.receiver && !BUILTIN_RECEIVERS.has(call.receiver.toLowerCase())) {
        // Unknown receiver — try to match by receiver name to a file
        // e.g. `dao.get()` might match a file named dao.py
        const receiverLower = call.receiver.toLowerCase();
        const byReceiver = targetIds.filter(id => {
          const file = id.split('::')[0].toLowerCase();
          return file.includes(receiverLower) || receiverLower.includes(
            file.split('/').pop()?.replace(/\.\w+$/, '') ?? ''
          );
        });
        if (byReceiver.length > 0) {
          chosen = byReceiver;
        } else {
          // Receiver present but unrecognized — only allow same-file
          const sameFile = targetIds.filter(id => id.split('::')[0] === callerFile);
          chosen = sameFile;
        }

      } else {
        // No receiver at all — apply strict disambiguation rules:
        // Priority 1: explicit import in the caller's file.
        //   If `calleeName` was imported from a specific module, only link to
        //   symbols declared in that module's file. This resolves the core
        //   false-positive problem: `from sqli.dao.student import get; get()`
        //   is correctly linked to student.py::get, not to every other `get`.
        const callerImports = fileImports.get(callerFile) ?? [];
        const importMatch   = callerImports.find(imp => imp.localName === call.calleeName);
        if (importMatch) {
          // Normalize the source path for matching against relFile paths.
          const srcNorm = importMatch.sourcePath.replace(/\\/g, '/').replace(/^\.\//, '');
          const fromImport = targetIds.filter(id => {
            const idFile = id.split('::')[0].replace(/\\/g, '/');
            // Match if the file path ends with the source path (with or without extension).
            return idFile.includes(srcNorm) || idFile.replace(/\.[^.]+$/, '').endsWith(srcNorm);
          });
          if (fromImport.length > 0) {
            chosen = fromImport;
            // Skip the rest of the disambiguation — import is authoritative.
            for (const toId of chosen) {
              if (toId === call.fromId) continue;
              const key = `${call.fromId}->${toId}`;
              if (seen.has(key)) continue;
              seen.add(key);
              edges.push({ from: call.fromId, to: toId, relation: 'calls' });
            }
            continue;
          }
        }

        // Priority 2: same-file (always safe).
        const sameFile = targetIds.filter(id => id.split('::')[0] === callerFile);
        if (sameFile.length > 0) {
          chosen = sameFile;
        } else if (AMBIGUOUS_NAMES.has(call.calleeName) && fileCountForName(call.calleeName) > 1) {
          // Ambiguous name in multiple files with no receiver and no import — drop it.
          // This is the main false-positive eliminator.
          chosen = [];
        } else if (fileCountForName(call.calleeName) === 1) {
          // Only one file declares this name — safe to link cross-file.
          chosen = targetIds;
        } else {
          // Multiple files, not in ambiguous list — prefer same directory.
          const callerDir = callerFile.split('/').slice(0, -1).join('/');
          const sameDir = targetIds.filter(id => id.split('::')[0].startsWith(callerDir));
          chosen = sameDir.length > 0 ? sameDir : targetIds;
        }
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