#!/usr/bin/env node
// apply-conversation-guard.mjs
// Menambahkan ke workflow WA Admin:
//  - debounce (Wait 6s + conversation_window + supersede-exit)
//  - kunci percakapan (acquire/release_conversation_lock)
//  - penggabungan pesan beruntun (Gabung Pesan Jendela)
//  - prompt state-aware (Siapkan Keputusan AI) + AUTO_REPLY only (Parse Keputusan AI)
//  - webhook respond segera (onReceived) supaya Meta tidak timeout selama Wait
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const [workflowPath, outPath] = process.argv.slice(2);
if (!workflowPath) {
  console.error('usage: node apply-conversation-guard.mjs <workflow.json> [out.json]');
  process.exit(1);
}

const wf = JSON.parse(readFileSync(workflowPath, 'utf8'));
const nodes = JSON.parse(wf.nodes);
const connections = JSON.parse(wf.connections);

const id = () => randomUUID();
const NEW_IDS = {
  wait: id(),
  cekJendela: id(),
  superseded: id(),
  supersededCond: id(),
  abaikanLama: id(),
  ambilLock: id(),
  lockDidapat: id(),
  lockCond: id(),
  abaikanTanpaLock: id(),
  gabungPesan: id(),
  lepasLock: id(),
  lepasLockDiam: id(),
};

const find = (name) => nodes.find((n) => n.name === name);
const position = (name) => {
  const n = find(name);
  return n ? [...n.position] : [0, 0];
};
const below = (name, offset = 200) => {
  const p = position(name);
  return [p[0] + offset, p[1]];
};
const nextFree = (name) => {
  const used = new Set(nodes.map((n) => n.position.join(',')));
  let p = below(name);
  while (used.has(p.join(','))) p[1] += 200;
  return p;
};

// ------------------------------------------------------------------
// 1) Node baru (push satu per satu agar posisi saling tahu)
// ------------------------------------------------------------------
const pushNode = (node) => { nodes.push(node); return node; };

pushNode({
  parameters: { waitType: 'timeInterval', amount: 6, unit: 'seconds' },
  id: NEW_IDS.wait,
  name: 'Tunda Jendela Pesan',
  type: 'n8n-nodes-base.wait',
  typeVersion: 1.5,
  position: nextFree('Hasil Customer'),
});

pushNode({
  parameters: {
    method: 'POST',
    url: '={{$env.DB_API_URL + "/rpc/conversation_window"}}',
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody:
      "={{ JSON.stringify({ p_chat_id: $('Hasil Customer').first().json.customer_phone, p_since_message_id: $('Hasil Customer').first().json.message_id }) }}",
    options: {},
  },
  id: NEW_IDS.cekJendela,
  name: 'Cek Jendela Pesan',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  position: nextFree('Tunda Jendela Pesan'),
});

pushNode({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: NEW_IDS.supersededCond,
          leftValue: '={{$json.newer_count}}',
          rightValue: 0,
          operator: { type: 'number', operation: 'gt' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  id: NEW_IDS.superseded,
  name: 'Superseded?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: nextFree('Cek Jendela Pesan'),
});

const supPos = position('Superseded?');
pushNode({
  parameters: {},
  id: NEW_IDS.abaikanLama,
  name: 'Abaikan Pesan Lama',
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position: [supPos[0] - 160, supPos[1] + 200],
});

pushNode({
  parameters: {
    method: 'POST',
    url: '={{$env.DB_API_URL + "/rpc/acquire_conversation_lock"}}',
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody:
      "={{ JSON.stringify({ p_chat_id: $('Hasil Customer').first().json.customer_phone, p_ttl_seconds: 45 }) }}",
    options: {},
  },
  id: NEW_IDS.ambilLock,
  name: 'Ambil Lock',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  position: nextFree('Superseded?'),
});

pushNode({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [
        {
          id: NEW_IDS.lockCond,
          leftValue: '={{$json.acquired}}',
          rightValue: false,
          operator: { type: 'boolean', operation: 'false' },
        },
      ],
      combinator: 'and',
    },
    options: {},
  },
  id: NEW_IDS.lockDidapat,
  name: 'Lock Didapat?',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: nextFree('Ambil Lock'),
});

const lockPos = position('Lock Didapat?');
pushNode({
  parameters: {},
  id: NEW_IDS.abaikanTanpaLock,
  name: 'Abaikan Tanpa Lock',
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position: [lockPos[0] - 160, lockPos[1] + 200],
});

