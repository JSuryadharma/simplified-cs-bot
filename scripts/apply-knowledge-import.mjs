// Tambah cabang impor knowledge v2 ke workflow "WA Admin - Sistem Lengkap" (file JSON hasil export n8n).
//   node scripts/apply-knowledge-import.mjs <input.json> <output.json>
//
// POST /webhook/admin/import-knowledge  (header x-import-key = IMPORT_API_KEY), body JSON:
//   { mode: 'append' | 'replace',
//     owner_name?: 'SaViOr Konveksi',
//     dataset?: { items, image_assets, style_profile },      // dataset berlabel (knowledge/dataset/*.json)
//     chats?: [{ file_name, text }],                         // ekspor chat .txt mentah -> dilabeli OpenRouter
//     available_files?: ['IMG-...jpg', ...],                 // nama gambar yang ada di n8n_data/storage
//     dry_run?: true }                                       // pratinjau: label + dokumen tanpa menulis
// Gambar sendiri disimpan dashboard langsung ke n8n_data/storage dengan nama yang sama seperti di chat.
//
// Alur: parse + potong chat -> label per potongan (OpenRouter, jeda 3 dtk, retry) -> gabung + dedupe ->
// embedding (batch 32) -> [replace: hapus semua point] -> upsert Qdrant -> sinkron bot.knowledge_items
// (lewati bila KNOWLEDGE_DB_SYNC=false, dipakai sandbox) -> ringkasan.
// Penghapusan data lama baru terjadi setelah semua embedding berhasil.
// Kode parser/pembangun dokumen diambil dari scripts/knowledge/*.snippet.js. Skrip idempoten.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PARSER = fs.readFileSync(path.join(here, 'knowledge/wa-parse.snippet.js'), 'utf8');
const BUILD = fs.readFileSync(path.join(here, 'knowledge/build.snippet.js'), 'utf8');

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('pakai: node scripts/apply-knowledge-import.mjs <input.json> <output.json>');
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const workflow = Array.isArray(raw) ? raw[0] : raw;

const NAMES = ['CATATAN 06 - Impor Knowledge v2', 'Webhook Impor Knowledge', 'Autorisasi Impor Knowledge', 'Impor Knowledge Diizinkan?',
  'Tolak Impor Knowledge', 'Siapkan Impor Knowledge', 'Perlu Label AI?', 'LLM Label Chat', 'Gabungkan Knowledge Impor',
  'Ada Dokumen Knowledge?', 'Impor Knowledge Kosong', 'Embedding Knowledge v2', 'Buat Points Knowledge', 'Ganti Semua Knowledge?',
  'Hapus Knowledge Lama', 'Upsert Knowledge v2', 'Sinkron DB Knowledge?', 'Simpan Knowledge DB', 'Ringkasan Impor Knowledge', 'Jawab Impor Knowledge',
  'Impor Knowledge Tidak Valid', 'Pratinjau Impor?', 'Jawab Pratinjau Impor'];
workflow.nodes = workflow.nodes.filter((n) => !NAMES.includes(n.name));
for (const name of NAMES) delete workflow.connections[name];

const y = Math.max(...workflow.nodes.map((n) => n.position?.[1] ?? 0)) + 520;
const at = (col, row = 0) => [col * 240, y + row * 200];
const id = (n) => `00000000-0000-4000-8000-0000000e${String(n).padStart(4, '0')}`;
const qdrant = (suffix) => `={{$env.QDRANT_URL + "/collections/" + $env.QDRANT_COLLECTION + "${suffix}"}}`;
const ifNode = (n, name, left, pos) => ({
  id: id(n), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{ id: id(100 + n), leftValue: left, rightValue: 'true', operator: { type: 'string', operation: 'equals' } }], combinator: 'and' }, options: {} },
});
const code = (n, name, jsCode, pos, extra = {}) => ({ id: id(n), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { jsCode }, ...extra });
const respond = (n, name, body, status, pos) => ({
  id: id(n), name, type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, position: pos,
  parameters: { respondWith: 'json', responseBody: body, options: { responseCode: status } },
});
const http = (n, name, method, url, jsonBody, pos, extra = {}) => ({
  id: id(n), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: pos,
  parameters: { method, url, sendBody: true, specifyBody: 'json', jsonBody, options: {}, ...(extra.parameters || {}) },
  ...(extra.node || {}),
});

