import * as vscode from 'vscode';
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

const EXT_MAP: Record<string, string[]> = {
  javascript:      ['js', 'mjs'],
  javascriptreact: ['jsx'],
  typescript:      ['ts'],
  typescriptreact: ['tsx'],
  python:          ['py'],
  java:            ['java'],
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

  // ── Single file ────────────────────────────────────────────────────────────

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
      const choice = await vscode.window.showWarningMessage(
        'CodeReach: No AI response — comments cannot be generated. ' +
        'For Ollama: run "ollama serve" in a terminal, then click Auto-Comment again. ' +
        'If you have not installed Ollama yet: get it from ollama.com and run "ollama pull <model>" first. ' +
        'You can also switch to a cloud provider in Settings → codereach.aiProvider.',
        'Comment without AI', 'Cancel',
      );
      if (choice !== 'Comment without AI') return;
      await this.runGenerationCounted(document, style, false);
      return;
    }

    await this.runGenerationCounted(document, style, true);
  }

  // ── Workspace ──────────────────────────────────────────────────────────────

  async generateForWorkspace(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token:    vscode.CancellationToken,
    useAi:   boolean,
  ): Promise<void> {
    const unique = [...new Set(Object.values(EXT_MAP).flat())];
    const uris   = await vscode.workspace.findFiles(
      `**/*.{${unique.join(',')}}`,
      '{**/node_modules/**,**/dist/**,**/out/**,**/build/**,**/target/**,**/static/**,**/vendor/**,**/assets/**,**/__pycache__/**,**/venv/**,**/.venv/**,**/env/**,**/migrations/**,**/generated/**,**/generated-sources/**,**/.next/**,**/.nuxt/**,**/coverage/**,**/__generated__/**,**/*.min.js,**/*.bundle.js,**/*.chunk.js,**/*.pyc}',
    );

    if (!uris.length) {
      vscode.window.showWarningMessage('CodeReach: No supported files found in workspace.');
      return;
    }

    let totalAdded   = 0;
    let totalSkipped = 0;

    for (let i = 0; i < uris.length; i++) {
      if (token.isCancellationRequested) break;

      const uri = uris[i];
      progress.report({
        message:   `${i + 1}/${uris.length} — ${vscode.workspace.asRelativePath(uri)}`,
        increment: (1 / uris.length) * 100,
      });

      let doc: vscode.TextDocument;
      try {
        doc = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }

      const style = STYLE_FOR_LANG[doc.languageId];
      if (!style) continue;

      const { added, skipped } = await this.runGenerationCounted(doc, style, useAi);
      totalAdded   += added;
      totalSkipped += skipped;
    }

    const msg = totalSkipped > 0
      ? `CodeReach: Added ${totalAdded} comment(s) across workspace. ${totalSkipped} skipped.`
      : `CodeReach: Added ${totalAdded} comment(s) across workspace.`;
    vscode.window.showInformationMessage(msg);
  }

  // ── Core logic ─────────────────────────────────────────────────────────────

  private async runGenerationCounted(
    document: vscode.TextDocument,
    style:    CommentStyle,
    useAi:    boolean,
  ): Promise<{ added: number; skipped: number }> {
    const parsed  = await this.parser.parse(document);
    const symbols = parsed.symbols.filter(
      s => s.kind === 'function' || s.kind === 'method',
    );

    if (symbols.length === 0) return { added: 0, skipped: 0 };

    const uncommented = symbols.filter(
      s => !this.hasCommentAbove(document, s.line, style),
    );

    if (uncommented.length === 0) return { added: 0, skipped: 0 };

    let added   = 0;
    let skipped = 0;

    // Bottom-to-top so prior insertions don't shift line numbers of later functions.
    const sorted = [...uncommented].sort((a, b) => b.line - a.line);

    for (const sym of sorted) {
      const live = vscode.workspace.textDocuments.find(
        d => d.uri.toString() === document.uri.toString(),
      ) ?? document;

      const slice = this.functionSlice(live, sym.line);
      if (!slice) { skipped++; continue; }

      const comment = useAi
        ? await this.generateComment(sym.name, slice, style, live.languageId)
        : this.structuralComment(sym.name, style);

      if (!comment) { skipped++; continue; }

      const indent    = this.indentOf(live, sym.line);
      const indented  = this.indentComment(comment, indent);
      const insertPos = new vscode.Position(sym.line, 0);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(live.uri, insertPos, indented + '\n');
      await vscode.workspace.applyEdit(edit);
      added++;
    }

    return { added, skipped };
  }

  // ── AI probe ───────────────────────────────────────────────────────────────

  async probeAi(): Promise<boolean> {
    try {
      const reply = await this.ai.generateText('Reply with the single word: ok', 'ping');
      return !!(reply && reply.trim());
    } catch {
      return false;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

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

  private structuralComment(name: string, style: CommentStyle): string {
    switch (style) {
      case 'jsdoc':
      case 'javadoc':
        return `/**\n * TODO: describe ${name}\n */`;
      case 'python': {
        const q = '"""';
        return `${q}TODO: describe ${name}.${q}`;
      }
    }
  }

  private cleanComment(raw: string, style: CommentStyle): string {
    let s = raw.trim();

    s = s.replace(/^```[\w]*\r?\n?/im, '').replace(/\r?\n?```\s*$/im, '').trim();

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