pushNode({
  parameters: {
    jsCode: `const ctx = $('Hasil Customer').first().json;
const win = $('Cek Jendela Pesan').first().json;
const combined = String(win.combined_text || '').trim();
return [{ json: { ...ctx, message_text: combined || ctx.message_text } }];`,
  },
  id: NEW_IDS.gabungPesan,
  name: 'Gabung Pesan Jendela',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: nextFree('Lock Didapat?'),
});

pushNode({
  parameters: {
    method: 'POST',
    url: '={{$env.DB_API_URL + "/rpc/release_conversation_lock"}}',
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody:
      "={{ JSON.stringify({ p_chat_id: $('Hasil Customer').first().json.customer_phone, p_run_id: $('Ambil Lock').first().json.run_id }) }}",
    options: {},
  },
  id: NEW_IDS.lepasLock,
  name: 'Lepas Lock',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  position: nextFree('Hasil Keputusan DB'),
});

pushNode({
  parameters: {
    method: 'POST',
    url: '={{$env.DB_API_URL + "/rpc/release_conversation_lock"}}',
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody:
      "={{ JSON.stringify({ p_chat_id: $('Hasil Customer').first().json.customer_phone, p_run_id: $('Ambil Lock').first().json.run_id }) }}",
    options: {},
  },
  id: NEW_IDS.lepasLockDiam,
  name: 'Lepas Lock (Diam)',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  position: nextFree('Diam Menunggu Owner'),
});

// ------------------------------------------------------------------
// 2) Edit node yang ada
// ------------------------------------------------------------------
const webhook = find('Webhook Pesan WhatsApp');
if (webhook) {
  webhook.parameters.options = { ...(webhook.parameters.options || {}), rawBody: true, responseMode: 'onReceived' };
}

