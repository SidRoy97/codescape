"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextPicker = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const ImpactAnalyzer_1 = require("../graph/ImpactAnalyzer");
// Single job: build the smallest useful AI context bundle for a request.
// It reads the code graph (passed in via a getter) and the file summaries.
// It no longer depends on SymbolIndexer or BlastRadiusAnalyzer — the graph
// is now the single source of truth for symbols and impact.
class ContextPicker {
    constructor(getGraph, summarizer) {
        this.getGraph = getGraph;
        this.summarizer = summarizer;
    }
    // Build full context for the active file plus the selected symbol.
    // Use when asking AI to change a specific function.
    async buildContext(editor) {
        const document = editor.document;
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root)
            return '';
        const relFile = path.relative(root, document.uri.fsPath);
        const graph = this.getGraph();
        // The word under the cursor, or the current selection.
        const selection = editor.selection;
        const selectedWord = selection.isEmpty
            ? document.getText(document.getWordRangeAtPosition(selection.active))
            : document.getText(selection);
        const parts = [];
        // 1. File summaries — gives the AI a project map in ~20 lines.
        const summaries = this.summarizer.getSummaries();
        if (summaries.size > 0) {
            parts.push('// === PROJECT FILE SUMMARIES ===');
            for (const [file, summary] of summaries) {
                parts.push(`// ${file.padEnd(50)} ${summary}`);
            }
            parts.push('');
        }
        // 2. The current file — always include the full text.
        parts.push(`// === CURRENT FILE: ${relFile} ===`);
        parts.push(document.getText());
        parts.push('');
        // 3. Impact of the selected symbol — what it calls, what calls it.
        if (selectedWord && selectedWord.length > 1) {
            const node = graph.nodes.find(n => n.name === selectedWord && n.file === relFile)
                ?? graph.nodes.find(n => n.name === selectedWord);
            if (node) {
                const analyzer = new ImpactAnalyzer_1.ImpactAnalyzer(graph);
                const impact = analyzer.analyze(node.id);
                if (impact) {
                    parts.push(`// === SYMBOL: ${selectedWord} ===`);
                    parts.push(`// Defined at ${node.file}:${node.line + 1} (${node.kind})`);
                    parts.push('');
                    if (impact.directCallers.length > 0) {
                        parts.push('// Called by:');
                        for (const caller of impact.directCallers) {
                            parts.push(`//   ${caller.file}:${caller.line + 1} ${caller.name}`);
                        }
                        parts.push('');
                    }
                    if (impact.affected.length > 0) {
                        parts.push(`// Changing this affects ${impact.affected.length} symbol(s) — check these before editing.`);
                        parts.push('');
                    }
                }
            }
        }
        const content = parts.join('\n');
        const tokenEst = Math.round(content.length / 4);
        const header = [
            '// === CODESCAPE AI CONTEXT ===',
            `// Generated: ${new Date().toLocaleString()}`,
            `// Estimated tokens: ~${tokenEst}`,
            `// Active file: ${relFile}`,
            `// Selected symbol: ${selectedWord || '(none — place cursor on a function name)'}`,
            '',
        ].join('\n');
        return header + content;
    }
    // Build a lightweight context — summaries plus the symbol list, no file bodies.
    // Use for high-level questions: architecture, where to add things.
    async buildLightContext() {
        const graph = this.getGraph();
        const parts = [
            '// === CODESCAPE LIGHT CONTEXT ===',
            `// Generated: ${new Date().toLocaleString()}`,
            '',
            this.summarizer.formatForAi(),
            '',
            '// === SYMBOL INDEX ===',
        ];
        // Group symbols by file so the list is readable.
        const byFile = new Map();
        for (const node of graph.nodes) {
            const existing = byFile.get(node.file) ?? [];
            existing.push(node);
            byFile.set(node.file, existing);
        }
        for (const [file, nodes] of byFile) {
            parts.push(`// ${file}`);
            for (const node of nodes) {
                parts.push(`//   ${node.kind.padEnd(10)} ${node.name.padEnd(35)} L${node.line + 1}`);
            }
        }
        return parts.join('\n');
    }
}
exports.ContextPicker = ContextPicker;
