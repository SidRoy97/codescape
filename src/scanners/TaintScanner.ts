import * as vscode from 'vscode';
import { Node } from 'web-tree-sitter';
import { LanguageParser } from '../graph/LanguageParser';
import { Issue } from '../types';

// Single job: find data that flows from an untrusted SOURCE to a dangerous
// SINK without passing through a SANITIZER, within a single function body.
//
// This is lightweight intra-file taint tracking, not a full dataflow engine.
// Phase 1 deliberately stays inside one function and one file: it marks
// variables tainted when assigned from a source, propagates taint through
// simple assignments, clears it when a sanitizer is applied, and flags when a
// tainted value reaches a sink. Cross-function and cross-file flow is Phase 2
// and will use the code graph.
//
// Design goal: high precision over high recall. I would rather miss a
// convoluted flow than cry wolf — a security tool that over-reports gets
// muted. Sources, sinks, and sanitizers are intentionally a tight,
// high-confidence set.

// Untrusted inputs — high-confidence web/form sources only in Phase 1.
const SOURCE_PATTERNS: RegExp[] = [
  /\breq\.(?:body|query|params|headers|cookies)\b/,
  /\brequest\.(?:body|query|params|headers)\b/,
  /\.getParameter\s*\(/,            // Java servlet
  /\be\.target\.value\b/,           // React form input
  /\bevent\.target\.value\b/,
  /\bprocess\.argv\b/,
];

// Dangerous destinations. Each has a message and a fix suggestion.
interface SinkDef {
  pattern:    RegExp;
  message:    string;
  suggestion: string;
}

const SINKS: SinkDef[] = [
  {
    pattern:    /\.innerHTML\s*=/,
    message:    'Untrusted input reaches innerHTML — XSS risk.',
    suggestion: 'Use textContent, or sanitize with DOMPurify.sanitize() before assigning.',
  },
  {
    pattern:    /dangerouslySetInnerHTML/,
    message:    'Untrusted input reaches dangerouslySetInnerHTML — XSS risk.',
    suggestion: 'Sanitize first: { __html: DOMPurify.sanitize(value) }',
  },
  {
    pattern:    /\beval\s*\(/,
    message:    'Untrusted input reaches eval() — code injection risk.',
    suggestion: 'Never pass user input to eval(). Restructure to avoid dynamic execution.',
  },
  {
    pattern:    /\.(?:query|execute|executeQuery|executeUpdate)\s*\(/,
    message:    'Untrusted input reaches a database query — SQL injection risk.',
    suggestion: 'Use parameterized queries: db.query("... WHERE id = ?", [value]).',
  },
  {
    pattern:    /\bres\.(?:send|write|end)\s*\(/,
    message:    'Untrusted input written to HTTP response — XSS risk.',
    suggestion: 'Encode output (e.g. escape-html) before sending user input back.',
  },
  {
    pattern:    /\.(?:exec|spawn)\s*\(/,
    message:    'Untrusted input reaches a shell/exec call — command injection risk.',
    suggestion: 'Avoid shells; pass a fixed command with an args array and validate inputs.',
  },
];

// Applying any of these breaks the taint flow — the value is considered safe.
// Conservative on purpose: only well-known sanitizers are listed. An unusual
// project sanitizer is not trusted silently; we'd rather report.
const SANITIZERS: RegExp[] = [
  /\bDOMPurify\.sanitize\s*\(/,
  /\bsanitize\w*\s*\(/,
  /\bescape\w*\s*\(/,
  /\bencodeURI(?:Component)?\s*\(/,
  /\bvalidate\w*\s*\(/,
  /\bparseInt\s*\(/,
  /\bparseFloat\s*\(/,
  /\bNumber\s*\(/,
];

// Tree-sitter node types that open a fresh taint scope, per grammar.
const FUNCTION_BODY_TYPES: Record<string, string[]> = {
  javascript: ['function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
  typescript: ['function_declaration', 'method_definition', 'arrow_function', 'function_expression'],
  python:     ['function_definition'],
  java:       ['method_declaration', 'constructor_declaration'],
};

export class TaintScanner {
  constructor(private readonly parser: LanguageParser) {}

  // Analyze one document and return any source-to-sink flows as Issues.
  // Returns [] for unsupported languages or on any parse failure — this is an
  // optional on-demand check and must never break the rest of the pipeline.
  async scan(document: vscode.TextDocument): Promise<Issue[]> {
    let parsed;
    try {
      parsed = await this.parser.parseTree(document);
    } catch {
      return [];
    }
    if (!parsed) return [];

    const { root, grammar } = parsed;
    const fnTypes = FUNCTION_BODY_TYPES[grammar] ?? [];
    const issues: Issue[] = [];

    // Find each function body and analyze it as an isolated taint scope.
    this.parser.walk(root, node => {
      if (fnTypes.includes(node.type)) {
        this.analyzeScope(node, issues);
      }
    });

    return this.dedupe(issues);
  }

  // Walk one function's statements top to bottom, tracking which local names
  // currently hold tainted data, and report when a tainted value reaches a
  // sink. A single linear pass covers the common cases and keeps this fast
  // and predictable. It intentionally does not model branches or loops —
  // that complexity belongs in Phase 2.
  private analyzeScope(fnNode: Node, issues: Issue[]): void {
    const tainted = new Set<string>();
    const statements: Node[] = [];
    this.collectStatements(fnNode, statements);

    for (const stmt of statements) {
      const text = stmt.text;
      const line = stmt.startPosition.row;

      // 1) Does this statement assign a tainted or clean value to a variable?
      const assign = this.readAssignment(text);
      if (assign) {
        const rhsTainted = this.isTainted(assign.rhs, tainted)
                        && !this.isSanitized(assign.rhs);
        if (rhsTainted) {
          tainted.add(assign.lhs);
        } else {
          // Reassignment to a clean value clears prior taint on lhs.
          tainted.delete(assign.lhs);
        }
      }

      // 2) Does a tainted value (or a raw source) reach a sink here?
      for (const sink of SINKS) {
        if (!sink.pattern.test(text)) continue;
        if (this.isSanitized(text)) continue;        // sanitized inline at the sink
        if (!this.isTainted(text, tainted)) continue; // no tainted data present

        issues.push({
          id:         `taint:${line}:${stmt.startPosition.column}`,
          message:    sink.message,
          severity:   'error',
          category:   'security',
          line,
          column:     stmt.startPosition.column,
          endLine:    line,
          endColumn:  stmt.startPosition.column + Math.min(text.length, 120),
          rule:       'taint:source-to-sink',
          suggestion: sink.suggestion,
          source:     'static',
        });
        break; // one finding per statement is enough
      }
    }
  }

  // Gather statement-ish descendants of a function without descending into
  // nested function bodies — those are analyzed as their own scopes by the
  // outer walk, so descending here would mix their variables into this scope.
  private collectStatements(node: Node, out: Node[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      out.push(child);
      const isNestedFn =
        child.type.includes('function') ||
        child.type === 'method_definition' ||
        child.type === 'arrow_function';
      if (!isNestedFn) this.collectStatements(child, out);
    }
  }

  // Parse a simple "lhs = rhs" assignment from a statement's text. Handles
  // `const x = ...`, `let x = ...`, `x = ...`, and `this.x = ...`. Returns
  // the bare variable name for lhs and the full rhs text, or null when the
  // statement is not a single clear assignment.
  private readAssignment(text: string): { lhs: string; rhs: string } | null {
    const m = text.match(/^\s*(?:const|let|var\s+)?\s*([\w.$\[\]'"]+)\s*=\s*([^=].*)$/s);
    if (!m) return null;
    const lhsRaw = m[1];
    const rhs    = m[2];
    const lastDot = lhsRaw.lastIndexOf('.');
    const lhs = lastDot >= 0 ? lhsRaw.slice(lastDot + 1) : lhsRaw;
    // If lhs is not a plain identifier we cannot track it reliably — bail.
    if (!/^[\w$]+$/.test(lhs)) return null;
    return { lhs, rhs };
  }

  // Is there untrusted data referenced in this text — either a direct source
  // access, or a currently-tainted variable name used as a whole word?
  private isTainted(text: string, tainted: Set<string>): boolean {
    for (const src of SOURCE_PATTERNS) {
      if (src.test(text)) return true;
    }
    for (const name of tainted) {
      if (new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(text)) {
        return true;
      }
    }
    return false;
  }

  // Does this text apply a known sanitizer? Used to clear taint on an
  // assignment rhs and to suppress a sink finding when the value is
  // sanitized inline at the point of use.
  private isSanitized(text: string): boolean {
    return SANITIZERS.some(s => s.test(text));
  }

  // Collapse duplicate findings on the same line+rule — a statement can
  // match a sink more than once through nested child nodes.
  private dedupe(issues: Issue[]): Issue[] {
    const seen = new Set<string>();
    return issues.filter(i => {
      const key = `${i.line}:${i.rule}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// Escape a variable name for safe use inside a RegExp.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}