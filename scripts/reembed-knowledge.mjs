// Hitung ulang embedding semua point Qdrant dengan prefix dokumen nomic
// ("search_document: " + payload.text) dan tulis ke collection tujuan.
//   node scripts/reembed-knowledge.mjs <sumber> [tujuan]   (default tujuan = sumber)
// Qdrant & LM Studio diakses dari host (localhost).
import { loadEnv } from './lib.mjs';

loadEnv();
const QDRANT = process.env.QDRANT_HOST_URL || 'http://localhost:6333';
const LM = (process.env.LM_STUDIO_HOST_URL || 'http://localhost:1234/v1').replace(/\/$/, '');
const MODEL = process.env.LM_STUDIO_EMBEDDING_MODEL || 'text-embedding-nomic-embed-text-v1.5';
const [source = 'wa_knowledge', target = source] = process.argv.slice(2);

const docText = (p) => p.text || (p.question ? `Pertanyaan: ${p.question}\nJawaban: ${p.answer}` : p.asset_description || '');

async function call(url, method, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const info = await call(`${QDRANT}/collections/${source}`, 'GET');
const points = [];
let offset = null;
do {
  const page = await call(`${QDRANT}/collections/${source}/points/scroll`, 'POST', { limit: 256, offset, with_payload: true, with_vector: false });
  points.push(...page.result.points);
  offset = page.result.next_page_offset;
} while (offset);

if (target !== source) {
  await fetch(`${QDRANT}/collections/${target}`, { method: 'DELETE' });
  await call(`${QDRANT}/collections/${target}`, 'PUT', { vectors: info.result.config.params.vectors });
}

const texts = points.map((p) => `search_document: ${docText(p.payload)}`);
const emb = await call(`${LM}/embeddings`, 'POST', { model: MODEL, input: texts });
const upserts = points.map((p, i) => ({ id: p.id, vector: emb.data[i].embedding, payload: p.payload }));
await call(`${QDRANT}/collections/${target}/points?wait=true`, 'PUT', { points: upserts });
process.stdout.write(`${upserts.length} point di-embed ulang: ${source} -> ${target}\n`);
