#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = '/Users/M1/Documents/N8N/n8n_data/database.sqlite'
WF_ID = 'MJfyeItNO2eVUsP0'

conn = sqlite3.connect(DB_PATH, timeout=10)
c = conn.cursor()

c.execute("SELECT versionId, nodes, connections FROM workflow_history WHERE workflowId = ? ORDER BY rowid DESC LIMIT 1", (WF_ID,))
row = c.fetchone()
version_id = row[0]
nodes = json.loads(row[1])
connections = json.loads(row[2])

print(f"Version: {version_id}")
print(f"Before: {len(nodes)} nodes")

# 1) Remove Diam Menunggu Owner connection
if 'Perlu Klasifikasi?' in connections and connections['Perlu Klasifikasi?'].get('main'):
    if len(connections['Perlu Klasifikasi?']['main']) > 1:
        connections['Perlu Klasifikasi?']['main'][1] = []
        print("  Removed: Perlu Klasifikasi? -> Diam Menunggu Owner")

# 2) Remove Diam Menunggu Owner node
diam_idx = next((i for i, n in enumerate(nodes) if n['name'] == 'Diam Menunggu Owner'), None)
if diam_idx is not None:
    nodes.pop(diam_idx)
    print("  Removed node: Diam Menunggu Owner")

# 3) Fix Webhook: remove rawBody
for n in nodes:
    if n['name'] == 'Webhook Pesan WhatsApp':
        n['parameters']['options'] = {}
        print("  Fixed: Webhook - removed rawBody")
        break

# 4) Add Buat Tiket Otomatis node
buat_tiket_node = {
    "parameters": {
        "method": "POST",
        "url": "={{$env.DB_API_URL + \"/rpc/create_support_ticket\"}}",
        "sendBody": True,
        "contentType": "json",
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ p_customer_id: $('Parse Keputusan AI').first().json.customer_id, p_subject: $('Parse Keputusan AI').first().json.needs_summary || 'Chat dari pelanggan', p_priority: 'normal', p_initial_message: $('Parse Keputusan AI').first().json.customer_message }) }}",
        "options": {"response": {"response": {"neverError": True}}}
    },
    "id": "b7e8f9a0-1234-5678-9abc-def012345678",
    "name": "Buat Tiket Otomatis",
    "type": "n8n-nodes-base.httpRequest",
    "typeVersion": 4.4,
    "position": [4500, 800]
}

# 5) Add Ambil Kode Tiket node
ambil_kode_tiket_node = {
    "parameters": {
        "jsCode": "const res = $input.first().json;\nconst ticketCode = res?.result?.code || res?.code || 'Tiket baru';\nreturn [{ json: { ticket_code: ticketCode, ...$('Parse Keputusan AI').first().json } }];"
    },
    "id": "c8f9a0b1-2345-6789-abcd-ef0123456789",
    "name": "Ambil Kode Tiket",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [4700, 800]
}

# 6) Modify Eskalasi ke Owner to include ticket info
for n in nodes:
    if n['name'] == 'Eskalasi ke Owner':
        n['parameters']['textBody'] = "={{$json.owner_message}}"
        print("  Modified: Eskalasi ke Owner")
        break

# Add new nodes
nodes.append(buat_tiket_node)
nodes.append(ambil_kode_tiket_node)
print("  Added: Buat Tiket Otomatis, Ambil Kode Tiket")

# 7) Connect: Balas Otomatis? false -> Buat Tiket Otomatis -> Ambil Kode Tiket -> Eskalasi ke Owner
if 'Balas Otomatis?' not in connections:
    connections['Balas Otomatis?'] = {'main': []}
while len(connections['Balas Otomatis?'].get('main', [])) < 2:
    connections['Balas Otomatis?']['main'].append([])
connections['Balas Otomatis?']['main'][1] = [{"node": "Buat Tiket Otomatis", "type": "main", "index": 0}]
connections['Buat Tiket Otomatis'] = {"main": [[{"node": "Ambil Kode Tiket", "type": "main", "index": 0}]]}
connections['Ambil Kode Tiket'] = {"main": [[{"node": "Eskalasi ke Owner", "type": "main", "index": 0}]]}

# Remove Log Eskalasi connection
if 'Eskalasi ke Owner' in connections and connections['Eskalasi ke Owner'].get('main'):
    connections['Eskalasi ke Owner']['main'][0] = []

print(f"\nAfter: {len(nodes)} nodes")
print("Flow: Balas Otomatis? -> false -> Buat Tiket Otomatis -> Ambil Kode Tiket -> Eskalasi ke Owner")

# Save to workflow_history
c.execute("UPDATE workflow_history SET nodes = ?, connections = ? WHERE versionId = ?",
          (json.dumps(nodes), json.dumps(connections), version_id))

# Also update workflow_entity
c.execute("UPDATE workflow_entity SET nodes = ?, connections = ? WHERE id = ?",
          (json.dumps(nodes), json.dumps(connections), WF_ID))

conn.commit()
conn.close()
print("\nDone! Updated both workflow_history and workflow_entity.")
