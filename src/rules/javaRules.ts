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

  { id: 'java:sql-injection',
    pattern: /Statement\s+\w+.*executeQuery\s*\([^)]*\+/g,
    severity: 'error', category: 'security',
    message: 'SQL query built with string concatenation — SQL injection risk.',
    suggestion: 'Use PreparedStatement: pstmt.setString(1, value)' },

  { id: 'java:sql-injection-update',
    pattern: /\.execute(?:Update|Query)\s*\(\s*[^)]*\+\s*\w+/g,
    severity: 'error', category: 'security',
    message: 'SQL execute call uses string concatenation — SQL injection risk.',
    suggestion: 'Use PreparedStatement with parameterized queries.' },

  { id: 'java:sql-injection-format',
    pattern: /(?:execute|executeQuery|executeUpdate)\s*\(\s*String\.format\s*\(/g,
    severity: 'error', category: 'security',
    message: 'SQL query uses String.format — SQL injection risk.',
    suggestion: 'Use PreparedStatement with ? placeholders instead.' },

  { id: 'java:command-injection',
    pattern: /Runtime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec\s*\(/g,
    severity: 'error', category: 'security',
    message: 'Runtime.exec() can be vulnerable to command injection.',
    suggestion: 'Validate and sanitize all inputs. Use ProcessBuilder with a fixed command array.' },

  { id: 'java:process-builder-injection',
    pattern: /new\s+ProcessBuilder\s*\([^)]*(?:request\.|getParameter|input)\w*/g,
    severity: 'error', category: 'security',
    message: 'ProcessBuilder uses user input — command injection risk.',
    suggestion: 'Validate inputs against a strict allowlist before passing to ProcessBuilder.' },

  // --- Security: Deserialization ---

  { id: 'java:unsafe-deserialization',
    pattern: /ObjectInputStream\s+\w+\s*=\s*new\s+ObjectInputStream/g,
    severity: 'error', category: 'security',
    message: 'Java deserialization can execute arbitrary code on untrusted data.',
    suggestion: 'Use JSON/XML parsers instead. If ObjectInputStream is necessary, implement a whitelist with resolveClass().' },

  // --- Security: Hardcoded secrets ---

  { id: 'java:hardcoded-secret',
    pattern: /(?:password|secret|apiKey|token|authKey|privateKey)\s*=\s*"[^"]{4,}"/gi,
    severity: 'error', category: 'security',
    message: 'Possible hardcoded secret or credential detected.',
    suggestion: 'Use environment variables: System.getenv("MY_SECRET") or a secrets manager.' },

  { id: 'java:hardcoded-db-password',
    pattern: /getConnection\s*\([^)]*"[^"]*password[^"]*"[^)]*"[^"]{4,}"/gi,
    severity: 'error', category: 'security',
    message: 'Database connection contains hardcoded password.',
    suggestion: 'Load credentials from environment variables or a vault.' },

  // --- Security: Cryptography ---

  { id: 'java:weak-hash-md5',
    pattern: /MessageDigest\.getInstance\s*\(\s*"MD5"\s*\)/g,
    severity: 'error', category: 'security',
    message: 'MD5 is cryptographically broken — do not use for security.',
    suggestion: 'Use SHA-256: MessageDigest.getInstance("SHA-256")' },

  { id: 'java:weak-hash-sha1',
    pattern: /MessageDigest\.getInstance\s*\(\s*"SHA-1"\s*\)/g,
    severity: 'warning', category: 'security',
    message: 'SHA-1 is deprecated for security use.',
    suggestion: 'Use SHA-256: MessageDigest.getInstance("SHA-256")' },

  { id: 'java:weak-cipher-des',
    pattern: /Cipher\.getInstance\s*\(\s*"DES/g,
    severity: 'error', category: 'security',
    message: 'DES cipher is broken and easily cracked.',
    suggestion: 'Use AES: Cipher.getInstance("AES/GCM/NoPadding")' },

  { id: 'java:cipher-ecb-mode',
    pattern: /Cipher\.getInstance\s*\(\s*"[^"]*\/ECB\//g,
    severity: 'error', category: 'security',
    message: 'ECB cipher mode is insecure — identical blocks produce identical ciphertext.',
    suggestion: 'Use GCM mode: Cipher.getInstance("AES/GCM/NoPadding")' },

  { id: 'java:insecure-random',
    pattern: /\bnew\s+Random\s*\(\s*\)/g,
    severity: 'warning', category: 'security',
    message: 'java.util.Random is not cryptographically secure.',
    suggestion: 'Use java.security.SecureRandom for tokens, IDs, and anything security-related.' },

  // --- Security: XML / XXE ---

  { id: 'java:xxe-document-builder',
    pattern: /DocumentBuilderFactory\.newInstance\s*\(\s*\)/g,
    severity: 'error', category: 'security',
    message: 'XML parser may be vulnerable to XXE (XML External Entity) attacks.',
    suggestion: 'Disable external entities:\nfactory.setFeature("http://xml.org/sax/features/external-general-entities", false);\nfactory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);' },

  { id: 'java:xxe-sax-parser',
    pattern: /SAXParserFactory\.newInstance\s*\(\s*\)/g,
    severity: 'warning', category: 'security',
    message: 'SAXParserFactory default settings may allow XXE attacks.',
    suggestion: 'Disable external entities after creating the factory.' },

  // --- Security: HTTP / Web ---

  { id: 'java:xss-response-write',
    pattern: /response\.getWriter\s*\(\s*\)\.(?:print|println|write)\s*\([^)]*(?:request\.getParameter|getHeader|getQueryString)/g,
    severity: 'error', category: 'security',
    message: 'User input written directly to HTTP response — XSS vulnerability.',
    suggestion: 'Encode output with OWASP Java Encoder: Encode.forHtml(userInput)' },

  { id: 'java:open-redirect',
    pattern: /sendRedirect\s*\([^)]*(?:request\.getParameter|getHeader)\s*\([^)]*\)/g,
    severity: 'error', category: 'security',
    message: 'Redirect URL comes from user input — open redirect vulnerability.',
    suggestion: 'Validate the URL against an allowlist before redirecting.' },

  // --- Security: File ---

  { id: 'java:path-traversal',
    pattern: /new\s+File\s*\([^)]*(?:getParameter|request\.|input)\w*/g,
    severity: 'error', category: 'security',
    message: 'File path includes user input — path traversal vulnerability.',
    suggestion: 'Use file.getCanonicalPath() and verify it starts with the allowed base directory.' },

  // --- Code smells ---

  { id: 'java:system-out',
    pattern: /System\.out\.(print|println|printf)\s*\(/g,
    severity: 'hint', category: 'code-smell',
    message: 'System.out found — use a logger in production.',
    suggestion: 'Use SLF4J: logger.info("message")' },

  { id: 'java:empty-catch',
    pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g,
    severity: 'warning', category: 'code-smell',
    message: 'Empty catch block silently swallows the exception.',
    suggestion: 'Log it: logger.error("Unexpected error", e)' },

  { id: 'java:catch-throwable',
    pattern: /catch\s*\(\s*Throwable\s/g,
    severity: 'warning', category: 'code-smell',
    message: 'Catching Throwable also catches OutOfMemoryError.',
    suggestion: 'Catch Exception or specific exception types instead.' },

  { id: 'java:public-field',
    pattern: /^\s*public\s+(?!static\s+final|class|interface|enum|void)\w+\s+\w+\s*;/gm,
    severity: 'warning', category: 'code-smell',
    message: 'Public mutable field breaks encapsulation.',
    suggestion: 'Make private and add getter/setter methods.' },

  { id: 'java:null-before-instanceof',
    pattern: /\w+\s*!=\s*null\s*&&\s*\w+\s+instanceof/g,
    severity: 'hint', category: 'code-smell',
    message: 'Null check before instanceof is redundant — instanceof returns false for null.' },

  { id: 'java:todo',
    pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)/gi,
    severity: 'info', category: 'code-smell',
    message: 'TODO/FIXME comment — move to your issue tracker.' },
];

// Skip lines that are rule/pattern definitions rather than real code, so a
// linter or security file does not flag its own detection patterns.
function isRuleDefinitionLine(line: string): boolean {
  const t = line.trim();
  if (/^pattern:\s*\//.test(t)) return true;
  if (/^\{?\s*id:\s*['"][a-z]+:/.test(t)) return true;
  if (/^(message|suggestion):\s*['"]/.test(t)) return true;
  return false;
}

export function runJavaRules(lines: string[]): Issue[] {
  const issues: Issue[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip pure comment lines to avoid false positives
    if (line.trim().startsWith('//') && !/TODO|FIXME|HACK|XXX/i.test(line)) continue;

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