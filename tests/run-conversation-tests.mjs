// Jalankan kasus uji percakapan dari tests/conversations/cases.json ke n8n sandbox
// (lihat tests/sandbox/setup.sh), lalu baca balasan yang ditangkap mock-whatsapp.
//
//   bash tests/sandbox/setup.sh
//   node tests/run-conversation-tests.mjs [C01,C09,...]
//
// Hasil: tests/results/<timestamp>.json, .md, dan .html
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../scripts/lib.mjs';

loadEnv();
const here = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_URL = process.env.SANDBOX_N8N_URL || 'http://localhost:5679';
const MOCK_URL = process.env.MOCK_WHATSAPP_URL_HOST || 'http://localhost:8080';
const DB_API = process.env.DB_API_HOST_URL || 'http://localhost:3002';
const QDRANT = process.env.QDRANT_HOST_URL || 'http://localhost:6333';
const COLLECTION = process.env.QDRANT_COLLECTION || 'wa_knowledge';
const SQLITE = path.join(here, 'sandbox/n8n_data/database.sqlite');
const OWNER = String(process.env.OWNER_PHONE || '').replace(/\D/g, '');
const STEP_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 180000);

if (!OWNER) throw new Error('OWNER_PHONE kosong di .env');
if (SANDBOX_URL.includes('5678') || /ngrok/.test(SANDBOX_URL)) throw new Error('Tes hanya boleh ke n8n sandbox, bukan instance live');

const only = (process.argv[2] || '').split(',').filter(Boolean);
const { cases } = JSON.parse(fs.readFileSync(path.join(here, 'conversations/cases.json'), 'utf8'));
const selected = only.length ? cases.filter((c) => only.includes(c.id)) : cases;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTag = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12); // MMDDhhmm

function sqlite(query) {
  const out = execFileSync('python3', ['-c', `
import sqlite3, json, sys
c = sqlite3.connect('file:${SQLITE}?mode=ro', uri=True)
print(json.dumps(c.execute(sys.argv[1]).fetchall()))`, query]).toString();
  return JSON.parse(out);
}
const lastExecutionId = () => sqlite('select coalesce(max(id),0) from execution_entity')[0][0];

async function waitExecutions(afterId) {
  const start = Date.now();
  while (Date.now() - start < STEP_TIMEOUT_MS) {
    const rows = sqlite(`select id, status from execution_entity where id > ${afterId} order by id`);
    if (rows.length && rows.every(([, s]) => !['new', 'running', 'waiting'].includes(s))) {
      await sleep(500);
      return rows.map(([id, status]) => ({ id, status }));
    }
    await sleep(1000);
  }
  return [{ id: null, status: 'timeout' }];
}

async function mockMessages() {
  const res = await fetch(`${MOCK_URL}/messages`);
  return (await res.json()).messages.slice().reverse(); // kronologis
}

async function sendInbound(phone, name, text) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{ id: 'test-waba', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '620000000000', phone_number_id: 'sandbox' },
      contacts: [{ profile: { name }, wa_id: phone }],
      messages: [{ from: phone, id: `wamid.test.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text }, type: 'text' }],
    } }] }],
  };
  const res = await fetch(`${SANDBOX_URL}/webhook/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}: ${await res.text()}`);
}

async function seedOrder(phone, orderNumber, seed) {
  const res = await fetch(`${DB_API}/rpc/upsert_order`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      p_order_number: orderNumber, p_customer_phone: phone, p_customer_name: 'Pelanggan Uji',
      p_status: seed.status, p_items: seed.items || [], p_subtotal: seed.subtotal || 0,
      p_shipping_cost: seed.shipping_cost || 0, p_shipping_address: seed.shipping_address || 'Bandung',
      p_tracking_number: seed.tracking_number || null, p_notes: 'DATA UJI OTOMATIS', p_ordered_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`seed order HTTP ${res.status}: ${await res.text()}`);
}

async function loadAssets() {
  const res = await fetch(`${QDRANT}/collections/${COLLECTION}/points/scroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: 500, with_payload: true, with_vector: false, filter: { must: [{ key: 'content_type', match: { value: 'image_asset' } }] } }),
  });
  const points = (await res.json()).result?.points || [];
  return points.map((p) => p.payload);
}

function identifyAsset(msg, assets) {
  const img = msg.body.image || {};
  const hit = assets.find((a) =>
    (img.file_name && a.original_file_name && img.file_name === a.original_file_name) ||
    (img.caption && (img.caption === a.asset_caption || img.caption === a.asset_description)));
  return hit?.asset_id || '(tidak dikenal)';
}

const fill = (s, vars) => String(s).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
const short = (s, n = 160) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

