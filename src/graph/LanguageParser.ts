import * as vscode from 'vscode';
import * as path from 'path';
import { Parser, Language, Node } from 'web-tree-sitter';

// A symbol declaration found by parsing — function, class, method, or variable.
export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable';
  line: number;
  nameColumn: number;
  value?: string;
  exported?: boolean;
}

export interface ParsedCall {
  calleeName: string;
  receiver: string | null;
  line: number;
}

// An import statement found by parsing.
// Maps a local name (how it's used in this file) to the source module path.
// Example: `from sqli.dao.student import Student` →
//   { localName: 'Student', sourcePath: 'sqli/dao/student' }
// Example: `import { get } from './dao/user'` →
//   { localName: 'get', sourcePath: './dao/user' }
export interface ParsedImport {
  localName:  string;
  sourcePath: string;
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  calls:   ParsedCall[];
  imports: ParsedImport[];
}

export interface ParseTreeResult {
  root:    Node;
  grammar: string;
}

const GRAMMAR_FILES: Record<string, string> = {
  javascript:      'tree-sitter-javascript.wasm',
  javascriptreact: 'tree-sitter-javascript.wasm',
  typescript:      'tree-sitter-typescript.wasm',
  typescriptreact: 'tree-sitter-tsx.wasm',
  python:          'tree-sitter-python.wasm',
  java:            'tree-sitter-java.wasm',
};

const DECLARATION_TYPES: Record<string, Record<string, ParsedSymbol['kind']>> = {
  javascript: {
    function_declaration:  'function',
    method_definition:     'method',
    class_declaration:     'class',
    lexical_declaration:   'function',
  },
  typescript: {
    function_declaration:  'function',
    method_definition:     'method',
    class_declaration:     'class',
    lexical_declaration:   'function',
  },
  python: {
    function_definition: 'function',
    class_definition:    'class',
  },
  java: {
    method_declaration:  'method',
    class_declaration:   'class',
    field_declaration:   'variable',
  },
};

const CALL_TYPES: Record<string, string> = {
  javascript: 'call_expression',
  typescript: 'call_expression',
  python:     'call',
  java:       'method_invocation',
};

// Import node types per grammar.
const IMPORT_TYPES: Record<string, string[]> = {
  javascript: ['import_statement', 'import_declaration'],
  typescript: ['import_statement', 'import_declaration'],
  python:     ['import_statement', 'import_from_statement'],
  java:       ['import_declaration'],
};

const SKIP_VARIABLE_NAMES = new Set([
  'i', 'j', 'k', 'n', 'x', 'y', 'z', 'tmp', 'temp', 'result', 'res',
  '_', '__', 'e', 'err', 'error', 'cb', 'callback', 'fn', 'args',
]);

export class LanguageParser {
  private languages = new Map<string, Language>();
  private parser?: Parser;
  private ready = false;

  constructor(private readonly extensionPath: string) {}

  async init(): Promise<void> {
    if (this.ready) return;
    await Parser.init();
    this.parser = new Parser();
    this.ready = true;
  }

  private grammarKey(languageId: string): string | undefined {
    if (languageId === 'javascriptreact') return 'javascript';
    if (languageId === 'typescriptreact') return 'typescript';
    if (GRAMMAR_FILES[languageId]) return languageId;
    return undefined;
  }

  private async loadLanguage(languageId: string): Promise<Language | null> {
    const file = GRAMMAR_FILES[languageId];
    if (!file) return null;
    if (this.languages.has(file)) return this.languages.get(file)!;
    const wasmPath = path.join(this.extensionPath, 'media', 'grammars', file);
    const lang = await Language.load(wasmPath);
    this.languages.set(file, lang);
    return lang;
  }

  async parseTree(document: vscode.TextDocument): Promise<ParseTreeResult | null> {
    await this.init();
    const grammar = this.grammarKey(document.languageId);
    if (!grammar || !this.parser) return null;
    const lang = await this.loadLanguage(document.languageId);
    if (!lang) return null;
    this.parser.setLanguage(lang);
    const tree = this.parser.parse(document.getText());
    if (!tree) return null;
    return { root: tree.rootNode, grammar };
  }

