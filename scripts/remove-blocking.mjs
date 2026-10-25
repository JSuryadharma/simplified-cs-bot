#!/usr/bin/env node
// remove-blocking.mjs
// Removes the blocking mechanism and adds ticket creation on escalation
import { readFileSync } from 'node:fs';
import { sqlite3 } from 'better-sqlite3';

const db = new sqlite3('/Users/M1/Documents/N8N/n8n_data/database.sqlite', { readonly: false });

// Get the active workflow
const wf = db.prepare("SELECT id, nodes, connections FROM workflow_entity WHERE id = 'MJfyeItNO2eVUsP0'").get();
const nodes = JSON.parse(wf.nodes);
const connections = JSON.parse(wf.connections);

console.log('Before:');
console.log('  Nodes:', nodes.length);

// 1) Remove connection from Perlu Klasifikasi? -> Diam Menunggu Owner
if (connections['Perlu Klasifikasi?']?.main?.[1]) {
  connections['Perlu Klasifikasi?'].main[1] = [];
  console.log('  Removed: Perlu Klasifikasi? -> Diam Menunggu Owner');
}

// 2) Remove Diam Menunggu Owner node entirely
const diamIdx = nodes.findIndex(n => n.name === 'Diam Menunggu Owner');
if (diamIdx >= 0) {
  nodes.splice(diamIdx, 1);
  console.log('  Removed node: Diam Menunggu Owner');
}

// 3) Add a new node: Buat Tiket Otomatis (creates ticket on escalation)
const buatTiketId = 'b7e8f9a0-1234-5678-9abc-def012345678';
const buatTiketNode = {
  parameters: {
    method: 'POST',
    url: '={{$env.DB_API_URL + "/rpc/create_support_ticket"}}',
    sendBody: true,
    contentType: 'json',
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({
      p_customer_id: $('Parse Keputusan AI').first().json.customer_id,
      p_subject: $('Parse Keputusan AI').first().json.needs_summary || 'Chat dari pelanggan',
      p_priority: 'normal',
      p_initial_message: $('Parse Keputusan AI').first().json.customer_message
    }) }}`,
    options: {}
  },
  id: buatTiketId,
  name: 'Buat Tiket Otomatis',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  position: [4500, 800]
};

// 4) Add a node to get ticket code for notification
const ambilKodeTiketId = 'c8f9a0b1-2345-6789-abcd-ef0123456789';
const ambilKodeTiketNode = {
  parameters: {
    jsCode: `const res = $input.first().json;
const ticketCode = res?.result?.code || res?.code || 'Tiket baru';
return [{ json: { ticket_code: ticketCode, ...$('Parse Keputusan AI').first().json } }];`
  },
  id: ambilKodeTiketId,
  name: 'Ambil Kode Tiket',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [4700, 800]
};

// 5) Modify Eskalasi ke Owner to include ticket info
const eskalasiIdx = nodes.findIndex(n => n.name === 'Eskalasi ke Owner');
if (eskalasiIdx >= 0) {
  nodes[eskalasiIdx].parameters.textBody = `={{$json.owner_message}}\n\nTiket: {{ $('Ambil Kode Tiket').first().json.ticket_code }}`;
}

// Add new nodes
nodes.push(buatTiketNode);
nodes.push(ambilKodeTiketNode);

// 6) Connect: Balas Otomatis? (false) -> Buat Tiket Otomatis -> Ambil Kode Tiket -> Eskalasi ke Owner
if (!connections['Balas Otomatis?']) connections['Balas Otomatis?'] = { main: [] };
// Output 1 (false/ESCALATE) goes to Buat Tiket Otomatis
connections['Balas Otomatis?'].main[1] = [{ node: 'Buat Tiket Otomatis', type: 'main', index: 0 }];

connections['Buat Tiket Otomatis'] = { main: [[{ node: 'Ambil Kode Tiket', type: 'main', index: 0 }]] };
connections['Ambil Kode Tiket'] = { main: [[{ node: 'Eskalasi ke Owner', type: 'main', index: 0 }]] };

// 7) Remove Log Eskalasi connection (it was after Eskalasi ke Owner)
if (connections['Eskalasi ke Owner']?.main?.[0]) {
  connections['Eskalasi ke Owner'].main[0] = [];
}

console.log('\nAfter:');
console.log('  Nodes:', nodes.length);
console.log('  New nodes: Buat Tiket Otomatis, Ambil Kode Tiket');

// Save back
db.prepare("UPDATE workflow_entity SET nodes = ?, connections = ? WHERE id = 'MJfyeItNO2eVUsP0'")
  .run(JSON.stringify(nodes), JSON.stringify(connections));

db.close();
console.log('\nDone! Workflow updated.');
