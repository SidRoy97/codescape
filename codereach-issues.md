# CodeReach — Project Issues Report

Generated: 23/06/2026, 01:18:36

Total issues: 24 across 8 file(s)

Severity: hint 14 · warning 10
Category: code-smell 16 · duplicate 7 · security 1

## src/extension.ts — 10 issue(s)

### activate

- **L51** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L54** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L57** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

### activateInternal

- **L62** [warning/code-smell] Function is 448 lines long — split it into smaller functions.
  - Fix: Aim for under 30 lines per function.
- **L77** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L78** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L79** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L147** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L195** [warning/duplicate] Duplicate block (6+ lines) also at line 221.
  - Fix: Extract shared logic into a reusable function.

### deactivate

- **L513** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

## src/scanners/AiScanner.ts — 5 issue(s)

### callOllama

- **L138** [warning/duplicate] Duplicate block (6+ lines) also at line 248.
  - Fix: Extract shared logic into a reusable function.
- **L139** [warning/duplicate] Duplicate block (6+ lines) also at line 249.
  - Fix: Extract shared logic into a reusable function.

### callHuggingFace

- **L162** [warning/duplicate] Duplicate block (6+ lines) also at line 262.
  - Fix: Extract shared logic into a reusable function.

### parseResponse

- **L305** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

### handleError

- **L373** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

## src/graph/GraphPanel.ts — 3 issue(s)

### renderImpact

- **L68** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
- **L79** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

### buildHtml

- **L238** [warning/code-smell] Function is 88 lines long — split it into smaller functions.
  - Fix: Aim for under 30 lines per function.

## src/rules/reactRules.ts — 2 issue(s)

### detectStateSprawl

- **L316** [warning/duplicate] Duplicate block (6+ lines) also at line 344.
  - Fix: Extract shared logic into a reusable function.
- **L317** [warning/duplicate] Duplicate block (6+ lines) also at line 345.
  - Fix: Extract shared logic into a reusable function.

## src/AnalysisOrchestrator.ts — 1 issue(s)

### runAiPhase

- **L117** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.

## src/graph/PreciseRelationships.ts — 1 issue(s)

### incoming

- **L121** [warning/duplicate] Duplicate block (6+ lines) also at line 132.
  - Fix: Extract shared logic into a reusable function.

## src/graph/ListPanel.ts — 1 issue(s)

### makeNonce

- **L180** [warning/security] Math.random() is not cryptographically secure.
  - Fix: Use crypto.randomBytes() or crypto.randomUUID() for security-sensitive values.

## src/context/FileSummarizer.ts — 1 issue(s)

### saveCache

- **L123** [hint/code-smell] console statement found — remove before shipping.
  - Fix: Use a logging library like winston or pino.
