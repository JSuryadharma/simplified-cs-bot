// Hitung ulang embedding semua point Qdrant memakai model embedding OpenRouter
// (OPENROUTER_EMBEDDING_MODEL) dan tulis ke collection tujuan. Dimensi collection tujuan
// mengikuti model, jadi collection tujuan dibuat ulang bila berbeda dari sumber.
//   node scripts/reembed-knowledge.mjs <sumber> [tujuan]   (default tujuan = sumber)
// Qdrant diakses dari host (localhost).
import { embedTexts, loadEnv } from './lib.mjs';

loadEnv();
const QDRANT = process.env.QDRANT_HOST_URL || 'http://localhost:6333';
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

const vectors = await embedTexts(points.map((p) => docText(p.payload)));
const size = vectors[0].length;
if (target !== source) {
  await fetch(`${QDRANT}/collections/${target}`, { method: 'DELETE' });
  await call(`${QDRANT}/collections/${target}`, 'PUT', { vectors: { size, distance: 'Cosine' } });
} else if (info.result.config.params.vectors.size !== size) {
  throw new Error(`dimensi model (${size}) beda dengan ${source}; pakai collection tujuan baru`);
}
const upserts = points.map((p, i) => ({ id: p.id, vector: vectors[i], payload: p.payload }));
await call(`${QDRANT}/collections/${target}/points?wait=true`, 'PUT', { points: upserts });
process.stdout.write(`${upserts.length} point di-embed ulang: ${source} -> ${target}\n`);
