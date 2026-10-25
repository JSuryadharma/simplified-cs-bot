import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'workflows');
fs.mkdirSync(outDir, { recursive: true });

let sequence = 1;
const uuid = () => `00000000-0000-4000-8000-${String(sequence++).padStart(12, '0')}`;
const sections = [];

function node(name, type, typeVersion, position, parameters = {}, extra = {}) {
  return { parameters, id: uuid(), name, type, typeVersion, position, ...extra };
}

function code(name, position, jsCode) {
  return node(name, 'n8n-nodes-base.code', 2, position, { jsCode });
}

function webhook(name, position, method, route, responseMode = 'onReceived', rawBody = false) {
  return node(
    name,
    'n8n-nodes-base.webhook',
    2.1,
    position,
    {
      httpMethod: method,
      path: route,
      responseMode,
      options: rawBody ? { rawBody: true } : {},
    },
    { webhookId: uuid() },
  );
}

function formTrigger(name, position, route, fields) {
  return node(
    name,
    'n8n-nodes-base.formTrigger',
    2.6,
    position,
    {
      authentication: 'n8nUserAuth',
      formTitle: 'Upload Knowledge WhatsApp Savior',
      formDescription: 'Upload ekspor chat WhatsApp (.txt) atau aset gambar referensi (.jpg, .png, .webp). Hanya pengguna n8n yang sudah login yang dapat membuka form ini.',
      formFields: { values: fields },
      responseMode: 'lastNode',
      options: {
        path: route,
        buttonLabel: 'Upload dan proses',
        appendAttribution: false,
        useWorkflowTimezone: true,
      },
    },
    { webhookId: uuid() },
  );
}

function http(name, position, method, url, jsonBody = null, headers = [], options = {}, extra = {}) {
  const parameters = { method, url };
  if (headers.length) {
    parameters.sendHeaders = true;
    parameters.headerParameters = { parameters: headers };
  }
  if (jsonBody !== null) {
    parameters.sendBody = true;
    parameters.contentType = 'json';
    parameters.specifyBody = 'json';
    parameters.jsonBody = jsonBody;
  }
  parameters.options = options;
  return node(name, 'n8n-nodes-base.httpRequest', 4.4, position, parameters, extra);
}

function readWriteFile(name, position, operation, parameters = {}) {
  return node(name, 'n8n-nodes-base.readWriteFile', 1.1, position, {
    operation,
    ...parameters,
  });
}

function ifString(name, position, leftValue, rightValue) {
  return node(name, 'n8n-nodes-base.if', 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: uuid(),
        leftValue,
        rightValue,
        operator: { type: 'string', operation: 'equals' },
      }],
      combinator: 'and',
    },
    options: {},
  });
}

function ifNumberGreater(name, position, leftValue, rightValue) {
  return node(name, 'n8n-nodes-base.if', 2.2, position, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{
        id: uuid(),
        leftValue,
        rightValue,
        operator: { type: 'number', operation: 'gt' },
      }],
      combinator: 'and',
    },
    options: {},
  });
}

function respond(name, position, respondWith, responseBody, responseCode = 200) {
  return node(name, 'n8n-nodes-base.respondToWebhook', 1.4, position, {
    respondWith,
    responseBody,
    options: { responseCode },
  });
}

function noOp(name, position) {
  return node(name, 'n8n-nodes-base.noOp', 1, position, {});
}

function manual(name, position) {
  return node(name, 'n8n-nodes-base.manualTrigger', 1, position, {});
}

function stickyNote(name, position, content, width = 440, height = 520, color = 5) {
  return node(name, 'n8n-nodes-base.stickyNote', 1, position, {
    content,
    width,
    height,
    color,
  });
}