const SIAPKAN = `${PARSER}
const body = $json.body || {};
const mode = body.mode === 'replace' ? 'replace' : 'append';
const ownerName = String(body.owner_name || $env.OWNER_NAME || '').trim();
const chats = Array.isArray(body.chats) ? body.chats.filter((c) => c && String(c.text || '').trim()) : [];
const dataset = body.dataset && typeof body.dataset === 'object' ? body.dataset : null;
if (!chats.length && !dataset) throw new Error('Kirim minimal satu chat (.txt) atau dataset knowledge.');
const availableFiles = Array.isArray(body.available_files) ? body.available_files.map(String) : null;

const chatStats = [];
const out = [];
for (const chat of chats) {
  const name = String(chat.file_name || 'chat.txt').replace(/^Chat WhatsApp dengan /i, '').replace(/\\.txt$/i, '');
  const parsed = parseWhatsAppExport(chat.text, { ownerName });
  if (!parsed.messages.length) { chatStats.push({ chat: name, error: 'format ekspor tidak dikenali' }); continue; }
  const chunks = chunkConversation(parsed, { maxChars: 7000 });
  chatStats.push({ chat: name, owner: parsed.owner, messages: parsed.messages.length, chunks: chunks.length,
    owner_images: parsed.messages.filter((m) => m.role === 'owner').flatMap((m) => m.attachments).filter((a) => a.kind === 'image').length });
  for (const chunk of chunks) {
    out.push({ json: { chat: name, chunk_index: chunk.index, requestBody: {
      model: $env.OPENROUTER_MODEL,
      temperature: 0.1,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: KB_LABEL_SYSTEM_TEXT },
        { role: 'user', content: 'Chat dengan pelanggan "' + name + '", potongan ' + (chunk.index + 1) + '/' + chunks.length + ':\\n' + chunk.text },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'label_knowledge', strict: true, schema: KB_LABEL_SCHEMA_JSON } },
    } } });
  }
}
const meta = { mode, dry_run: body.dry_run === true, owner_name: ownerName, dataset, available_files: availableFiles, chats: chatStats, chunk_total: out.length };
if (!out.length) return [{ json: { skip_llm: true, meta } }];
return out.map((item, i) => ({ json: { ...item.json, meta: i === 0 ? meta : undefined } }));`;