const siapkan = find('Siapkan Keputusan AI');
if (siapkan) {
  const liveModel = /model:\s*'([^']+)'/.exec(siapkan.parameters.jsCode);
  siapkan.parameters.jsCode = `const MIN_RELEVANT_SCORE = 0.45; // tune to your embedding model's score distribution
const STRONG_MATCH_SCORE = 0.75; // tune similarly
const MAX_KNOWLEDGE_ITEMS = 6;

const ctx = $('Gabung Pesan Jendela').first().json;
const search = $input.first().json || {};
const rawPoints = search.result?.points || search.points || search.result || [];
const pointsArray = Array.isArray(rawPoints) ? rawPoints : [];

const knowledgeAll = pointsArray
  .map((p) => ({
    score: p.score ?? 0,
    content_type: p.payload?.content_type || 'chat_qa',
    question: p.payload?.question || '',
    answer: p.payload?.answer || '',
    text: p.payload?.text || '',
    source: p.payload?.source || '',
    asset_id: p.payload?.asset_id || '',
    asset_description: p.payload?.asset_description || '',
    asset_caption: p.payload?.asset_caption || '',
    asset_path: p.payload?.asset_path || '',
    original_file_name: p.payload?.original_file_name || '',
    mime_type: p.payload?.mime_type || ''
  }))
  .sort((a, b) => b.score - a.score);

const topScore = knowledgeAll.length ? knowledgeAll[0].score : 0;

// Best matches first, weak/irrelevant noise filtered out before it reaches the model
const knowledge = knowledgeAll
  .filter((k) => k.score >= MIN_RELEVANT_SCORE)
  .slice(0, MAX_KNOWLEDGE_ITEMS);

const matchStrength =
  topScore >= STRONG_MATCH_SCORE ? 'STRONG' : topScore >= MIN_RELEVANT_SCORE ? 'WEAK' : 'NONE';

const system = \`Anda adalah admin toko WhatsApp yang berpengalaman. Selalu balas dalam Bahasa Indonesia, mengikuti gaya bahasa pada profil_gaya_owner.

LANGKAH WAJIB SEBELUM MENYUSUN BALASAN:
1. Baca ulang riwayat_terbaru + pesan_pelanggan untuk memahami apa yang SEBENARNYA ditanyakan pelanggan, termasuk hal yang tersirat/implisit (mis. "yang itu", "warna itu", varian tanpa detail). Tulis pemahaman singkatnya di field customer_intent.
2. Cocokkan customer_intent dengan data_order (untuk status pesanan) dan knowledge_relevan (untuk info produk/bisnis), sambil memperhatikan kekuatan_kecocokan_knowledge (STRONG/WEAK/NONE) yang sudah dihitung sistem.
3. SEBELUM memutuskan pertanyaan berikutnya, periksa riwayat_terbaru dan data_order, lalu catat slot yang SUDAH terisi: produk, keperluan, preferensi bahan/warna/ukuran, jumlah/pcs. JANGAN PERNAH menanyakan ulang slot yang sudah terisi — tanyakan HANYA slot yang masih kosong, maksimal SATU pertanyaan per balasan. Jika semua slot yang diperlukan sudah terisi, langsung berikan jawaban atau rekomendasi.

ATURAN BALASAN:
A. Selalu balas pelanggan secara langsung dengan balasan sederhana, singkat, natural, dan terasa manusiawi. Jangan pernah memilih mode eskalasi.
B. Jangan mengarang harga, stok, kebijakan, status order, resi, tanggal, atau janji yang tidak ada di data_order/knowledge_relevan.
C. Field question pada knowledge HANYA referensi konteks; field ANSWER adalah sumber jawaban, sesuaikan redaksinya dengan gaya owner dan konteks — jangan tempel mentah-mentah kalau kaku.
D. Balasan TIDAK PERNAH menyebut AI/model/vector database/dataset.
E. data_order adalah SATU-SATUNYA sumber sah untuk status pesanan pelanggan ini.
F. Jika knowledge atau data order tidak cukup menjawab, tetap berikan balasan sopan dan jujur, misalnya memberitahu akan dicek dan dijawab kemudian. Jangan mengarang fakta.
G. Untuk permintaan gambar: pilih asset_id dari knowledge_relevan HANYA jika sangat relevan dengan customer_intent (bukan sekadar mirip kategori). Jika ragu, tanyakan detail dulu ke pelanggan. asset_id wajib string kosong ("") jika tidak perlu mengirim gambar.
H. Output WAJIB mengikuti JSON schema yang diberikan, tanpa teks tambahan di luar schema.

CONTOH:
- Pelanggan: "Kaos dan celana olahraga ya", lalu "mau yang adem" -> produk dan keperluan sudah terisi, slot bahan belum -> reply berisi rekomendasi bahan adem untuk kaos/celana olahraga TANPA menanyakan ulang produknya.
- Pelanggan: "warna merah masih ada?" (size belum disebut) -> tanyakan size yang dimaksud (satu pertanyaan), jangan tanya warna karena sudah terisi.
- Pelanggan: "kak, ini masih diproses admin?" -> reply singkat ramah sesuai data_order, tanpa menyebut AI.\`;

const payload = {
  profil_gaya_owner: ctx.style_profile,
  nama_pelanggan: ctx.customer_name,
  pesan_pelanggan: ctx.message_text,
  riwayat_terbaru: ctx.recent_messages,
  data_order: ctx.orders,
  kekuatan_kecocokan_knowledge: matchStrength, // STRONG | WEAK | NONE
  knowledge_relevan: knowledge
};

return [{ json: {
  context: ctx,
  knowledge,
  matchStrength,
  requestBody: {
    model: ${liveModel ? `'${liveModel[1]}'` : "$env.LM_STUDIO_CHAT_MODEL"},
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'keputusan_admin_whatsapp',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            customer_intent: { type: 'string' },
            action: { type: 'string', enum: ['AUTO_REPLY'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reply: { type: 'string' },
            needs_summary: { type: 'string' },
            owner_question: { type: 'string' },
            asset_id: { type: 'string' }
          },
          required: ['customer_intent', 'action', 'confidence', 'reply', 'needs_summary', 'owner_question', 'asset_id']
        }
      }
    }
  }
} }];`;
}

