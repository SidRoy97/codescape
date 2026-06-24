import * as vscode from 'vscode';
import { Node } from 'web-tree-sitter';
import { LanguageParser } from '../graph/LanguageParser';
import { Issue } from '../types';

// Single job: find data that flows from an untrusted SOURCE to a dangerous
// SINK without passing through a SANITIZER, within a single function body.
//
// Intra-file taint tracking — marks variables tainted when assigned from a
// source, propagates taint through simple assignments, clears it when a
// sanitizer is applied, and flags when a tainted value reaches a sink.
// Cross-function and cross-file flow is handled by CrossFileTaintScanner.
//
// Design goal: high precision over high recall. A security tool that
// over-reports gets muted. Sources, sinks, and sanitizers are intentionally
// a tight, high-confidence set that works across JS/TS, Python, and Java.

// ─── Sources ──────────────────────────────────────────────────────────────────
// Untrusted inputs — high-confidence web/form/CLI sources across all languages.
const SOURCE_PATTERNS: RegExp[] = [
  // JavaScript / TypeScript — Express / Fastify / Koa
  /\breq\.(?:body|query|params|headers|cookies)\b/,
  /\brequest\.(?:body|query|params|headers)\b/,
  // React form input
  /\be\.target\.value\b/,
  /\bevent\.target\.value\b/,
  // Node CLI
  /\bprocess\.argv\b/,
  // Python — Flask
  /\brequest\.(?:args|form|json|data|files|cookies|headers)\b/,
  /\brequest\.args\.get\s*\(/,
  /\brequest\.form\.get\s*\(/,
  /\brequest\.get_json\s*\(/,
  // Python — Django
  /\brequest\.(?:GET|POST|FILES|COOKIES|META)\b/,
  /\brequest\.GET\.get\s*\(/,
  /\brequest\.POST\.get\s*\(/,
  // Java — Servlet
  /\.getParameter\s*\(/,
  /\.getHeader\s*\(/,
  /\.getQueryString\s*\(/,
  /\.getInputStream\s*\(/,
];

// ─── Sinks ────────────────────────────────────────────────────────────────────
interface SinkDef {
  pattern:    RegExp;
  message:    string;
  suggestion: string;
}

const SINKS: SinkDef[] = [

  // ── XSS — JavaScript / TypeScript ──
  {
    pattern:    /\.innerHTML\s*=/,
    message:    'User input flows into innerHTML without sanitization. An attacker can inject scripts that run in the victim\'s browser.',
    suggestion: 'Use textContent for plain text, or sanitize with DOMPurify.sanitize(input) before assigning to innerHTML.',
  },
  {
    pattern:    /dangerouslySetInnerHTML/,
    message:    'User input flows into dangerouslySetInnerHTML. React bypasses its own escaping here, making XSS possible.',
    suggestion: 'Sanitize first: { __html: DOMPurify.sanitize(input) }. Never pass raw user data.',
  },
  {
    pattern:    /\bdocument\.write\s*\(/,
    message:    'User input flows into document.write(). This renders HTML directly and is a classic XSS vector.',
    suggestion: 'Avoid document.write(). Use DOM methods (createElement, textContent) with sanitized content instead.',
  },

  // ── XSS — Java HTTP response ──
  {
    pattern:    /response\.getWriter\s*\(\s*\)\s*\.\s*(?:print|println|write)\s*\(/,
    message:    'User input is written directly to the HTTP response without encoding. An attacker can inject HTML or scripts.',
    suggestion: 'Encode output before writing: use OWASP Java Encoder — Encode.forHtml(userInput).',
  },
  {
    pattern:    /out\.(?:print|println)\s*\(/,
    message:    'User input reaches a JSP/Servlet output stream without encoding — XSS risk.',
    suggestion: 'Encode with OWASP Java Encoder: Encode.forHtml(userInput) before printing.',
  },

  // ── Code injection ──
  {
    pattern:    /\beval\s*\(/,
    message:    'User input reaches eval(). The attacker controls what JavaScript code runs in your application.',
    suggestion: 'Remove eval(). Use JSON.parse() for data, or restructure to avoid running dynamic code.',
  },
  {
    pattern:    /\bnew\s+Function\s*\(/,
    message:    'User input reaches new Function(). This executes arbitrary code the same way eval() does.',
    suggestion: 'Remove new Function(). Restructure to avoid dynamic code execution.',
  },

  // ── SQL injection — JS / Python ──
  {
    pattern:    /\.(?:query|execute|executemany|executeQuery|executeUpdate|run)\s*\(/,
    message:    'User input is used directly in a database query. An attacker can read, modify, or delete data in your database.',
    suggestion: 'Use parameterized queries: db.query("SELECT * FROM t WHERE id = ?", [userInput]). Never concatenate user data into SQL.',
  },

  // ── SQL injection — Java Statement ──
  {
    pattern:    /\.(?:executeQuery|executeUpdate|execute)\s*\(\s*[^)]*\+/,
    message:    'A SQL query is built by concatenating user input. An attacker can manipulate the query to access or destroy data.',
    suggestion: 'Use PreparedStatement with ? placeholders: pstmt.setString(1, userInput). Never build SQL by string concatenation.',
  },

  // ── HTTP response — Express ──
  {
    pattern:    /\bres\.(?:send|write|end|json)\s*\(/,
    message:    'User input is sent back in the HTTP response without encoding. If a browser renders this, it can execute injected scripts.',
    suggestion: 'Encode the value before sending it back, or ensure your template engine auto-escapes output.',
  },

  // ── Command injection — JS / Python ──
  {
    pattern:    /\b(?:exec|spawn|execSync|spawnSync)\s*\(/,
    message:    'User input reaches a shell command. An attacker can run arbitrary commands on your server.',
    suggestion: 'Never pass user input to shell commands. Use a fixed command with a validated args array, and shell=False in Python.',
  },

  // ── Command injection — Python ──
  {
    pattern:    /\bos\.(?:system|popen)\s*\(/,
    message:    'User input reaches os.system() or os.popen(). An attacker can run arbitrary commands on your server.',
    suggestion: 'Replace with subprocess.run(["cmd", arg], shell=False) and validate every argument against an allowlist.',
  },
  {
    pattern:    /\bsubprocess\.(?:run|call|Popen|check_output)\s*\(/,
    message:    'User input reaches subprocess. If shell=True is used or the input is unsanitized, the attacker controls the command.',
    suggestion: 'Pass a list of arguments instead of a shell string, and set shell=False.',
  },

  // ── Command injection — Java ──
  {
    pattern:    /Runtime\.getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(/,
    message:    'User input reaches Runtime.exec(). An attacker can run arbitrary commands on the server.',
    suggestion: 'Use ProcessBuilder with a fixed command array: new ProcessBuilder("cmd", validatedArg). Validate every argument.',
  },
  {
    pattern:    /new\s+ProcessBuilder\s*\(/,
    message:    'User input reaches ProcessBuilder. If the command or its arguments are not fixed, the attacker controls execution.',
    suggestion: 'Hard-code the command name and validate each argument strictly before passing it to ProcessBuilder.',
  },

  // ── Path traversal ──
  {
    pattern:    /(?:readFile|writeFile|readFileSync|writeFileSync|createReadStream|open)\s*\(/,
    message:    'User input is used in a file path. An attacker can read or overwrite files outside your intended directory (path traversal).',
    suggestion: 'Use path.basename(userInput) to strip directory components, then verify the resolved path starts with your allowed base directory.',
  },
];

// ─── Sanitizers ───────────────────────────────────────────────────────────────
// Applying any of these breaks the taint flow — the value is considered safe.
// Conservative on purpose: only well-known sanitizers are listed.
const SANITIZERS: RegExp[] = [
  // JS/TS
  /\bDOMPurify\.sanitize\s*\(/,
  /\bsanitize\w*\s*\(/,
  /\bescape\w*\s*\(/,
  /\bencodeURI(?:Component)?\s*\(/,
  /\bvalidate\w*\s*\(/,
  /\bparseInt\s*\(/,
  /\bparseFloat\s*\(/,
  /\bNumber\s*\(/,
  // Python
  /\bbleach\.clean\s*\(/,
  /\bmarkupsafe\.escape\s*\(/,
  /\bhtml\.escape\s*\(/,
  /\bquote(?:_plus)?\s*\(/,         // urllib.parse.quote
  // Java
  /\bEncode\.for\w+\s*\(/,          // OWASP Java Encoder
  /\bHtmlUtils\.htmlEscape\s*\(/,   // Spring
  /\bStringEscapeUtils\.\w+\s*\(/,  // Apache Commons
  /\bPreparedStatement\b/,          // parameterized query — taint stops here
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
  // Returns [] for unsupported languages or on any parse failure.
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

    this.parser.walk(root, node => {
      if (fnTypes.includes(node.type)) {
        this.analyzeScope(node, issues);
      }
    });

    return this.dedupe(issues);
  }

  // Walk one function's statements, tracking taint through assignments and
  // flagging when tainted data reaches a sink without a sanitizer in between.
  private analyzeScope(fnNode: Node, issues: Issue[]): void {
    const tainted = new Set<string>();
    const statements: Node[] = [];
    this.collectStatements(fnNode, statements);

    for (const stmt of statements) {
      const text = stmt.text;
      const line = stmt.startPosition.row;

      const assign = this.readAssignment(text);
      if (assign) {
        const rhsTainted = this.isTainted(assign.rhs, tainted)
                        && !this.isSanitized(assign.rhs);
        if (rhsTainted) {
          tainted.add(assign.lhs);
        } else {
          tainted.delete(assign.lhs);
        }
      }

      for (const sink of SINKS) {
        if (!sink.pattern.test(text)) continue;
        if (this.isSanitized(text)) continue;
        if (!this.isTainted(text, tainted)) continue;

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
        break;
      }
    }
  }

  // Collect statement-level descendants without descending into nested
  // function bodies — those are analyzed as their own scopes.
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

  private readAssignment(text: string): { lhs: string; rhs: string } | null {
    const m = text.match(/^\s*(?:const|let|var\s+)?\s*([\w.$\[\]'"]+)\s*=\s*([^=].*)$/s);
    if (!m) return null;
    const lhsRaw  = m[1];
    const rhs     = m[2];
    const lastDot = lhsRaw.lastIndexOf('.');
    const lhs     = lastDot >= 0 ? lhsRaw.slice(lastDot + 1) : lhsRaw;
    if (!/^[\w$]+$/.test(lhs)) return null;
    return { lhs, rhs };
  }

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

  private isSanitized(text: string): boolean {
    return SANITIZERS.some(s => s.test(text));
  }

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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}