import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

const envVars = readEnvFile(['OLLAMA_HOST', 'OLLAMA_MODEL']);
const OLLAMA_HOST =
  process.env.OLLAMA_HOST || envVars.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL || envVars.OLLAMA_MODEL || 'qwen3.5:9b';

/**
 * Extract the latest user message text from the XML-formatted prompt.
 */
function extractLastMessage(prompt: string): string {
  const matches = [...prompt.matchAll(/<message[^>]*>([\s\S]*?)<\/message>/g)];
  if (matches.length === 0) return prompt;
  const last = matches[matches.length - 1][1];
  // Unescape XML entities
  return last
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * Classify whether a message is simple enough for Ollama or needs Claude.
 * Uses fast heuristics — no LLM call needed for classification.
 */
export function isSimpleQuery(prompt: string): boolean {
  const text = extractLastMessage(prompt).toLowerCase();

  // Qwen ONLY handles these — everything else goes to Claude
  const simplePatterns = [
    // Greetings
    /^(hi|hello|hey|good morning|good afternoon|good evening|good night|thanks|thank you|ok|okay|bye|gn|gm)\b/i,
    // Quick factual questions (what is, who is, define, meaning of)
    /^(what is|what are|who is|who are|define|meaning of|how do you say|translate|convert)\b/i,
    // Simple math or conversions
    /^\d+\s*[\+\-\*\/\%]\s*\d+/,
    /\b(celsius|fahrenheit|km|miles|kg|pounds|convert)\b/i,
    // General knowledge that doesn't need memory or tools
    /^(what time|what date|what day)\b/i,
    // Chinese language, China-related queries — Qwen's strength
    /[\u4e00-\u9fff]/,  // Contains Chinese characters
    /\b(chinese|mandarin|cantonese|pinyin|china|beijing|shanghai|shenzhen|guangzhou|chengdu|wuhan|hangzhou|nanjing|taiwan|hong kong|macau)\b/i,
    /\b(translate.*chinese|chinese.*translate|in chinese|in mandarin)\b/i,
    /\b(baidu|weibo|wechat|xiaohongshu|douyin|bilibili|tencent|alibaba|bytedance|huawei|xiaomi|oppo|vivo|jd\.com|taobao|tmall|pinduoduo)\b/i,
  ];

  for (const pattern of simplePatterns) {
    if (pattern.test(text)) return true;
  }

  // Default: Claude handles it (has memory, tools, conversation history)
  return false;
}

/**
 * Load key Ori-Mnemos notes for context.
 * Reads note files directly — fast, no MCP overhead.
 */
function loadOriContext(): string {
  const vaultNotes = path.join(process.cwd(), 'data', 'ori-vault', 'notes');
  try {
    if (!fs.existsSync(vaultNotes)) return '';
    const files = fs.readdirSync(vaultNotes).filter((f) => f.endsWith('.md') && f !== 'index.md');
    if (files.length === 0) return '';

    const notes: string[] = [];
    let totalLen = 0;
    const MAX_CONTEXT = 2000; // Keep it short for fast inference

    for (const file of files.slice(0, 10)) {
      const content = fs.readFileSync(path.join(vaultNotes, file), 'utf-8');
      // Strip YAML frontmatter
      const body = content.replace(/^---[\s\S]*?---\n?/, '').trim();
      if (body && totalLen + body.length < MAX_CONTEXT) {
        notes.push(body);
        totalLen += body.length;
      }
    }

    if (notes.length === 0) return '';
    return `\n\nRelevant memory notes:\n${notes.join('\n---\n')}`;
  } catch {
    return '';
  }
}

/**
 * Call Ollama API to generate a response.
 */
export async function queryOllama(
  userMessage: string,
  assistantName: string,
): Promise<string> {
  const url = new URL('/api/generate', OLLAMA_HOST);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const oriContext = loadOriContext();

  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    prompt: userMessage,
    system: `/no_think You are ${assistantName}, a helpful personal assistant running on a home server via NanoClaw. Be concise and direct. Do not use markdown formatting unless asked.

You handle simple questions directly. For complex tasks, the user's message is automatically routed to a more capable agent (Claude) that has access to:
- File system (inbox, ingest folder, documents)
- Ori-Mnemos persistent memory
- Google Drive, Salesforce, 1Password, Plaud recordings
- Web browser, code execution, system monitoring

If someone asks about files, memory, ingest, or any tool you dont have, tell them their request is being forwarded to the full agent, or suggest they rephrase to trigger the advanced agent. Never say you cannot access files or memory — the system can, just not through you directly.${oriContext}`,
    stream: false,
    keep_alive: '24h',
    options: {
      num_predict: 1024,
      thinking: false,
    },
  });

  return new Promise<string>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 11434),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        family: 4,
        timeout: 60000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.response?.trim()) {
              resolve(parsed.response.trim());
            } else {
              reject(new Error(`Ollama returned no response`));
            }
          } catch {
            reject(
              new Error(
                `Failed to parse Ollama response: ${data.slice(0, 200)}`,
              ),
            );
          }
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Ollama request timed out'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * Try to handle a message with Ollama. Returns the response text if handled,
 * or null if the message should be delegated to Claude.
 */
export async function tryOllamaRoute(
  prompt: string,
  assistantName: string,
): Promise<string | null> {
  // Check for system status keywords — run directly on host
  const lastMsg = extractLastMessage(prompt).toLowerCase();
  if (
    /\b(system status|server status|cpu|gpu|temp|temperature|ram|memory usage|disk space|server health)\b/.test(
      lastMsg,
    )
  ) {
    try {
      const scriptPath = `${process.cwd()}/scripts/system-status.sh`;
      const output = execSync(`bash ${scriptPath}`, { timeout: 5000 })
        .toString()
        .trim();
      logger.info('System status query handled directly');
      return output;
    } catch (err) {
      logger.warn('Failed to run system-status.sh, falling back');
    }
  }

  if (!isSimpleQuery(prompt)) {
    logger.debug('Ollama router: complex query, delegating to Claude');
    return null;
  }

  const userMessage = extractLastMessage(prompt);
  logger.info(
    { model: OLLAMA_MODEL, length: userMessage.length },
    'Ollama router: handling simple query locally',
  );

  try {
    const response = await queryOllama(userMessage, assistantName);
    logger.info(
      { model: OLLAMA_MODEL, responseLength: response.length },
      'Ollama router: response generated',
    );
    return response;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Ollama router: failed, falling back to Claude',
    );
    return null;
  }
}
