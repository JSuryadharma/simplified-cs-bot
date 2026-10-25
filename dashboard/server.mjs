import http from 'node:http';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const DB_API_URL = (process.env.DB_API_URL || 'http://host.docker.internal:3001').replace(/\/+$/, '');
const LM_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const LM_TOKEN = process.env.OPENROUTER_API_KEY || '';
const LM_CHAT_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
const OWNER_PHONE = process.env.OWNER_PHONE || '';
const WA_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WA_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WA_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
// Gateway mock hanya dipakai bila diminta (WA_SEND_MODE=mock), supaya dashboard live tidak
// diam-diam "mengirim" ke mock lalu menutup tiket padahal pelanggan tidak menerima apa pun.
const MOCK_WHATSAPP_URL = process.env.WA_SEND_MODE === 'mock' ? (process.env.MOCK_WHATSAPP_URL || '') : '';
// Disarankan: kirim lewat webhook n8n yang memakai credential "WhatsApp account",
// sehingga token Meta hanya tersimpan di n8n.
const N8N_SEND_WEBHOOK_URL = process.env.N8N_SEND_WEBHOOK_URL || '';
const N8N_SEND_SECRET = process.env.N8N_SEND_SECRET || '';
const TZ = process.env.TZ || 'Asia/Jakarta';
// Impor knowledge: gambar disimpan ke storage n8n (bind mount), chat/dataset diproses webhook n8n.
const N8N_IMPORT_WEBHOOK_URL = process.env.N8N_IMPORT_WEBHOOK_URL || '';
const IMPORT_API_KEY = process.env.IMPORT_API_KEY || '';
const QDRANT_URL = (process.env.QDRANT_URL || '').replace(/\/+$/, '');
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || 'wa_knowledge';
const STORAGE_DIR = process.env.STORAGE_DIR || '';
const LM_EMBED_MODEL = process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
const SCORE_THRESHOLD = Number(process.env.QDRANT_SCORE_THRESHOLD || 0.6);
const IMAGE_FILE = /^[\w .()+-]{1,180}\.(jpe?g|png|webp)$/i;

