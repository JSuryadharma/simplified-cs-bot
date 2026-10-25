// Terapkan perbaikan chatbot ke workflow "WA Admin - Sistem Lengkap" (file JSON hasil export n8n).
//   node scripts/apply-chatbot-fixes.mjs <input.json> <output.json>
//
// 1. Keputusan AI memakai OpenRouter ($env.OPENROUTER_MODEL); jika gagal (mis. 429) -> eskalasi, bukan diam.
// 2. Pencarian knowledge memakai prefix nomic ("search_query: " / "search_document: ") dan
//    menyertakan pesan pelanggan sebelumnya agar "ada contoh gambarnya?" tetap punya konteks.
// 3. Penjaga balasan: buang placeholder seperti "[Lampirkan gambar ...]"; gambar hanya dikirim
//    jika pelanggan memang meminta contoh/gambar.
// 4. Cabang owner dipulihkan: /pesanan, /bantuan, dan #TKT-XXXXXXXX jawaban.
// Skrip idempoten: menjalankan ulang pada workflow yang sudah diperbaiki tidak menggandakan node.
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('pakai: node scripts/apply-chatbot-fixes.mjs <input.json> <output.json>');
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const workflow = Array.isArray(raw) ? raw[0] : raw;
const byName = (name) => workflow.nodes.find((n) => n.name === name);
const must = (name) => { const n = byName(name); if (!n) throw new Error(`node "${name}" tidak ditemukan`); return n; };
const lmHeaders = { parameters: [{ name: 'Authorization', value: '=Bearer {{$env.LM_STUDIO_API_TOKEN}}' }] };

