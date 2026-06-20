# Codescape — Project Issues Report

Generated: 20/06/2026, 01:33:32

Total issues: 79 across 14 file(s)

Severity: hint 43 · warning 15 · error 21
Category: code-smell 51 · security 22 · duplicate 6

## src/extension.ts — 16 issue(s)

### activate

- **L47** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L50** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L53** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

### activateInternal

- **L58** [warning/code-smell] Function is 402 lines long — split it into smaller functions.
  - Fix: Aim for under 30 lines per function.
- **L73** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L74** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L75** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L136** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L141** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L184** [warning/duplicate] Duplicate block (6+ lines) also at line 210.
  - Fix: Extract shared logic into a reusable function.
- **L402** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L416** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L444** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L454** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L457** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

### deactivate

- **L463** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

## src/scanners/AiScanner.ts — 15 issue(s)

### (file scope)

- **L11** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L17** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L22** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

### callOllama

- **L124** [warning/duplicate] Duplicate block (6+ lines) also at line 234.
  - Fix: Extract shared logic into a reusable function.
- **L125** [warning/duplicate] Duplicate block (6+ lines) also at line 235.
  - Fix: Extract shared logic into a reusable function.

### callHuggingFace

- **L148** [warning/duplicate] Duplicate block (6+ lines) also at line 248.
  - Fix: Extract shared logic into a reusable function.
- **L172** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L187** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

### callOpenAiFormat

- **L233** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

### callAnthropic

- **L259** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L263** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

### parseResponse

- **L291** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

### handleError

- **L348** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L352** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L359** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

## src/rules/javascriptRules.ts — 12 issue(s)

### (file scope)

- **L20** [error/security] eval() executes arbitrary code — severe security risk.
  - Fix: Use JSON.parse() for data, or restructure to avoid dynamic execution.
- **L34** [warning/security] document.write() is a security risk and blocks page rendering.
- **L38** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L41** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L45** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L91** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L98** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L104** [warning/security] Math.random() is not cryptographically secure.
  - Fix: Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive values.
- **L158** [error/code-smell] debugger statement left in code — remove it.
- **L161** [error/code-smell] debugger statement left in code — remove it.
- **L165** [warning/code-smell] Use === or !== to avoid silent type coercion bugs.
- **L194** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

## src/rules/reactRules.ts — 8 issue(s)

### (file scope)

- **L34** [error/security] eval() executes arbitrary code — severe security risk.
  - Fix: Use JSON.parse() for data, or restructure to avoid dynamic execution.
- **L41** [error/security] eval() executes arbitrary code — severe security risk.
  - Fix: Use JSON.parse() for data, or restructure to avoid dynamic execution.
- **L78** [warning/code-smell] Use const or let instead of var.
  - Fix: const if the value never changes, let if it does.
- **L262** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L263** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L265** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])

### detectStateSprawl

- **L336** [warning/duplicate] Duplicate block (6+ lines) also at line 364.
  - Fix: Extract shared logic into a reusable function.
- **L337** [warning/duplicate] Duplicate block (6+ lines) also at line 365.
  - Fix: Extract shared logic into a reusable function.

## src/graph/GraphPanel.ts — 7 issue(s)

### buildHtml

- **L120** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L142** [warning/code-smell] Function is 70 lines long — split it into smaller functions.
  - Fix: Aim for under 30 lines per function.
- **L177** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L191** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L194** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L195** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

### makeNonce

- **L223** [warning/security] Math.random() is not cryptographically secure.
  - Fix: Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive values.

## src/rules/javaRules.ts — 6 issue(s)

### (file scope)

- **L24** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L25** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L32** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L83** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L90** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L186** [warning/code-smell] Use === or !== to avoid silent type coercion bugs.

## src/context/FileSummarizer.ts — 4 issue(s)

### summarizeWorkspace

- **L69** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

### saveCache

- **L123** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

### hashString

- **L132** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L133** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

## src/rules/pythonRules.ts — 4 issue(s)

### (file scope)

- **L26** [error/security] eval() executes arbitrary code — severe security risk.
  - Fix: Use JSON.parse() for data, or restructure to avoid dynamic execution.
- **L41** [error/security] SQL query built with string interpolation — SQL injection risk.
  - Fix: Use parameterized queries: db.query("SELECT * FROM users WHERE id = ?", [id])
- **L149** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L155** [error/code-smell] debugger statement left in code — remove it.

## src/providers/DashboardProvider.ts — 2 issue(s)

### buildHtml

- **L126** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;
- **L156** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

## src/reports/UnderstandingGenerator.ts — 1 issue(s)

### summarizeFileSymbols

- **L196** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

## src/scanners/DuplicateScanner.ts — 1 issue(s)

### hash

- **L59** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

## src/graph/ListPanel.ts — 1 issue(s)

### makeNonce

- **L180** [warning/security] Math.random() is not cryptographically secure.
  - Fix: Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive values.

## src/providers/CodeActionsProvider.ts — 1 issue(s)

### (file scope)

- **L19** [hint/code-smell] Magic number — name it so the intent is clear.
  - Fix: const SECONDS_PER_DAY = 86400;

## src/AnalysisOrchestrator.ts — 1 issue(s)

### runAiPhase

- **L117** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
