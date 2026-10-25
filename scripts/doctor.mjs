import { loadEnv } from './lib.mjs';

loadEnv();

const lmConfigured = process.env.LM_STUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
const lmHostUrl = lmConfigured
  .replace('host.docker.internal', '127.0.0.1')
  .replace(/\/$/, '');
const n8nPort = process.env.N8N_PORT || '5678';

const checks = [
  ['n8n', `http://127.0.0.1:${n8nPort}/healthz`],
  ['Qdrant', 'http://127.0.0.1:6333/healthz'],
  ['Mock WhatsApp', 'http://127.0.0.1:8080/health'],
  ['LM Studio', `${lmHostUrl}/models`],
];

let failed = 0;
for (const [name, url] of checks) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json().catch(() => ({}));
    const extra = name === 'LM Studio' ? ` (${(body.data || []).length} model terlihat)` : '';
    process.stdout.write(`OK   ${name}${extra}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`GAGAL ${name}: ${error.message}\n`);
  }
}

process.exitCode = failed ? 1 : 0;
