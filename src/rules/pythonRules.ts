import { Issue } from '../types';

interface Rule {
  id:          string;
  pattern:     RegExp;
  message:     string;
  severity:    Issue['severity'];
  category:    Issue['category'];
  suggestion?: string;
}

const RULES: Rule[] = [

  // --- Security: Injection ---

  { id: 'py:no-exec',
    pattern: /\bexec\s*\(/g,
    severity: 'error', category: 'security',
    message: 'exec() executes arbitrary code — severe security risk.' },

  { id: 'py:no-eval',
    pattern: /\beval\s*\(/g,
    severity: 'error', category: 'security',
    message: 'eval() executes arbitrary code — severe security risk.',
    suggestion: 'Use ast.literal_eval() if you only need to parse data structures.' },

  { id: 'py:sql-injection-percent',
    pattern: /cursor\.(execute|executemany)\s*\([^)]*%[^)]*\)/g,
    severity: 'error', category: 'security',
    message: 'SQL query uses % formatting — SQL injection risk.',
    suggestion: 'Use parameterized queries: cursor.execute(sql, (param,))' },

  { id: 'py:sql-injection-fstring',
    pattern: /cursor\.(execute|executemany)\s*\(\s*f['"]/g,
    severity: 'error', category: 'security',
    message: 'SQL query uses f-string — SQL injection risk.',
    suggestion: 'Use parameterized queries: cursor.execute("SELECT * FROM t WHERE id = ?", (id,))' },

  { id: 'py:sql-injection-format',
    pattern: /cursor\.(execute|executemany)\s*\([^)]*\.format\s*\(/g,
    severity: 'error', category: 'security',
    message: 'SQL query uses .format() — SQL injection risk.',
    suggestion: 'Use parameterized queries instead of string formatting.' },

  { id: 'py:subprocess-shell',
    pattern: /subprocess\.\w+\s*\([^)]*shell\s*=\s*True/g,
    severity: 'error', category: 'security',
    message: 'subprocess with shell=True is vulnerable to command injection.',
    suggestion: 'Pass a list of arguments and use shell=False.' },

  { id: 'py:os-system',
    pattern: /os\.system\s*\(/g,
    severity: 'error', category: 'security',
    message: 'os.system() is vulnerable to command injection.',
    suggestion: 'Use subprocess.run(["cmd", "arg"], shell=False) instead.' },

  { id: 'py:os-popen',
    pattern: /os\.popen\s*\(/g,
    severity: 'error', category: 'security',
    message: 'os.popen() is vulnerable to command injection.',
    suggestion: 'Use subprocess.run() with shell=False instead.' },

  // --- Security: Deserialization ---

  { id: 'py:no-pickle',
    pattern: /\bpickle\.(load|loads)\s*\(/g,
    severity: 'error', category: 'security',
    message: 'pickle.load() can execute arbitrary code on untrusted data.',
    suggestion: 'Use json.load() for data interchange. Never unpickle data from untrusted sources.' },

  { id: 'py:yaml-unsafe-load',
    pattern: /yaml\.load\s*\([^)]*\)(?!\s*,\s*Loader)/g,
    severity: 'error', category: 'security',
    message: 'yaml.load() without Loader can execute arbitrary Python code.',
    suggestion: 'Use yaml.safe_load() or yaml.load(data, Loader=yaml.SafeLoader)' },

  { id: 'py:no-marshal',
    pattern: /\bmarshal\.loads?\s*\(/g,
    severity: 'error', category: 'security',
    message: 'marshal.load() can execute arbitrary code on untrusted data.',
    suggestion: 'Use json for safe data serialization.' },

  // --- Security: Hardcoded secrets ---

  { id: 'py:hardcoded-secret',
    pattern: /(?:password|secret|api_?key|token|auth_?key|private_?key)\s*=\s*['"][^'"]{4,}['"]/gi,
    severity: 'error', category: 'security',
    message: 'Possible hardcoded secret or credential detected.',
    suggestion: 'Use os.environ.get("MY_SECRET") or a secrets manager.' },

  // --- Security: Cryptography ---

  { id: 'py:weak-hash-md5',
    pattern: /hashlib\.md5\s*\(/g,
    severity: 'error', category: 'security',
    message: 'MD5 is cryptographically broken — do not use for security.',
    suggestion: 'Use hashlib.sha256() for checksums, or bcrypt for passwords.' },

  { id: 'py:weak-hash-sha1',
    pattern: /hashlib\.sha1\s*\(/g,
    severity: 'warning', category: 'security',
    message: 'SHA1 is deprecated for security use.',
    suggestion: 'Use hashlib.sha256() or hashlib.sha512() instead.' },

  { id: 'py:insecure-random',
    pattern: /\brandom\.(random|randint|choice|randrange)\s*\(/g,
    severity: 'warning', category: 'security',
    message: 'random module is not cryptographically secure.',
    suggestion: 'Use secrets module: secrets.token_hex(), secrets.choice(), secrets.randbelow()' },

  // --- Security: Path traversal ---

  { id: 'py:path-traversal',
    pattern: /open\s*\(\s*(?:request\.|req\.|flask\.request\.|self\.request\.)\w+/g,
    severity: 'error', category: 'security',
    message: 'File path comes from request data — path traversal vulnerability.',
    suggestion: 'Sanitize with os.path.basename() and validate against an allowed directory.' },

  // --- Security: Network ---

  { id: 'py:ssl-verify-disabled',
    pattern: /verify\s*=\s*False/g,
    severity: 'error', category: 'security',
    message: 'SSL certificate verification disabled — vulnerable to MITM attacks.',
    suggestion: 'Remove verify=False. If using self-signed certs, pass verify="/path/to/cert.pem"' },

  { id: 'py:bind-all-interfaces',
    pattern: /host\s*=\s*['"]0\.0\.0\.0['"]/g,
    severity: 'warning', category: 'security',
    message: 'Server bound to 0.0.0.0 — exposed on all network interfaces.',
    suggestion: 'Bind to "127.0.0.1" in development. Use a reverse proxy in production.' },

  { id: 'py:flask-debug-mode',
    pattern: /debug\s*=\s*True/g,
    severity: 'error', category: 'security',
    message: 'Flask debug mode enabled — exposes interactive debugger to the network.',
    suggestion: 'Never use debug=True in production. Use FLASK_ENV=development instead.' },

  // --- Security: Input validation ---

  { id: 'py:assert-for-auth',
    pattern: /assert\s+(?:user|auth|permission|role|is_admin|is_authenticated)/gi,
    severity: 'error', category: 'security',
    message: 'assert used for authentication check — disabled with Python -O flag.',
    suggestion: 'Use explicit if/raise: if not user.is_authenticated: raise PermissionError()' },

  // --- Code smells ---

  { id: 'py:bare-except',
    pattern: /\bexcept\s*:/g,
    severity: 'warning', category: 'code-smell',
    message: 'Bare except: catches everything including SystemExit.',
    suggestion: 'Specify exception type: except ValueError: or except Exception:' },

  { id: 'py:mutable-default',
    pattern: /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\}|list\(\)|dict\(\))/g,
    severity: 'error', category: 'code-smell',
    message: 'Mutable default argument shared across all function calls.',
    suggestion: 'Use None as default: def fn(items=None):\n    if items is None: items = []' },

  { id: 'py:print',
    pattern: /^\s*print\s*\(/gm,
    severity: 'hint', category: 'code-smell',
    message: 'print() found — use the logging module in production.',
    suggestion: 'Replace with logging.info() or logging.debug()' },

  { id: 'py:wildcard-import',
    pattern: /^\s*from\s+\w+\s+import\s+\*/gm,
    severity: 'warning', category: 'code-smell',
    message: 'Wildcard import pollutes the namespace.',
    suggestion: 'Import only what you need: from module import SpecificClass' },

  { id: 'py:global',
    pattern: /^\s*global\s+\w+/gm,
    severity: 'warning', category: 'code-smell',
    message: 'global variable — hard to test and reason about.',
    suggestion: 'Pass as parameter or encapsulate in a class.' },

  { id: 'py:todo',
    pattern: /#\s*(TODO|FIXME|HACK|XXX)/gi,
    severity: 'info', category: 'code-smell',
    message: 'TODO/FIXME comment — move to your issue tracker.' },
];

// Skip lines that are rule/pattern definitions rather than real code, so a
// linter or security file (this project included) does not flag its own
// detection patterns — e.g. the line `pattern: /\beval\s*\(/` contains "eval(".
// Real exec()/eval()/SQL calls do not take this shape and are still detected.
function isRuleDefinitionLine(line: string): boolean {
  const t = line.trim();
  if (/^pattern:\s*\//.test(t)) return true;
  if (/^\{?\s*id:\s*['"][a-z]+:/.test(t)) return true;
  if (/^(message|suggestion):\s*['"]/.test(t)) return true;
  return false;
}

export function runPythonRules(lines: string[]): Issue[] {
  const issues: Issue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip pure comment lines to avoid false positives
    if (line.trim().startsWith('#') && !/TODO|FIXME|HACK|XXX/i.test(line)) continue;

    // Skip rule-definition lines (see isRuleDefinitionLine).
    if (isRuleDefinitionLine(line)) continue;

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = rule.pattern.exec(line)) !== null) {
        issues.push({
          id:         `${rule.id}:${i}:${match.index}`,
          message:    rule.message,
          severity:   rule.severity,
          category:   rule.category,
          line:       i,
          column:     match.index,
          endLine:    i,
          endColumn:  match.index + match[0].length,
          rule:       rule.id,
          suggestion: rule.suggestion,
          source:     'static',
        });
        if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      }
    }
  }

  return issues;
}