async function runCase(c, index, assets) {
  const phone = `62899${runTag.slice(2)}${String(index).padStart(2, '0')}`; // 62899 + DDhhmm + nn
  const vars = { case_phone: phone, order_number: `TEST-${runTag}-${c.id}`, ticket: '' };
  if (c.seed_order) await seedOrder(phone, vars.order_number, c.seed_order);

  const seen = (await mockMessages()).length ? new Set((await mockMessages()).map((m) => m.id)) : new Set();
  const isTicket = (t) => /#TKT-(?!X{8})[A-Z0-9]{8}/.test(t);
  const summarize = (msgs) => {
    const toCustomer = msgs.filter((m) => m.body.to === phone);
    const ownerTexts = msgs.filter((m) => m.body.to === OWNER).map((m) => m.body.text?.body || '');
    return {
      customerTexts: toCustomer.filter((m) => m.body.type === 'text').map((m) => m.body.text.body),
      images: toCustomer.filter((m) => m.body.type === 'image').map((m) => identifyAsset(m, assets)),
      escalations: ownerTexts.filter(isTicket),
      ownerReplies: ownerTexts.filter((t) => !isTicket(t)),
    };
  };
  const evaluate = (e, { customerTexts, images, escalations, ownerReplies }, prefix = '') => {
    const checks = [];
    const check = (label, ok) => checks.push({ label: prefix + label, ok });
    if ('customer_reply' in e) check(e.customer_reply ? 'pelanggan dapat balasan teks' : 'pelanggan tidak dibalas otomatis', (customerTexts.length > 0) === e.customer_reply);
    if (e.reply_matches) check(`balasan cocok /${e.reply_matches}/`, customerTexts.some((t) => new RegExp(fill(e.reply_matches, vars), 'i').test(t)));
    if (e.reply_not_matches) check(`balasan tidak memuat /${e.reply_not_matches}/`, customerTexts.length > 0 && !customerTexts.some((t) => new RegExp(e.reply_not_matches, 'i').test(t)));
    if (e.customer_reply_equals) check('jawaban owner diteruskan persis', customerTexts.some((t) => t.trim() === e.customer_reply_equals));
    if ('image' in e) {
      if (e.image === false) check('tidak ada gambar', images.length === 0);
      // expect.image boleh berupa daftar asset_id yang sama-sama benar
      else check(`gambar ${[].concat(e.image).join(' / ')} terkirim`, [].concat(e.image).some((id) => images.includes(id)));
    }
    if ('escalation' in e) check(e.escalation ? 'eskalasi #TKT ke owner' : 'tanpa eskalasi', (escalations.length > 0) === e.escalation);
    if (e.escalation_matches) check(`eskalasi memuat /${e.escalation_matches}/`, escalations.some((t) => new RegExp(e.escalation_matches, 'i').test(t)));
    if ('owner_reply' in e) check('owner dapat balasan', (ownerReplies.length > 0) === e.owner_reply);
    if (e.owner_reply_matches) check(`balasan owner cocok /${fill(e.owner_reply_matches, vars)}/`, ownerReplies.some((t) => new RegExp(fill(e.owner_reply_matches, vars), 'i').test(t)));
    return checks;
  };

  const captured = [];
  const executions = [];
  const sent = [];
  const stepChecks = [];
  for (const step of c.steps) {
    const from = step.role === 'owner' ? OWNER : phone;
    const text = fill(step.text, vars);
    if (step.text.includes('{{ticket}}') && !vars.ticket) {
      sent.push({ role: step.role, text, skipped: 'tidak ada kode #TKT dari langkah sebelumnya' });
      continue;
    }
    sent.push({ role: step.role, text });
    const before = lastExecutionId();
    await sendInbound(from, step.role === 'owner' ? (process.env.OWNER_NAME || 'Owner') : 'Pelanggan Uji', text);
    executions.push(...await waitExecutions(before));
    const stepCaptured = [];
    for (const m of await mockMessages()) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      captured.push(m);
      stepCaptured.push(m);
      const tkt = String(m.body.text?.body || '').match(/#TKT-[A-Z0-9]+/);
      if (tkt && m.body.to === OWNER) vars.ticket = tkt[0];
    }
    // expect per langkah: hanya pesan keluar akibat langkah ini yang diperiksa
    if (step.expect) stepChecks.push(...evaluate(step.expect, summarize(stepCaptured), `langkah ${sent.length}: `));
  }

  const { customerTexts, images, escalations, ownerReplies } = summarize(captured);
  const checks = [...evaluate(c.expect || {}, { customerTexts, images, escalations, ownerReplies }), ...stepChecks];

  const execErrors = executions.filter((x) => x.status !== 'success');
  const pass = checks.every((x) => x.ok) && !sent.some((s) => s.skipped);
  return {
    id: c.id, group: c.group, title: c.title, phone, pass,
    sent, checks, executions,
    actual: { customer_texts: customerTexts, images, escalations, owner_replies: ownerReplies },
    note: [
      execErrors.length ? `eksekusi n8n: ${execErrors.map((x) => `${x.status}${x.id ? ` #${x.id}` : ''}`).join(', ')}` : '',
      ...sent.filter((s) => s.skipped).map((s) => `langkah dilewati: ${s.skipped}`),
    ].filter(Boolean).join('; '),
  };
}

