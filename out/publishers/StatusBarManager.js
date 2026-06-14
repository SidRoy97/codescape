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
exports.StatusBarManager = void 0;
const vscode = __importStar(require("vscode"));
// Single job: count issues in the store and update the status bar text + color
class StatusBarManager {
    constructor(store) {
        this.store = store;
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        // Clicking the status bar opens the dashboard
        this.item.command = 'codescape.openDashboard';
        this.item.show();
        this.render();
    }
    // Recalculate and redraw after every analysis
    render() {
        const all = this.store.getAll();
        const errors = all.reduce((n, r) => n + r.issues.filter(i => i.severity === 'error').length, 0);
        const warnings = all.reduce((n, r) => n + r.issues.filter(i => i.severity === 'warning').length, 0);
        const total = all.reduce((n, r) => n + r.issues.length, 0);
        if (total === 0) {
            // Green checkmark when the workspace is clean
            this.item.text = '$(check) Codescape';
            this.item.backgroundColor = undefined;
            this.item.tooltip = 'Codescape: No issues found';
            return;
        }
        const parts = [];
        if (errors > 0)
            parts.push(`$(error) ${errors}`);
        if (warnings > 0)
            parts.push(`$(warning) ${warnings}`);
        this.item.text = `Codescape: ${parts.join('  ')}`;
        this.item.tooltip = `Codescape: ${total} issue(s) — click to open dashboard`;
        this.item.backgroundColor = errors > 0
            ? new vscode.ThemeColor('statusBarItem.errorBackground')
            : new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    dispose() { this.item.dispose(); }
}
exports.StatusBarManager = StatusBarManager;
