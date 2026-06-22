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

  // ─── Security: XSS ────────────────────────────────────────────────────────

  { id: 'react:dangerous-html',
    pattern: /dangerouslySetInnerHTML\s*=\s*\{/g,
    severity: 'error', category: 'security',
    message: 'dangerouslySetInnerHTML can cause XSS if content is not sanitized.',
    suggestion: 'Sanitize first: { __html: DOMPurify.sanitize(html) }' },

  { id: 'react:ref-inner-html',
    pattern: /(?:ref|current)\s*\.\s*innerHTML\s*=/g,
    severity: 'error', category: 'security',
    message: 'Setting innerHTML on a ref can cause XSS.',
    suggestion: 'Use ref.current.textContent for plain text, or sanitize with DOMPurify.' },

  { id: 'react:no-eval',
    pattern: /\beval\s*\(/g,
    severity: 'error', category: 'security',
    message: 'eval() executes arbitrary code — severe XSS risk in React.',
    suggestion: 'Restructure to avoid dynamic code execution.' },

  { id: 'react:no-new-function',
    pattern: /new\s+Function\s*\(/g,
    severity: 'error', category: 'security',
    message: 'new Function() executes arbitrary code — same risk as eval().',
    suggestion: 'Restructure to avoid dynamic code execution.' },

  { id: 'react:href-javascript',
    pattern: /href\s*=\s*\{?\s*['"`]javascript:/gi,
    severity: 'error', category: 'security',
    message: 'href with javascript: scheme is an XSS vector.',
    suggestion: 'Use onClick handler instead: <button onClick={fn}>click</button>' },

  { id: 'react:href-user-input',
    pattern: /href\s*=\s*\{(?!['"`]https?)[^}]*(?:props\.|state\.|params\.|query\.)\w+/g,
    severity: 'warning', category: 'security',
    message: 'href value comes from props/state — could be set to javascript: by attacker.',
    suggestion: 'Validate URL starts with https:// before using as href.' },

  { id: 'react:target-blank',
    pattern: /target\s*=\s*['"`]_blank['"`](?!.*rel)/g,
    severity: 'warning', category: 'security',
    message: 'target="_blank" without rel="noopener noreferrer" leaks window.opener.',
    suggestion: 'Add rel="noopener noreferrer" to all target="_blank" links.' },

  // ─── Security: Sensitive data exposure ────────────────────────────────────

  { id: 'react:hardcoded-secret',
    pattern: /(?:apiKey|api_key|secret|password|token|auth)\s*[:=]\s*['"`][^'"`\s]{6,}['"`]/gi,
    severity: 'error', category: 'security',
    message: 'Hardcoded secret in React code — will be visible in the browser bundle.',
    suggestion: 'Use environment variables: process.env.REACT_APP_MY_KEY (never secret keys in frontend).' },

  { id: 'react:secret-in-env',
    pattern: /process\.env\.REACT_APP_(?:SECRET|PASSWORD|PRIVATE|API_KEY|TOKEN)\b/gi,
    severity: 'error', category: 'security',
    message: 'Secret in REACT_APP_ env var — these are embedded in the public JS bundle.',
    suggestion: 'Secrets must live on the server. Call a backend API that holds the secret.' },

  { id: 'react:console-log-sensitive',
    pattern: /console\.\w+\s*\([^)]*(?:password|token|secret|auth|credit|ssn|dob)\w*/gi,
    severity: 'warning', category: 'security',
    message: 'Possible sensitive data logged to console — visible in browser DevTools.',
    suggestion: 'Remove console logs that include sensitive user data.' },

  // ─── Security: API calls ──────────────────────────────────────────────────

  { id: 'react:fetch-user-input',
    pattern: /fetch\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*['"]?\s*\+)\s*(?:props\.|state\.|params\.|input\.|query\.)\w+/g,
    severity: 'error', category: 'security',
    message: 'fetch() URL includes user-controlled data — SSRF or open redirect risk.',
    suggestion: 'Validate the URL against an allowlist before fetching.' },

  { id: 'react:axios-user-input',
    pattern: /axios\.\w+\s*\(\s*(?:`[^`]*\$\{|['"][^'"]*['"]?\s*\+)\s*(?:props\.|state\.|params\.)\w+/g,
    severity: 'warning', category: 'security',
    message: 'axios request URL includes user-controlled data.',
    suggestion: 'Validate the URL against an allowlist before making the request.' },

  { id: 'react:fetch-no-error-check',
    pattern: /\.then\s*\(\s*(?:res|response)\s*=>\s*(?:res|response)\.json\(\)\s*\)(?!\s*\.catch)/g,
    severity: 'warning', category: 'security',
    message: 'fetch().then(res => res.json()) without .catch() — errors are silently swallowed.',
    suggestion: 'Add .catch(err => ...) or use try/catch in an async function.' },

  // ─── Security: Storage ────────────────────────────────────────────────────

  { id: 'react:sensitive-in-localstorage',
    pattern: /localStorage\.setItem\s*\([^)]*(?:token|password|secret|auth|session)/gi,
    severity: 'error', category: 'security',
    message: 'Sensitive data stored in localStorage — accessible to any JS on the page.',
    suggestion: 'Use httpOnly cookies for tokens. localStorage is not safe for sensitive data.' },

  { id: 'react:sensitive-in-sessionstorage',
    pattern: /sessionStorage\.setItem\s*\([^)]*(?:token|password|secret|auth|session)/gi,
    severity: 'warning', category: 'security',
    message: 'Sensitive data stored in sessionStorage — accessible to XSS attacks.',
    suggestion: 'Use httpOnly cookies for authentication tokens.' },

  // ─── Security: Input handling ─────────────────────────────────────────────

  { id: 'react:regex-from-input',
    pattern: /new\s+RegExp\s*\(\s*(?:props\.|state\.|e\.target\.value|input)/g,
    severity: 'error', category: 'security',
    message: 'RegExp built from user input — ReDoS (regex denial of service) risk.',
    suggestion: 'Never build regular expressions from user-supplied strings.' },

  { id: 'react:postmessage-no-origin',
    pattern: /window\.addEventListener\s*\(\s*['"]message['"]\s*,[^)]*\)(?![^{]*event\.origin)/g,
    severity: 'error', category: 'security',
    message: 'postMessage listener without origin validation — any page can send messages.',
    suggestion: 'Always check event.origin before processing: if (event.origin !== "https://trusted.com") return;' },

  // ─── Rules of Hooks ───────────────────────────────────────────────────────

  { id: 'react:hook-in-condition',
    pattern: /if\s*\([^)]*\)\s*\{[^}]*use[A-Z]\w+\s*\(/g,
    severity: 'error', category: 'code-smell',
    message: 'Hook called inside a condition — violates Rules of Hooks.',
    suggestion: 'Move the hook to top level. Use conditional logic inside the hook.' },

  { id: 'react:hook-in-loop',
    pattern: /(?:for|while)\s*\([^)]*\)\s*\{[^}]*use[A-Z]\w+\s*\(/g,
    severity: 'error', category: 'code-smell',
    message: 'Hook called inside a loop — violates Rules of Hooks.' },

  { id: 'react:async-effect',
    pattern: /useEffect\s*\(\s*async\s*\(/g,
    severity: 'error', category: 'code-smell',
    message: 'async useEffect callback returns a Promise instead of a cleanup function.',
    suggestion: 'Define async inside and call it:\nuseEffect(() => { const run = async () => {}; run(); }, []);' },

  // ─── useEffect pitfalls ───────────────────────────────────────────────────

  { id: 'react:effect-no-deps',
    pattern: /useEffect\s*\(\s*\(\s*\)\s*=>/g,
    severity: 'warning', category: 'code-smell',
    message: 'useEffect with no dependency array runs after every render.',
    suggestion: 'Add [] to run once, or [dep] to run when dep changes.' },

  { id: 'react:missing-cleanup',
    pattern: /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{[^}]*(?:setInterval|setTimeout|addEventListener)\s*\(/g,
    severity: 'warning', category: 'code-smell',
    message: 'useEffect sets up timer/listener but may be missing cleanup.',
    suggestion: 'Return cleanup: return () => clearInterval(id)' },

  { id: 'react:effect-fetch-no-cleanup',
    pattern: /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{[^}]*fetch\s*\(/g,
    severity: 'warning', category: 'security',
    message: 'fetch inside useEffect without AbortController — memory leak on unmount.',
    suggestion: 'Use AbortController:\nconst ctrl = new AbortController();\nfetch(url, { signal: ctrl.signal });\nreturn () => ctrl.abort();' },

  // ─── State mutations ──────────────────────────────────────────────────────

  { id: 'react:direct-state-mutation',
    pattern: /this\.state\.\w+\s*=/g,
    severity: 'error', category: 'code-smell',
    message: 'Direct state mutation — React won\'t re-render.',
    suggestion: 'Use setState() or the useState setter.' },

  { id: 'react:array-mutation',
    pattern: /(?:state|this\.state)\.\w+\.(?:push|pop|splice|sort|reverse|shift|unshift)\s*\(/g,
    severity: 'error', category: 'code-smell',
    message: 'Mutating state array in-place won\'t trigger a re-render.',
    suggestion: 'Return a new array: setState(prev => [...prev, item])' },

  // ─── Key prop issues ──────────────────────────────────────────────────────

  { id: 'react:key-as-index',
    pattern: /\.map\s*\(\s*\([^,)]+,\s*(\w+)\)\s*=>[^)]*key\s*=\s*\{?\s*\1\s*\}?/g,
    severity: 'warning', category: 'code-smell',
    message: 'Using array index as key causes bugs when the list reorders.',
    suggestion: 'Use a stable unique id: key={item.id}' },

  // ─── Re-render traps ──────────────────────────────────────────────────────

  { id: 'react:inline-fn',
    pattern: /\bon[A-Z]\w+\s*=\s*\{(?:\s*\([^)]*\)\s*=>|\s*function\s*\()/g,
    severity: 'hint', category: 'code-smell',
    message: 'Inline function prop creates a new reference every render.',
    suggestion: 'Wrap with useCallback() or define the handler outside JSX.' },

  { id: 'react:inline-style',
    pattern: /\bstyle\s*=\s*\{\s*\{/g,
    severity: 'hint', category: 'code-smell',
    message: 'Inline style object is recreated every render.',
    suggestion: 'Define as const outside component or use useMemo().' },

  { id: 'react:context-inline',
    pattern: /\bvalue\s*=\s*\{\s*\{[^}]*\}\s*\}/g,
    severity: 'warning', category: 'code-smell',
    message: 'Inline context value recreated every render — all consumers re-render.',
    suggestion: 'Memoize: const val = useMemo(() => ({ ... }), [deps])' },

  // ─── Deprecated / removed APIs ────────────────────────────────────────────

  { id: 'react:string-ref',
    pattern: /\bref\s*=\s*["'`]\w+["'`]/g,
    severity: 'error', category: 'code-smell',
    message: 'String refs removed in React 19. Use useRef() instead.' },

  { id: 'react:find-dom-node',
    pattern: /ReactDOM\.findDOMNode\s*\(/g,
    severity: 'error', category: 'code-smell',
    message: 'ReactDOM.findDOMNode() is deprecated and removed in React 19.',
    suggestion: 'Use a ref: const ref = useRef(); <Component ref={ref} />' },

  { id: 'react:will-mount',
    pattern: /componentWillMount\s*\(\s*\)/g,
    severity: 'error', category: 'code-smell',
    message: 'componentWillMount is deprecated. Use componentDidMount.' },

  { id: 'react:will-receive-props',
    pattern: /componentWillReceiveProps\s*\(/g,
    severity: 'error', category: 'code-smell',
    message: 'componentWillReceiveProps is deprecated. Use getDerivedStateFromProps.' },

  { id: 'react:will-update',
    pattern: /componentWillUpdate\s*\(/g,
    severity: 'error', category: 'code-smell',
    message: 'componentWillUpdate is deprecated. Use getSnapshotBeforeUpdate.' },

  { id: 'react:use-layout-effect-ssr',
    pattern: /\buseLayoutEffect\s*\(/g,
    severity: 'info', category: 'code-smell',
    message: 'useLayoutEffect causes a warning in SSR environments.',
    suggestion: 'Use useEffect when possible, or guard with: if (typeof window !== "undefined")' },
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

// Run every rule against every line and return all matches as Issues
export function runReactRules(lines: string[]): Issue[] {
  const issues: Issue[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Skip pure comment lines to avoid false positives
    if (lines[i].trim().startsWith('//')) continue;

    // Skip rule-definition lines (see isRuleDefinitionLine).
    if (isRuleDefinitionLine(lines[i])) continue;

    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = rule.pattern.exec(lines[i])) !== null) {
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

  // Multi-line checks that need full file context
  issues.push(...detectStateSprawl(lines));
  issues.push(...detectMissingDepArrays(lines));
  issues.push(...detectPropDrilling(lines));

  return issues;
}

// 6+ useState in one component — useReducer would be cleaner and more testable
function detectStateSprawl(lines: string[]): Issue[] {
  const issues: Issue[] = [];
  const text    = lines.join('\n');
  const pattern = /(?:function|const)\s+([A-Z]\w*)\s*[=(]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const startLine = text.slice(0, match.index).split('\n').length - 1;
    const body      = lines.slice(startLine, startLine + 200).join('\n');
    const count     = (body.match(/\buseState\s*\(/g) ?? []).length;

    if (count >= 6) {
      issues.push({
        id:         `react:state-sprawl:${startLine}`,
        line:       startLine,
        column:     0,
        message:    `"${match[1]}" has ${count} useState calls — consider useReducer.`,
        severity:   'warning',
        category:   'code-smell',
        rule:       'react:state-sprawl',
        suggestion: 'useReducer is easier to test and reason about with 5+ related state variables.',
        source:     'static',
      });
    }
  }

  return issues;
}

// useCallback or useMemo without dep array = memoization never fires
function detectMissingDepArrays(lines: string[]): Issue[] {
  const issues: Issue[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!/useCallback\s*\(|useMemo\s*\(/.test(lines[i])) continue;

    const hook  = lines[i].includes('useCallback') ? 'useCallback' : 'useMemo';
    const chunk = lines.slice(i, i + 10).join('\n');

    if (!new RegExp(`${hook}\\s*\\([^)]*,\\s*\\[`).test(chunk)) {
      issues.push({
        id:         `react:no-deps:${i}`,
        line:       i,
        column:     lines[i].indexOf(hook),
        message:    `${hook} without a dependency array — memoization never kicks in.`,
        severity:   'warning',
        category:   'code-smell',
        rule:       'react:no-deps',
        suggestion: `Add deps: ${hook}(fn, [dep1, dep2])`,
        source:     'static',
      });
    }
  }

  return issues;
}

// Same prop passed 3+ times = likely prop drilling — Context would be cleaner
function detectPropDrilling(lines: string[]): Issue[] {
  const issues: Issue[] = [];

  const propCount: Record<string, number> = {};
  for (const line of lines) {
    const matches = line.match(/\b(\w+)=\{(\w+)\}/g) ?? [];
    for (const m of matches) {
      const parts = m.match(/(\w+)=\{(\w+)\}/);
      if (parts) {
        propCount[parts[1]] = (propCount[parts[1]] ?? 0) + 1;
      }
    }
  }

  const drilled = Object.entries(propCount).filter(([, n]) => n >= 3);
  if (drilled.length > 0) {
    issues.push({
      id:         'react:prop-drilling:0',
      line:       0,
      column:     0,
      message:    `Possible prop drilling: ${drilled.map(([k]) => k).join(', ')} passed 3+ times.`,
      severity:   'hint',
      category:   'code-smell',
      rule:       'react:prop-drilling',
      suggestion: 'Consider React Context or Zustand to avoid passing props through many layers.',
      source:     'static',
    });
  }

  return issues;
}