import { execSync } from 'child_process';
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

  // Only delegate to Claude when the message clearly needs tools or code
  const complexPatterns = [
    // Explicit tool/service requests
    /\b(salesforce|google drive|1password|plaud|ori mnemos)\b/i,
    /\b(use claude|ask claude)\b/,
    // Code/file operations (must mention specific files or code concepts)
    /\b(read|write|edit|create|delete)\b.*\b(file|code|script)\b/,
    /\b(commit|push|pull|merge|deploy|build|refactor|debug)\b/,
    // File paths
    /\b(\.ts|\.js|\.py|\.json|\.md|\.yaml|\.env|\.sh)\b/,
    /\b(src\/|container\/|groups\/|data\/|\/workspace)\b/,
    // Scheduling
    /\b(schedule|remind me|set a reminder|cron)\b/,
    // Explicit multi-step
    /\b(step by step|implement|configure|install|set up)\b/,
    // File attachments that need processing
    /\[Document saved|\.pdf|\.docx|\.xlsx/,
    // Database/API work
    /\b(soql|query|sql|apex)\b/i,
  ];

  for (const pattern of complexPatterns) {
    if (pattern.test(text)) return false;
  }

  // Very long messages are likely complex
  if (text.length > 1000) return false;

  // Default: Ollama handles it
  return true;
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

  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    prompt: userMessage,
    system: `/no_think You are ${assistantName}, a helpful personal assistant. Be concise and direct. Do not use markdown formatting unless asked.`,
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