function workflow(name, id, nodes, buildConnections, versionId = uuid()) {
  const connections = {};
  const connect = (from, to, output = 0, input = 0, type = 'main') => {
    connections[from] ??= {};
    connections[from][type] ??= [];
    while (connections[from][type].length <= output) connections[from][type].push([]);
    connections[from][type][output].push({ node: to, type, index: input });
  };
  buildConnections(connect);
  return {
    id,
    name,
    nodes,
    pinData: {},
    connections,
    active: false,
    settings: {
      executionOrder: 'v1',
      timezone: 'Asia/Jakarta',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'none',
      saveManualExecutions: true,
    },
    versionId,
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

const normalizeRpcCode = `const raw = $input.first().json;
const value = Array.isArray(raw) ? (raw[0] ?? {}) : raw;
return [{ json: value?.result && Object.keys(value).length === 1 ? value.result : value }];`;

const lmHeaders = [
  { name: 'Authorization', value: '=Bearer {{$env.LM_STUDIO_API_TOKEN}}' },
];

const waCredential = {
  whatsAppApi: {
    id: 'GWHOrCyNFPuKQ7zL',
    name: 'WhatsApp account',
  },
};

const waPhoneNumberId = '1233522196505651';

const decisionModelCredential = {
  openAiApi: { id: 'RCJcJ2eZuxKoZF1D', name: 'OpenAI account' },
};

function lmChatModel(name, position) {
  return node(
    name,
    '@n8n/n8n-nodes-langchain.lmChatOpenAi',
    1.2,
    position,
    {
      model: { __rl: true, mode: 'id', value: '={{$env.LM_STUDIO_CHAT_MODEL}}' },
      options: {
        baseURL: '={{$env.LM_STUDIO_BASE_URL}}',
        temperature: 0.25,
      },
    },
    { credentials: decisionModelCredential, id: 'a1b2c3d4-e5f6-4789-a0b1-c2d3e4f5a6b7' },
  );
}

function aiAgent(name, position, systemMessageExpression, textExpression) {
  return node(name, '@n8n/n8n-nodes-langchain.agent', 3.1, position, {
    promptType: 'define',
    text: `={{${textExpression}}}`,
    hasOutputParser: false,
    options: { systemMessage: `={{${systemMessageExpression}}}` },
  }, { id: 'b2c3d4e5-f6a7-4890-b1c2-d3e4f5a6b7c8' });
}

function waSend(name, position, toExpression, textExpression) {
  return node(
    name,
    'n8n-nodes-base.whatsApp',
    1.1,
    position,
    {
      resource: 'message',
      operation: 'send',
      phoneNumberId: waPhoneNumberId,
      recipientPhoneNumber: `={{${toExpression}}}`,
      messageType: 'text',
      textBody: `={{${textExpression}}}`,
      additionalFields: {},
    },
    { credentials: waCredential },
  );
}

function waSendImage(name, position, toExpression, captionExpression) {
  return node(
    name,
    'n8n-nodes-base.whatsApp',
    1.1,
    position,
    {
      resource: 'message',
      operation: 'send',
      phoneNumberId: waPhoneNumberId,
      recipientPhoneNumber: `={{${toExpression}}}`,
      messageType: 'image',
      mediaPath: 'useMedian8n',
      mediaPropertyName: 'data',
      additionalFields: {
        mediaCaption: `={{${captionExpression}}}`,
      },
    },
    { credentials: waCredential },
  );
}

// 00 — membuat collection Qdrant dengan dimensi yang dibaca langsung dari model embedding.
{
  const nodes = [
    manual('Jalankan Setup', [0, 0]),
    http(
      'Cek Collection',
      [220, 0],
      'GET',
      '={{$env.QDRANT_URL + "/collections/" + $env.QDRANT_COLLECTION}}',
      null,
      [],
      { response: { response: { neverError: true, responseFormat: 'json', fullResponse: true } } },
    ),
    ifString('Sudah Ada?', [440, 0], '={{String($json.statusCode)}}', '200'),
    code('Collection Sudah Siap', [680, -100], `return [{ json: { ready: true, created: false, collection: $env.QDRANT_COLLECTION, message: 'Collection Qdrant sudah tersedia.' } }];`),
    http(
      'Tes Embedding',
      [680, 100],
      'POST',
      '={{$env.LM_STUDIO_BASE_URL + "/embeddings"}}',
      `={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: ['inisialisasi basis pengetahuan WhatsApp'] }) }}`,
      lmHeaders,
    ),
    code('Baca Dimensi', [900, 100], `const vector = $json.data?.[0]?.embedding;
if (!Array.isArray(vector) || vector.length === 0) {
  throw new Error('LM Studio tidak mengembalikan embedding. Pastikan server aktif dan model embedding sudah dimuat.');
}
return [{ json: { dimension: vector.length } }];`),
    http(
      'Buat Collection',
      [1120, 100],
      'PUT',
      '={{$env.QDRANT_URL + "/collections/" + $env.QDRANT_COLLECTION}}',
      `={{ JSON.stringify({ vectors: { size: $json.dimension, distance: 'Cosine' } }) }}`,
      [],
      { response: { response: { neverError: false, responseFormat: 'json' } } },
    ),
  ];
  const wf = workflow('WA Admin 00 - Inisialisasi Qdrant', 'HDbUNeUhlOyK3CGI', nodes, (c) => {
    c('Jalankan Setup', 'Cek Collection');
    c('Cek Collection', 'Sudah Ada?');
    c('Sudah Ada?', 'Collection Sudah Siap', 0);
    c('Sudah Ada?', 'Tes Embedding', 1);
    c('Tes Embedding', 'Baca Dimensi');
    c('Baca Dimensi', 'Buat Collection');
  });
  sections.push({
    workflow: wf,
    offsetY: -1600,
    note: stickyNote(
      'CATATAN 00 - Setup Qdrant',
      [-560, -1780],
      `## 00 — Inisialisasi Qdrant

**Kapan dijalankan:** manual, satu kali saat instalasi atau setelah mengganti model embedding.

**Cara kerja:**
1. Memeriksa apakah collection Qdrant sudah ada.
2. Jika ada, alur selesai tanpa mengubah data.
3. Jika belum ada, meminta satu embedding ke LM Studio.
4. Panjang vector dari model dipakai sebagai dimensi collection.
5. Collection dibuat dengan distance **Cosine**.

**Hasil:** collection siap dipakai oleh alur RAG. Bagian ini tidak berjalan otomatis saat pesan WhatsApp masuk.`,
      440,
      520,
      4,
    ),
  });
}

// 01 — endpoint GET yang dipakai Meta saat memverifikasi callback URL.
{
  const nodes = [
    webhook('Verifikasi Webhook', [0, 0], 'GET', 'whatsapp', 'responseNode'),
    code('Validasi Token', [240, 0], `const query = $json.query || {};
const mode = String(query['hub.mode'] || '');
const token = String(query['hub.verify_token'] || '');
const challenge = String(query['hub.challenge'] || '');
const valid = mode === 'subscribe' && token === String($env.WHATSAPP_VERIFY_TOKEN || '');
return [{ json: valid
  ? { statusCode: 200, body: challenge }
  : { statusCode: 403, body: 'Token verifikasi tidak valid' }
}];`),
    respond('Jawab Verifikasi', [480, 0], 'text', '={{$json.body}}', '={{$json.statusCode}}'),
  ];
  const wf = workflow('WA Admin 01 - Verifikasi Webhook Meta', 'ocD7e6nuJ0YQ8nRQ', nodes, (c) => {
    c('Verifikasi Webhook', 'Validasi Token');
    c('Validasi Token', 'Jawab Verifikasi');
  });
  sections.push({
    workflow: wf,
    offsetY: -900,
    note: stickyNote(
      'CATATAN 01 - Verifikasi Meta',
      [-560, -1050],
      `## 01 — Verifikasi Webhook Meta

**Trigger:** \`GET /webhook/whatsapp\`

Meta mengirim \`hub.mode\`, \`hub.verify_token\`, dan \`hub.challenge\`.

- Token dibandingkan dengan \`WHATSAPP_VERIFY_TOKEN\`.
- Jika cocok: challenge dikembalikan dengan HTTP 200.
- Jika salah: request ditolak dengan HTTP 403.

Alur ini hanya untuk proses verifikasi callback, bukan untuk menerima pesan pelanggan.`,
      440,
      400,
      5,
    ),
  });
}

// 02 — router utama: pelanggan, RAG, eskalasi, balasan owner, dan ringkasan order.
{
  const normalizeInbound = `const { createHmac, timingSafeEqual } = require('crypto');
const item = $input.first();
const body = item.json.body || {};
const headers = item.json.headers || {};
const appSecret = String($env.WHATSAPP_APP_SECRET || '');

if (appSecret) {
  const actual = String(headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'] || '');
  const rawBase64 = item.binary?.data?.data || '';
  const raw = Buffer.from(rawBase64, 'base64');
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (!actual || a.length !== b.length || !timingSafeEqual(a, b)) {
    return [{ json: { kind: 'invalid_signature' } }];
  }
}

const value = body.entry?.[0]?.changes?.[0]?.value || {};
const messages = Array.isArray(value.messages) ? value.messages : [];
if (!messages.length) return [{ json: { kind: 'ignore', reason: 'status_or_empty_event' } }];

const contacts = value.contacts || [];
const ownerPhone = String($env.OWNER_PHONE || '').replace(/\\D/g, '');
const output = [];
for (const message of messages) {
  const phone = String(message.from || '').replace(/\\D/g, '');
  let text = '';
  if (message.type === 'text') text = message.text?.body || '';
  else if (message.type === 'button') text = message.button?.text || '';
  else if (message.type === 'interactive') {
    text = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
  } else {
    text = '[Pelanggan mengirim pesan tipe ' + String(message.type || 'tidak dikenal') + '. Perlu ditangani owner.]';
  }
  const contact = contacts.find((x) => String(x.wa_id || '').replace(/\\D/g, '') === phone) || contacts[0] || {};
  output.push({ json: {
    kind: 'message',
    message_id: String(message.id || ('generated-' + Date.now())),
    phone,
    name: contact.profile?.name || (phone === ownerPhone ? String($env.OWNER_NAME || 'Owner') : 'Pelanggan'),
    text: String(text).trim(),
    timestamp: new Date(Number(message.timestamp || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    is_owner: phone !== '' && phone === ownerPhone,
    message_type: message.type || 'text'
  } });
}
return output;`;

  const prepareDecision = `const ctx = $('Hasil Customer').first().json;
const search = $input.first().json || {};
const points = search.result?.points || search.points || search.result || [];
const knowledge = (Array.isArray(points) ? points : []).map((p) => ({
  score: p.score,
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
}));

const system = ` + "`" + `Anda adalah admin WhatsApp toko. Selalu gunakan Bahasa Indonesia.

ATURAN KERAS:
1. AUTO_REPLY hanya jika jawaban benar-benar didukung knowledge relevan atau data order pelanggan.
2. Jangan mengarang harga, stok, kebijakan, status order, resi, tanggal, atau janji.
3. Jika knowledge tidak menjawab, meragukan, konflik, atau membutuhkan keputusan owner, pilih ESCALATE.
4. Saat ESCALATE jangan membuat balasan pelanggan. Ringkas kebutuhan dan tulis pertanyaan spesifik untuk owner.
5. Balasan AUTO_REPLY harus meniru profil gaya owner, singkat, natural, dan tidak menyebut AI/vector database.
6. Data order adalah sumber resmi untuk status pesanan pelanggan ini.
7. Jika pelanggan meminta contoh/referensi gambar dan ada image_asset yang sangat relevan, pilih asset_id persis dari knowledge_relevan.
8. Jangan memilih aset yang hanya mirip secara umum. Jika pelanggan meminta gambar tetapi tidak ada image_asset yang relevan, pilih ESCALATE.
9. asset_id harus string kosong jika tidak perlu mengirim gambar.
10. Output wajib mengikuti JSON schema.` + "`" + `;

const payload = {
  profil_gaya_owner: ctx.style_profile,
  nama_pelanggan: ctx.customer_name,
  pesan_pelanggan: ctx.message_text,
  riwayat_terbaru: ctx.recent_messages,
  data_order: ctx.orders,
  knowledge_relevan: knowledge
};

return [{ json: {
  context: ctx,
  knowledge,
  requestBody: {
    model: $env.LM_STUDIO_CHAT_MODEL,
    temperature: 0.25,
    max_tokens: 700,
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
            action: { type: 'string', enum: ['AUTO_REPLY', 'ESCALATE'] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            reply: { type: 'string' },
            needs_summary: { type: 'string' },
            owner_question: { type: 'string' },
            asset_id: { type: 'string' }
          },
          required: ['action', 'confidence', 'reply', 'needs_summary', 'owner_question', 'asset_id']
        }
      }
    }
  }
} }];`;

  const parseDecision = `const ctx = $('Hasil Customer').first().json;
const prep = $('Siapkan Keputusan AI').first().json;
let content = $json.choices?.[0]?.message?.content || $json.choices?.[0]?.message?.reasoning_content || '';
if (typeof content !== 'string') content = JSON.stringify(content);
content = content.trim().replace(/^\x60\x60\x60(?:json)?/i, '').replace(/\x60\x60\x60$/, '').trim();
let parsed;
try { parsed = JSON.parse(content); } catch { parsed = {}; }

const hasKnowledge = Array.isArray(prep.knowledge) && prep.knowledge.length > 0;
const hasOrders = Array.isArray(ctx.orders) && ctx.orders.length > 0;
let action = parsed.action === 'AUTO_REPLY' ? 'AUTO_REPLY' : 'ESCALATE';
let reply = String(parsed.reply || '').trim();
if (action === 'AUTO_REPLY' && (!reply || (!hasKnowledge && !hasOrders))) action = 'ESCALATE';
const requestedAssetId = String(parsed.asset_id || '').trim();
const selectedAsset = prep.knowledge.find((entry) =>
  entry.content_type === 'image_asset' &&
  entry.asset_id &&
  entry.asset_id === requestedAssetId &&
  entry.asset_path &&
  entry.mime_type.startsWith('image/')
) || null;

return [{ json: {
  action,
  confidence: Number(parsed.confidence || 0),
  reply: action === 'AUTO_REPLY' ? reply : '',
  needs_summary: String(parsed.needs_summary || ('Pelanggan menanyakan: ' + ctx.message_text)).trim(),
  owner_question: String(parsed.owner_question || 'Mohon berikan jawaban yang boleh diteruskan ke pelanggan.').trim(),
  customer_id: ctx.customer_id,
  customer_message: ctx.message_text,
  knowledge_used: prep.knowledge,
  selected_asset: action === 'AUTO_REPLY' ? selectedAsset : null
} }];`;

  const prepareOrderSummary = `const data = $input.first().json;
const requestBody = {
  model: $env.LM_STUDIO_CHAT_MODEL,
  temperature: 0.2,
  max_tokens: 700,
  messages: [
    { role: 'system', content: 'Anda admin operasional toko. Buat ringkasan order dalam Bahasa Indonesia yang padat dan mudah dibaca di WhatsApp. Cantumkan jumlah order, total nilai rupiah, status dominan, order yang perlu perhatian, dan nomor order/resi penting. Jangan mengarang data.' },
    { role: 'user', content: JSON.stringify(data) }
  ]
};
return [{ json: { requestBody, orderData: data } }];`;

  const parseOrderSummary = `const content = String($json.choices?.[0]?.message?.content || $json.choices?.[0]?.message?.reasoning_content || '').trim();
return [{ json: { text: content || 'Belum ada data order untuk filter tersebut.' } }];`;

  const nodes = [
    webhook('Webhook Pesan WhatsApp', [0, 300], 'POST', 'whatsapp', 'onReceived', true),
    code('Normalisasi dan Verifikasi', [220, 300], normalizeInbound),
    ifString('Event Pesan?', [460, 300], '={{$json.kind}}', 'message'),
    noOp('Abaikan Event', [680, 500]),
    ifString('Dari Owner?', [680, 200], '={{String($json.is_owner)}}', 'true'),

    http('DB Terima Owner', [920, -180], 'POST', '={{$env.DB_API_URL + "/rpc/receive_owner"}}',
      `={{ JSON.stringify({ p_message_id: $json.message_id, p_phone: $json.phone, p_text: $json.text, p_timestamp: $json.timestamp }) }}`),
    code('Hasil Owner', [1140, -180], normalizeRpcCode),
    ifString('Balasan Tiket?', [1360, -180], '={{$json.action}}', 'forward_customer'),
    waSend('Teruskan Jawaban Owner', [1600, -380], '$json.customer_phone', '$json.owner_answer'),
    http('Selesaikan Tiket', [1840, -380], 'POST', '={{$env.DB_API_URL + "/rpc/complete_owner_reply"}}',
      `={{ JSON.stringify({ p_ticket_id: $('Hasil Owner').first().json.ticket_id, p_provider_message_id: $json.messages?.[0]?.id || null }) }}`),
    code('Hasil Tiket Selesai', [2060, -380], normalizeRpcCode),
    http('Embedding Jawaban Owner', [2280, -380], 'POST', '={{$env.LM_STUDIO_BASE_URL + "/embeddings"}}',
      `={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: ['Pertanyaan: ' + $json.question + '\\nJawaban: ' + $json.answer] }) }}`, lmHeaders),
    code('Point Jawaban Owner', [2500, -380], `const done = $('Hasil Tiket Selesai').first().json;
const vector = $json.data?.[0]?.embedding;
if (!Array.isArray(vector)) throw new Error('Embedding jawaban owner gagal dibuat.');
return [{ json: { points: [{ id: done.ticket_id, vector, payload: { content_type: 'chat_qa', question: done.question, answer: done.answer, text: 'Pertanyaan: ' + done.question + '\\nJawaban: ' + done.answer, source: done.source, ticket_code: done.ticket_code, updated_at: new Date().toISOString() } }] } }];`),
    http('Upsert Knowledge Owner', [2720, -380], 'PUT', '={{$env.QDRANT_URL + "/collections/" + $env.QDRANT_COLLECTION + "/points?wait=true"}}',
      '={{ JSON.stringify($json) }}'),

    ifString('Perintah Pesanan?', [1600, -60], '={{$json.action}}', 'summarize_orders'),
    code('Siapkan Ringkasan Order', [1840, -120], prepareOrderSummary),
    http('LLM Ringkas Order', [2060, -120], 'POST', '={{$env.LM_STUDIO_BASE_URL + "/chat/completions"}}',
      '={{ JSON.stringify($json.requestBody) }}', lmHeaders),
    code('Hasil Ringkasan Order', [2280, -120], parseOrderSummary),
    waSend('Kirim Ringkasan ke Owner', [2500, -120], '$env.OWNER_PHONE', '$json.text'),
    ifString('Tampilkan Bantuan?', [1840, 80], '={{$json.action}}', 'help'),
    waSend('Kirim Bantuan Owner', [2060, 80], '$env.OWNER_PHONE', '$json.text'),
    noOp('Abaikan Duplikat Owner', [2060, 180]),

    http('DB Terima Customer', [920, 420], 'POST', '={{$env.DB_API_URL + "/rpc/receive_customer"}}',
      `={{ JSON.stringify({ p_message_id: $json.message_id, p_phone: $json.phone, p_name: $json.name, p_text: $json.text, p_timestamp: $json.timestamp }) }}`),
    code('Hasil Customer', [1140, 420], normalizeRpcCode),
    ifString('Perlu Klasifikasi?', [1360, 420], '={{$json.action}}', 'classify'),
    noOp('Diam Menunggu Owner', [1600, 620]),
    http('Embedding Pertanyaan', [1600, 360], 'POST', '={{$env.LM_STUDIO_BASE_URL + "/embeddings"}}',
      `={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: [$json.message_text] }) }}`, lmHeaders),
    http('Cari Knowledge Qdrant', [1840, 360], 'POST', '={{$env.QDRANT_URL + "/collections/" + $env.QDRANT_COLLECTION + "/points/query"}}',
      `={{ JSON.stringify({ query: $json.data?.[0]?.embedding, limit: 8, score_threshold: Number($env.QDRANT_SCORE_THRESHOLD || 0.72), with_payload: true }) }}`,
      [], { response: { response: { neverError: true, responseFormat: 'json' } } }),
    code('Siapkan Keputusan AI', [2060, 360], prepareDecision),
    http('LLM Ambil Keputusan', [2280, 360], 'POST', '={{$env.LM_STUDIO_BASE_URL + "/chat/completions"}}',
      '={{ JSON.stringify($json.requestBody) }}', lmHeaders),
    code('Parse Keputusan AI', [2500, 360], parseDecision),
    http('Simpan Keputusan', [2720, 360], 'POST', '={{$env.DB_API_URL + "/rpc/apply_decision"}}',
      `={{ JSON.stringify({
        p_customer_id: $json.customer_id,
        p_action: $json.action,
        p_reply: $json.reply,
        p_summary: $json.needs_summary,
        p_owner_question: $json.owner_question,
        p_confidence: $json.confidence,
        p_source_context: { customer_message: $json.customer_message, knowledge_used: $json.knowledge_used, selected_asset: $json.selected_asset }
      }) }}`),
    code('Hasil Keputusan DB', [2940, 360], normalizeRpcCode),
    code('Gabungkan Aset Keputusan', [3160, 360], `const db = $input.first().json;
const decision = $('Parse Keputusan AI').first().json;
return [{ json: { ...db, selected_asset: decision.selected_asset || null } }];`),
    ifString('Balas Otomatis?', [3380, 360], '={{$json.action}}', 'auto_reply'),
    waSend('Kirim Balasan Otomatis', [3620, 220], '$json.customer_phone', '$json.reply'),
    http('Log Balasan Otomatis', [3860, 120], 'POST', '={{$env.DB_API_URL + "/rpc/log_delivery"}}',
      `={{ JSON.stringify({ p_phone: $('Gabungkan Aset Keputusan').first().json.customer_phone, p_text: $('Gabungkan Aset Keputusan').first().json.reply, p_kind: 'auto_reply', p_ticket_code: null, p_provider_message_id: $json.messages?.[0]?.id || null }) }}`),
    ifString('Ada Aset Gambar?', [3860, 320], `={{String(Boolean($('Gabungkan Aset Keputusan').first().json.selected_asset?.asset_path))}}`, 'true'),
    readWriteFile('Baca Aset Gambar', [4100, 260], 'read', {
      fileSelector: `={{$('Gabungkan Aset Keputusan').first().json.selected_asset.asset_path}}`,
      options: {
        dataPropertyName: 'data',
        fileName: `={{$('Gabungkan Aset Keputusan').first().json.selected_asset.original_file_name || 'referensi-gambar'}}`,
        mimeType: `={{$('Gabungkan Aset Keputusan').first().json.selected_asset.mime_type}}`,
      },
    }),
    waSendImage(
      'Kirim Aset Gambar',
      [4340, 260],
      `$('Gabungkan Aset Keputusan').first().json.customer_phone`,
      `$('Gabungkan Aset Keputusan').first().json.selected_asset.asset_caption || $('Gabungkan Aset Keputusan').first().json.selected_asset.asset_description || ''`,
    ),
    http('Log Aset Gambar', [4580, 260], 'POST', '={{$env.DB_API_URL + "/rpc/log_delivery"}}',
      `={{ JSON.stringify({ p_phone: $('Gabungkan Aset Keputusan').first().json.customer_phone, p_text: '[image] ' + ($('Gabungkan Aset Keputusan').first().json.selected_asset.asset_caption || $('Gabungkan Aset Keputusan').first().json.selected_asset.asset_description || ''), p_kind: 'auto_reply_asset', p_ticket_code: null, p_provider_message_id: $json.messages?.[0]?.id || null }) }}`),
    noOp('Selesai Tanpa Aset', [4100, 420]),
    waSend('Eskalasi ke Owner', [3620, 540], '$env.OWNER_PHONE', '$json.owner_message'),
    http('Log Eskalasi', [3860, 540], 'POST', '={{$env.DB_API_URL + "/rpc/log_delivery"}}',
      `={{ JSON.stringify({ p_phone: $env.OWNER_PHONE, p_text: $('Gabungkan Aset Keputusan').first().json.owner_message, p_kind: 'escalation', p_ticket_code: $('Gabungkan Aset Keputusan').first().json.ticket_code, p_provider_message_id: $json.messages?.[0]?.id || null }) }}`),
  ];

  const wf = workflow('WA Admin 02 - Router Utama WhatsApp', 'Q3uCUsnXOh85Rb0b', nodes, (c) => {
    c('Webhook Pesan WhatsApp', 'Normalisasi dan Verifikasi');
    c('Normalisasi dan Verifikasi', 'Event Pesan?');
    c('Event Pesan?', 'Dari Owner?', 0);
    c('Event Pesan?', 'Abaikan Event', 1);
    c('Dari Owner?', 'DB Terima Owner', 0);
    c('Dari Owner?', 'DB Terima Customer', 1);

    c('DB Terima Owner', 'Hasil Owner');
    c('Hasil Owner', 'Balasan Tiket?');
    c('Balasan Tiket?', 'Teruskan Jawaban Owner', 0);
    c('Teruskan Jawaban Owner', 'Selesaikan Tiket');
    c('Selesaikan Tiket', 'Hasil Tiket Selesai');
    c('Hasil Tiket Selesai', 'Embedding Jawaban Owner');
    c('Embedding Jawaban Owner', 'Point Jawaban Owner');
    c('Point Jawaban Owner', 'Upsert Knowledge Owner');
    c('Balasan Tiket?', 'Perintah Pesanan?', 1);
    c('Perintah Pesanan?', 'Siapkan Ringkasan Order', 0);
    c('Siapkan Ringkasan Order', 'LLM Ringkas Order');
    c('LLM Ringkas Order', 'Hasil Ringkasan Order');
    c('Hasil Ringkasan Order', 'Kirim Ringkasan ke Owner');
    c('Perintah Pesanan?', 'Tampilkan Bantuan?', 1);
    c('Tampilkan Bantuan?', 'Kirim Bantuan Owner', 0);
    c('Tampilkan Bantuan?', 'Abaikan Duplikat Owner', 1);

    c('DB Terima Customer', 'Hasil Customer');
    c('Hasil Customer', 'Perlu Klasifikasi?');
    c('Perlu Klasifikasi?', 'Embedding Pertanyaan', 0);
    c('Perlu Klasifikasi?', 'Diam Menunggu Owner', 1);
    c('Embedding Pertanyaan', 'Cari Knowledge Qdrant');
    c('Cari Knowledge Qdrant', 'Siapkan Keputusan AI');
    c('Siapkan Keputusan AI', 'LLM Ambil Keputusan');
    c('LLM Ambil Keputusan', 'Parse Keputusan AI');
    c('Parse Keputusan AI', 'Simpan Keputusan');
    c('Simpan Keputusan', 'Hasil Keputusan DB');
    c('Hasil Keputusan DB', 'Gabungkan Aset Keputusan');
    c('Gabungkan Aset Keputusan', 'Balas Otomatis?');
    c('Balas Otomatis?', 'Kirim Balasan Otomatis', 0);
    c('Kirim Balasan Otomatis', 'Log Balasan Otomatis');
    c('Kirim Balasan Otomatis', 'Ada Aset Gambar?');
    c('Ada Aset Gambar?', 'Baca Aset Gambar', 0);
    c('Baca Aset Gambar', 'Kirim Aset Gambar');
    c('Kirim Aset Gambar', 'Log Aset Gambar');
    c('Ada Aset Gambar?', 'Selesai Tanpa Aset', 1);
    c('Balas Otomatis?', 'Eskalasi ke Owner', 1);
    c('Eskalasi ke Owner', 'Log Eskalasi');
  });
  sections.push({
    workflow: wf,
    offsetY: 200,
    note: stickyNote(
      'CATATAN 02 - Router WhatsApp',
      [-560, -260],
      `## 02 — Router Utama WhatsApp

**Trigger:** \`POST /webhook/whatsapp\`

**Pesan pelanggan:**
1. Validasi signature Meta jika \`WHATSAPP_APP_SECRET\` diisi.
2. Simpan pesan dan deduplikasi melalui database.
3. Ambil order pelanggan dan profil gaya owner.
4. Cari knowledge relevan di Qdrant.
5. LM Studio memilih **AUTO_REPLY** atau **ESCALATE** secara fail-closed (panggilan HTTP langsung ke \`/chat/completions\` dengan \`response_format: json_schema\`).
   Catatan: percobaan mengganti node ini dengan node native **AI Agent** (LangChain) gagal stabil di n8n 2.37.10 — request macet tanpa error, CPU/koneksi jaringan 0%, baik dengan LM Studio maupun OpenRouter (free & paid). Lihat laporan gap knowledge untuk detail.
6. Jika knowledge/order cukup, kirim jawaban bergaya owner memakai node native **WhatsApp Business Cloud**.
7. Jika pelanggan meminta referensi dan ada \`image_asset\` yang relevan, node native mengunggah binary gambar dan mengirimkannya setelah balasan teks.
8. Jika tidak cukup, kirim ringkasan ke owner dan diam kepada pelanggan.

**Pesan owner:**
- \`#TKT-XXXXXXXX jawaban\`: diteruskan persis ke pelanggan, tiket diselesaikan, lalu Q&A disimpan ke Qdrant.
- \`/pesanan\`: membuat ringkasan order.
- Pesan pelanggan tambahan saat menunggu owner hanya disimpan dan tidak dibalas.

**Koneksi WhatsApp keluar:** enam node pengiriman memakai credential n8n **WhatsApp account** dan sender test Meta \`+1 (555) 648-4067\` (Phone Number ID \`1233522196505651\`). Access token disimpan di credential n8n, bukan di parameter HTTP workflow.`,
      440,
      760,
      3,
    ),
  });
}

// 03 — analisis WhatsApp export: profil gaya owner + pasangan tanya/jawab ke Qdrant.
{
  const parseExport = `const body = $json.body || $json || {};
const raw = String(body.export_text || body.chat_export || '');
const ownerName = String(body.owner_name || $env.OWNER_NAME || 'Owner').trim();
const sourceTrigger = String(body.source_trigger || 'api');
if (!raw.trim()) throw new Error('Field export_text wajib berisi isi file ekspor WhatsApp.');

const entries = [];
const lines = raw.replace(/\\r\\n/g, '\\n').split('\\n');
const linePattern = /^\\[?(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}),?\\s+(\\d{1,2}[.:]\\d{2}(?::\\d{2})?)\\]?\\s*(?:[-–]\\s*)?([^:]+):\\s*(.*)$/;
for (const line of lines) {
  const match = line.match(linePattern);
  if (match) {
    entries.push({ date: match[1], time: match[2], sender: match[3].trim(), text: match[4].trim() });
  } else if (entries.length && line.trim()) {
    entries[entries.length - 1].text += '\\n' + line.trim();
  }
}

if (!entries.length) throw new Error('Format ekspor tidak dikenali. Gunakan file .txt hasil Export chat WhatsApp tanpa media.');
const ownerLower = ownerName.toLowerCase();
const ownerMessages = entries.filter((e) => e.sender.toLowerCase() === ownerLower && e.text).slice(-350);
if (!ownerMessages.length) throw new Error('Nama owner tidak ditemukan di ekspor. Kirim owner_name yang persis sama dengan nama pada log.');

const excerptEntries = entries.slice(-700);
let excerpt = excerptEntries.map((e) => e.sender + ': ' + e.text).join('\\n');
if (excerpt.length > 60000) excerpt = excerpt.slice(-60000);
let ownerSample = ownerMessages.map((e) => e.text).join('\\n---\\n');
if (ownerSample.length > 30000) ownerSample = ownerSample.slice(-30000);

return [{ json: {
  owner_name: ownerName,
  total_entries: entries.length,
  owner_message_count: ownerMessages.length,
  excerpt,
  owner_sample: ownerSample,
  source_trigger: sourceTrigger
} }];`;

  const prepareStyle = `const data = $input.first().json;
const system = ` + "`" + `Anda menganalisis log percakapan WhatsApp toko dalam Bahasa Indonesia.
Tugas:
1. Buat profil gaya chat owner yang operasional: sapaan, panjang kalimat, pilihan kata, emoji, tanda baca, cara menyatakan kepastian/ketidakpastian, dan hal yang harus dihindari.
2. Ekstrak maksimal 100 pasangan pertanyaan pelanggan dan jawaban owner yang benar-benar tampak dalam log.
3. Jangan mengarang FAQ. Abaikan obrolan pribadi, informasi sensitif, nomor rekening, OTP, alamat lengkap, dan pasangan tanpa jawaban jelas.
4. Rapikan pertanyaan agar dapat dicari secara semantik, tetapi pertahankan makna jawaban owner.
5. Output wajib sesuai JSON schema.` + "`" + `;
return [{ json: {
  stats: data,
  requestBody: {
    model: $env.LM_STUDIO_CHAT_MODEL,
    temperature: 0.15,
    max_tokens: 5000,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify({ owner_name: data.owner_name, contoh_pesan_owner: data.owner_sample, percakapan: data.excerpt }) }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'analisis_chat_owner', strict: true,
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            style_profile: { type: 'string' },
            qa_pairs: {
              type: 'array', maxItems: 100,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  question: { type: 'string' },
                  answer: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } }
                },
                required: ['question', 'answer', 'tags']
              }
            }
          },
          required: ['style_profile', 'qa_pairs']
        }
      }
    }
  }
} }];`;

  const parseStyle = `let content = $json.choices?.[0]?.message?.content || $json.choices?.[0]?.message?.reasoning_content || '';
content = String(content).trim().replace(/^\x60\x60\x60(?:json)?/i, '').replace(/\x60\x60\x60$/, '').trim();
let parsed;
try { parsed = JSON.parse(content); } catch { throw new Error('Model tidak menghasilkan JSON analisis chat yang valid.'); }
const pairs = (Array.isArray(parsed.qa_pairs) ? parsed.qa_pairs : [])
  .map((p) => ({ question: String(p.question || '').trim(), answer: String(p.answer || '').trim(), tags: Array.isArray(p.tags) ? p.tags.map(String) : [] }))
  .filter((p) => p.question && p.answer)
  .slice(0, 100);
const stats = $('Siapkan Analisis Style').first().json.stats;
return [{ json: {
  style_profile: String(parsed.style_profile || '').trim(),
  qa_pairs: pairs,
  pair_count: pairs.length,
  source_stats: { total_entries: stats.total_entries, owner_message_count: stats.owner_message_count, owner_name: stats.owner_name, source_trigger: stats.source_trigger }
} }];`;

  const combineImportResult = `const analysis = $('Parse Analisis Style').first().json;
const saved = $input.first().json;
return [{ json: { ...analysis, database: saved } }];`;

  const makePoints = `const { randomUUID } = require('crypto');
const analysis = $('Parse Analisis Style').first().json;
const vectors = $json.data || [];
if (vectors.length !== analysis.qa_pairs.length) throw new Error('Jumlah embedding tidak sama dengan jumlah pasangan knowledge.');
const points = analysis.qa_pairs.map((pair, index) => ({
  id: randomUUID(),
  vector: vectors[index].embedding,
  payload: {
    content_type: 'chat_qa',
    question: pair.question,
    answer: pair.answer,
    text: 'Pertanyaan: ' + pair.question + '\\nJawaban: ' + pair.answer,
    tags: pair.tags,
    source: 'whatsapp_chat_export',
    owner_name: analysis.source_stats.owner_name,
    imported_at: new Date().toISOString()
  }
}));
return [{ json: { points } }];`;

  const nodes = [
    webhook('Webhook Impor Chat', [0, 0], 'POST', 'admin/import-chat', 'responseNode'),
    code('Autorisasi Impor', [220, 0], `const headers = $json.headers || {};
const supplied = String(headers['x-import-key'] || '');
return [{ json: {
  ...$json,
  body: { ...($json.body || {}), source_trigger: 'api' },
  auth_state: supplied && supplied === String($env.IMPORT_API_KEY || '') ? 'authorized' : 'unauthorized'
} }];`),
    ifString('Diizinkan?', [440, 0], '={{$json.auth_state}}', 'authorized'),
    respond('Tolak Impor', [680, 180], 'json', '={{ { error: "unauthorized" } }}', 401),
    code('Parse Ekspor WhatsApp', [680, -80], parseExport),
    code('Siapkan Analisis Style', [900, -80], prepareStyle),
    http('LLM Analisis Chat', [1120, -80], 'POST', '={{$env.LM_STUDIO_BASE_URL + "/chat/completions"}}',
      '={{ JSON.stringify($json.requestBody) }}', lmHeaders),
    code('Parse Analisis Style', [1340, -80], parseStyle),
    http('Simpan Style dan Knowledge', [1560, -80], 'POST', '={{$env.DB_API_URL + "/rpc/save_style_and_knowledge"}}',
      `={{ JSON.stringify({ p_style_profile: $json.style_profile, p_pairs: $json.qa_pairs, p_source_stats: $json.source_stats }) }}`),
    code('Gabungkan Hasil Impor', [1780, -80], combineImportResult),
    ifNumberGreater('Ada Pasangan QA?', [2000, -80], '={{$json.pair_count}}', 0),
    http('Embedding Knowledge Impor', [2220, -160], 'POST', '={{$env.LM_STUDIO_BASE_URL + "/embeddings"}}',
      `={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: $json.qa_pairs.map((p) => 'Pertanyaan: ' + p.question + '\\nJawaban: ' + p.answer) }) }}`, lmHeaders),
    code('Buat Points Impor', [2440, -160], makePoints),
    http('Upsert Knowledge Impor', [2660, -160], 'PUT', '={{$env.QDRANT_URL + "/collections/" + $env.QDRANT_COLLECTION + "/points?wait=true"}}',
      '={{ JSON.stringify($json) }}'),
    ifString('Impor Berasal dari Form?', [2880, -160], `={{$('Parse Analisis Style').first().json.source_stats.source_trigger}}`, 'form_upload'),
    code('Upload Chat Selesai', [3120, -240], `const analysis = $('Parse Analisis Style').first().json;
return [{ json: {
  ok: true,
  upload_type: 'text',
  owner_name: analysis.source_stats.owner_name,
  style_updated: true,
  knowledge_count: analysis.pair_count,
  message: 'Chat WhatsApp berhasil diproses dan knowledge Qdrant diperbarui.'
} }];`),
    respond('Impor Berhasil', [3120, -80], 'json', `={{ ({ ok: true, style_updated: true, knowledge_count: $('Parse Analisis Style').first().json.pair_count, qdrant: $json.status || 'completed' }) }}`, 200),
    ifString('Tanpa QA Berasal dari Form?', [2220, 60], `={{$json.source_stats.source_trigger}}`, 'form_upload'),
    code('Upload Chat Tanpa QA Selesai', [2460, 20], `return [{ json: {
  ok: true,
  upload_type: 'text',
  owner_name: $json.source_stats.owner_name,
  style_updated: true,
  knowledge_count: 0,
  message: 'Profil gaya tersimpan, tetapi tidak ditemukan pasangan tanya-jawab yang cukup jelas.'
} }];`),
    respond('Impor Tanpa QA', [2460, 140], 'json', `={{ ({ ok: true, style_updated: true, knowledge_count: 0, note: 'Profil gaya tersimpan, tetapi tidak ada pasangan tanya-jawab yang cukup jelas.' }) }}`, 200),
  ];
  const wf = workflow('WA Admin 03 - Impor Chat dan Style Owner', 'RrB96aJmTndgiwP8', nodes, (c) => {
    c('Webhook Impor Chat', 'Autorisasi Impor');
    c('Autorisasi Impor', 'Diizinkan?');
    c('Diizinkan?', 'Parse Ekspor WhatsApp', 0);
    c('Diizinkan?', 'Tolak Impor', 1);
    c('Parse Ekspor WhatsApp', 'Siapkan Analisis Style');
    c('Siapkan Analisis Style', 'LLM Analisis Chat');
    c('LLM Analisis Chat', 'Parse Analisis Style');
    c('Parse Analisis Style', 'Simpan Style dan Knowledge');
    c('Simpan Style dan Knowledge', 'Gabungkan Hasil Impor');
    c('Gabungkan Hasil Impor', 'Ada Pasangan QA?');
    c('Ada Pasangan QA?', 'Embedding Knowledge Impor', 0);
    c('Embedding Knowledge Impor', 'Buat Points Impor');
    c('Buat Points Impor', 'Upsert Knowledge Impor');
    c('Upsert Knowledge Impor', 'Impor Berasal dari Form?');
    c('Impor Berasal dari Form?', 'Upload Chat Selesai', 0);
    c('Impor Berasal dari Form?', 'Impor Berhasil', 1);
    c('Ada Pasangan QA?', 'Tanpa QA Berasal dari Form?', 1);
    c('Tanpa QA Berasal dari Form?', 'Upload Chat Tanpa QA Selesai', 0);
    c('Tanpa QA Berasal dari Form?', 'Impor Tanpa QA', 1);
  });
  sections.push({
    workflow: wf,
    offsetY: 1700,
    note: stickyNote(
      'CATATAN 03 - Impor Chat',
      [-560, 1450],
      `## 03 — Impor Chat & Gaya Owner

**Trigger:** \`POST /webhook/admin/import-chat\`

**Keamanan:** header \`x-import-key\` wajib sama dengan \`IMPORT_API_KEY\`.
Alur yang sama juga dipakai oleh form upload text pada bagian 05.

**Cara kerja:**
1. Parse file teks hasil **Export chat WhatsApp tanpa media**.
2. Pisahkan pesan owner dan pelanggan.
3. LM Studio menyusun profil gaya serta pasangan pertanyaan/jawaban yang jelas.
4. Profil gaya dan metadata disimpan ke PostgreSQL.
5. Pasangan Q&A dibuatkan embedding dan di-upsert ke Qdrant.

**Hasil:** balasan otomatis berikutnya dapat meniru gaya owner dan memakai FAQ dari histori chat.`,
      440,
      600,
      6,
    ),
  });
}

// 04 — endpoint internal untuk sinkronisasi order dari toko/e-commerce.
{
  const nodes = [
    webhook('Webhook Upsert Order', [0, 0], 'POST', 'admin/orders/upsert', 'responseNode'),
    code('Autorisasi Order', [220, 0], `const headers = $json.headers || {};
const supplied = String(headers['x-import-key'] || '');
const body = $json.body || {};
const authorized = supplied && supplied === String($env.IMPORT_API_KEY || '');
return [{ json: { auth_state: authorized ? 'authorized' : 'unauthorized', body } }];`),
    ifString('Order Diizinkan?', [440, 0], '={{$json.auth_state}}', 'authorized'),
    respond('Tolak Order', [680, 160], 'json', '={{ { error: "unauthorized" } }}', 401),
    http('DB Upsert Order', [680, -80], 'POST', '={{$env.DB_API_URL + "/rpc/upsert_order"}}',
      `={{ JSON.stringify({
        p_order_number: $json.body.order_number,
        p_customer_phone: $json.body.customer_phone,
        p_customer_name: $json.body.customer_name || null,
        p_status: $json.body.status || 'baru',
        p_items: $json.body.items || [],
        p_subtotal: Number($json.body.subtotal || 0),
        p_shipping_cost: Number($json.body.shipping_cost || 0),
        p_shipping_address: $json.body.shipping_address || null,
        p_tracking_number: $json.body.tracking_number || null,
        p_notes: $json.body.notes || null,
        p_ordered_at: $json.body.ordered_at || new Date().toISOString()
      }) }}`),
    code('Hasil Upsert Order', [900, -80], normalizeRpcCode),
    respond('Jawab Upsert Order', [1120, -80], 'json', '={{$json}}', 200),
  ];
  const wf = workflow('WA Admin 04 - API Sinkronisasi Order', 'vijuE6PoFM6NvHeF', nodes, (c) => {
    c('Webhook Upsert Order', 'Autorisasi Order');
    c('Autorisasi Order', 'Order Diizinkan?');
    c('Order Diizinkan?', 'DB Upsert Order', 0);
    c('Order Diizinkan?', 'Tolak Order', 1);
    c('DB Upsert Order', 'Hasil Upsert Order');
    c('Hasil Upsert Order', 'Jawab Upsert Order');
  });
  sections.push({
    workflow: wf,
    offsetY: 2600,
    note: stickyNote(
      'CATATAN 04 - Sinkronisasi Order',
      [-560, 2400],
      `## 04 — Sinkronisasi Order

**Trigger:** \`POST /webhook/admin/orders/upsert\`

**Keamanan:** header \`x-import-key\` wajib sama dengan \`IMPORT_API_KEY\`.

Payload order divalidasi lalu dikirim ke RPC database. Operasinya **idempoten berdasarkan nomor order**: nomor baru dibuat, nomor yang sudah ada diperbarui.

Data ini dipakai router utama untuk menjawab status pesanan dan perintah owner \`/pesanan\`.`,
      440,
      460,
      2,
    ),
  });
}

// 05 — form internal untuk upload chat WhatsApp dan aset gambar referensi.
{
  const validateUpload = `const { randomUUID } = require('crypto');
const item = $input.first();
const body = item.json.body || item.json || {};
const dataType = String(body.data_type || '').trim().toLowerCase();
if (!['text', 'image'].includes(dataType)) {
  throw new Error('Tipe data harus text atau image.');
}

const binaryKeys = Object.keys(item.binary || {});
const sourceKey = item.binary?.file ? 'file' : binaryKeys[0];
const uploaded = sourceKey ? item.binary[sourceKey] : null;
if (!uploaded) throw new Error('File wajib dipilih.');

const originalFileName = String(uploaded.fileName || 'upload').replace(/[\\r\\n]/g, '').slice(0, 180);
const extension = String(uploaded.fileExtension || originalFileName.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const mimeType = String(uploaded.mimeType || '').toLowerCase();
const allowedText = extension === 'txt' && (!mimeType || mimeType.startsWith('text/'));
const allowedImage = ['jpg', 'jpeg', 'png', 'webp'].includes(extension) && ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType);

if (dataType === 'text' && !allowedText) {
  throw new Error('Untuk tipe text, upload file .txt hasil Export chat WhatsApp.');
}
if (dataType === 'image' && !allowedImage) {
  throw new Error('Untuk tipe image, format yang diizinkan hanya JPG, PNG, atau WEBP.');
}

const parseSize = (value) => {
  if (typeof value === 'number') return value;
  const match = String(value || '').trim().match(/^([\\d.]+)\\s*(b|kb|mb|gb)?$/i);
  if (!match) return 0;
  const scale = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Number(match[1]) * (scale[(match[2] || 'b').toLowerCase()] || 1);
};
const fileSizeBytes = parseSize(uploaded.fileSize);
if (fileSizeBytes > 15 * 1024 * 1024) throw new Error('Ukuran file maksimal 15 MB.');

const description = String(body.description || '').trim();
if (dataType === 'image' && description.length < 8) {
  throw new Error('Deskripsi penggunaan gambar wajib diisi minimal 8 karakter agar aset dapat dicari secara semantik.');
}

const tags = [...new Set(String(body.tags || '').split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
const assetId = randomUUID();
const storedExtension = extension === 'jpeg' ? 'jpg' : extension;

return [{
  json: {
    upload_type: dataType,
    owner_name: String(body.owner_name || 'Savior').trim() || 'Savior',
    description,
    tags,
    original_file_name: originalFileName,
    file_extension: storedExtension,
    mime_type: mimeType || (dataType === 'text' ? 'text/plain' : 'application/octet-stream'),
    file_size: uploaded.fileSize || null,
    asset_id: assetId,
    asset_path: '/home/node/.n8n/assets/' + assetId + '.' + storedExtension,
    submitted_at: body.submittedAt || new Date().toISOString(),
    source_trigger: String(body.source_trigger || 'form_upload')
  },
  binary: { file: uploaded }
}];`;

  const prepareTextUpload = `return [{ json: {
  export_text: String($json.export_text || ''),
  owner_name: String($json.owner_name || 'Savior').trim() || 'Savior',
  source_trigger: String($json.source_trigger || 'form_upload')
} }];`;

  const prepareAssetPoint = `const meta = $('Siapkan Metadata Upload').first().json;
const vector = $json.data?.[0]?.embedding;
if (!Array.isArray(vector) || vector.length === 0) {
  throw new Error('Embedding aset gambar gagal dibuat.');
}
return [{ json: {
  points: [{
    id: meta.asset_id,
    vector,
    payload: {
      content_type: 'image_asset',
      asset_id: meta.asset_id,
      asset_description: meta.description,
      asset_caption: meta.description.slice(0, 900),
      asset_path: meta.asset_path,
      original_file_name: meta.original_file_name,
      mime_type: meta.mime_type,
      file_size: meta.file_size,
      tags: meta.tags,
      text: 'Aset gambar referensi: ' + meta.description + (meta.tags.length ? '\\nTag: ' + meta.tags.join(', ') : ''),
      source: 'admin_upload_form',
      imported_at: new Date().toISOString()
    }
  }]
} }];`;

  const nodes = [
    formTrigger('Form Upload Knowledge', [0, 0], 'admin-upload-knowledge', [
      {
        fieldLabel: 'Tipe data',
        fieldName: 'data_type',
        fieldType: 'radio',
        fieldOptions: { values: [{ option: 'text' }, { option: 'image' }] },
        defaultValue: 'text',
        requiredField: true,
      },
      {
        fieldLabel: 'Nama business owner pada chat',
        fieldName: 'owner_name',
        fieldType: 'text',
        defaultValue: 'Savior',
        placeholder: 'Harus sama dengan nama pengirim di file chat',
      },
      {
        fieldLabel: 'Deskripsi penggunaan aset',
        fieldName: 'description',
        fieldType: 'textarea',
        placeholder: 'Wajib untuk gambar. Contoh: referensi kaos panitia warna tosca dengan sablon depan-belakang',
      },
      {
        fieldLabel: 'Tag',
        fieldName: 'tags',
        fieldType: 'text',
        placeholder: 'Pisahkan dengan koma, contoh: kaos, panitia, tosca',
      },
      {
        fieldLabel: 'File',
        fieldName: 'file',
        fieldType: 'file',
        multipleFiles: false,
        acceptFileTypes: '.txt, .jpg, .jpeg, .png, .webp',
        requiredField: true,
      },
    ]),
    webhook('Webhook API Upload Knowledge', [0, 300], 'POST', 'admin/upload-knowledge', 'responseNode'),
    code('Autorisasi API Upload', [240, 300], `const item = $input.first();
const headers = item.json.headers || {};
const supplied = String(headers['x-import-key'] || '');
return [{
  json: {
    ...item.json,
    body: { ...(item.json.body || {}), source_trigger: 'api_upload' },
    auth_state: supplied && supplied === String($env.IMPORT_API_KEY || '') ? 'authorized' : 'unauthorized'
  },
  binary: item.binary
}];`),
    ifString('API Upload Diizinkan?', [480, 300], '={{$json.auth_state}}', 'authorized'),
    respond('Tolak API Upload', [720, 420], 'json', '={{ { error: "unauthorized" } }}', 401),
    code('Validasi File Upload', [240, 0], validateUpload),
    ifString('Upload Chat Text?', [480, 0], '={{$json.upload_type}}', 'text'),
    node('Baca Isi File Chat', 'n8n-nodes-base.extractFromFile', 1.1, [720, -120], {
      operation: 'text',
      binaryPropertyName: 'file',
      destinationKey: 'export_text',
      options: { encoding: 'utf8', stripBOM: true, keepSource: 'json' },
    }),
    code('Siapkan Upload Chat', [960, -120], prepareTextUpload),
    code('Siapkan Metadata Upload', [720, 140], `const item = $input.first();
const meta = item.json;
return [{
  json: {
    ...meta,
    embedding_text: 'Aset gambar referensi WhatsApp. Deskripsi: ' + meta.description +
      (meta.tags.length ? '\\nTag: ' + meta.tags.join(', ') : '') +
      '\\nNama file: ' + meta.original_file_name
  },
  binary: item.binary
}];`),
    readWriteFile('Simpan Aset ke Volume n8n', [960, 140], 'write', {
      fileName: `={{$json.asset_path}}`,
      dataPropertyName: 'file',
      options: {},
    }),
    http('Embedding Deskripsi Aset', [1200, 140], 'POST', '={{$env.LM_STUDIO_BASE_URL + "/embeddings"}}',
      `={{ JSON.stringify({ model: $env.LM_STUDIO_EMBEDDING_MODEL, input: [$json.embedding_text] }) }}`, lmHeaders),
    code('Buat Point Aset Gambar', [1440, 140], prepareAssetPoint),
    http('Upsert Aset ke Qdrant', [1680, 140], 'PUT', '={{$env.QDRANT_URL + "/collections/" + $env.QDRANT_COLLECTION + "/points?wait=true"}}',
      '={{ JSON.stringify($json) }}'),
    ifString('Upload Gambar dari Form?', [1920, 140], `={{$('Siapkan Metadata Upload').first().json.source_trigger}}`, 'form_upload'),
    code('Upload Gambar Selesai', [2160, 60], `const meta = $('Siapkan Metadata Upload').first().json;
return [{ json: {
  ok: true,
  upload_type: 'image',
  asset_id: meta.asset_id,
  original_file_name: meta.original_file_name,
  description: meta.description,
  tags: meta.tags,
  stored_in: 'n8n_volume_and_qdrant',
  message: 'Aset gambar berhasil disimpan dan dapat dipilih oleh bot saat relevan.'
} }];`),
    respond('API Upload Gambar Berhasil', [2160, 220], 'json', `={{ ({
      ok: true,
      upload_type: 'image',
      asset_id: $('Siapkan Metadata Upload').first().json.asset_id,
      original_file_name: $('Siapkan Metadata Upload').first().json.original_file_name,
      description: $('Siapkan Metadata Upload').first().json.description,
      tags: $('Siapkan Metadata Upload').first().json.tags,
      stored_in: 'n8n_volume_and_qdrant'
    }) }}`, 200),
  ];

  const wf = workflow('WA Admin 05 - Upload Knowledge dan Aset', 'Up10adKnow1edge26', nodes, (c) => {
    c('Form Upload Knowledge', 'Validasi File Upload');
    c('Webhook API Upload Knowledge', 'Autorisasi API Upload');
    c('Autorisasi API Upload', 'API Upload Diizinkan?');
    c('API Upload Diizinkan?', 'Validasi File Upload', 0);
    c('API Upload Diizinkan?', 'Tolak API Upload', 1);
    c('Validasi File Upload', 'Upload Chat Text?');
    c('Upload Chat Text?', 'Baca Isi File Chat', 0);
    c('Baca Isi File Chat', 'Siapkan Upload Chat');
    c('Siapkan Upload Chat', 'Parse Ekspor WhatsApp');
    c('Upload Chat Text?', 'Siapkan Metadata Upload', 1);
    c('Siapkan Metadata Upload', 'Simpan Aset ke Volume n8n');
    c('Simpan Aset ke Volume n8n', 'Embedding Deskripsi Aset');
    c('Embedding Deskripsi Aset', 'Buat Point Aset Gambar');
    c('Buat Point Aset Gambar', 'Upsert Aset ke Qdrant');
    c('Upsert Aset ke Qdrant', 'Upload Gambar dari Form?');
    c('Upload Gambar dari Form?', 'Upload Gambar Selesai', 0);
    c('Upload Gambar dari Form?', 'API Upload Gambar Berhasil', 1);
  });
  sections.push({
    workflow: wf,
    offsetY: 3500,
    note: stickyNote(
      'CATATAN 05 - Upload Knowledge dan Aset',
      [-560, 3300],
      `## 05 — Upload Knowledge & Aset Gambar

**Form produksi:** \`/form/admin-upload-knowledge\`
**API multipart:** \`POST /webhook/admin/upload-knowledge\`

**Keamanan:** form memerlukan login n8n; API memerlukan header \`x-import-key\`.

**Tipe text (.txt):**
1. Membaca Export chat WhatsApp.
2. Nama owner default **Savior** dan dapat diedit agar sama persis dengan log.
3. Menggunakan alur 03 untuk membuat profil gaya serta Q&A di Qdrant.
4. File mentah tidak disimpan setelah selesai diproses.

**Tipe image (JPG/PNG/WEBP):**
1. Deskripsi dan tag divalidasi.
2. File asli disimpan persisten di volume \`n8n_data/assets\`.
3. Embedding deskripsi dan metadata/path file disimpan sebagai \`image_asset\` di Qdrant.
4. Router dapat memilih aset relevan, meng-upload-nya ke WhatsApp, lalu mengirimkannya ke pelanggan.

Ukuran file maksimal **15 MB**. Deskripsi gambar harus spesifik agar pencarian aset akurat.`,
      500,
      720,
      1,
    ),
  });
}

const combinedNodes = [
  stickyNote(
    'CATATAN UTAMA - Peta Workflow',
    [0, -2200],
    `# WA Admin — Workflow Lengkap

Satu workflow ini berisi enam alur yang dibedakan oleh trigger masing-masing. Semuanya berbagi database, Qdrant, LM Studio, environment, dan volume aset yang sama.

Urutan membaca canvas: **00 Setup → 01 Verifikasi Meta → 02 Router Utama → 03 Impor Chat → 04 Sinkronisasi Order → 05 Upload Knowledge/Aset**.`,
    1600,
    320,
    7,
  ),
];
const combinedConnections = {};

for (const section of sections) {
  combinedNodes.push(section.note);
  for (const current of section.workflow.nodes) {
    combinedNodes.push({
      ...current,
      position: [current.position[0], current.position[1] + section.offsetY],
    });
  }
  Object.assign(combinedConnections, section.workflow.connections);
}

const combinedWorkflow = {
  id: 'WaAdm1nLengkap26',
  name: 'WA Admin - Sistem Lengkap',
  nodes: combinedNodes,
  pinData: {},
  connections: combinedConnections,
  active: false,
  settings: {
    executionOrder: 'v1',
    timezone: 'Asia/Jakarta',
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'none',
    saveManualExecutions: true,
  },
  versionId: uuid(),
  meta: { templateCredsSetupCompleted: true },
  tags: [],
};

const legacyFiles = [
  '00-inisialisasi-qdrant.json',
  '01-verifikasi-webhook-meta.json',
  '02-router-utama-whatsapp.json',
  '03-impor-chat-style-owner.json',
  '04-api-sinkronisasi-order.json',
];
for (const file of legacyFiles) {
  const target = path.join(outDir, file);
  if (fs.existsSync(target)) fs.unlinkSync(target);
}

const outputFile = path.join(outDir, 'wa-admin-lengkap.json');
fs.writeFileSync(outputFile, JSON.stringify(combinedWorkflow, null, 2));
process.stdout.write(`Generated combined workflow: ${outputFile}\n`);