const GABUNG = `${BUILD}
const { createHash } = require('crypto');
const prepItems = $('Siapkan Impor Knowledge').all();
const meta = prepItems[0].json.meta;
const results = $input.all();
const perChat = {};
let failed = 0;
results.forEach((item, i) => {
  const src = prepItems[i] ? prepItems[i].json : {};
  if (src.skip_llm) return;
  let content = item.json.choices?.[0]?.message?.content || '';
  content = String(content).trim().replace(/^\`\`\`(?:json)?/i, '').replace(/\`\`\`$/, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(content); } catch { failed += 1; return; }
  (perChat[src.chat] = perChat[src.chat] || []).push(parsed);
});

const merged = { items: [], image_assets: [], style_profile: '' };
if (meta.dataset) {
  merged.items.push(...(meta.dataset.items || []));
  merged.image_assets.push(...(meta.dataset.image_assets || []));
  merged.style_profile = meta.dataset.style_profile || '';
}
const notes = [];
for (const [chat, labels] of Object.entries(perChat)) {
  const d = labelsToDataset(labels, { chat, prefix: 'chat-' + chat.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
  merged.items.push(...d.items);
  merged.image_assets.push(...d.image_assets);
  if (d.style_notes) notes.push(d.style_notes);
}
if (!merged.style_profile && notes.length) merged.style_profile = notes.join('\\n').slice(0, 1500);

const { docs, skipped } = buildKnowledgeDocs(merged, {
  hashHex: (s) => createHash('sha1').update(s).digest('hex'),
  source: meta.dataset && !Object.keys(perChat).length ? 'knowledge_dataset' : 'whatsapp_import',
  availableFiles: meta.available_files || undefined,
});
const summary = { mode: meta.mode, chats: meta.chats, chunks_labeled: results.length - failed - (prepItems[0].json.skip_llm ? 1 : 0), chunks_failed: failed,
  documents: docs.length, skipped: skipped.length, skipped_detail: skipped.slice(0, 30),
  by_type: docs.reduce((a, d) => ({ ...a, [d.payload.content_type]: (a[d.payload.content_type] || 0) + 1 }), {}) };
// Pratinjau: kembalikan hasil label + dokumen tanpa embedding/menulis. Dashboard mengirim ulang
// "dataset" ini saat pengguna menekan Simpan, jadi chat tidak perlu dilabeli dua kali.
if (meta.dry_run) {
  return [{ json: { has_docs: false, preview: true, summary, dataset: merged,
    documents: docs.map((d) => ({ id: d.id, kb_id: d.payload.kb_id, content_type: d.payload.content_type, category: d.payload.category,
      question: d.payload.question || '', answer: d.payload.answer || '', asset_id: d.payload.asset_id || '', file: d.payload.original_file_name || '',
      asset_kind: d.payload.asset_kind || '', caption: d.payload.asset_caption || '', auto_reply: d.payload.auto_reply })) } }];
}
if (!docs.length) return [{ json: { has_docs: false, summary } }];
const batches = [];
for (let i = 0; i < docs.length; i += 32) batches.push({ offset: i, texts: docs.slice(i, i + 32).map((d) => 'search_document: ' + d.text) });
return batches.map((b, i) => ({ json: { has_docs: true, ...b, ...(i === 0 ? { docs, summary, style_profile: merged.style_profile, replace: meta.mode === 'replace' } : {}) } }));`;

const POINTS = `const first = $('Gabungkan Knowledge Impor').first().json;
const batches = $('Gabungkan Knowledge Impor').all();
const embeddings = $input.all();
const vectors = [];
embeddings.forEach((item, i) => {
  const data = item.json.data || [];
  const expected = batches[i].json.texts.length;
  if (data.length !== expected) throw new Error('Embedding batch ' + i + ' berisi ' + data.length + ' vektor, seharusnya ' + expected + '. Data lama tidak dihapus.');
  data.forEach((d, j) => { vectors[batches[i].json.offset + j] = d.embedding; });
});
if (vectors.length !== first.docs.length || vectors.some((v) => !Array.isArray(v))) throw new Error('Embedding tidak lengkap. Data lama tidak dihapus.');
const points = first.docs.map((d, i) => ({ id: d.id, vector: vectors[i], payload: d.payload }));
return [{ json: { points, replace: first.replace === true, count: points.length } }];`;

const DB_BODY = "={{ JSON.stringify({ p_items: $('Gabungkan Knowledge Impor').first().json.docs.filter((d) => d.payload.content_type !== 'image_asset').map((d) => ({ kb_id: d.payload.kb_id, content_type: d.payload.content_type, category: d.payload.category, question: d.payload.question, answer: d.payload.answer, tags: String(d.payload.tags || '').split(', ').filter(Boolean) })), p_style_profile: $('Gabungkan Knowledge Impor').first().json.style_profile || null, p_replace: $('Buat Points Knowledge').first().json.replace, p_source: 'knowledge_import', p_source_stats: $('Gabungkan Knowledge Impor').first().json.summary }) }}";

