// Webhook kirim balasan dari dashboard tiket (workflow "WA Admin - Sistem Lengkap", file JSON hasil export n8n).
//   node scripts/apply-dashboard-send.mjs <input.json> <output.json>
//
// Dashboard (port 4000) tidak menyimpan token Meta. Saat owner membalas tiket dari dashboard,
// server dashboard memanggil POST /webhook/dashboard-send { to, text } dengan header
// x-dashboard-secret = DASHBOARD_SEND_SECRET. Workflow mengirim lewat credential
// "WhatsApp account" lalu mengembalikan { provider_message_id }. Bila gagal, webhook
// mengembalikan error sehingga dashboard tidak menutup tiket.
// Hanya menambah node baru; node yang sudah ada tidak diubah. Skrip idempoten.
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('pakai: node scripts/apply-dashboard-send.mjs <input.json> <output.json>');
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const workflow = Array.isArray(raw) ? raw[0] : raw;

// Pakai credential & sender yang sama dengan node "Teruskan Jawaban Owner".
const forward = workflow.nodes.find((n) => n.name === 'Teruskan Jawaban Owner');
if (!forward) throw new Error('node "Teruskan Jawaban Owner" tidak ditemukan');

const NAMES = ['Dashboard Kirim', 'Validasi Dashboard', 'Kirim dari Dashboard', 'Balas Dashboard', 'Balas Dashboard Gagal'];
workflow.nodes = workflow.nodes.filter((n) => !NAMES.includes(n.name));
for (const name of NAMES) delete workflow.connections[name];

const y = Math.max(...workflow.nodes.map((n) => n.position?.[1] ?? 0)) + 400;
workflow.nodes.push(
  {
    id: '00000000-0000-4000-8000-0000000d0001',
    name: 'Dashboard Kirim',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [0, y],
    webhookId: '6f1d8a52-2b1c-4c7e-9a43-d0a5b0000001',
    parameters: { httpMethod: 'POST', path: 'dashboard-send', responseMode: 'responseNode', options: {} },
  },
  {
    id: '00000000-0000-4000-8000-0000000d0002',
    name: 'Validasi Dashboard',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [240, y],
    onError: 'continueErrorOutput',
    parameters: {
      jsCode: [
        "const secret = $env.DASHBOARD_SEND_SECRET || '';",
        'const headers = $json.headers || {};',
        "if (!secret || headers['x-dashboard-secret'] !== secret) throw new Error('unauthorized');",
        "const to = String($json.body?.to || '').replace(/\\D/g, '');",
        "const text = String($json.body?.text || '').trim();",
        "if (!/^62\\d{8,13}$/.test(to) || !text) throw new Error('invalid_payload');",
        'return [{ json: { to, text } }];',
      ].join('\n'),
    },
  },
  {
    id: '00000000-0000-4000-8000-0000000d0003',
    name: 'Kirim dari Dashboard',
    type: 'n8n-nodes-base.whatsApp',
    typeVersion: forward.typeVersion,
    position: [480, y],
    onError: 'continueErrorOutput',
    credentials: forward.credentials,
    parameters: {
      resource: 'message',
      operation: 'send',
      phoneNumberId: forward.parameters.phoneNumberId,
      recipientPhoneNumber: '={{$json.to}}',
      messageType: 'text',
      textBody: '={{$json.text}}',
      additionalFields: {},
    },
  },
  {
    id: '00000000-0000-4000-8000-0000000d0004',
    name: 'Balas Dashboard',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.4,
    position: [720, y],
    parameters: {
      respondWith: 'json',
      responseBody: '={{ JSON.stringify({ provider_message_id: $json.messages?.[0]?.id || null }) }}',
      options: {},
    },
  },
  {
    // Error (rahasia salah, nomor tidak valid, ditolak Meta) dikembalikan ke dashboard sebagai 502.
    id: '00000000-0000-4000-8000-0000000d0005',
    name: 'Balas Dashboard Gagal',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.4,
    position: [720, y + 200],
    parameters: {
      respondWith: 'json',
      responseBody: "={{ JSON.stringify({ error: { message: String($json.error?.description || $json.error?.message || $json.error || 'gagal kirim') } }) }}",
      options: { responseCode: 502 },
    },
  },
);
workflow.connections['Dashboard Kirim'] = { main: [[{ node: 'Validasi Dashboard', type: 'main', index: 0 }]] };
const fail = [{ node: 'Balas Dashboard Gagal', type: 'main', index: 0 }];
workflow.connections['Validasi Dashboard'] = { main: [[{ node: 'Kirim dari Dashboard', type: 'main', index: 0 }], fail] };
workflow.connections['Kirim dari Dashboard'] = { main: [[{ node: 'Balas Dashboard', type: 'main', index: 0 }], fail] };

fs.writeFileSync(output, JSON.stringify(Array.isArray(raw) ? [workflow] : workflow, null, 2));
console.log(`dashboard-send ditambahkan (${workflow.nodes.length} node) → ${output}`);
