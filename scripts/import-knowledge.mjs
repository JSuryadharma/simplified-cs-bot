// Impor knowledge ke Qdrant (dan opsional ke tabel bot.knowledge_items) dari dataset berlabel.
//   node scripts/import-knowledge.mjs --dataset knowledge/dataset/savior-knowledge.json \
//        [--collection wa_knowledge_test] [--replace] [--dry-run]
//
// --replace  hapus SEMUA point di collection lalu isi ulang.
//            Embedding dibuat lebih dulu; penghapusan baru dilakukan setelah semua embedding berhasil.
// --dry-run  hanya bangun dokumen dan tampilkan ringkasan.
// Qdrant diakses dari host (localhost); embedding lewat OpenRouter. Knowledge hanya di Qdrant.
import fs from 'node:fs';
import path from 'node:path';
import { embedTexts, loadEnv, projectRoot } from './lib.mjs';
import { buildKnowledgeDocs, sha1Hex } from './knowledge/index.mjs';

loadEnv();
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const values = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

const QDRANT = process.env.QDRANT_HOST_URL || 'http://localhost:6333';
const collection = values('collection')[0] || process.env.QDRANT_COLLECTION || 'wa_knowledge';
const storage = path.join(projectRoot, 'n8n_data/storage');
const datasets = values('dataset');
if (!datasets.length) throw new Error('pakai: --dataset <file.json> (boleh lebih dari satu)');

async function call(url, method, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 400)}`);
  return json;
}

const merged = { items: [], image_assets: [], style_profile: '' };
for (const file of datasets) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  merged.items.push(...(d.items || []));
  merged.image_assets.push(...(d.image_assets || []));
  merged.style_profile = d.style_profile || merged.style_profile;
}
const availableFiles = fs.existsSync(storage) ? fs.readdirSync(storage) : null;
const { docs, skipped } = buildKnowledgeDocs(merged, { hashHex: sha1Hex, source: 'knowledge_dataset', availableFiles });
const byType = docs.reduce((acc, d) => ({ ...acc, [d.payload.content_type]: (acc[d.payload.content_type] || 0) + 1 }), {});
process.stdout.write(`${docs.length} dokumen (${JSON.stringify(byType)}), dilewati ${skipped.length}${skipped.length ? ': ' + JSON.stringify(skipped) : ''}\n`);
if (flag('dry-run')) process.exit(0);

// 1. Embedding dulu (OpenRouter, batch 32). Gagal di sini = data lama tetap utuh.
const vectors = await embedTexts(docs.map((d) => d.text), { batchSize: 32 });

// 2. Pastikan collection ada (dimensi dari embedding)
const exists = await fetch(`${QDRANT}/collections/${collection}`);
if (exists.status === 404) {
  await call(`${QDRANT}/collections/${collection}`, 'PUT', { vectors: { size: vectors[0].length, distance: 'Cosine' } });
  process.stdout.write(`collection ${collection} dibuat (dim ${vectors[0].length})\n`);
}

// 3. Ganti semua bila --replace, lalu upsert
if (flag('replace')) {
  await call(`${QDRANT}/collections/${collection}/points/delete?wait=true`, 'POST', { filter: {} });
  process.stdout.write(`semua point lama di ${collection} dihapus\n`);
}
const points = docs.map((d, i) => ({ id: d.id, vector: vectors[i], payload: d.payload }));
for (let i = 0; i < points.length; i += 64) {
  await call(`${QDRANT}/collections/${collection}/points?wait=true`, 'PUT', { points: points.slice(i, i + 64) });
}
const info = await call(`${QDRANT}/collections/${collection}`, 'GET');
process.stdout.write(`${points.length} point ditulis; total di ${collection}: ${info.result.points_count}\n`);

