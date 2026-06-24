import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { LanguageParser } from '../graph/LanguageParser';
import { AiScanner } from '../scanners/AiScanner';

type CommentStyle = 'jsdoc' | 'python' | 'javadoc';

const STYLE_FOR_LANG: Record<string, CommentStyle> = {
  javascript:      'jsdoc',
  javascriptreact: 'jsdoc',
  typescript:      'jsdoc',
  typescriptreact: 'jsdoc',
  python:          'python',
  java:            'javadoc',
};

const SYSTEM_PROMPTS: Record<CommentStyle, string> = {
  jsdoc:
`Write a JSDoc comment for the given JavaScript/TypeScript function.
Output only the JSDoc block — start with /** and end with */.
Include a one-line description, @param for each parameter, and @returns if it returns a value.
Keep it under 8 lines. Do not include the function code. Do not use markdown fences.
Example output:
/**
 * Validates a user token against the provided secret.
 * @param token - The JWT string to verify
 * @param secret - The signing secret
 * @returns true if valid, false otherwise
 */`,

  python:
`Write a Google-style Python docstring for the given function.
Output only the docstring — start and end with triple double-quotes.
Include a one-line summary, an Args: section if there are parameters, and Returns: if it returns a value.
Do not include the function code. Do not use markdown fences.
Example output:
"""Validates user credentials against the database.

Args:
    username: The user login name.
    password: The plaintext password to verify.

Returns:
    True if credentials are valid, False otherwise.
"""`,

  javadoc:
`Write a Javadoc comment for the given Java method.
Output only the Javadoc block — start with /** and end with */.
Include a one-line description, @param for each parameter, and @return if it returns a value.
Do not include the method code. Do not use markdown fences.
Example output:
/**
 * Validates a user token against the provided secret.
 * @param token the JWT string to verify
 * @param secret the signing secret
 * @return true if the token is valid and unexpired
 */`,
};

export class CommentGenerator {
  constructor(
    private readonly parser: LanguageParser,
    private readonly ai: AiScanner,
  ) {}