const STATUS_LABELS = {
  waiting_owner: 'Menunggu owner',
  owner_replied: 'Sudah dibalas owner',
  resolved: 'Selesai',
  cancelled: 'Dibatalkan',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > maxBytes) {
        req.destroy();
        reject(new Error('body_too_large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

async function callRpc(name, body) {
  const res = await fetch(`${DB_API_URL}/rpc/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data?.message || data?.error || `${res.status} ${res.statusText}`;
    throw new Error(`RPC ${name}: ${message}`);
  }
  return data;
}

async function summarizeWithLm(question, extra = '') {
  const system =
    'Anda adalah asisten admin toko. Ringkas pertanyaan pelanggan WhatsApp dalam 1-2 kalimat ' +
    'Bahasa Indonesia yang padat, jelas, dan siap dibaca owner. Sebutkan inti kebutuhan, ' +
    'produk/order yang dibahas, dan apa yang diminta pelanggan. Jangan menambahkan ' +
    'informasi yang tidak ada di pertanyaan. Output hanya teks ringkasan, tanpa label.';
  let res;
  try {
    res = await fetch(`${LM_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${LM_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: LM_CHAT_MODEL,
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Pertanyaan pelanggan:\n${question}\n\n${extra}`.trim() },
        ],
      }),
    });
  } catch {
    throw new Error(`OpenRouter tidak dapat dijangkau di ${LM_BASE}. Periksa koneksi internet dan OPENROUTER_API_KEY.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenRouter: ${data?.error?.message || `${res.status} ${res.statusText}`}`);
  }
  const content = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.message?.reasoning_content || '';
  const text = String(content).trim().replace(/^```(?:text|markdown)?/i, '').replace(/```$/, '').trim();
  if (!text) throw new Error('OpenRouter tidak menghasilkan ringkasan.');
  return text;
}

// Nilai contoh di .env (dev-token, demo-...) bukan kredensial Meta sungguhan.
function looksLikePlaceholder(value) {
  return !value || /^(dev|demo|test|ganti|changeme|xxx)/i.test(value);
}

function sendChannel() {
  if (N8N_SEND_WEBHOOK_URL) return 'n8n-webhook';
  if (!looksLikePlaceholder(WA_ACCESS_TOKEN) && !looksLikePlaceholder(WA_PHONE_NUMBER_ID)) return 'whatsapp-cloud-api';
  if (MOCK_WHATSAPP_URL) return 'mock-whatsapp';
  return null;
}

async function postJson(url, headers, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { ok: false, data: {}, error: `tidak dapat menghubungi ${new URL(url).host}: ${err.message}` };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data, error: res.ok ? null : (data?.error?.message || data?.message || `${res.status} ${res.statusText}`) };
}

async function sendWhatsApp(to, text) {
  const channel = sendChannel();
  let result;
  if (channel === 'n8n-webhook') {
    result = await postJson(N8N_SEND_WEBHOOK_URL, N8N_SEND_SECRET ? { 'x-dashboard-secret': N8N_SEND_SECRET } : {}, { to, text });
  } else if (channel === 'whatsapp-cloud-api') {
    result = await postJson(
      `https://graph.facebook.com/${WA_GRAPH_VERSION}/${WA_PHONE_NUMBER_ID}/messages`,
      { authorization: `Bearer ${WA_ACCESS_TOKEN}` },
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } },
    );
  } else if (channel === 'mock-whatsapp') {
    result = await postJson(`${MOCK_WHATSAPP_URL.replace(/\/+$/, '')}/messages`, {}, { to, type: 'text', text: { body: text } });
  } else {
    return {
      sent: false,
      channel: null,
      provider_message_id: null,
      error: 'WhatsApp belum dikonfigurasi: isi N8N_SEND_WEBHOOK_URL, atau WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID.',
    };
  }
  const providerId = result.data?.messages?.[0]?.id || result.data?.provider_message_id || null;
  // Tanpa wamid berarti WhatsApp tidak menerima pesan, walaupun HTTP-nya 200.
  const sent = result.ok && Boolean(providerId);
  return {
    sent,
    channel,
    provider_message_id: providerId,
    error: sent ? null : (result.error || 'WhatsApp tidak mengembalikan ID pesan.'),
  };
}

function dayRange(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function monthRange(monthStr) {
  const start = new Date(`${monthStr}-01T00:00:00`);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

function todayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function thisMonthStr() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function previousDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function summarizeOrders(orders) {
  const rows = [];
  const byType = new Map();
  for (const order of orders) {
    let items = order.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch { items = []; }
    }
    for (const item of Array.isArray(items) ? items : []) {
      const title = String(item?.name || order.order_number || 'Item');
      const pcs = Number(item?.qty || item?.pcs || 1);
      const type = String(item?.type || 'produk');
      const price = Number(item?.price || 0);
      rows.push({
        order_number: order.order_number,
        status: order.status,
        title,
        pcs,
        type,
        price,
        line_total: price * pcs,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone,
      });
      byType.set(type, (byType.get(type) || 0) + pcs);
    }
  }
  const totalOrders = orders.length;
  const totalValue = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
  const totalPcs = rows.reduce((sum, r) => sum + r.pcs, 0);
  return {
    total_orders: totalOrders,
    total_value: totalValue,
    total_pcs: totalPcs,
    rows,
    by_type: Array.from(byType, ([type, pcs]) => ({ type, pcs })).sort((a, b) => b.pcs - a.pcs),
  };
}

/* ---------- Knowledge (impor + ringkasan) ---------- */
async function listStorageFiles() {
  if (!STORAGE_DIR) return null;
  try { return (await readdir(STORAGE_DIR)).filter((f) => IMAGE_FILE.test(f)); } catch { return null; }
}

async function knowledgeSummary() {
  if (!QDRANT_URL) throw new Error('QDRANT_URL belum diatur untuk dashboard.');
  const points = [];
  let offset = null;
  do {
    const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/scroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: 256, offset, with_payload: true, with_vector: false }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Qdrant: ${data?.status?.error || res.status}`);
    points.push(...(data.result?.points || []));
    offset = data.result?.next_page_offset ?? null;
  } while (offset !== null && points.length < 5000);
  const byType = {};
  const byCategory = {};
  const items = [];
  const assets = [];
  for (const p of points) {
    const pl = p.payload || {};
    const type = pl.content_type || 'chat_qa';
    byType[type] = (byType[type] || 0) + 1;
    if (pl.category) byCategory[pl.category] = (byCategory[pl.category] || 0) + 1;
    if (type === 'image_asset') {
      assets.push({ asset_id: pl.asset_id, file: pl.original_file_name, kind: pl.asset_kind || '', caption: pl.asset_caption || pl.asset_description || '', products: pl.produk || '' });
    } else {
      items.push({ id: pl.kb_id || p.id, type, category: pl.category || '', question: pl.question || '', answer: pl.answer || pl.text || '', auto_reply: pl.auto_reply !== false && type !== 'price_reference', valid_from: pl.valid_from || '', source: pl.source || '' });
    }
  }
  items.sort((a, b) => (a.category + a.question).localeCompare(b.category + b.question));
  assets.sort((a, b) => (a.kind + a.asset_id).localeCompare(b.kind + b.asset_id));
  const files = await listStorageFiles();
  return { collection: QDRANT_COLLECTION, total: points.length, by_type: byType, by_category: byCategory, items, assets, storage_images: files ? files.length : null };
}

// Panggil webhook n8n tanpa batas waktu fetch bawaan (pelabelan chat bisa memakan beberapa menit)
function postLong(urlStr, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': payload.length, ...headers }, timeout: timeoutMs }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw: raw.slice(0, 500) }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ status: 0, data: { error: `n8n tidak dapat dihubungi: ${err.message}` } }));
    req.end(payload);
  });
}

async function importKnowledge(body) {
  if (!N8N_IMPORT_WEBHOOK_URL || !IMPORT_API_KEY) throw new Error('N8N_IMPORT_WEBHOOK_URL / IMPORT_API_KEY belum diatur untuk dashboard.');
  const mode = body.mode === 'replace' ? 'replace' : 'append';
  const dryRun = body.dry_run === true;
  if (mode === 'replace' && !dryRun && String(body.confirm || '').trim().toUpperCase() !== 'HAPUS') {
    return { status: 400, data: { ok: false, error: 'Ketik HAPUS untuk mengonfirmasi penggantian semua knowledge.' } };
  }
  const chats = (Array.isArray(body.chats) ? body.chats : [])
    .map((c) => ({ file_name: basename(String(c.file_name || 'chat.txt')), text: String(c.text || '') }))
    .filter((c) => c.text.trim());
  let dataset = body.dataset && typeof body.dataset === 'object' ? body.dataset : null;
  if (dataset && !Array.isArray(dataset.items) && !Array.isArray(dataset.image_assets)) dataset = null;

  // Simpan gambar dengan nama yang sama seperti di chat. Nama yang sudah ada tidak ditimpa.
  const saved = [];
  const kept = [];
  const rejected = [];
  for (const img of Array.isArray(body.images) ? body.images : []) {
    const name = basename(String(img.file_name || ''));
    if (!IMAGE_FILE.test(name) || !STORAGE_DIR) { rejected.push(name || '(tanpa nama)'); continue; }
    const buf = Buffer.from(String(img.data_base64 || '').replace(/^data:[^,]+,/, ''), 'base64');
    if (!buf.length || buf.length > 15 * 1024 * 1024) { rejected.push(name); continue; }
    const target = join(STORAGE_DIR, name);
    try { await stat(target); kept.push(name); continue; } catch {}
    // Pratinjau tidak menulis apa pun; gambar baru dihitung tersedia agar asetnya ikut dipratinjau
    if (!dryRun) await writeFile(target, buf);
    saved.push(name);
  }
  if (!chats.length && !dataset) {
    return { status: 400, data: { ok: false, error: 'Pilih minimal satu file chat (.txt) atau dataset (.json).', images: { saved, kept, rejected } } };
  }
  const stored = await listStorageFiles();
  const availableFiles = stored ? [...new Set([...stored, ...saved])] : null;
  const result = await postLong(N8N_IMPORT_WEBHOOK_URL, { 'x-import-key': IMPORT_API_KEY }, {
    mode, dry_run: dryRun, owner_name: String(body.owner_name || '').trim(), chats, dataset, available_files: availableFiles,
  }, 30 * 60 * 1000);
  return { status: result.status >= 200 && result.status < 300 ? 200 : (result.status || 502), data: { ...result.data, images: { saved, kept, rejected } } };
}

// Cari knowledge seperti bot: embedding pertanyaan lalu query Qdrant. Hasil di bawah ambang
// skor juga ditampilkan (ditandai) supaya terlihat kenapa bot tidak memakainya.
async function searchKnowledge(q, limit) {
  if (!QDRANT_URL) throw new Error('QDRANT_URL belum diatur untuk dashboard.');
  const text = String(q || '').trim();
  if (!text) throw new Error('Isi pertanyaan yang mau dicek.');
  let emb;
  try {
    const res = await fetch(`${LM_BASE}/embeddings`, {
      method: 'POST', headers: { authorization: `Bearer ${LM_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: LM_EMBED_MODEL, input: [text] }), signal: AbortSignal.timeout(30_000),
    });
    emb = await res.json();
    if (!res.ok) throw new Error(emb?.error?.message || res.status);
  } catch (err) {
    throw new Error(`Embedding OpenRouter gagal (${LM_BASE}): ${err.message}`);
  }
  const res = await fetch(`${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/query`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: emb.data?.[0]?.embedding, limit: Math.min(Number(limit) || 10, 30), with_payload: true }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Qdrant: ${data?.status?.error || res.status}`);
  return {
    query: text, threshold: SCORE_THRESHOLD, collection: QDRANT_COLLECTION,
    results: (data.result?.points || []).map((p) => {
      const pl = p.payload || {};
      return { score: p.score, used: p.score >= SCORE_THRESHOLD, type: pl.content_type || 'chat_qa', category: pl.category || '', kb_id: pl.kb_id || pl.asset_id || String(p.id),
        question: pl.question || '', answer: pl.answer || '', auto_reply: pl.auto_reply !== false && pl.content_type !== 'price_reference',
        asset_id: pl.asset_id || '', file: pl.original_file_name || '', asset_kind: pl.asset_kind || '', caption: pl.asset_caption || pl.asset_description || '' };
    }),
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await readFile(join(__dirname, 'public', 'index.html'));
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': html.length,
      });
      return res.end(html);
    }

    if (req.method === 'GET' && path === '/api/health') {
      return json(res, 200, {
        status: 'ok',
        service: 'wa-dashboard',
        time: new Date().toISOString(),
        timezone: TZ,
        wa_channel: sendChannel(),
        wa_configured: sendChannel() !== null,
      });
    }

    if (req.method === 'GET' && path === '/api/tickets') {
      const tickets = await callRpc('dashboard_tickets', {});
      return json(res, 200, { count: tickets.length, tickets });
    }

    if (req.method === 'POST' && /^\/api\/tickets\/[^/]+\/summarize$/.test(path)) {
      const ticketId = path.split('/')[3];
      const body = await readBody(req);
      const tickets = await callRpc('dashboard_tickets', {});
      const ticket = tickets.find((t) => t.ticket_id === ticketId);
      if (!ticket) return json(res, 404, { error: 'ticket_not_found' });

      const summary = body.summary && String(body.summary).trim()
        ? String(body.summary).trim()
        : await summarizeWithLm(ticket.question || '', ticket.needs_summary ? `Ringkasan sebelumnya: ${ticket.needs_summary}` : '');

      const result = await callRpc('dashboard_update_ticket_summary', {
        p_ticket_id: ticketId,
        p_summary: summary,
      });
      return json(res, 200, result);
    }

    if (req.method === 'POST' && /^\/api\/tickets\/[^/]+\/reply$/.test(path)) {
      const ticketId = path.split('/')[3];
      const body = await readBody(req);
      const reply = String(body.reply || '').trim();
      if (!reply) return json(res, 400, { error: 'reply_required' });

      const tickets = await callRpc('dashboard_tickets', {});
      const ticket = tickets.find((t) => t.ticket_id === ticketId);
      if (!ticket) return json(res, 404, { error: 'ticket_not_found' });

      const ownerResult = await callRpc('receive_owner', {
        p_message_id: `dash.${randomUUID()}`,
        p_phone: OWNER_PHONE,
        p_text: `#${ticket.code} ${reply}`,
        p_timestamp: new Date().toISOString(),
      });

      if (ownerResult?.action !== 'forward_customer') {
        return json(res, 409, {
          error: 'ticket_not_forwardable',
          detail: ownerResult?.action === 'help' ? ownerResult.text : 'Tiket sudah selesai atau tidak ditemukan.',
        });
      }

      const delivery = await sendWhatsApp(ownerResult.customer_phone, ownerResult.owner_answer);

      // Tiket hanya ditutup bila WhatsApp benar-benar menerima pesan. Bila gagal, tiket
      // tetap "owner_replied" sehingga bisa dikirim ulang dari dashboard atau WhatsApp.
      if (!delivery.sent) {
        return json(res, 502, {
          error: 'delivery_failed',
          message: `Gagal kirim ke pelanggan (${delivery.channel || 'tanpa kanal'}): ${delivery.error}`,
          ticket_id: ticketId,
          ticket_code: ownerResult.ticket_code,
          delivery,
        });
      }

      const complete = await callRpc('complete_owner_reply', {
        p_ticket_id: ownerResult.ticket_id,
        p_provider_message_id: delivery.provider_message_id,
      });

      return json(res, 200, {
        ticket_id: ticketId,
        ticket_code: ownerResult.ticket_code,
        customer_phone: ownerResult.customer_phone,
        delivery,
        knowledge: complete,
      });
    }

    // Kirim ulang jawaban owner untuk tiket yang sudah selesai (mis. tiket yang dulu
    // ditandai selesai padahal pengirimannya gagal).
    if (req.method === 'POST' && /^\/api\/tickets\/[^/]+\/resend$/.test(path)) {
      const ticketId = path.split('/')[3];
      const tickets = await callRpc('dashboard_tickets', {});
      const ticket = tickets.find((t) => t.ticket_id === ticketId);
      if (!ticket) return json(res, 404, { error: 'ticket_not_found' });
      if (!ticket.owner_answer) return json(res, 409, { error: 'no_owner_answer', message: 'Tiket ini belum punya jawaban owner.' });

      const delivery = await sendWhatsApp(ticket.customer_phone, ticket.owner_answer);
      if (!delivery.sent) {
        return json(res, 502, {
          error: 'delivery_failed',
          message: `Gagal kirim ke pelanggan (${delivery.channel || 'tanpa kanal'}): ${delivery.error}`,
          delivery,
        });
      }
      if (ticket.status !== 'resolved') {
        await callRpc('complete_owner_reply', { p_ticket_id: ticketId, p_provider_message_id: delivery.provider_message_id });
      }
      return json(res, 200, { ticket_id: ticketId, ticket_code: ticket.code, delivery });
    }

    if (req.method === 'GET' && path === '/api/orders') {
      const dateStr = url.searchParams.get('date') || todayStr();
      const prevStr = previousDay(dateStr);
      const currentRange = dayRange(dateStr);
      const previousRange = dayRange(prevStr);

      const [current, previous] = await Promise.all([
        callRpc('dashboard_orders_range', { p_from: currentRange.from, p_to: currentRange.to }),
        callRpc('dashboard_orders_range', { p_from: previousRange.from, p_to: previousRange.to }),
      ]);

      return json(res, 200, {
        date: dateStr,
        previous_date: prevStr,
        current: { date: dateStr, ...summarizeOrders(current) },
        previous: { date: prevStr, ...summarizeOrders(previous) },
      });
    }

    if (req.method === 'GET' && path === '/api/orders/month') {
      const monthStr = url.searchParams.get('month') || thisMonthStr();
      const summary = await callRpc('dashboard_month_orders', { p_month: `${monthStr}-01` });
      return json(res, 200, summary);
    }

    if (req.method === 'GET' && path === '/api/knowledge') {
      return json(res, 200, await knowledgeSummary());
    }

    if (req.method === 'GET' && path.startsWith('/api/knowledge/image/')) {
      const name = basename(decodeURIComponent(path.slice('/api/knowledge/image/'.length)));
      if (!STORAGE_DIR || !IMAGE_FILE.test(name)) return json(res, 404, { error: 'not_found' });
      try {
        const file = await readFile(join(STORAGE_DIR, name));
        const type = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, { 'content-type': type, 'content-length': file.length, 'cache-control': 'max-age=3600' });
        return res.end(file);
      } catch {
        return json(res, 404, { error: 'not_found' });
      }
    }

    if (req.method === 'POST' && path === '/api/knowledge/search') {
      const body = await readBody(req);
      try {
        return json(res, 200, await searchKnowledge(body.q, body.limit));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (req.method === 'POST' && path === '/api/knowledge/import') {
      const body = await readBody(req, 120 * 1024 * 1024);
      const result = await importKnowledge(body);
      return json(res, result.status, result.data);
    }

    return json(res, 404, { error: 'not_found', path });
  } catch (err) {
    process.stderr.write(`[wa-dashboard] error ${req.method} ${path}: ${err.message}\n`);
    return json(res, 500, { error: 'internal_error', message: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`[wa-dashboard] listening on :${PORT} (tz=${TZ})\n`);
});