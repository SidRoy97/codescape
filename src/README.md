# CodeSec — AI Code Quality

Real-time code quality, security analysis, and AI-powered fixes for VS Code.
Works with any LLM — Ollama (free, local), Groq, HuggingFace, OpenRouter, or Anthropic.

## Features

### 🔒 Security Analysis
- SQL injection, XSS, command injection, path traversal
- Hardcoded secrets and credentials
- Unsafe deserialization (pickle, ObjectInputStream)
- Weak crypto (MD5, SHA1, DES, ECB mode)
- Insecure cookies, SSRF, ReDoS, prototype pollution
- React-specific: dangerous href, localStorage secrets, postMessage

### 🧹 Code Quality
- SOLID principle violations
- God files and God classes (>300 lines, >15 methods)
- Deep nesting (5+ levels)
- Callback hell
- Boolean flag parameters
- Chained ternaries
- Too many function parameters
- TypeScript `any` type usage
- Return null anti-pattern

### ⚛️ React / TSX
- Rules of Hooks violations
- Async useEffect, missing cleanup
- State mutations, index as key
- Re-render traps (inline functions, objects)
- Deprecated lifecycle methods
- State sprawl → useReducer suggestion
- Prop drilling detection

### 📊 Complexity
- Cyclomatic complexity per function
- Average complexity in dashboard

### 📋 Duplicate Code
- Fingerprint-based duplicate block detection

### 🤖 AI Analysis
- Deep semantic analysis via local or cloud LLM
- Two-phase: static rules instant, AI in background
- One-click AI fix with diff preview
- Explain any issue in plain English

### 🧠 Context Generation
- Symbol index — every function/class mapped to file + line
- Blast radius — files affected if this one changes
- AGENTS.md — universal AI context file (works with Claude Code, Cursor, ChatGPT, Copilot)
- Copy AI context — minimal token bundle for any AI

## Languages

JavaScript, TypeScript, JSX, TSX, Python, Java

## AI Providers

| Provider | Cost | Setup |
|---|---|---|
| Ollama | Free forever | `ollama serve` + `ollama pull qwen2.5-coder:7b` |
| Groq | Free tier | API key from console.groq.com |
| HuggingFace | Free tier | Token from huggingface.co/settings/tokens |
| OpenRouter | Free models | API key from openrouter.ai |
| Anthropic | Paid | API key from console.anthropic.com |

## Quick Start

1. Install the extension
2. Open any JS/TS/Python/Java file — analysis runs automatically
3. See squiggles inline and issues in the Problems panel (`Cmd+Shift+M`)
4. Click the CodeSec icon in the Activity Bar for the dashboard

## Commands

| Command | What it does |
|---|---|
| `CodeSec: Analyze Current File` | Manual analysis with progress |
| `CodeSec: Analyze Entire Workspace` | Scan all files |
| `CodeSec: Build Symbol Index` | Index every function and class |
| `CodeSec: Generate AI Context File (AGENTS.md)` | Universal AI context for any LLM |
| `CodeSec: Summarize Project Files` | One-sentence summary per file |
| `CodeSec: Copy AI Context` | Minimal context for the selected symbol |
| `CodeSec: Show Blast Radius` | Files affected by changing the active file |

## Configuration

All settings under `codeSec.*` in VS Code Settings:

```json
{
  "codeSec.aiProvider": "ollama",
  "codeSec.aiModel": "qwen2.5-coder:7b",
  "codeSec.analyzeOnSave": true,
  "codeSec.complexityThreshold": 10,
  "codeSec.duplicateLineThreshold": 6
}
```