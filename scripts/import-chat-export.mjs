import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, readJsonResponse } from './lib.mjs';

loadEnv();

const [fileArg, ownerArg] = process.argv.slice(2);
if (!fileArg) {
  process.stderr.write('Pemakaian: node scripts/import-chat-export.mjs <file.txt> [nama-owner]\n');
  process.exit(2);
}
if (!process.env.IMPORT_API_KEY) {
  process.stderr.write('IMPORT_API_KEY belum diisi di .env\n');
  process.exit(2);
}

const file = path.resolve(fileArg);
const exportText = fs.readFileSync(file, 'utf8');
const n8nBaseUrl = (process.env.N8N_PUBLIC_URL || 'http://localhost:5678').replace(/\/$/, '');
const response = await fetch(`${n8nBaseUrl}/webhook/admin/import-chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-import-key': process.env.IMPORT_API_KEY },
  body: JSON.stringify({ export_text: exportText, owner_name: ownerArg || process.env.OWNER_NAME || 'Owner' }),
});
const result = await readJsonResponse(response);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

