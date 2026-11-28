// Tes: eskalasi hanya lewat dashboard tiket, tidak ada pesan WhatsApp ke owner.
// Jalankan: node tests/escalation.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const [workflow] = JSON.parse(readFileSync(new URL('../workflows/wa-admin-lengkap.json', import.meta.url), 'utf8'));
const targets = (name, output = 0) => (workflow.connections[name]?.main?.[output] || []).map((c) => c.node);
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('node "Eskalasi ke Owner" sudah tidak ada', () => {
  assert.ok(!workflow.nodes.some((n) => n.name === 'Eskalasi ke Owner'));
  for (const [from, v] of Object.entries(workflow.connections)) {
    for (const outs of Object.values(v)) for (const o of outs) for (const c of o) assert.notEqual(c.node, 'Eskalasi ke Owner', `masih tersambung dari ${from}`);
  }
});

test('eskalasi tetap membuka tiket, lalu berhenti tanpa kirim WhatsApp', () => {
  assert.deepEqual(targets('Perlu Tiket?', 0), ['Buka Tiket']);
  assert.deepEqual(targets('Buka Tiket'), ['Hasil Keputusan DB']);
  assert.deepEqual(targets('Balas Otomatis?', 1), ['Tiket di Dashboard']);
  const end = workflow.nodes.find((n) => n.name === 'Tiket di Dashboard');
  assert.equal(end.type, 'n8n-nodes-base.noOp');
  assert.deepEqual(targets('Tiket di Dashboard'), []);
});

test('semua pengiriman WhatsApp hanya ke pelanggan lewat nomor bisnis', () => {
  const senders = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.whatsApp');
  assert.deepEqual(senders.map((n) => n.name).sort(), ['Kirim Aset Gambar', 'Kirim Balasan Otomatis', 'Teruskan Jawaban Owner']);
  for (const n of senders) {
    assert.match(String(n.parameters.recipientPhoneNumber), /customer_phone/, `${n.name} mengirim ke pelanggan`);
    assert.equal(String(n.parameters.phoneNumberId).replace(/^=/, ''), '1206698449192012');
  }
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
process.exit(failed ? 1 : 0);
