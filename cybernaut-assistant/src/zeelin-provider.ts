import { registerProvider } from '@flue/runtime';

// Zeelin gateway via local proxy on 127.0.0.1:18081.
// 两个 provider：
//  - zeelin（anthropic-messages 口）：claude / Doubao / DeepSeek，stop_reason 映射干净。
//  - zeelin-oai（openai 口 /v1/chat/completions）：gpt-5.5 等 OpenAI 协议模型。
//    gpt-5.5 是 reasoning 模型，maxTokens 必须给足，否则正文被思考吃光返空。
const raw = process.env.OPENAI_BASE_URL || process.env.LLM_BASE_URL || 'http://127.0.0.1:18081/v1';
const anthropicBase = raw.replace(/\/v1\/?$/, '');
const openaiBase = raw.endsWith('/v1') || raw.endsWith('/v1/') ? raw.replace(/\/$/, '') : `${anthropicBase}/v1`;
const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';

registerProvider('zeelin', {
  api: 'anthropic-messages',
  baseUrl: anthropicBase,
  apiKey,
  contextWindow: 200000,
  maxTokens: 8192,
  models: {
    'claude-sonnet-4-6': { contextWindow: 200000, maxTokens: 8192 },
    'Doubao-seed-2-1-pro': { contextWindow: 256000, maxTokens: 16384 },
    'Doubao-seed-2-1-turbo': { contextWindow: 256000, maxTokens: 16384 },
    'DeepSeek-V4-Flash': { contextWindow: 128000, maxTokens: 8192 },
  },
});

registerProvider('zeelin-oai', {
  api: 'openai-completions',
  baseUrl: openaiBase,
  apiKey,
  contextWindow: 256000,
  maxTokens: 32768,
  models: {
    // reasoning 模型：maxTokens 给足，避免思考吃光正文
    'gpt-5.5': { contextWindow: 256000, maxTokens: 32768 },
  },
});
