import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AiScanner } from '../scanners/AiScanner';

// One cached summary entry per file.
interface FileSummary {
  file: string;
  summary: string;
  hash: number;
}

const CACHE_FILE = 'codescape-summaries.json';

const SUMMARY_PROMPT = `In exactly ONE sentence under 20 words, describe what this file does.
Start with a verb. Focus on single responsibility.
Return only the sentence — no filename, no markdown, no extra text.`;

// generate and cache a one-line AI summary per file.
export class FileSummarizer {
  private cache = new Map<string, FileSummary>();
  private loaded = false;

  constructor(
    private readonly ai: AiScanner,
    private readonly context: vscode.ExtensionContext,
  ) {}

  // Summarize every file in the workspace — skips files already cached.
  async summarizeWorkspace(): Promise<Map<string, string>> {
    this.loadCache();

    const uris = await vscode.workspace.findFiles(
      '**/*.{ts,tsx,js,jsx,py,java}',
      '{**/node_modules/**,**/dist/**,**/out/**}',
    );

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return new Map();

    let newCount = 0;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Codescape: Summarizing files…', cancellable: true },
      async (progress, token) => {
        for (let i = 0; i < uris.length; i++) {
          if (token.isCancellationRequested) break;

          const uri = uris[i];
          const rel = path.relative(root, uri.fsPath);

          let content: string;
          try {
            content = fs.readFileSync(uri.fsPath, 'utf8');
          } catch {
            continue;
          }

          const hash = this.hashString(content);
          const cached = this.cache.get(rel);
          if (cached && cached.hash === hash) {
            progress.report({ message: `${i + 1}/${uris.length} (cached)`, increment: (1 / uris.length) * 100 });
            continue;
          }

          try {
            const summary = await this.ai.generateText(
              SUMMARY_PROMPT,
              `File: ${rel}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``,
            );
            if (summary && summary.trim()) {
              this.cache.set(rel, { file: rel, summary: summary.trim(), hash });
              newCount++;
            }
          } catch {
            // AI unavailable — skip this file, try next time.
          }

          progress.report({ message: `${i + 1}/${uris.length}`, increment: (1 / uris.length) * 100 });
        }
      },
    );

    this.saveCache();

    if (newCount > 0) {
      vscode.window.showInformationMessage(
        `Codescape: Summarized ${newCount} file(s). Now run "Codescape: Generate AI Context File".`,
      );
    }

    return this.getSummaries();
  }

  // Return current summaries as a flat map.
  getSummaries(): Map<string, string> {
    this.loadCache();
    return new Map(Array.from(this.cache.entries()).map(([k, v]) => [k, v.summary]));
  }

  private loadCache(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const cachePath = this.getCachePath();
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, 'utf8');
        const data = JSON.parse(raw) as FileSummary[];
        for (const entry of data) this.cache.set(entry.file, entry);
      }
    } catch {
      // Cache missing or corrupt — start fresh.
    }
  }

  private saveCache(): void {
    try {
      const cachePath = this.getCachePath();
      const dir = path.dirname(cachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(Array.from(this.cache.values()), null, 2));
    } catch (e) {
      console.error('Codescape: could not save summary cache', e);
    }
  }

  private getCachePath(): string {
    return path.join(this.context.globalStorageUri.fsPath, CACHE_FILE);
  }

  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < Math.min(str.length, 10000); i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return hash;
  }
}