  async parse(document: vscode.TextDocument): Promise<ParseResult> {
    await this.init();
    const grammar = this.grammarKey(document.languageId);
    if (!grammar || !this.parser) return { symbols: [], calls: [], imports: [] };
    const lang = await this.loadLanguage(document.languageId);
    if (!lang) return { symbols: [], calls: [], imports: [] };
    this.parser.setLanguage(lang);
    const tree = this.parser.parse(document.getText());
    if (!tree) return { symbols: [], calls: [], imports: [] };

    const declTypes   = DECLARATION_TYPES[grammar] ?? {};
    const callType    = CALL_TYPES[grammar];
    const importTypes = new Set(IMPORT_TYPES[grammar] ?? []);

    const symbols: ParsedSymbol[] = [];
    const calls:   ParsedCall[]   = [];
    const imports: ParsedImport[] = [];

    let scopeDepth = 0;

    this.walk(tree.rootNode, node => {
      const isFnScope =
        node.type === 'function_declaration' ||
        node.type === 'method_definition'    ||
        node.type === 'arrow_function'       ||
        node.type === 'function_expression'  ||
        node.type === 'function_definition'  ||
        node.type === 'method_declaration';

      if (isFnScope) scopeDepth++;

      const kind = declTypes[node.type];
      if (kind) {
        if (node.type === 'lexical_declaration') {
          this.extractLexicalDeclaration(node, symbols, scopeDepth);
        } else if (node.type === 'field_declaration') {
          this.extractJavaField(node, symbols);
        } else {
          const nameNode = node.childForFieldName('name');
          if (nameNode && nameNode.text) {
            const exported = this.isExported(node);
            symbols.push({
              name: nameNode.text,
              kind,
              line: node.startPosition.row,
              nameColumn: nameNode.startPosition.column,
              exported,
            });
          }
        }
      }

      if (node.type === callType) {
        const callee = this.readCallee(node);
        if (callee) {
          calls.push({ calleeName: callee.name, receiver: callee.receiver, line: node.startPosition.row });
        }
      }

      // Extract import statements for import-aware call resolution.
      if (importTypes.has(node.type)) {
        const extracted = this.extractImports(node, grammar);
        imports.push(...extracted);
      }
    });

    return { symbols, calls, imports };
  }

  // ── Import extraction ────────────────────────────────────────────────────

  private extractImports(node: Node, grammar: string): ParsedImport[] {
    switch (grammar) {
      case 'javascript':
      case 'typescript': return this.extractJsImports(node);
      case 'python':     return this.extractPythonImports(node);
      case 'java':       return this.extractJavaImports(node);
      default:           return [];
    }
  }

  // JS/TS: import { get, create } from './dao/user'
  //        import User from './dao/user'
  //        import * as dao from './dao/user'
  private extractJsImports(node: Node): ParsedImport[] {
    const result: ParsedImport[] = [];

    let sourcePath = '';
    const sourceField = node.childForFieldName('source');
    if (sourceField) {
      sourcePath = sourceField.text.replace(/^['"]|['"]$/g, '');
    } else {
      for (let i = node.childCount - 1; i >= 0; i--) {
        const child = node.child(i);
        if (child && (child.type === 'string' || child.type === 'string_literal')) {
          sourcePath = child.text.replace(/^['"]|['"]$/g, '');
          break;
        }
      }
    }
    if (!sourcePath) return [];

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (
        child.type === 'import_clause' ||
        child.type === 'named_imports' ||
        child.type === 'import_specifier'
      ) {
        this.walkImportClause(child, sourcePath, result);
      }
    }

    if (result.length === 0) {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'identifier') {
          result.push({ localName: child.text, sourcePath });
          break;
        }
      }
    }

    return result;
  }

  private walkImportClause(node: Node, sourcePath: string, out: ParsedImport[]): void {
    if (node.type === 'import_specifier') {
      const alias     = node.childForFieldName('alias');
      const name      = node.childForFieldName('name');
      const localName = (alias ?? name)?.text;
      if (localName) out.push({ localName, sourcePath });
      return;
    }
    if (node.type === 'identifier') {
      out.push({ localName: node.text, sourcePath });
      return;
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) this.walkImportClause(child, sourcePath, out);
    }
  }

  // Python:
  //   from sqli.dao.student import Student, get
  //   import sqli.dao.student
  private extractPythonImports(node: Node): ParsedImport[] {
    const result: ParsedImport[] = [];

    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      const sourcePath = moduleNode ? moduleNode.text.replace(/\./g, '/') : '';

      let pastImport = false;
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child) continue;
        if (child.type === 'import') { pastImport = true; continue; }
        if (!pastImport) continue;

