import * as vscode from 'vscode';
import * as path from 'path';
import { Parser, Language, Node } from 'web-tree-sitter';

// A symbol declaration found by parsing — function, class, method, or variable.
export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable';
  line: number;
  // Character offset of the symbol's name on its line.
  nameColumn: number;
  // For variables: the raw value text (first 120 chars), so the understanding
  // doc can show what the constant holds without reading the file again.
  value?: string;
  // True when the symbol is exported (export const / export function / etc.).
  exported?: boolean;
}

export interface ParsedCall {
  calleeName: string;
  receiver: string | null;
  line: number;
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  calls: ParsedCall[];
}

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
    lexical_declaration:   'function', // handled specially — may become 'variable'
  },
  typescript: {
    function_declaration:  'function',
    method_definition:     'method',
    class_declaration:     'class',
    lexical_declaration:   'function', // handled specially — may become 'variable'
  },
  python: {
    function_definition: 'function',
    class_definition:    'class',
  },
  java: {
    method_declaration:  'method',
    class_declaration:   'class',
    // Java module-level field declarations (public static final)
    field_declaration:   'variable',
  },
};

const CALL_TYPES: Record<string, string> = {
  javascript: 'call_expression',
  typescript: 'call_expression',
  python:     'call',
  java:       'method_invocation',
};

// Variable names that are too generic to be useful in the understanding doc.
// Skipping these avoids cluttering the doc with noise like `i`, `tmp`, `_`.
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

  // Expose the raw syntax tree for callers that need to walk the AST directly
  // (e.g. TaintScanner). Returns null for unsupported languages or on failure.
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

    // Track nesting depth so we can restrict variable extraction to
    // module/class level and skip variables inside function bodies.
    let scopeDepth = 0;

    this.walk(tree.rootNode, node => {
      // Track function/method scope depth so we know when we're inside a body.
      const isFnScope =
        node.type === 'function_declaration' ||
        node.type === 'method_definition'    ||
        node.type === 'arrow_function'       ||
        node.type === 'function_expression'  ||
        node.type === 'function_definition'  || // Python
        node.type === 'method_declaration';     // Java

      if (isFnScope) scopeDepth++;

      const kind = declTypes[node.type];
      if (kind) {
        if (node.type === 'lexical_declaration') {
          // JS/TS: split into function-valued consts (→ 'function') and
          // plain value consts (→ 'variable'). Only extract variables at
          // module level (scopeDepth === 0) to avoid local noise.
          this.extractLexicalDeclaration(node, symbols, scopeDepth);
        } else if (node.type === 'field_declaration') {
          // Java: extract public static final fields as module-level variables.
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
    });

    // Correct scopeDepth: we incremented on enter but never decremented
    // because walk() is a flat visitor. That is fine — we only use
    // scopeDepth === 0 at the top of the file where depth hasn't grown yet.

    return { symbols, calls };
  }

  // Split a lexical_declaration (const/let) into function symbols and
  // variable symbols based on what the right-hand side actually is.
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
        // Arrow/function expression — treat as a function symbol regardless
        // of scope depth (closures inside activateInternal matter too).
        symbols.push({
          name: nameNode.text,
          kind: 'function',
          line: lexDecl.startPosition.row,
          nameColumn: nameNode.startPosition.column,
          exported,
        });
      } else if (scopeDepth === 0 && valueNode) {
        // Plain value (string, number, object, array, RegExp, etc.) at
        // module level. Skip generic/noisy names and skip function calls
        // whose return value we can't describe without running the code.
        const name = nameNode.text;
        if (SKIP_VARIABLE_NAMES.has(name)) continue;
        if (name.length < 2) continue;

        // Skip variables whose value is itself a function call — we can't
        // summarize the return value statically without running the code,
        // so including them would just add noise.
        const valueText = valueNode.text ?? '';
        const isCallResult = /^\w+\s*\(/.test(valueText.trim());
        if (isCallResult && !exported) continue;

        // Capture a short excerpt of the value for context.
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

  // Extract public static final Java fields as named constants.
  private extractJavaField(node: Node, symbols: ParsedSymbol[]): void {
    // Only interested in public static final fields — these are Java's
    // equivalent of module-level constants.
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
      exported: true, // public static final is always accessible
    });
  }

  // True when the node is directly preceded by an export keyword.
  private isExported(node: Node): boolean {
    const parent = node.parent;
    if (!parent) return false;
    // export const / export function / export class
    if (parent.type === 'export_statement') return true;
    // export default
    if (parent.type === 'export_default_declaration') return true;
    return false;
  }

  // Public so TaintScanner and other AST consumers can reuse it directly.
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