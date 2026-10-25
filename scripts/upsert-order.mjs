import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, readJsonResponse } from './lib.mjs';

loadEnv();

const [fileArg] = process.argv.slice(2);
if (!fileArg) {
  process.stderr.write('Pemakaian: node scripts/upsert-order.mjs <order.json>\n');
  process.exit(2);
}
if (!process.env.IMPORT_API_KEY) {
  process.stderr.write('IMPORT_API_KEY belum diisi di .env\n');
  process.exit(2);
}

const payload = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
const n8nBaseUrl = (process.env.N8N_PUBLIC_URL || 'http://localhost:5678').replace(/\/$/, '');
const response = await fetch(`${n8nBaseUrl}/webhook/admin/orders/upsert`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-import-key': process.env.IMPORT_API_KEY },
  body: JSON.stringify(payload),
});
const result = await readJsonResponse(response);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