const RINGKAS = `const first = $('Gabungkan Knowledge Impor').first().json;
const pts = $('Buat Points Knowledge').first().json;
let db = null;
try { db = $('Simpan Knowledge DB').first().json; } catch { db = { skipped: true }; }
return [{ json: { ok: true, ...first.summary, written: pts.count, replaced: pts.replace, db } }];`;

const AUTH = `const headers = $json.headers || {};
const supplied = String(headers['x-import-key'] || '');
return [{ json: { body: $json.body || {}, auth_state: supplied && supplied === String($env.IMPORT_API_KEY || '') ? 'authorized' : 'unauthorized' } }];`;

const injectConstants = (src) => src
  .replace('KB_LABEL_SYSTEM_TEXT', 'KB_LABEL_SYSTEM')
  .replace('KB_LABEL_SCHEMA_JSON', 'KB_LABEL_SCHEMA');

workflow.nodes.push(
  { id: id(1), name: 'CATATAN 06 - Impor Knowledge v2', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-560, y - 40],
    parameters: { width: 500, height: 640, color: 5, content: '## 06 — Impor Knowledge v2 (dashboard)\nPOST `/webhook/admin/import-knowledge` dengan header `x-import-key`.\n- `dataset`: knowledge berlabel (knowledge/dataset/*.json) langsung di-embed\n- `chats`: ekspor .txt mentah, dipotong lalu dilabeli OpenRouter per potongan\n- `mode: replace` menghapus SEMUA point setelah embedding baru berhasil\n- gambar disimpan dashboard ke storage dengan nama yang sama seperti di chat\nKode parser & pembangun dokumen: scripts/knowledge/*.snippet.js (dipasang oleh scripts/apply-knowledge-import.mjs).' } },
  { id: id(2), name: 'Webhook Impor Knowledge', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: at(0), webhookId: '7a2e4c10-5d3b-4f61-8e2a-0b6c7e000001',
    parameters: { httpMethod: 'POST', path: 'admin/import-knowledge', responseMode: 'responseNode', options: {} } },
  code(3, 'Autorisasi Impor Knowledge', AUTH, at(1)),
  ifNode(4, 'Impor Knowledge Diizinkan?', "={{ String($json.auth_state === 'authorized') }}", at(2)),
  respond(5, 'Tolak Impor Knowledge', '={{ { error: "unauthorized" } }}', 401, at(3, 1)),
  code(6, 'Siapkan Impor Knowledge', injectConstants(`${SIAPKAN.replace(PARSER, `${PARSER}\n${BUILD}`)}`), at(3), { onError: 'continueErrorOutput' }),
  ifNode(7, 'Perlu Label AI?', '={{ String($json.skip_llm !== true) }}', at(4)),
  http(8, 'LLM Label Chat', 'POST', '={{($env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1") + "/chat/completions"}}', '={{ JSON.stringify($json.requestBody) }}', at(5), {
    parameters: { sendHeaders: true, headerParameters: { parameters: [{ name: 'Authorization', value: '=Bearer {{$env.OPENROUTER_API_KEY}}' }] },
      options: { timeout: 120000, batching: { batch: { batchSize: 1, batchInterval: 3000 } } } },
    node: { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput' } }),
  code(9, 'Gabungkan Knowledge Impor', GABUNG, at(6)),
  ifNode(10, 'Ada Dokumen Knowledge?', '={{ String($json.has_docs === true) }}', at(7)),
  respond(11, 'Impor Knowledge Kosong', '={{ { ok: false, error: "Tidak ada knowledge yang bisa diimpor", ...$json.summary } }}', 422, at(8, 1)),
  http(12, 'Embedding Knowledge v2', 'POST', '={{$env.OPENROUTER_BASE_URL + "/embeddings"}}', '={{ JSON.stringify({ model: $env.OPENROUTER_EMBEDDING_MODEL, input: $json.texts }) }}', at(8), {
    parameters: { sendHeaders: true, headerParameters: { parameters: [{ name: 'Authorization', value: '=Bearer {{$env.OPENROUTER_API_KEY}}' }] }, options: { timeout: 120000 } } }),
  code(13, 'Buat Points Knowledge', POINTS, at(9)),
  ifNode(14, 'Ganti Semua Knowledge?', '={{ String($json.replace === true) }}', at(10)),
  http(15, 'Hapus Knowledge Lama', 'POST', qdrant('/points/delete?wait=true'), '={{ JSON.stringify({ filter: {} }) }}', at(11, -1)),
  http(16, 'Upsert Knowledge v2', 'PUT', qdrant('/points?wait=true'), "={{ JSON.stringify({ points: $('Buat Points Knowledge').first().json.points }) }}", at(12), { parameters: { options: { timeout: 120000 } } }),
  ifNode(17, 'Sinkron DB Knowledge?', "={{ String($env.KNOWLEDGE_DB_SYNC !== 'false') }}", at(13)),
  http(18, 'Simpan Knowledge DB', 'POST', '={{$env.DB_API_URL + "/rpc/import_knowledge"}}', DB_BODY, at(14, -1)),
  code(19, 'Ringkasan Impor Knowledge', RINGKAS, at(15)),
  respond(20, 'Jawab Impor Knowledge', '={{ $json }}', 200, at(16)),
);
// Error di Siapkan (mis. body kosong) dijawab 400 lewat output error
workflow.nodes.push(ifNode(22, 'Pratinjau Impor?', '={{ String($json.preview === true) }}', at(8, 2)));
workflow.nodes.push(respond(23, 'Jawab Pratinjau Impor', '={{ { ok: true, preview: true, ...$json.summary, dataset: $json.dataset, documents: $json.documents } }}', 200, at(9, 2)));
workflow.nodes.push(respond(21, 'Impor Knowledge Tidak Valid', '={{ { ok: false, error: $json.error?.message || $json.error || "invalid" } }}', 400, at(4, 1)));

const link = (from, ...outputs) => {
  workflow.connections[from] = { main: outputs.map((targets) => [].concat(targets).filter(Boolean).map((node) => ({ node, type: 'main', index: 0 }))) };
};
link('Webhook Impor Knowledge', 'Autorisasi Impor Knowledge');
link('Autorisasi Impor Knowledge', 'Impor Knowledge Diizinkan?');
link('Impor Knowledge Diizinkan?', 'Siapkan Impor Knowledge', 'Tolak Impor Knowledge');
link('Siapkan Impor Knowledge', 'Perlu Label AI?', 'Impor Knowledge Tidak Valid');
link('Perlu Label AI?', 'LLM Label Chat', 'Gabungkan Knowledge Impor');
link('LLM Label Chat', 'Gabungkan Knowledge Impor');
link('Gabungkan Knowledge Impor', 'Ada Dokumen Knowledge?');
link('Ada Dokumen Knowledge?', 'Embedding Knowledge v2', 'Pratinjau Impor?');
link('Pratinjau Impor?', 'Jawab Pratinjau Impor', 'Impor Knowledge Kosong');
link('Embedding Knowledge v2', 'Buat Points Knowledge');
link('Buat Points Knowledge', 'Ganti Semua Knowledge?');
link('Ganti Semua Knowledge?', 'Hapus Knowledge Lama', 'Upsert Knowledge v2');
link('Hapus Knowledge Lama', 'Upsert Knowledge v2');
link('Upsert Knowledge v2', 'Sinkron DB Knowledge?');
link('Sinkron DB Knowledge?', 'Simpan Knowledge DB', 'Ringkasan Impor Knowledge');
link('Simpan Knowledge DB', 'Ringkasan Impor Knowledge');
link('Ringkasan Impor Knowledge', 'Jawab Impor Knowledge');

fs.writeFileSync(output, JSON.stringify(Array.isArray(raw) ? [workflow] : workflow, null, 2));
process.stdout.write(`cabang impor knowledge v2 ditambahkan: ${output} (${workflow.nodes.length} node)\n`);
