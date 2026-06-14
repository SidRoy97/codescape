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
exports.DiagnosticsPublisher = void 0;
const vscode = __importStar(require("vscode"));
const types_1 = require("../types");
// Icon per category shown in the Problems panel message
const ICONS = {
    'code-smell': '🧹', security: '🔒', complexity: '📊', duplicate: '📋', ai: '🤖',
};
// Single job: take a FileAnalysisResult and show squiggles in the editor
class DiagnosticsPublisher {
    constructor() {
        // One collection per extension — named "Codescape" in the Problems panel
        this.collection = vscode.languages.createDiagnosticCollection('Codescape');
    }
    // Push issues for one file into the Problems panel
    present(result) {
        const diags = result.issues.map(i => this.toDiagnostic(i, result.uri));
        this.collection.set(result.uri, diags);
    }
    // Remove squiggles for a single file
    clear(uri) {
        this.collection.delete(uri);
    }
    // Remove all squiggles across every file
    clearAll() {
        this.collection.clear();
    }
    // Convert our Issue shape to the vscode.Diagnostic shape
    toDiagnostic(issue, docUri) {
        // Look up the open document to clamp line numbers safely
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === docUri.toString());
        const maxL = doc ? doc.lineCount - 1 : issue.line;
        const line = Math.min(issue.line, maxL);
        const lineLen = doc ? doc.lineAt(line).text.length : 200;
        const range = new vscode.Range(line, Math.min(issue.column, lineLen), Math.min(issue.endLine ?? line, maxL), Math.min(issue.endColumn ?? lineLen, lineLen));
        // Suggestion goes on a second line so it's visible without clicking
        const msg = `${ICONS[issue.category]} ${issue.message}${issue.suggestion ? `\n💡 ${issue.suggestion}` : ''}`;
        const diag = new vscode.Diagnostic(range, msg, (0, types_1.toVsCodeSeverity)(issue.severity));
        // Source label shown in Problems panel — AI issues get a different label
        diag.source = issue.source === 'ai' ? 'Codescape (AI)' : 'Codescape';
        diag.code = issue.rule;
        return diag;
    }
    dispose() {
        this.collection.dispose();
    }
}
exports.DiagnosticsPublisher = DiagnosticsPublisher;
