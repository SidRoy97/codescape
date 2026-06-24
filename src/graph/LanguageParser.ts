import * as vscode from 'vscode';
import * as path from 'path';
import { Parser, Language, Node } from 'web-tree-sitter';

// A symbol declaration found by parsing — function, class, or method.
export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method';
  line: number;
  // Character offset of the symbol's name on its line. The call-hierarchy
  // provider needs the cursor on the name itself, not just the line start.
  nameColumn: number;
}

// A call expression found by parsing — "this code calls something named X".
export interface ParsedCall {
  // The name being called, e.g. "validateToken".
  calleeName: string;
  // The receiver the call was made on, if any: for `store.get()` this is
  // "store"; for `this.foo()` it is "this"; for a plain `foo()` it is null.
  receiver: string | null;
  // Line where the call happens.
  line: number;
}

// The raw result of parsing one file: what it declares and what it calls.
export interface ParseResult {
  symbols: ParsedSymbol[];
  calls: ParsedCall[];
}

// The raw syntax tree plus its grammar key — returned by parseTree() so
// callers like TaintScanner can walk the AST directly without re-parsing.
export interface ParseTreeResult {
  root: Node;
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
    method_declaration: 'method',
    class_declaration:  'class',
  },
};

const CALL_TYPES: Record<string, string> = {
  javascript: 'call_expression',
  typescript: 'call_expression',
  python:     'call',
  java:       'method_invocation',
};

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

  // Expose the raw syntax tree for callers that need to walk the AST directly
  // (e.g. TaintScanner). Returns null for unsupported languages or on any
  // parse failure — callers must handle null gracefully.
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
    if (!grammar || !this.parser) return { symbols: [], calls: [] };
    const lang = await this.loadLanguage(document.languageId);
    if (!lang) return { symbols: [], calls: [] };
    this.parser.setLanguage(lang);
    const tree = this.parser.parse(document.getText());
    if (!tree) return { symbols: [], calls: [] };

    const declTypes = DECLARATION_TYPES[grammar] ?? {};
    const callType  = CALL_TYPES[grammar];
    const symbols: ParsedSymbol[] = [];
    const calls: ParsedCall[] = [];

    this.walk(tree.rootNode, node => {
      const kind = declTypes[node.type];
      if (kind) {
        if (node.type !== 'lexical_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode && nameNode.text) {
            symbols.push({
              name: nameNode.text,
              kind,
              line: node.startPosition.row,
              nameColumn: nameNode.startPosition.column,
            });
          }
        } else {
          this.extractArrowFunctions(node, symbols);
        }
      }
      if (node.type === callType) {
        const callee = this.readCallee(node);
        if (callee) {
          calls.push({ calleeName: callee.name, receiver: callee.receiver, line: node.startPosition.row });
        }
      }
    });

    return { symbols, calls };
  }

  private extractArrowFunctions(lexDecl: Node, symbols: ParsedSymbol[]): void {
    for (let i = 0; i < lexDecl.childCount; i++) {
      const child = lexDecl.child(i);
      if (!child || child.type !== 'variable_declarator') continue;
      const nameNode  = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (!nameNode || !valueNode) continue;
      const isFn = valueNode.type === 'arrow_function'
                || valueNode.type === 'function_expression'
                || valueNode.type === 'async_function_expression';
      if (isFn && nameNode.text) {
        symbols.push({
          name: nameNode.text,
          kind: 'function',
          line: lexDecl.startPosition.row,
          nameColumn: nameNode.startPosition.column,
        });
      }
    }
  }

  // Public so TaintScanner and other AST consumers can reuse it directly
  // without re-parsing. Callers that need to stop at function boundaries
  // must do so inside their own visitor function.
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
      if (/[()\[\]]/.test(recvText)) return { name, receiver: '<computed>' };
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

    if (/[()\[\]]/.test(receiver)) return { name, receiver: '<computed>' };
    return { name, receiver: receiver || null };
  }
}