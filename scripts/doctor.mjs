import { loadEnv } from './lib.mjs';

loadEnv();

const openRouterUrl = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const openRouterAuth = { authorization: `Bearer ${process.env.OPENROUTER_API_KEY || ''}` };
const port = (name, fallback) => process.env[name] || fallback;

const checks = [
  ['n8n', `http://127.0.0.1:${port('N8N_PORT', '5678')}/healthz`],
  ['Qdrant', `http://127.0.0.1:${port('QDRANT_PORT', '6333')}/healthz`],
  ['Mock WhatsApp', `http://127.0.0.1:${port('MOCK_WHATSAPP_PORT', '8080')}/health`],
  ['Dashboard', `http://127.0.0.1:${port('DASHBOARD_PORT', '4000')}/api/health`],
  ['OpenRouter', `${openRouterUrl}/key`, openRouterAuth],
];

let failed = 0;
for (const [name, url, headers] of checks) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json().catch(() => ({}));
    const extra = name === 'OpenRouter' ? ` (API key valid${body.data?.is_free_tier ? ', free tier' : ''})` : '';
    process.stdout.write(`OK   ${name}${extra}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`GAGAL ${name}: ${error.message}\n`);
  }
}

process.exitCode = failed ? 1 : 0;
