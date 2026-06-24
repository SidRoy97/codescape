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
  // This lets the graph builder resolve which symbol a common name refers to
  // instead of matching every symbol with that name.
  receiver: string | null;
  // Line where the call happens.
  line: number;
}

// The raw result of parsing one file: what it declares and what it calls.
export interface ParseResult {
  symbols: ParsedSymbol[];
  calls: ParsedCall[];
}

// Maps a VS Code language id to its grammar file name.
// JavaScript and TypeScript are separate grammars but both are loaded.
const GRAMMAR_FILES: Record<string, string> = {
  javascript:      'tree-sitter-javascript.wasm',
  javascriptreact: 'tree-sitter-javascript.wasm',
  typescript:      'tree-sitter-typescript.wasm',
  typescriptreact: 'tree-sitter-tsx.wasm',
  python:          'tree-sitter-python.wasm',
  java:            'tree-sitter-java.wasm',
};

// Tree-sitter node types that declare a function/class/method, per language.
// Kept tiny on purpose — only the declarations v1 needs.
const DECLARATION_TYPES: Record<string, Record<string, ParsedSymbol['kind']>> = {
  javascript: {
    function_declaration:       'function',
    method_definition:          'method',
    class_declaration:          'class',
    // Arrow functions assigned to a const at any scope level.
    // e.g. const analyzeDocument = async (...) => { ... }
    // e.g. const ensureGraph = async (): Promise<void> => { ... }
    lexical_declaration:        'function',
  },
  typescript: {
    function_declaration:       'function',
    method_definition:          'method',
    class_declaration:          'class',
    lexical_declaration:        'function',
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

// Tree-sitter node types that represent a call expression, per language.
const CALL_TYPES: Record<string, string> = {
  javascript: 'call_expression',
  typescript: 'call_expression',
  python:     'call',
  java:       'method_invocation',
};

// Single job: turn file text into raw symbols and calls using Tree-sitter.
// This is the only file aware of Tree-sitter. Security note: Tree-sitter
// parses in-process via WebAssembly — it runs no shell and makes no network
// calls, so there is no command-injection surface here. Do not add any
// exec/spawn/fetch logic to this file.
export class LanguageParser {
  // One Tree-sitter Language object per grammar, loaded lazily and cached.
  private languages = new Map<string, Language>();
  private parser?: Parser;
  private ready = false;

  constructor(private readonly extensionPath: string) {}

  // Initialise the Tree-sitter runtime once. Safe to call repeatedly.
  async init(): Promise<void> {
    if (this.ready) return;
    await Parser.init();
    this.parser = new Parser();
    this.ready = true;
  }

  // Returns the base grammar key (javascript/typescript/python/java)
  // for a VS Code language id, or undefined if unsupported.
  private grammarKey(languageId: string): string | undefined {
    if (languageId === 'javascriptreact') return 'javascript';
    if (languageId === 'typescriptreact') return 'typescript';
    if (GRAMMAR_FILES[languageId]) return languageId;
    return undefined;
  }

  // Load and cache the grammar for a language id. Returns null if unsupported.
  private async loadLanguage(languageId: string): Promise<Language | null> {
    const file = GRAMMAR_FILES[languageId];
    if (!file) return null;

    if (this.languages.has(file)) {
      return this.languages.get(file)!;
    }

    const wasmPath = path.join(this.extensionPath, 'media', 'grammars', file);
    const lang = await Language.load(wasmPath);
    this.languages.set(file, lang);
    return lang;
  }

  // Parse one document into raw symbols and calls.
  // Returns empty arrays for unsupported languages — never throws on those.
  async parse(document: vscode.TextDocument): Promise<ParseResult> {
    await this.init();

    const grammar = this.grammarKey(document.languageId);
    if (!grammar || !this.parser) {
      return { symbols: [], calls: [] };
    }

    const lang = await this.loadLanguage(document.languageId);
    if (!lang) return { symbols: [], calls: [] };

    this.parser.setLanguage(lang);
    const tree = this.parser.parse(document.getText());
    if (!tree) return { symbols: [], calls: [] };

    const declTypes = DECLARATION_TYPES[grammar] ?? {};
    const callType  = CALL_TYPES[grammar];

    const symbols: ParsedSymbol[] = [];
    const calls: ParsedCall[] = [];

    // Walk the syntax tree once, collecting declarations and calls.
    this.walk(tree.rootNode, node => {
      const kind = declTypes[node.type];
      if (kind) {
        // Standard declarations (function_declaration, method_definition,
        // class_declaration) expose a "name" field directly.
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
          // lexical_declaration covers `const foo = () => ...` and
          // `const foo = async function ...`. We extract every declarator
          // that has an arrow_function or function_expression as its value,
          // so only real function-valued consts become symbols — not
          // `const x = 5` or `const cfg = config.get(...)`.
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

  // Extract arrow-function or function-expression declarators from a
  // lexical_declaration node (const/let). Each variable_declarator whose
  // value is an arrow_function or function_expression becomes a 'function'
  // symbol. This catches patterns like:
  //   const analyzeDocument = async (doc, ms = 0) => { ... }
  //   const ensureGraph = async (): Promise<void> => { ... }
  //   const symbolUnderCursor = async () => { ... }
  private extractArrowFunctions(lexDecl: Node, symbols: ParsedSymbol[]): void {
    for (let i = 0; i < lexDecl.childCount; i++) {
      const child = lexDecl.child(i);
      if (!child || child.type !== 'variable_declarator') continue;

      const nameNode  = child.childForFieldName('name');
      const valueNode = child.childForFieldName('value');
      if (!nameNode || !valueNode) continue;

      // Only promote to a symbol when the right-hand side is actually a function.
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

  // Depth-first walk over the syntax tree, calling `visit` on each node.
  // We skip into the children of lexical_declaration ourselves (via
  // extractArrowFunctions above), so we do NOT recurse into its children
  // here — doing so would double-visit the variable_declarator subtree and
  // potentially emit duplicate symbols.
  private walk(node: Node, visit: (n: Node) => void): void {
    visit(node);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) this.walk(child, visit);
    }
  }

  // Read the name being called and its receiver from a call expression.
  // Handles plain calls (foo() → name "foo", receiver null) and member calls
  // (obj.foo() → name "foo", receiver "obj"; this.foo() → receiver "this").
  // For chained access (a.b.foo()) the receiver is the segment just before the
  // method ("b"), which is the most useful part for resolution.
  private readCallee(node: Node): { name: string; receiver: string | null } | null {
    // Java's method_invocation exposes the receiver and method as separate
    // fields ("object" and "name") rather than a single dotted "function"
    // node, so I handle it explicitly to capture the receiver.
    const nameField = node.childForFieldName('name');
    const objectField = node.childForFieldName('object');
    if (objectField && nameField) {
      const name = nameField.text;
      const recvText = objectField.text;
      // A computed receiver (call/index result) cannot be typed by name.
      if (/[()\[\]]/.test(recvText)) return { name, receiver: '<computed>' };
      // For a dotted receiver like "this.store", keep the last segment.
      const lastDot = recvText.lastIndexOf('.');
      const receiver = lastDot >= 0 ? recvText.slice(lastDot + 1) : recvText;
      return { name, receiver: receiver || null };
    }

    const fnNode = node.childForFieldName('function')
      ?? node.childForFieldName('name');
    if (!fnNode) return null;

    const text = fnNode.text;
    const lastDot = text.lastIndexOf('.');
    if (lastDot < 0) {
      return { name: text, receiver: null };
    }

    const name = text.slice(lastDot + 1);

    // The receiver is the segment immediately before the method name. For
    // "this.store.get" that is "store"; for "this.foo" it is "this".
    const beforeDot = text.slice(0, lastDot);
    const prevDot = beforeDot.lastIndexOf('.');
    const receiver = prevDot >= 0 ? beforeDot.slice(prevDot + 1) : beforeDot;

    // If the receiver is a call or index result (e.g. "cfg()" in
    // this.cfg().get(), or "arr[0]" ), its type cannot be known from the name
    // alone, so name-matching would create false edges. I mark it computed so
    // the graph builder drops the call rather than guessing.
    if (/[()\[\]]/.test(receiver)) {
      return { name, receiver: '<computed>' };
    }

    return { name, receiver: receiver || null };
  }
}