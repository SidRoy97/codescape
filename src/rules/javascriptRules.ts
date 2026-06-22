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

  // eval() runs any string as code — classic code injection vector
  { id: 'js:no-eval',
    pattern: /\beval\s*\(/g,
    severity: 'error', category: 'security',
    message: 'eval() executes arbitrary code — severe security risk.',
    suggestion: 'Use JSON.parse() for data, or restructure to avoid dynamic execution.' },

  // innerHTML renders HTML including scripts — XSS if value is user-controlled
  { id: 'js:no-inner-html',
    pattern: /\.innerHTML\s*=/g,
    severity: 'warning', category: 'security',
    message: 'innerHTML assignment can cause XSS if value includes user input.',
    suggestion: 'Use textContent for plain text, or sanitize with DOMPurify first.' },

  // document.write is an old XSS vector and blocks page rendering
  { id: 'js:no-document-write',
    pattern: /document\.write\s*\(/g,
    severity: 'warning', category: 'security',
    message: 'document.write() is a security risk and blocks page rendering.' },

  // SQL built inside a DB call with a variable = injection. The verb
  // alternation is grouped so "|" cannot leak into bare words — the previous
  // version omitted the group, so the pattern was effectively
  // "...SELECT" OR "INSERT" OR "UPDATE" OR "DELETE...", which matched any
  // identifier containing "update"/"insert"/"delete" (e.g. cfg.update(...)).
  // Now it requires a query verb, a string opener, a SQL keyword, and a
  // ${...} interpolation, all together.
  { id: 'js:sql-injection',
    pattern: /(?:query|execute|executeQuery|executeUpdate|run)\s*\(\s*[`'"][^`'"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`'"]*\$\{/gi,
    severity: 'error', category: 'security',
    message: 'SQL query built with string interpolation — SQL injection risk.',
    suggestion: 'Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])' },

  // SQL built by string concatenation inside a DB call — the other common
  // injection form (e.g. execute("SELECT ... " + userId)).
  { id: 'js:sql-injection-concat',
    pattern: /(?:query|execute|executeQuery|executeUpdate|run)\s*\(\s*[`'"][^`'"]*\b(?:SELECT|INSERT|UPDATE|DELETE)\b[^`'"]*[`'"]\s*\+/gi,
    severity: 'error', category: 'security',
    message: 'SQL query built with string concatenation — SQL injection risk.',
    suggestion: 'Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])' },

  // Template literal SQL is still injection if it includes variables. The
  // keyword alternation is already grouped here, so this rule was correct;
  // it requires a backtick, a leading SQL keyword, and a ${...}.
  { id: 'js:sql-template-literal',
    pattern: /`\s*(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE)\s[^`]*\$\{/gi,
    severity: 'error', category: 'security',
    message: 'SQL query uses template literal with variables — SQL injection risk.',
    suggestion: 'Use parameterized queries or an ORM like Prisma/TypeORM.' },

  // --- Security: Hardcoded secrets ---

  // Credentials in source code get committed and leaked
  { id: 'js:no-hardcoded-secret',
    pattern: /(?:password|secret|api_?key|token|auth|private_?key)\s*[:=]\s*['"`][^'"`\s]{4,}['"`]/gi,
    severity: 'error', category: 'security',
    message: 'Possible hardcoded secret or credential detected.',
    suggestion: 'Move to environment variables: process.env.MY_SECRET' },

  // JWT secrets hardcoded = anyone can forge tokens
  { id: 'js:hardcoded-jwt-secret',
    pattern: /jwt\.sign\s*\([^,]+,\s*['"`][^'"`]{4,}['"`]/g,
    severity: 'error', category: 'security',
    message: 'JWT signed with hardcoded secret — tokens can be forged.',
    suggestion: 'Use process.env.JWT_SECRET and store it outside source code.' },

  // --- Security: Path traversal ---

  // User input in file paths = attacker can read /etc/passwd etc
  { id: 'js:path-traversal',
    pattern: /(?:readFile|writeFile|readFileSync|writeFileSync|createReadStream)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/g,
    severity: 'error', category: 'security',
    message: 'File path includes user input — path traversal vulnerability.',
    suggestion: 'Sanitize the path: path.basename(userInput) and validate it stays within allowed directory.' },

  // --- Security: Network / SSRF ---

  // Fetch with user-controlled URL = attacker can make server call internal services
  { id: 'js:ssrf-risk',
    pattern: /fetch\s*\(\s*(?:req\.|params\.|query\.|body\.)\w+/g,
    severity: 'error', category: 'security',
    message: 'fetch() URL comes from request data — Server-Side Request Forgery (SSRF) risk.',
    suggestion: 'Validate the URL against an allowlist before making the request.' },

  // --- Security: Insecure crypto ---

  // MD5 is broken — don't use for passwords or security
  { id: 'js:weak-hash-md5',
    pattern: /createHash\s*\(\s*['"`]md5['"`]\s*\)/gi,
    severity: 'error', category: 'security',
    message: 'MD5 is cryptographically broken — do not use for security purposes.',
    suggestion: 'Use bcrypt for passwords, or SHA-256 (crypto.createHash("sha256")) for checksums.' },

  // SHA1 is deprecated for security use
  { id: 'js:weak-hash-sha1',
    pattern: /createHash\s*\(\s*['"`]sha1['"`]\)/g,
    severity: 'warning', category: 'security',
    message: 'SHA1 is deprecated for security use.',
    suggestion: 'Use SHA-256 or SHA-512: crypto.createHash("sha256")' },

  // Math.random is predictable — not suitable for tokens or IDs
  { id: 'js:insecure-random',
    pattern: /Math\.random\s*\(\s*\)/g,
    severity: 'warning', category: 'security',
    message: 'Math.random() is not cryptographically secure.',
    suggestion: 'Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive values.' },

  // --- Security: Cookies ---

  // Cookie without httpOnly can be read by JavaScript — XSS can steal sessions
  { id: 'js:cookie-no-httponly',
    pattern: /(?:res\.cookie|setCookie)\s*\([^)]*\)\s*(?!.*httpOnly)/g,
    severity: 'warning', category: 'security',
    message: 'Cookie set without httpOnly flag — JavaScript can read it.',
    suggestion: 'Add httpOnly: true to prevent XSS-based session theft.' },

  // --- Security: Prototype pollution ---

  // Merging user objects into existing ones can corrupt prototype chain
  { id: 'js:prototype-pollution',
    pattern: /Object\.assign\s*\(\s*\w+\s*,\s*(?:req\.|params\.|query\.|body\.)/g,
    severity: 'error', category: 'security',
    message: 'Object.assign with user input can pollute the prototype chain.',
    suggestion: 'Validate and allowlist keys before merging user-supplied objects.' },

  // --- Security: ReDoS ---

  // RegExp from user input can be used for ReDoS attacks
  { id: 'js:regex-dos',
    pattern: /new\s+RegExp\s*\(\s*(?:req\.|params\.|query\.|body\.)\w+/g,
    severity: 'error', category: 'security',
    message: 'RegExp built from user input — ReDoS (regex denial of service) risk.',
    suggestion: 'Never build regular expressions from user-supplied strings.' },

  // --- Code smells ---

  // console.log left in = noise in production and leaks info
  { id: 'js:no-console',
    pattern: /\bconsole\.(log|warn|error|debug)\s*\(/g,
    severity: 'hint', category: 'code-smell',
    message: 'console statement found — remove before shipping.',
    suggestion: 'Use a logging library like winston or pino.' },

  // debugger stops execution in production
  { id: 'js:no-debugger',
    pattern: /\bdebugger\s*;/g,
    severity: 'error', category: 'code-smell',
    message: 'debugger statement left in code — remove it.' },

  // == coerces types silently: "0" == false is true
  { id: 'js:eqeq',
    pattern: /[^!=<>]==[^=>]|[^!=<>]!=[^=>]/g,
    severity: 'warning', category: 'code-smell',
    message: 'Use === or !== to avoid silent type coercion bugs.' },

  // var leaks out of blocks — const/let are block-scoped
  { id: 'js:no-var',
    pattern: /\bvar\s+/g,
    severity: 'warning', category: 'code-smell',
    message: 'Use const or let instead of var.',
    suggestion: 'const if the value never changes, let if it does.' },

  // Empty catch blocks hide errors silently
  { id: 'js:empty-catch',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g,
    severity: 'warning', category: 'code-smell',
    message: 'Empty catch block silently swallows errors.',
    suggestion: 'Log the error or explain in a comment why ignoring is safe.' },

  // Track in issue tracker, not buried in comments
  { id: 'js:todo',
    pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)/gi,
    severity: 'info', category: 'code-smell',
    message: 'TODO/FIXME comment — move this to your issue tracker.' },
];

// I skip lines that are clearly rule/pattern definitions rather than real code
// to analyze. Without this, a security or linter file (this project included)
// flags its OWN detection patterns: the line `pattern: /\beval\s*\(/` literally
// contains "eval(", and the SQL/debugger patterns contain their own keywords.
// These are descriptions of code to find, not code that runs, so scanning them
// produces pure false positives. Real `eval(...)` / `debugger;` / SQL calls do
// not match these shapes and are still fully detected.
function isRuleDefinitionLine(line: string): boolean {
  const t = line.trim();
  if (/^pattern:\s*\//.test(t)) return true;                 // pattern: /.../,
  if (/^\{?\s*id:\s*['"][a-z]+:/.test(t)) return true;        // { id: 'js:...',
  if (/^(message|suggestion):\s*['"]/.test(t)) return true;   // message: '...'
  return false;
}

// Run every rule against every line and return all matches as Issues
export function runJavaScriptRules(lines: string[]): Issue[] {
  const issues: Issue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip pure comment lines to avoid false positives (except TODO lines)
    if (line.trim().startsWith('//') && !/TODO|FIXME|HACK|XXX/i.test(line)) continue;

    // Skip rule-definition lines so the scanner does not flag detection
    // patterns (its own, or any linter/security tooling it analyzes).
    if (isRuleDefinitionLine(line)) continue;

    for (const rule of RULES) {
      // Reset regex state — global flag keeps position between calls without this
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

        // Guard against zero-width matches causing an infinite loop.
        if (match.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      }
    }
  }

  // Multi-line check: functions over 50 lines are hard to reason about
  issues.push(...detectLongFunctions(lines));
  return issues;
}

// Flag functions that are too long to hold in your head at once
function detectLongFunctions(lines: string[]): Issue[] {
  const issues: Issue[] = [];
  let fnStart = -1;
  let depth   = 0;
  let startDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    if (fnStart === -1 && /\bfunction\b|\=\>\s*\{/.test(lines[i])) {
      fnStart    = i;
      startDepth = depth;
    }

    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }

    if (fnStart !== -1 && depth <= startDepth) {
      const len = i - fnStart;
      if (len > 50) {
        issues.push({
          id:         `js:long-fn:${fnStart}`,
          message:    `Function is ${len} lines long — split it into smaller functions.`,
          severity:   'warning',
          category:   'code-smell',
          line:       fnStart,
          column:     0,
          rule:       'js:long-function',
          suggestion: 'Aim for under 30 lines per function.',
          source:     'static',
        });
      }
      fnStart = -1;
    }
  }

  return issues;
}