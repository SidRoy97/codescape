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
exports.AiScanner = void 0;
const vscode = __importStar(require("vscode"));
// Best default model per provider — chosen for code quality and free availability
const DEFAULT_MODELS = {
    ollama: 'qwen2.5-coder:7b', // best free local code model
    groq: 'qwen-2.5-coder-32b', // free, very fast, excellent at code
    huggingface: 'Qwen/Qwen2.5-Coder-7B-Instruct', // free HF inference, good at code
    openrouter: 'qwen/qwen-2.5-coder-32b-instruct:free',
    anthropic: 'claude-sonnet-4-20250514',
    'openai-compatible': 'llama3',
};
// Base URL per provider — where we send the API request
const DEFAULT_URLS = {
    ollama: 'http://localhost:11434',
    groq: 'https://api.groq.com/openai', // Groq speaks OpenAI format
    huggingface: 'https://api-inference.huggingface.co',
    openrouter: 'https://openrouter.ai/api',
    anthropic: 'https://api.anthropic.com',
    'openai-compatible': 'http://localhost:1234',
};
// Where to get a free key per provider
const KEY_SIGNUP_URLS = {
    groq: 'https://console.groq.com',
    huggingface: 'https://huggingface.co/settings/tokens',
    openrouter: 'https://openrouter.ai',
    anthropic: 'https://console.anthropic.com',
};
// Instruct the model to return strict JSON only — no prose, no markdown fences
const SYSTEM_PROMPT = `You are a senior software engineer doing a code review.
Find real concrete issues only. Do not invent issues.
Check: security vulnerabilities, bugs, code smells, performance problems.

Return ONLY a JSON array. Each element must have:
{"line":<1-indexed number>,"severity":"error"|"warning"|"info"|"hint",
 "category":"code-smell"|"security"|"complexity"|"duplicate",
 "message":"<what is wrong>","suggestion":"<how to fix it>"}

Return [] if no issues found. JSON array only — no markdown, no explanation.`;
// Single job: call the configured AI provider and return parsed Issues
class AiScanner {
    constructor(config) {
        this.config = config;
        this.name = 'AiScanner';
    }
    async scan(document) {
        // Respect the user's choice to disable AI
        if (!this.config.isAiEnabled())
            return [];
        // Skip very large files — too slow and too many tokens
        if (document.getText().length > 60000) {
            vscode.window.showWarningMessage('Codescape: File >60KB — skipping AI scan.');
            return [];
        }
        const provider = this.config.getAiProvider();
        const model = this.config.getAiModel() || DEFAULT_MODELS[provider] || DEFAULT_MODELS['ollama'];
        const baseUrl = (this.config.getAiBaseUrl() || DEFAULT_URLS[provider] || '').replace(/\/$/, '');
        const apiKey = this.config.getAiApiKey();
        // Check cloud providers have a key configured before attempting the call
        if (this.requiresKey(provider) && !apiKey) {
            this.showMissingKeyMessage(provider);
            return [];
        }
        const userMsg = `Language: ${document.languageId}\n\`\`\`\n${document.getText()}\n\`\`\``;
        try {
            let text;
            // Route to the right API format — each provider speaks a slightly different dialect
            if (provider === 'ollama')
                text = await this.callOllama(baseUrl, model, userMsg);
            else if (provider === 'huggingface')
                text = await this.callHuggingFace(baseUrl, apiKey, model, userMsg);
            else if (provider === 'anthropic')
                text = await this.callAnthropic(baseUrl, apiKey, model, userMsg);
            else
                text = await this.callOpenAiFormat(baseUrl, apiKey, model, userMsg, provider);
            return this.parseResponse(text);
        }
        catch (err) {
            this.handleError(err, provider);
            return [];
        }
    }
    // Used by CodeActionsProvider for targeted fix and explain requests
    async generateText(system, user) {
        const provider = this.config.getAiProvider();
        const model = this.config.getAiModel() || DEFAULT_MODELS[provider];
        const baseUrl = (this.config.getAiBaseUrl() || DEFAULT_URLS[provider]).replace(/\/$/, '');
        const apiKey = this.config.getAiApiKey();
        try {
            if (provider === 'ollama')
                return await this.callOllama(baseUrl, model, user, system);
            if (provider === 'huggingface')
                return await this.callHuggingFace(baseUrl, apiKey, model, user, system);
            if (provider === 'anthropic')
                return await this.callAnthropic(baseUrl, apiKey, model, user, system);
            return await this.callOpenAiFormat(baseUrl, apiKey, model, user, provider, system);
        }
        catch (err) {
            this.handleError(err, provider);
            return '';
        }
    }
    // --- Private: one method per API format ---
    // Ollama runs locally — no key, no account, just ollama serve
    async callOllama(baseUrl, model, user, system = SYSTEM_PROMPT) {
        const res = await fetch(`${baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                stream: false,
                options: { temperature: 0.1 }, // low temp = consistent analysis output
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
            }),
        });
        // Model not pulled yet — give a specific actionable error
        if (res.status === 404) {
            vscode.window.showErrorMessage(`Codescape: Ollama model "${model}" not found.`, `Run: ollama pull ${model}`);
            throw new Error('model not found');
        }
        if (!res.ok)
            throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return data?.message?.content ?? '';
    }
    // HuggingFace Inference API — free token at huggingface.co/settings/tokens
    // Supports thousands of open models with no credit card
    async callHuggingFace(baseUrl, apiKey, model, user, system = SYSTEM_PROMPT) {
        // HuggingFace uses a different URL shape: /models/{model_id}
        const url = `${baseUrl}/models/${model}`;
        const headers = {
            'Content-Type': 'application/json',
        };
        // Token is optional for some public models but gives higher rate limits
        if (apiKey)
            headers['Authorization'] = `Bearer ${apiKey}`;
        // HuggingFace chat completion format for instruct models
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                inputs: `<|system|>\n${system}\n<|user|>\n${user}\n<|assistant|>`,
                parameters: {
                    temperature: 0.1,
                    max_new_tokens: 2048,
                    return_full_text: false, // only return the generated part, not the prompt
                },
            }),
        });
        // Model is loading on HF side — this is normal for cold starts
        if (res.status === 503) {
            const body = await res.json();
            const wait = Math.ceil(body.estimated_time ?? 20);
            vscode.window.showWarningMessage(`Codescape: HuggingFace model is loading (~${wait}s). Try again shortly.`);
            throw new Error('model loading');
        }
        // Model name is wrong or gated — need to pick a different one
        if (res.status === 404 || res.status === 403) {
            vscode.window.showErrorMessage(`Codescape: HuggingFace model "${model}" not found or is gated.`, 'Browse Free Models').then(c => {
                if (c === 'Browse Free Models') {
                    vscode.env.openExternal(vscode.Uri.parse('https://huggingface.co/models?pipeline_tag=text-generation&sort=trending&search=code'));
                }
            });
            throw new Error('model not available');
        }
        if (!res.ok)
            throw new Error(`HuggingFace HTTP ${res.status}: ${await res.text()}`);
        // HF returns an array: [{ generated_text: "..." }]
        const data = await res.json();
        return data?.[0]?.generated_text ?? '';
    }
    // Groq, OpenRouter, LM Studio, vLLM — all speak OpenAI chat format
    async callOpenAiFormat(baseUrl, apiKey, model, user, provider, system = SYSTEM_PROMPT) {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (apiKey)
            headers['Authorization'] = `Bearer ${apiKey}`;
        // OpenRouter needs these to track usage and show the app in their dashboard
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = 'https://github.com/your-org/codescape';
            headers['X-Title'] = 'Codescape VS Code Extension';
        }
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                temperature: 0.1,
                max_tokens: 2048,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: user },
                ],
            }),
        });
        if (!res.ok)
            throw new Error(`${provider} HTTP ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return data?.choices?.[0]?.message?.content ?? '';
    }
    // Anthropic uses its own message format — different from OpenAI
    async callAnthropic(baseUrl, apiKey, model, user, system = SYSTEM_PROMPT) {
        const res = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model,
                max_tokens: 2048,
                system,
                messages: [{ role: 'user', content: user }],
            }),
        });
        if (!res.ok)
            throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);
        const data = await res.json();
        return data?.content?.find(b => b.type === 'text')?.text ?? '';
    }
    // Pull the JSON array out of the response even if the model wrapped it in prose
    parseResponse(raw) {
        if (!raw)
            return [];
        // Find the JSON array — model may have added explanation before or after it
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        if (!jsonMatch)
            return [];
        let parsed;
        try {
            parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed))
                return [];
        }
        catch {
            console.error('Codescape: failed to parse AI JSON response');
            return [];
        }
        return parsed
            .filter(i => typeof i.line === 'number' && i.line >= 1 && i.message)
            .map((i, idx) => ({
            id: `ai:${i.line}:${idx}`,
            message: i.message,
            severity: i.severity ?? 'warning',
            category: i.category ?? 'code-smell',
            line: Math.max(0, i.line - 1), // AI returns 1-indexed, VS Code wants 0-indexed
            column: 0,
            endLine: Math.max(0, i.line - 1),
            rule: 'ai:review',
            suggestion: i.suggestion,
            source: 'ai',
        }));
    }
    // Providers that need a key configured before we even try calling them
    requiresKey(provider) {
        return ['groq', 'huggingface', 'openrouter', 'anthropic'].includes(provider);
    }
    // Friendly first-time setup message with a link to the signup page
    showMissingKeyMessage(provider) {
        const signupUrl = KEY_SIGNUP_URLS[provider];
        const label = provider.charAt(0).toUpperCase() + provider.slice(1);
        vscode.window.showWarningMessage(`Codescape: ${label} needs a free API key. Get one and paste it in Settings → codescape.aiApiKey.`, `Get ${label} Key`, 'Use Ollama Instead (no key)').then(choice => {
            if (choice === `Get ${label} Key`) {
                vscode.env.openExternal(vscode.Uri.parse(signupUrl));
            }
            if (choice === 'Use Ollama Instead (no key)') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'codescape.aiProvider');
            }
        });
    }
    // Friendly error messages so users know exactly what went wrong
    handleError(err, provider) {
        const msg = err instanceof Error ? err.message : String(err);
        if (provider === 'ollama' && msg.includes('ECONNREFUSED')) {
            // Ollama server isn't running — give the exact command to start it
            vscode.window.showErrorMessage('Codescape: Ollama is not running. Start it first.', 'Run: ollama serve', 'Get Ollama').then(c => {
                if (c === 'Get Ollama')
                    vscode.env.openExternal(vscode.Uri.parse('https://ollama.com'));
            });
        }
        else if (msg.includes('401')) {
            vscode.window.showErrorMessage(`Codescape: Invalid API key for ${provider}. Check Settings → codescape.aiApiKey.`);
        }
        else if (msg.includes('429')) {
            vscode.window.showWarningMessage(`Codescape: Rate limit hit on ${provider} — skipping AI analysis this time.`);
        }
        else if (msg.includes('model loading') || msg.includes('model not found') || msg.includes('model not available')) {
            // Already showed a specific message in the calling method — don't double-notify
        }
        else {
            console.error(`Codescape AI error [${provider}]:`, msg);
        }
    }
}
exports.AiScanner = AiScanner;