// ---------------------------------------------------------------- 1. OpenRouter
const llm = must('LLM Ambil Keputusan');
llm.parameters.url = '={{($env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1") + "/chat/completions"}}';
llm.parameters.sendHeaders = true;
llm.parameters.headerParameters = { parameters: [{ name: 'Authorization', value: '=Bearer {{$env.OPENROUTER_API_KEY}}' }] };
llm.parameters.jsonBody = '={{ JSON.stringify({ ...$json.requestBody, model: $env.OPENROUTER_MODEL }) }}';
llm.parameters.options = { ...(llm.parameters.options || {}), timeout: 60000 };
Object.assign(llm, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput' });

// ---------------------------------------------------------------- 2. Pencarian knowledge
must('Embedding Pertanyaan').parameters.jsonBody =
  "={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: ['search_query: ' + (($json.recent_messages || []).filter((m) => m.sender === 'customer').slice(-2).map((m) => m.text).join('\\n') || $json.message_text)] }) }}";
must('Embedding Knowledge Impor').parameters.jsonBody =
  "={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: $json.qa_pairs.map((p) => 'search_document: Pertanyaan: ' + p.question + '\\nJawaban: ' + p.answer) }) }}";
must('Embedding Deskripsi Aset').parameters.jsonBody =
  "={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: ['search_document: ' + $json.embedding_text] }) }}";

// ---------------------------------------------------------------- 3. Prompt + penjaga balasan
const prep = must('Siapkan Keputusan AI');
const extraRules = [
  '10. Jika knowledge_relevan menjawab inti pertanyaan, walaupun jawabannya umum (mis. "tergantung jenis produk"), pilih AUTO_REPLY dan sampaikan jawaban itu. Jangan menjanjikan konfirmasi owner pada AUTO_REPLY.',
  '11. Jangan menulis placeholder, asset_id, atau teks seperti [gambar] di reply. Gambar dikirim terpisah oleh sistem.',
  '12. Pilih asset_id hanya jika isi gambar sama dengan yang diminta (jenis produk yang sama). Gambar produk lain dianggap tidak relevan.',
  '13. Output wajib mengikuti JSON schema.',
].join('\n');
if (!prep.parameters.jsCode.includes('Jangan menulis placeholder')) {
  prep.parameters.jsCode = prep.parameters.jsCode.replace('10. Output wajib mengikuti JSON schema.', extraRules);
  if (!prep.parameters.jsCode.includes('Jangan menulis placeholder')) throw new Error('aturan prompt tidak bisa disisipkan');
}

must('Parse Keputusan AI').parameters.jsCode = `const ctx = $('Hasil Customer').first().json;
const prep = $('Siapkan Keputusan AI').first().json;
let content = $json.choices?.[0]?.message?.content || $json.choices?.[0]?.message?.reasoning_content || '';
if (typeof content !== 'string') content = JSON.stringify(content);
content = content.trim().replace(/^\`\`\`(?:json)?/i, '').replace(/\`\`\`$/, '').trim();
let parsed;
try { parsed = JSON.parse(content); } catch { parsed = {}; }
const llmFailed = !content;

const hasKnowledge = Array.isArray(prep.knowledge) && prep.knowledge.length > 0;
const hasOrders = Array.isArray(ctx.orders) && ctx.orders.length > 0;
let action = parsed.action === 'AUTO_REPLY' ? 'AUTO_REPLY' : 'ESCALATE';
// Buang placeholder gambar/asset yang kadang ditulis model, mis. "[Lampirkan gambar ...]"
let reply = String(parsed.reply || '')
  .replace(/\\[[^\\]]*(gambar|foto|image|asset|lampir)[^\\]]*\\]/gi, '')
  .replace(/[ \\t]+\\n/g, '\\n').replace(/\\s{2,}/g, ' ').trim();
if (action === 'AUTO_REPLY' && (!reply || (!hasKnowledge && !hasOrders))) action = 'ESCALATE';

// Gambar hanya dikirim bila pelanggan meminta contoh/gambar pada pesan terakhirnya
const recentCustomerText = (ctx.recent_messages || []).filter((m) => m.sender === 'customer').slice(-2).map((m) => m.text).join(' ') || ctx.message_text;
const askedForImage = /gambar|foto|contoh|katalog|referensi|lihat|desain|model|pic|photo/i.test(recentCustomerText);
const requestedAssetId = String(parsed.asset_id || '').trim();
const selectedAsset = askedForImage ? (prep.knowledge.find((entry) =>
  entry.content_type === 'image_asset' &&
  entry.asset_id &&
  entry.asset_id === requestedAssetId &&
  entry.asset_path &&
  entry.mime_type.startsWith('image/')
) || null) : null;

return [{ json: {
  action,
  confidence: Number(parsed.confidence || 0),
  reply: action === 'AUTO_REPLY' ? reply : '',
  needs_summary: String(parsed.needs_summary || ('Pelanggan menanyakan: ' + ctx.message_text)).trim(),
  owner_question: String(parsed.owner_question || (llmFailed ? 'Model AI tidak merespons (mis. limit OpenRouter). Mohon jawab pelanggan ini.' : 'Mohon berikan jawaban yang boleh diteruskan ke pelanggan.')).trim(),
  customer_id: ctx.customer_id,
  customer_message: ctx.message_text,
  knowledge_used: prep.knowledge,
  selected_asset: action === 'AUTO_REPLY' ? selectedAsset : null
} }];`;

// ---------------------------------------------------------------- 4. Cabang owner
if (!byName('Dari Owner?')) {
  const sendTemplate = must('Kirim Balasan Otomatis');
  const event = must('Event Pesan?');
  const [ex, ey] = event.position;
  const at = (dx, dy) => [ex + dx, ey + dy];
  const ifNode = (name, conditions, pos, extra = {}) => ({
    name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos,
    parameters: {
      conditions: {
        options: { caseSensitive: extra.caseSensitive ?? true, leftValue: '', typeValidation: extra.typeValidation || 'strict', version: 2 },
        conditions, combinator: extra.combinator || 'and',
      },
      options: {},
    },
  });
  const eq = (left, right) => ({ leftValue: left, rightValue: right, operator: { type: 'string', operation: 'equals' } });
  const starts = (prefix) => ({ leftValue: '={{$json.text}}', rightValue: prefix, operator: { type: 'string', operation: 'startsWith' } });
  const http = (name, method, url, jsonBody, pos, headers) => ({
    name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.4, position: pos,
    parameters: { method, url, ...(headers ? { sendHeaders: true, headerParameters: headers } : {}), sendBody: true, specifyBody: 'json', jsonBody, options: {} },
  });
  const code = (name, jsCode, pos) => ({ name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, parameters: { jsCode } });
  const send = (name, to, text, pos) => ({
    name, type: sendTemplate.type, typeVersion: sendTemplate.typeVersion, position: pos,
    credentials: sendTemplate.credentials,
    parameters: { operation: 'send', phoneNumberId: sendTemplate.parameters.phoneNumberId, recipientPhoneNumber: to, textBody: text, additionalFields: {} },
  });
  const unwrap = "const raw = $input.first().json;\nconst value = Array.isArray(raw) ? (raw[0] ?? {}) : raw;\nreturn [{ json: value?.result && Object.keys(value).length === 1 ? value.result : value }];";

  const nodes = [
    { name: 'CATATAN 02b - Perintah Owner', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: at(-40, 560),
      parameters: { width: 2600, height: 620, color: 4, content: '## 02b — Perintah Owner\nPesan dari OWNER_PHONE yang diawali `/pesanan`, `/bantuan`, atau `#TKT-` diproses di sini.\n- `/pesanan [hari_ini|semua|628xxx]` → ringkasan order ke owner\n- `#TKT-XXXXXXXX jawaban` → jawaban diteruskan persis ke pelanggan, tiket selesai, lalu disimpan sebagai knowledge\n- `/bantuan` → daftar perintah\nPesan owner lainnya diperlakukan seperti pelanggan (berguna untuk uji coba).' } },
    ifNode('Dari Owner?', [eq('={{String($json.is_owner)}}', 'true')], at(224, 700)),
    ifNode('Perintah Owner?', [starts('/pesanan'), starts('/bantuan'), starts('/help'), starts('#TKT-'), starts('TKT-')], at(448, 700), { caseSensitive: false, typeValidation: 'loose', combinator: 'or' }),
    http('DB Terima Owner', 'POST', '={{$env.DB_API_URL + "/rpc/receive_owner"}}', '={{ JSON.stringify({ p_message_id: $json.message_id, p_phone: $json.phone, p_text: $json.text, p_timestamp: $json.timestamp }) }}', at(672, 700)),
    code('Hasil Owner', unwrap, at(896, 700)),
    ifNode('Balasan Tiket?', [eq('={{$json.action}}', 'forward_customer')], at(1120, 700)),
    send('Teruskan Jawaban Owner', '={{$json.customer_phone}}', '={{$json.owner_answer}}', at(1344, 640)),
    http('Selesaikan Tiket', 'POST', '={{$env.DB_API_URL + "/rpc/complete_owner_reply"}}', "={{ JSON.stringify({ p_ticket_id: $('Hasil Owner').first().json.ticket_id, p_provider_message_id: $json.messages?.[0]?.id || null }) }}", at(1568, 640)),
    code('Hasil Tiket Selesai', unwrap, at(1792, 640)),
    http('Embedding Jawaban Owner', 'POST', '={{$env.LM_STUDIO_BASE_URL + "/embeddings"}}', "={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: ['search_document: Pertanyaan: ' + $json.question + '\\nJawaban: ' + $json.answer] }) }}", at(2016, 640), lmHeaders),
    code('Point Jawaban Owner', "const done = $('Hasil Tiket Selesai').first().json;\nconst vector = $json.data?.[0]?.embedding;\nif (!Array.isArray(vector)) throw new Error('Embedding jawaban owner gagal dibuat.');\nreturn [{ json: { points: [{ id: done.ticket_id, vector, payload: { content_type: 'chat_qa', question: done.question, answer: done.answer, text: 'Pertanyaan: ' + done.question + '\\nJawaban: ' + done.answer, source: done.source, ticket_code: done.ticket_code, updated_at: new Date().toISOString() } }] } }];", at(2240, 640)),
    http('Upsert Knowledge Owner', 'PUT', '={{$env.QDRANT_URL + "/collections/" + $env.QDRANT_COLLECTION + "/points?wait=true"}}', '={{ JSON.stringify($json) }}', at(2464, 640)),
    ifNode('Perintah Pesanan?', [eq('={{$json.action}}', 'summarize_orders')], at(1344, 880)),
    code('Siapkan Ringkasan Order', "const data = $input.first().json;\nconst requestBody = {\n  model: $env.OPENROUTER_MODEL,\n  temperature: 0.2,\n  max_tokens: 700,\n  messages: [\n    { role: 'system', content: 'Anda admin operasional toko konveksi. Buat ringkasan order dalam Bahasa Indonesia yang padat dan mudah dibaca di WhatsApp. Cantumkan filter, jumlah order, total nilai rupiah, status dominan, order yang perlu perhatian, serta nomor order/resi penting. Jangan mengarang data. Jangan memakai tabel markdown.' },\n    { role: 'user', content: JSON.stringify(data) }\n  ]\n};\nreturn [{ json: { requestBody, orderData: data } }];", at(1568, 880)),
    { ...http('LLM Ringkas Order', 'POST', '={{($env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1") + "/chat/completions"}}', '={{ JSON.stringify($json.requestBody) }}', at(1792, 880), { parameters: [{ name: 'Authorization', value: '=Bearer {{$env.OPENROUTER_API_KEY}}' }] }),
      retryOnFail: true, maxTries: 2, waitBetweenTries: 5000, onError: 'continueRegularOutput' },
    code('Hasil Ringkasan Order', "const content = String($json.choices?.[0]?.message?.content || '').trim();\nif (content) return [{ json: { text: content } }];\n// Cadangan tanpa AI bila model gagal\nconst d = $('Siapkan Ringkasan Order').first().json.orderData || {};\nconst rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');\nconst lines = (d.orders || []).slice(0, 15).map((o) => '• ' + o.order_number + ' — ' + (o.customer_name || o.customer_phone) + ' — ' + o.status + ' — ' + rp(o.total) + (o.tracking_number ? ' — resi ' + o.tracking_number : ''));\nconst text = 'Ringkasan order (' + (d.filter || '-') + '): ' + Number(d.order_count || 0) + ' order, total ' + rp(d.grand_total) + (lines.length ? '\\n' + lines.join('\\n') : '\\nBelum ada data order untuk filter tersebut.');\nreturn [{ json: { text } }];", at(2016, 880)),
    send('Kirim Ringkasan ke Owner', '={{$env.OWNER_PHONE}}', '={{$json.text}}', at(2240, 880)),
    ifNode('Tampilkan Bantuan?', [eq('={{$json.action}}', 'help')], at(1568, 1060)),
    send('Kirim Bantuan Owner', '={{$env.OWNER_PHONE}}', '={{$json.text}}', at(1792, 1040)),
    { name: 'Abaikan Duplikat Owner', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: at(1792, 1180), parameters: {} },
  ];
  const id = () => globalThis.crypto.randomUUID();
  workflow.nodes.push(...nodes.map((n) => ({ id: id(), ...n })));

  const link = (from, ...outputs) => {
    workflow.connections[from] = { main: outputs.map((targets) => [].concat(targets).map((node) => ({ node, type: 'main', index: 0 }))) };
  };
  link('Event Pesan?', 'Dari Owner?', 'Abaikan Event');
  link('Dari Owner?', 'Perintah Owner?', 'DB Terima Customer');
  link('Perintah Owner?', 'DB Terima Owner', 'DB Terima Customer');
  link('DB Terima Owner', 'Hasil Owner');
  link('Hasil Owner', 'Balasan Tiket?');
  link('Balasan Tiket?', 'Teruskan Jawaban Owner', 'Perintah Pesanan?');
  link('Teruskan Jawaban Owner', 'Selesaikan Tiket');
  link('Selesaikan Tiket', 'Hasil Tiket Selesai');
  link('Hasil Tiket Selesai', 'Embedding Jawaban Owner');
  link('Embedding Jawaban Owner', 'Point Jawaban Owner');
  link('Point Jawaban Owner', 'Upsert Knowledge Owner');
  link('Perintah Pesanan?', 'Siapkan Ringkasan Order', 'Tampilkan Bantuan?');
  link('Siapkan Ringkasan Order', 'LLM Ringkas Order');
  link('LLM Ringkas Order', 'Hasil Ringkasan Order');
  link('Hasil Ringkasan Order', 'Kirim Ringkasan ke Owner');
  link('Tampilkan Bantuan?', 'Kirim Bantuan Owner', 'Abaikan Duplikat Owner');
}

fs.writeFileSync(output, JSON.stringify(Array.isArray(raw) ? [workflow] : workflow, null, 2));
process.stdout.write(`workflow diperbaiki: ${output} (${workflow.nodes.length} node)\n`);