function expectedText(e) {
  const parts = [];
  if (e.customer_reply === true) parts.push('balas pelanggan');
  if (e.customer_reply === false) parts.push('tidak balas pelanggan');
  if (e.customer_reply_equals) parts.push('teruskan jawaban owner persis');
  if (e.image) parts.push(`gambar: ${[].concat(e.image).join(' / ')}`);
  if (e.image === false) parts.push('tanpa gambar');
  if (e.escalation === true) parts.push('eskalasi ke owner');
  if (e.owner_reply) parts.push('balas owner');
  return parts.join(', ');
}

function actualText(r) {
  const a = r.actual;
  const parts = [];
  if (a.customer_texts.length) parts.push(`Pelanggan: "${short(a.customer_texts.at(-1), 140)}"`);
  if (a.images.length) parts.push(`Gambar: ${a.images.join(', ')}`);
  if (a.escalations.length) parts.push(`Eskalasi: ${short(a.escalations[0].match(/#TKT-[A-Z0-9]+/)[0])}`);
  if (a.owner_replies.length) parts.push(`Owner: "${short(a.owner_replies.at(-1), 140)}"`);
  return parts.join(' · ') || '(tidak ada pesan keluar)';
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

function writeReports(results, meta) {
  const dir = path.join(here, 'results');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `conversation-${meta.started.replace(/[:.]/g, '-')}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify({ meta, results }, null, 2));

  const passed = results.filter((r) => r.pass).length;
  const md = [
    `# Hasil uji percakapan chatbot`,
    '',
    `${meta.started} · model ${meta.model} · ${passed}/${results.length} lulus`,
    '',
    '| ID | Kelompok | Skenario | Pesan uji | Diharapkan | Hasil aktual | Status | Catatan |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map((r) => {
      const c = cases.find((x) => x.id === r.id);
      const msg = r.sent.map((s) => `${s.role === 'owner' ? 'Owner' : 'Pelanggan'}: ${s.text}`).join(' → ').replace(OWNER, 'OWNER');
      const failed = r.checks.filter((x) => !x.ok).map((x) => x.label).join('; ');
      return `| ${r.id} | ${r.group} | ${r.title} | ${short(msg, 120).replace(/\|/g, '/')} | ${expectedText(c.expect)} | ${actualText(r).replace(/\|/g, '/')} | ${r.pass ? '✅ LULUS' : '❌ GAGAL'} | ${[failed && `gagal: ${failed}`, r.note].filter(Boolean).join('; ').replace(/\|/g, '/')} |`;
    }),
    '',
  ].join('\n');
  fs.writeFileSync(`${base}.md`, md);
  return { base, passed };
}

const meta = { started: new Date().toISOString(), sandbox: SANDBOX_URL, model: process.env.LM_STUDIO_CHAT_MODEL || '?' };
const assets = await loadAssets();
const results = [];
for (const [i, c] of selected.entries()) {
  if (i > 0 && process.env.CASE_DELAY_MS) await sleep(Number(process.env.CASE_DELAY_MS));
  process.stdout.write(`${c.id} ${c.title} ... `);
  try {
    const r = await runCase(c, cases.indexOf(c) + 1, assets);
    results.push(r);
    process.stdout.write(`${r.pass ? 'LULUS' : 'GAGAL'}  ${actualText(r)}${r.note ? `  [${r.note}]` : ''}\n`);
  } catch (err) {
    results.push({ id: c.id, group: c.group, title: c.title, pass: false, sent: c.steps, checks: [], executions: [], actual: { customer_texts: [], images: [], escalations: [], owner_replies: [] }, note: `error runner: ${err.message}` });
    process.stdout.write(`ERROR ${err.message}\n`);
  }
}
// Jawaban owner di kasus uji (#TKT dari kontak 62899…) ikut dipelajari ke knowledge yang dipakai
// bot live. Hapus lagi agar jawaban uji (mis. ongkir karangan) tidak dipakai ke pelanggan sungguhan.
const testTickets = [...new Set(results.flatMap((r) => r.actual.escalations.map((t) => t.match(/#(TKT-[A-Z0-9]+)/)?.[1]).filter(Boolean)))];
if (testTickets.length) {
  await fetch(`${QDRANT}/collections/${COLLECTION}/points/delete?wait=true`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filter: { must: [{ key: 'source', match: { value: 'owner_escalation' } }, { key: 'ticket_code', match: { any: testTickets } }] } }),
  });
  const list = testTickets.map((t) => `'${t}'`).join(',');
  execFileSync('docker', ['compose', '--env-file', '.env', 'exec', '-T', 'postgres', 'sh', '-c',
    `psql -q -U \${POSTGRES_USER:-wa_admin} -d \${POSTGRES_DB:-wa_admin} -c "delete from bot.knowledge_items k using bot.support_tickets t where t.id = k.ticket_id and k.source = 'owner_escalation' and t.code in (${list})"`],
  { cwd: path.resolve(here, '..'), stdio: 'ignore' });
}
meta.finished = new Date().toISOString();
const { base, passed } = writeReports(results, meta);
process.stdout.write(`\n${passed}/${results.length} lulus. Laporan: ${base}.md\n`);
