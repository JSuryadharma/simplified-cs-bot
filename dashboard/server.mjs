import http from 'node:http';
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
// Subpath di belakang reverse proxy, mis. "/wa-dashboard". Proxy boleh membuang prefix atau tidak.
const BASE_PATH = ('/' + (process.env.BASE_PATH || '')).replace(/\/{2,}/g, '/').replace(/\/+$/, '');
const DB_API_URL = (process.env.DB_API_URL || 'http://host.docker.internal:3001').replace(/\/+$/, '');
const LM_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const LM_TOKEN = process.env.OPENROUTER_API_KEY || '';
const LM_CHAT_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
// Semua perintah owner (jawab tiket, kirim ulang, ringkasan order) lewat endpoint n8n
// owner/command. Endpoint itu memakai credential "WhatsApp account", jadi token Meta hanya
// tersimpan di n8n, dan owner tidak lagi bisa memberi perintah lewat WhatsApp.
const N8N_OWNER_WEBHOOK_URL = process.env.N8N_OWNER_WEBHOOK_URL || '';
const DASHBOARD_SEND_SECRET = process.env.DASHBOARD_SEND_SECRET || '';
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

function ownerEndpointConfigured() {
  return Boolean(N8N_OWNER_WEBHOOK_URL && DASHBOARD_SEND_SECRET);
}

// Kirim perintah owner ke n8n. Mengembalikan { status, data } apa adanya supaya kode
// status n8n (400/401/409/502) diteruskan ke browser.
async function ownerCommand(body) {
  if (!ownerEndpointConfigured()) {
    return { status: 503, data: { error: 'owner_endpoint_not_configured', message: 'Endpoint perintah owner belum diatur: isi N8N_OWNER_WEBHOOK_URL dan DASHBOARD_SEND_SECRET.' } };
  }
  let res;
  try {
    res = await fetch(N8N_OWNER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dashboard-secret': DASHBOARD_SEND_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    return { status: 502, data: { error: 'n8n_unreachable', message: `Tidak dapat menghubungi n8n (${new URL(N8N_OWNER_WEBHOOK_URL).host}): ${err.message}` } };
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.message) data.message = data.error || `${res.status} ${res.statusText}`;
  return { status: res.status, data };
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
  if (BASE_PATH && url.pathname === BASE_PATH) {
    // URL relatif di index.html butuh garis miring penutup
    res.writeHead(301, { location: BASE_PATH + '/' + url.search });
    return res.end();
  }
  const path = BASE_PATH && url.pathname.startsWith(BASE_PATH + '/') ? url.pathname.slice(BASE_PATH.length) : url.pathname;

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
        owner_endpoint_configured: ownerEndpointConfigured(),
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

      // n8n mengirim jawaban, lalu menutup tiket dan menyimpan Q&A hanya bila WhatsApp
      // menerima pesan. Bila gagal (502), tiket tetap terbuka dan bisa dikirim lagi.
      const result = await ownerCommand({ action: 'reply', ticket_code: ticket.code, text: reply });
      return json(res, result.status, result.data);
    }

    // Kirim ulang jawaban owner yang sudah tersimpan (mis. pengiriman sebelumnya gagal).
    if (req.method === 'POST' && /^\/api\/tickets\/[^/]+\/resend$/.test(path)) {
      const ticketId = path.split('/')[3];
      const result = await ownerCommand({ action: 'resend', ticket_id: ticketId });
      return json(res, result.status, result.data);
    }

    // Ringkasan order oleh AI (dulu perintah WhatsApp /pesanan).
    if (req.method === 'POST' && path === '/api/orders/summary') {
      const body = await readBody(req);
      const result = await ownerCommand({ action: 'orders', filter: String(body.filter || 'hari_ini').trim() });
      return json(res, result.status, result.data);
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
  process.stdout.write(`[wa-dashboard] listening on :${PORT}${BASE_PATH} (tz=${TZ})\n`);
});