import { createHmac, randomUUID } from 'node:crypto';
import { loadEnv, readJsonResponse } from './lib.mjs';

loadEnv();

const [role = 'customer', phoneArg, ...messageParts] = process.argv.slice(2);
const phone = String(phoneArg || (role === 'owner' ? process.env.OWNER_PHONE : '628111111111')).replace(/\D/g, '');
const text = messageParts.join(' ').trim() || (role === 'owner' ? '/pesanan' : 'Halo, pesanan saya bagaimana?');
const name = role === 'owner' ? (process.env.OWNER_NAME || 'Owner') : 'Pelanggan Demo';
const n8nBaseUrl = (process.env.N8N_PUBLIC_URL || 'http://localhost:5678').replace(/\/$/, '');

const payload = {
  object: 'whatsapp_business_account',
  entry: [{
    id: 'mock-waba-id',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '620000000000', phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || 'demo' },
        contacts: [{ profile: { name }, wa_id: phone }],
        messages: [{
          from: phone,
          id: `wamid.sim.${randomUUID()}`,
          timestamp: String(Math.floor(Date.now() / 1000)),
          text: { body: text },
          type: 'text',
        }],
      },
    }],
  }],
};

const raw = JSON.stringify(payload);
const headers = { 'content-type': 'application/json' };
if (process.env.WHATSAPP_APP_SECRET) {
  headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(raw).digest('hex')}`;
}

const response = await fetch(`${n8nBaseUrl}/webhook/whatsapp`, { method: 'POST', headers, body: raw });
const result = await readJsonResponse(response);
process.stdout.write(`${JSON.stringify({ accepted: true, role, phone, response: result }, null, 2)}\n`);

