#!/usr/bin/env python3
"""
remove-blocking.py
Removes the blocking mechanism and adds ticket creation on escalation.
"""
import json
import sqlite3

DB_PATH = '/Users/M1/Documents/N8N/n8n_data/database.sqlite'
WF_ID = 'MJfyeItNO2eVUsP0'

conn = sqlite3.connect(DB_PATH, timeout=10)
c = conn.cursor()

# Get the active workflow
c.execute("SELECT nodes, connections FROM workflow_entity WHERE id = ?", (WF_ID,))
row = c.fetchone()
nodes = json.loads(row[0])
connections = json.loads(row[1])

print('Before:')
print(f'  Nodes: {len(nodes)}')

# 1) Remove connection from Perlu Klasifikasi? -> Diam Menunggu Owner
if 'Perlu Klasifikasi?' in connections and connections['Perlu Klasifikasi?'].get('main'):
    if len(connections['Perlu Klasifikasi?']['main']) > 1:
        connections['Perlu Klasifikasi?']['main'][1] = []
        print('  Removed: Perlu Klasifikasi? -> Diam Menunggu Owner')

# 2) Remove Diam Menunggu Owner node entirely
diam_idx = next((i for i, n in enumerate(nodes) if n['name'] == 'Diam Menunggu Owner'), None)
if diam_idx is not None:
    nodes.pop(diam_idx)
    print('  Removed node: Diam Menunggu Owner')

# 3) Add a new node: Buat Tiket Otomatis (creates ticket on escalation)
buat_tiket_node = {
    "parameters": {
        "method": "POST",
        "url": "={{$env.DB_API_URL + \"/rpc/create_support_ticket\"}}",
        "sendBody": True,
        "contentType": "json",
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify({ p_customer_id: $('Parse Keputusan AI').first().json.customer_id, p_subject: $('Parse Keputusan AI').first().json.needs_summary || 'Chat dari pelanggan', p_priority: 'normal', p_initial_message: $('Parse Keputusan AI').first().json.customer_message }) }}",
        "options": {}
    },
    "id": "b7e8f9a0-1234-5678-9abc-def012345678",
    "name": "Buat Tiket Otomatis",
    "type": "n8n-nodes-base.httpRequest",
    "typeVersion": 4.4,
    "position": [4500, 800]
}

# 4) Add a node to get ticket code for notification
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

# 5) Modify Eskalasi ke Owner to include ticket info
eskalasi_idx = next((i for i, n in enumerate(nodes) if n['name'] == 'Eskalasi ke Owner'), None)
if eskalasi_idx is not None:
    nodes[eskalasi_idx]['parameters']['textBody'] = "={{$json.owner_message}}\n\nTiket: {{ $('Ambil Kode Tiket').first().json.ticket_code }}"

# Add new nodes
nodes.append(buat_tiket_node)
nodes.append(ambil_kode_tiket_node)

# 6) Connect: Balas Otomatis? (false/ESCALATE) -> Buat Tiket Otomatis -> Ambil Kode Tiket -> Eskalasi ke Owner
if 'Balas Otomatis?' not in connections:
    connections['Balas Otomatis?'] = {'main': []}
while len(connections['Balas Otomatis?'].get('main', [])) < 2:
    connections['Balas Otomatis?']['main'].append([])

# Output 1 (false/ESCALATE) goes to Buat Tiket Otomatis
connections['Balas Otomatis?']['main'][1] = [{"node": "Buat Tiket Otomatis", "type": "main", "index": 0}]

connections['Buat Tiket Otomatis'] = {"main": [[{"node": "Ambil Kode Tiket", "type": "main", "index": 0}]]}
connections['Ambil Kode Tiket'] = {"main": [[{"node": "Eskalasi ke Owner", "type": "main", "index": 0}]]}

# 7) Remove Log Eskalasi connection (it was after Eskalasi ke Owner)
if 'Eskalasi ke Owner' in connections and connections['Eskalasi ke Owner'].get('main'):
    connections['Eskalasi ke Owner']['main'][0] = []

print('\nAfter:')
print(f'  Nodes: {len(nodes)}')
print('  New nodes: Buat Tiket Otomatis, Ambil Kode Tiket')
print('  Flow: Balas Otomatis? -> false -> Buat Tiket Otomatis -> Ambil Kode Tiket -> Eskalasi ke Owner')

# Save back
c.execute("UPDATE workflow_entity SET nodes = ?, connections = ? WHERE id = ?",
          (json.dumps(nodes), json.dumps(connections), WF_ID))

conn.commit()
conn.close()

print('\nDone! Workflow updated.')
