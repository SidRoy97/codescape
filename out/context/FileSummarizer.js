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
exports.FileSummarizer = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const CACHE_FILE = 'codescape-summaries.json';
const SUMMARY_PROMPT = `In exactly ONE sentence under 20 words, describe what this file does.
Start with a verb. Focus on single responsibility.
Return only the sentence — no filename, no markdown, no extra text.`;
// Single job: generate and cache a one-line AI summary per file.
class FileSummarizer {
    constructor(ai, context) {
        this.ai = ai;
        this.context = context;
        this.cache = new Map();
        this.loaded = false;
    }
    // Summarize every file in the workspace — skips files already cached.
    async summarizeWorkspace() {
        this.loadCache();
        const uris = await vscode.workspace.findFiles('**/*.{ts,tsx,js,jsx,py,java}', '{**/node_modules/**,**/dist/**,**/out/**}');
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root)
            return new Map();
        let newCount = 0;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Codescape: Summarizing files…', cancellable: true }, async (progress, token) => {
            for (let i = 0; i < uris.length; i++) {
                if (token.isCancellationRequested)
                    break;
                const uri = uris[i];
                const rel = path.relative(root, uri.fsPath);
                let content;
                try {
                    content = fs.readFileSync(uri.fsPath, 'utf8');
                }
                catch {
                    continue;
                }
                const hash = this.hashString(content);
                const cached = this.cache.get(rel);
                if (cached && cached.hash === hash) {
                    progress.report({ message: `${i + 1}/${uris.length} (cached)`, increment: (1 / uris.length) * 100 });
                    continue;
                }
                try {
                    const summary = await this.ai.generateText(SUMMARY_PROMPT, `File: ${rel}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``);
                    if (summary && summary.trim()) {
                        this.cache.set(rel, { file: rel, summary: summary.trim(), hash });
                        newCount++;
                    }
                }
                catch {
                    // AI unavailable — skip this file, try next time.
                }
                progress.report({ message: `${i + 1}/${uris.length}`, increment: (1 / uris.length) * 100 });
            }
        });
        this.saveCache();
        if (newCount > 0) {
            vscode.window.showInformationMessage(`Codescape: Summarized ${newCount} file(s). Now run "Codescape: Generate AI Context File".`);
        }
        return this.getSummaries();
    }
    // Return current summaries as a flat map.
    getSummaries() {
        this.loadCache();
        return new Map(Array.from(this.cache.entries()).map(([k, v]) => [k, v.summary]));
    }
    // Format all summaries as a compact comment block for pasting into AI.
    formatForAi() {
        const summaries = this.getSummaries();
        if (summaries.size === 0) {
            return '// No summaries yet. Run: Codescape: Summarize Project Files';
        }
        const lines = ['// FILE SUMMARIES', ''];
        for (const [file, summary] of summaries) {
            lines.push(`// ${file.padEnd(50)} ${summary}`);
        }
        return lines.join('\n');
    }
    loadCache() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const cachePath = this.getCachePath();
            if (fs.existsSync(cachePath)) {
                const raw = fs.readFileSync(cachePath, 'utf8');
                const data = JSON.parse(raw);
                for (const entry of data)
                    this.cache.set(entry.file, entry);
            }
        }
        catch {
            // Cache missing or corrupt — start fresh.
        }
    }
    saveCache() {
        try {
            const cachePath = this.getCachePath();
            const dir = path.dirname(cachePath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(cachePath, JSON.stringify(Array.from(this.cache.values()), null, 2));
        }
        catch (e) {
            console.error('Codescape: could not save summary cache', e);
        }
    }
    getCachePath() {
        return path.join(this.context.globalStorageUri.fsPath, CACHE_FILE);
    }
    hashString(str) {
        let hash = 5381;
        for (let i = 0; i < Math.min(str.length, 10000); i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash = hash & hash;
        }
        return hash;
    }
}
exports.FileSummarizer = FileSummarizer;
