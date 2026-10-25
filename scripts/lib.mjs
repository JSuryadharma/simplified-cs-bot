import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const target = path.join(projectRoot, '.env');
  if (!fs.existsSync(target)) return;
  for (const sourceLine of fs.readFileSync(target, 'utf8').split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export async function readJsonResponse(response) {
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}


// Embedding lewat OpenRouter (API kompatibel OpenAI). Dipakai skrip host.
export async function embedTexts(texts, { batchSize = 64 } = {}) {
  const base = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const model = process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY belum diisi di .env');
  const vectors = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const body = await readJsonResponse(await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({ model, input: batch }),
    }));
    if (!Array.isArray(body.data) || body.data.length !== batch.length) throw new Error('jumlah embedding tidak sesuai');
    vectors.push(...body.data.map((e) => e.embedding));
  }
  return vectors;
}