const parse = find('Parse Keputusan AI');
if (parse) {
  parse.parameters.jsCode = `const ctx = $('Gabung Pesan Jendela').first().json;
const prep = $('Siapkan Keputusan AI').first().json;

let content = $json.choices?.[0]?.message?.content || $json.choices?.[0]?.message?.reasoning_content || '';
if (typeof content !== 'string') content = JSON.stringify(content);
content = content.trim().replace(/^\`\`\`(?:json)?/i, '').replace(/\`\`\`$/, '').trim();

let parsed;
try { parsed = JSON.parse(content); } catch { parsed = {}; }

const knowledgeList = Array.isArray(prep.knowledge) ? prep.knowledge : [];
const hasKnowledge = knowledgeList.length > 0;
const hasOrders = Array.isArray(ctx.orders) && ctx.orders.length > 0;
const matchStrength = prep.matchStrength || 'NONE';

const action = 'AUTO_REPLY';
let reply = String(parsed.reply || '').trim();
const customerIntent = String(parsed.customer_intent || '').trim();

// Clamp confidence ke rentang 0-1, dan tangani NaN
let confidence = Number(parsed.confidence);
if (!Number.isFinite(confidence)) confidence = 0;
confidence = Math.min(1, Math.max(0, confidence));

// Safety net: model tidak memberi reply -> jangan kirim pesan kosong
if (!reply) reply = 'Baik, saya cek dulu ya. Mohon tunggu sebentar.';

const requestedAssetId = String(parsed.asset_id || '').trim();
const selectedAsset = knowledgeList.find((entry) =>
  entry.content_type === 'image_asset' &&
  entry.asset_id &&
  entry.asset_id === requestedAssetId &&
  entry.asset_path &&
  (entry.mime_type || '').startsWith('image/')
) || null;

const needsSummary = String(
  parsed.needs_summary || ('Pelanggan menanyakan: ' + ctx.message_text)
).trim();

const ownerQuestion = String(
  parsed.owner_question || 'Mohon berikan jawaban yang boleh diteruskan ke pelanggan.'
).trim();

return [{ json: {
  action,
  confidence,
  reply,
  needs_summary: needsSummary,
  owner_question: ownerQuestion,
  customer_id: ctx.customer_id,
  customer_message: ctx.message_text,
  customer_intent: customerIntent,
  match_strength: matchStrength,
  knowledge_used: knowledgeList,
  selected_asset: selectedAsset,
  // ringkasan untuk audit trail / dilempar ke p_source_context RPC
  source_context: {
    customer_message: ctx.message_text,
    customer_intent: customerIntent,
    match_strength: matchStrength,
    model_confidence: confidence,
    had_knowledge_match: hasKnowledge,
    had_order_data: hasOrders,
    requested_asset_id: requestedAssetId || null,
    asset_resolved: !!selectedAsset
  }
} }];`;
}

// ------------------------------------------------------------------
// 3) Sambungkan ulang
// ------------------------------------------------------------------
const link = (from, fromIndex, to) => {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= fromIndex) connections[from].main.push([]);
  connections[from].main[fromIndex] = [{ node: to, type: 'main', index: 0 }];
};
const appendLink = (from, fromIndex, to) => {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= fromIndex) connections[from].main.push([]);
  connections[from].main[fromIndex].push({ node: to, type: 'main', index: 0 });
};

// Hasil Customer -> (baru) Tunda Jendela Pesan
link('Hasil Customer', 0, 'Tunda Jendela Pesan');
// Tunda -> Cek Jendela -> Superseded?
link('Tunda Jendela Pesan', 0, 'Cek Jendela Pesan');
link('Cek Jendela Pesan', 0, 'Superseded?');
// Superseded? true -> Abaikan Pesan Lama; false -> Ambil Lock
link('Superseded?', 0, 'Abaikan Pesan Lama');
link('Superseded?', 1, 'Ambil Lock');
// Ambil Lock -> Lock Didapat?
link('Ambil Lock', 0, 'Lock Didapat?');
// Lock Didapat? true (tidak dapat) -> Abaikan Tanpa Lock; false -> Gabung Pesan Jendela
link('Lock Didapat?', 0, 'Abaikan Tanpa Lock');
link('Lock Didapat?', 1, 'Gabung Pesan Jendela');
// Gabung Pesan Jendela -> Perlu Klasifikasi? (penerus lama)
link('Gabung Pesan Jendela', 0, 'Perlu Klasifikasi?');
// Hasil Keputusan DB -> Lepas Lock -> Gabungkan Aset Keputusan
link('Hasil Keputusan DB', 0, 'Lepas Lock');
link('Lepas Lock', 0, 'Gabungkan Aset Keputusan');
// Diam Menunggu Owner -> Lepas Lock (Diam)
link('Diam Menunggu Owner', 0, 'Lepas Lock (Diam)');

// ------------------------------------------------------------------
// 4) CATATAN 02: tambahkan dokumentasi debounce/lock
// ------------------------------------------------------------------
const catatan = find('CATATAN 02 - Router WhatsApp');
if (catatan && catatan.parameters.content && !catatan.parameters.content.includes('Debounce')) {
  catatan.parameters.content += `\n\n[Guard Percakapan] Pesan beruntun pelanggan digabung lewat jendela 6 detik (Tunda Jendela Pesan → Cek Jendela Pesan). Hanya satu run AI per chat yang dibolehkan (Ambil Lock → Lepas Lock). Balasan otomatis disimpan ke riwayat sebelum dikirim.`;
}

wf.nodes = JSON.stringify(nodes);
wf.connections = JSON.stringify(connections);

if (outPath) {
  writeFileSync(outPath, JSON.stringify(wf, null, 2));
  console.log('written:', outPath);
} else {
  process.stdout.write(JSON.stringify(wf));
}
console.log('nodes:', nodes.length);
console.log('NEW_IDS:', JSON.stringify(NEW_IDS));