        if (child.type === 'dotted_name' || child.type === 'identifier') {
          result.push({ localName: child.text, sourcePath });
        } else if (child.type === 'aliased_import') {
          const alias     = child.childForFieldName('alias');
          const name      = child.childForFieldName('name');
          const localName = (alias ?? name)?.text;
          if (localName) result.push({ localName, sourcePath });
        }
      }
    } else if (node.type === 'import_statement') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (!child || child.type === 'import') continue;
        if (child.type === 'dotted_name') {
          const parts      = child.text.split('.');
          const localName  = parts[parts.length - 1];
          const sourcePath = parts.join('/');
          result.push({ localName, sourcePath });
        } else if (child.type === 'aliased_import') {
          const alias     = child.childForFieldName('alias');
          const name      = child.childForFieldName('name');
          const localName = (alias ?? name)?.text;
          if (localName) {
            const nameNode   = child.childForFieldName('name');
            const sourcePath = nameNode ? nameNode.text.replace(/\./g, '/') : '';
            result.push({ localName, sourcePath });
          }
        }
      }
    }

    return result;
  }

  // Java: import com.example.dao.UserDao;
  private extractJavaImports(node: Node): ParsedImport[] {
    const result: ParsedImport[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child || child.type !== 'scoped_identifier') continue;
      const fullPath   = child.text;
      const parts      = fullPath.split('.');
      const localName  = parts[parts.length - 1];
      const sourcePath = parts.join('/');
      result.push({ localName, sourcePath });
    }
    return result;
  }

  // ── Existing variable/symbol extraction ──────────────────────────────────

  private extractLexicalDeclaration(
    lexDecl: Node,
    symbols: ParsedSymbol[],
    scopeDepth: number,
  ): void {
    const exported = this.isExported(lexDecl);

    for (let i = 0; i < lexDecl.childCount; i++) {
      const child = lexDecl.child(i);
      if (!child || child.type !== 'variable_declarator') continue;

      const nameNode  = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (!nameNode || !nameNode.text) continue;

      const isFn = valueNode && (
        valueNode.type === 'arrow_function' ||
        valueNode.type === 'function_expression' ||
        valueNode.type === 'async_function_expression'
      );

      if (isFn) {
        if (scopeDepth > 1) continue;
        symbols.push({
          name: nameNode.text,
          kind: 'function',
          line: lexDecl.startPosition.row,
          nameColumn: nameNode.startPosition.column,
          exported,
        });
      } else if (scopeDepth === 0 && valueNode) {
        const name = nameNode.text;
        if (SKIP_VARIABLE_NAMES.has(name)) continue;
        if (name.length < 2) continue;

        const valueText    = valueNode.text ?? '';
        const isCallResult = /^\w+\s*\(/.test(valueText.trim());
        if (isCallResult && !exported) continue;

        const value = valueText.replace(/\s+/g, ' ').slice(0, 120);
        symbols.push({
          name,
          kind: 'variable',
          line: lexDecl.startPosition.row,
          nameColumn: nameNode.startPosition.column,
          value,
          exported,
        });
      }
    }
  }

  private extractJavaField(node: Node, symbols: ParsedSymbol[]): void {
    const text = node.text ?? '';
    if (!text.includes('static') || !text.includes('final')) return;

    const declarator = node.children.find(c => c?.type === 'variable_declarator');
    if (!declarator) return;
    const nameNode = declarator.childForFieldName('name');
    if (!nameNode || !nameNode.text) return;

    const valueNode = declarator.childForFieldName('value');
    const value = valueNode ? valueNode.text.replace(/\s+/g, ' ').slice(0, 120) : undefined;

    symbols.push({
      name: nameNode.text,
      kind: 'variable',
      line: node.startPosition.row,
      nameColumn: nameNode.startPosition.column,
      value,
      exported: true,
    });
  }

  private isExported(node: Node): boolean {
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === 'export_statement') return true;
    if (parent.type === 'export_default_declaration') return true;
    return false;
  }

  walk(node: Node, visit: (n: Node) => void): void {
    visit(node);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) this.walk(child, visit);
    }
  }

  private readCallee(node: Node): { name: string; receiver: string | null } | null {
    const nameField   = node.childForFieldName('name');
    const objectField = node.childForFieldName('object');
    if (objectField && nameField) {
      const name     = nameField.text;
      const recvText = objectField.text;
      if (/[()[\]]/.test(recvText)) return { name, receiver: '<computed>' };
      const lastDot  = recvText.lastIndexOf('.');
      const receiver = lastDot >= 0 ? recvText.slice(lastDot + 1) : recvText;
      return { name, receiver: receiver || null };
    }

    const fnNode = node.childForFieldName('function') ?? node.childForFieldName('name');
    if (!fnNode) return null;

    const text    = fnNode.text;
    const lastDot = text.lastIndexOf('.');
    if (lastDot < 0) return { name: text, receiver: null };

    const name      = text.slice(lastDot + 1);
    const beforeDot = text.slice(0, lastDot);
    const prevDot   = beforeDot.lastIndexOf('.');
    const receiver  = prevDot >= 0 ? beforeDot.slice(prevDot + 1) : beforeDot;

    if (/[()[\]]/.test(receiver)) return { name, receiver: '<computed>' };
    return { name, receiver: receiver || null };
  }
}