  // Public entry point — probe AI first, handle setup if needed, then generate.
  async generateForFile(document: vscode.TextDocument): Promise<void> {
    const style = STYLE_FOR_LANG[document.languageId];
    if (!style) {
      vscode.window.showWarningMessage(
        `CodeReach: Auto-comment is not supported for ${document.languageId}.`,
      );
      return;
    }

    const aiReady = await this.probeAi();
    if (!aiReady) {
      // Detect what state Ollama is in so we can show a precise message.
      const ollamaState = this.detectOllamaState();
      const message =
        ollamaState === 'not-installed'
          ? 'CodeReach: No AI response. Ollama does not appear to be installed. ' +
            'Install it from ollama.com, pull a model ("ollama pull llama3.2"), then start the server ("ollama serve"). ' +
            'You can also switch to a cloud provider in Settings → codereach.aiProvider.'
          : ollamaState === 'no-models'
          ? 'CodeReach: No AI response. Ollama is installed but no models are pulled yet. ' +
            'Run "ollama pull llama3.2" in a terminal first, then start the server. ' +
            'You can also switch to a cloud provider in Settings → codereach.aiProvider.'
          : 'CodeReach: No AI response. Ollama is installed and has models — the server just needs to be started. ' +
            'Click "Start Ollama" and generation will begin automatically once it is ready. ' +
            'You can also switch to a cloud provider in Settings → codereach.aiProvider.';

      const choice = await vscode.window.showWarningMessage(
        message,
        'Start Ollama',
        'Open Settings',
        'Get Ollama',
      );

      if (choice === 'Start Ollama') {
        // Open a terminal and start Ollama, then wait for it to be ready
        // before proceeding — so the user doesn't have to click again.
        const terminal = vscode.window.createTerminal('CodeReach: Ollama');
        terminal.show();
        terminal.sendText('ollama serve');

        // Poll until the server responds, up to 30 seconds.
        const ready = await this.waitForOllama(30);
        if (!ready) {
          vscode.window.showWarningMessage(
            'CodeReach: Ollama is taking longer than expected to start. ' +
            'Wait a few seconds and try Auto-Comment again.',
          );
          return;
        }
        // Server is up — fall through and generate immediately.
        vscode.window.showInformationMessage('CodeReach: Ollama is ready.');

      } else if (choice === 'Open Settings') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'codereach.aiProvider');
        return;
      } else if (choice === 'Get Ollama') {
        vscode.env.openExternal(vscode.Uri.parse('https://ollama.com'));
        return;
      } else {
        // Dismissed
        return;
      }
    }

    await this.runGeneration(document, style);
  }

  // Poll the AI provider every 2 seconds until it responds or we time out.
  private async waitForOllama(timeoutSeconds: number): Promise<boolean> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'CodeReach: Waiting for Ollama to start…' },
      async () => {
        const attempts = Math.floor(timeoutSeconds / 2);
        for (let i = 0; i < attempts; i++) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          const ready = await this.probeAi();
          if (ready) return true;
        }
        return false;
      },
    );
  }

  // Core generation logic — separated so it can be called after Ollama starts.
  private async runGeneration(document: vscode.TextDocument, style: CommentStyle): Promise<void> {
    const parsed = await this.parser.parse(document);
    const symbols = parsed.symbols.filter(
      s => s.kind === 'function' || s.kind === 'method',
    );

    if (symbols.length === 0) {
      vscode.window.showInformationMessage('CodeReach: No functions found in this file.');
      return;
    }

    const uncommented = symbols.filter(
      s => !this.hasCommentAbove(document, s.line, style),
    );

    if (uncommented.length === 0) {
      vscode.window.showInformationMessage(
        'CodeReach: All functions in this file already have comments.',
      );
      return;
    }

    let added = 0;
    let skipped = 0;

    await vscode.window.withProgress(
      {
        location:    vscode.ProgressLocation.Notification,
        title:       'CodeReach: Generating comments…',
        cancellable: true,
      },
      async (progress, token) => {
        // Bottom-to-top so insertions don't shift line numbers of earlier functions.
        const sorted = [...uncommented].sort((a, b) => b.line - a.line);

        for (let i = 0; i < sorted.length; i++) {
          if (token.isCancellationRequested) break;

          const sym = sorted[i];
          progress.report({
            message:   `${i + 1}/${sorted.length} — ${sym.name}`,
            increment: (1 / sorted.length) * 100,
          });

          const live = vscode.workspace.textDocuments.find(
            d => d.uri.toString() === document.uri.toString(),
          ) ?? document;

          const slice = this.functionSlice(live, sym.line);
          if (!slice) { skipped++; continue; }

          const comment = await this.generateComment(sym.name, slice, style, live.languageId);
          if (!comment) { skipped++; continue; }

          const indent    = this.indentOf(live, sym.line);
          const indented  = this.indentComment(comment, indent);
          const insertPos = new vscode.Position(sym.line, 0);

          const edit = new vscode.WorkspaceEdit();
          edit.insert(live.uri, insertPos, indented + '\n');
          await vscode.workspace.applyEdit(edit);
          added++;
        }
      },
    );

    const msg = skipped > 0
      ? `CodeReach: Added ${added} comment(s). ${skipped} skipped (AI returned empty response).`
      : `CodeReach: Added ${added} comment(s).`;
    vscode.window.showInformationMessage(msg);
  }

  // Detect the state of the local Ollama installation so we can show a
  // precise message — rather than always saying the same thing regardless
  // of whether Ollama is installed, has models, or just needs the server started.
  private detectOllamaState(): 'not-installed' | 'no-models' | 'has-models' {
    try {
      // If 'ollama' is not on PATH this will throw.
      const result = execSync('ollama list 2>&1', { timeout: 3000 }).toString().trim();
      // "ollama list" with no models prints just the header line "NAME  ID  SIZE  MODIFIED"
      // With models it has additional lines.
      const lines = result.split('\n').filter(l => l.trim());
      return lines.length <= 1 ? 'no-models' : 'has-models';
    } catch {
      return 'not-installed';
    }
  }

  private async probeAi(): Promise<boolean> {
    try {
      const reply = await this.ai.generateText('Reply with the single word: ok', 'ping');
      return !!(reply && reply.trim());
    } catch {
      return false;
    }
  }

  private hasCommentAbove(
    document: vscode.TextDocument,
    line:     number,
    style:    CommentStyle,
  ): boolean {
    for (let l = line - 1; l >= 0; l--) {
      const text = document.lineAt(l).text.trim();
      if (text === '') continue;
      if (style === 'python') {
        return text.startsWith('"""') || text.startsWith("'''") || text.startsWith('#');
      } else {
        return text.endsWith('*/') || text.startsWith('//') || text.startsWith('/*');
      }
    }
    return false;
  }

  private functionSlice(document: vscode.TextDocument, line: number): string | null {
    const start = Math.max(0, line);
    const end   = Math.min(document.lineCount, start + 60);
    const lines: string[] = [];
    for (let l = start; l < end; l++) {
      lines.push(document.lineAt(l).text);
    }
    return lines.join('\n') || null;
  }

  private async generateComment(
    name:   string,
    code:   string,
    style:  CommentStyle,
    langId: string,
  ): Promise<string | null> {
    const system = SYSTEM_PROMPTS[style];
    const user   = `Language: ${langId}\nFunction: ${name}\n\`\`\`\n${code.slice(0, 3000)}\n\`\`\``;
    try {
      const reply = await this.ai.generateText(system, user);
      if (!reply || !reply.trim()) {
        console.warn(`CodeReach CommentGenerator: empty reply for ${name}`);
        return null;
      }
      const cleaned = this.cleanComment(reply.trim(), style);
      if (!cleaned) {
        console.warn(`CodeReach CommentGenerator: unrecognised reply for ${name}:`, reply.slice(0, 200));
        return null;
      }
      return cleaned;
    } catch (e) {
      console.error(`CodeReach CommentGenerator: error for ${name}:`, e);
      return null;
    }
  }

  private cleanComment(raw: string, style: CommentStyle): string {
    let s = raw.trim();

    // Strip markdown fences.
    s = s.replace(/^```[\w]*\r?\n?/im, '').replace(/\r?\n?```\s*$/im, '').trim();

    // Find the first line that looks like the start of a real comment.
    const lines = s.split('\n');
    let startIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (style === 'python') {
        if (t.startsWith('"""') || t.startsWith("'''")) { startIdx = i; break; }
      } else {
        if (t.startsWith('/**') || t.startsWith('/*') || t.startsWith('//')) { startIdx = i; break; }
      }
    }
    s = lines.slice(startIdx).join('\n').trim();

    // Wrap plain text if the model forgot comment syntax.
    if (style === 'python') {
      if (!s.startsWith('"""') && !s.startsWith("'''")) {
        const plain = s.trim();
        s = plain ? `"""${plain}\n"""` : '';
      }
    } else {
      if (!s.startsWith('/*') && !s.startsWith('//')) {
        const plain = s.replace(/^#+\s*/gm, '').trim();
        const body  = plain.split('\n').join('\n * ');
        s = plain ? `/**\n * ${body}\n */` : '';
      }
    }

    return s;
  }

  private indentOf(document: vscode.TextDocument, line: number): string {
    const text  = document.lineAt(line).text;
    const match = text.match(/^(\s*)/);
    return match ? match[1] : '';
  }

  private indentComment(comment: string, indent: string): string {
    if (!indent) return comment;
    return comment.split('\n').map(line => indent + line).join('\n');
  }
}