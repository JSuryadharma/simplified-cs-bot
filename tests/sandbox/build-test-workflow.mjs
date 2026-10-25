// Ambil workflow live dari instance n8n (read-only export), lalu buat salinan
// sandbox: setiap node WhatsApp (yang memanggil graph.facebook.com) diganti
// HTTP Request ke mock-whatsapp dengan nama node yang sama, sehingga koneksi
// dan referensi $('...') tetap berlaku. Workflow live tidak diubah.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const workflowId = process.argv[2] || 'WaAdm1nLengkap26';
const out = path.join(here, 'wa-admin-sandbox.json');

const compose = ['compose', '--env-file', '.env'];
execFileSync('docker', [...compose, 'exec', '-T', 'n8n', 'n8n', 'export:workflow', `--id=${workflowId}`, '--output=/tmp/wa-sandbox-export.json'], { cwd: root, stdio: 'ignore' });
const exported = JSON.parse(execFileSync('docker', [...compose, 'exec', '-T', 'n8n', 'cat', '/tmp/wa-sandbox-export.json'], { cwd: root }).toString());
let workflow = Array.isArray(exported) ? exported[0] : exported;

// SANDBOX_FIXES=1: terapkan scripts/apply-chatbot-fixes.mjs sebelum node WhatsApp diganti ke mock
if (process.env.SANDBOX_FIXES === '1') {
  const tmp = path.join(here, 'wa-admin-fixed.tmp.json');
  fs.writeFileSync(tmp, JSON.stringify(workflow));
  execFileSync('node', [path.join(root, 'scripts/apply-chatbot-fixes.mjs'), tmp, tmp], { stdio: 'inherit' });
  workflow = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.rmSync(tmp);
}

// SANDBOX_FIX_SCRIPTS="scripts/a.mjs,scripts/b.mjs": jalankan skrip perbaikan tambahan (input.json output.json)
for (const script of (process.env.SANDBOX_FIX_SCRIPTS || '').split(',').filter(Boolean)) {
  const tmp = path.join(here, 'wa-admin-fixed.tmp.json');
  fs.writeFileSync(tmp, JSON.stringify(workflow));
  execFileSync('node', [path.join(root, script), tmp, tmp], { stdio: 'inherit' });
  const fixed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  workflow = Array.isArray(fixed) ? fixed[0] : fixed;
  fs.rmSync(tmp);
}

// SANDBOX_RPC_SUFFIX=_next: panggil versi uji fungsi DB (mis. /rpc/apply_decision_next) agar
// fungsi live tidak berubah selama pengujian (database dipakai bersama dengan instance live).
if (process.env.SANDBOX_RPC_SUFFIX) {
  for (const node of workflow.nodes) {
    if (typeof node.parameters?.url !== 'string') continue;
    node.parameters.url = node.parameters.url.replace(/\/rpc\/(receive_customer|apply_decision)(?=")/, `/rpc/$1${process.env.SANDBOX_RPC_SUFFIX}`);
  }
}

const inner = (expr, fallback = "''") => {
  const s = String(expr ?? '').trim();
  if (s.startsWith('={{') && s.endsWith('}}')) return s.slice(3, -2).trim();
  if (s.startsWith('=')) return JSON.stringify(s.slice(1));
  return s ? JSON.stringify(s) : fallback;
};

let replaced = 0;
workflow.nodes = workflow.nodes.map((node) => {
  if (node.type !== 'n8n-nodes-base.whatsApp') return node;
  replaced += 1;
  const p = node.parameters || {};
  const phoneId = p.phoneNumberId || 'sandbox';
  const to = inner(p.recipientPhoneNumber);
  let body;
  if (p.messageType === 'image') {
    const caption = inner(p.additionalFields?.mediaCaption);
    body = `{ messaging_product: 'whatsapp', to: String(${to}), type: 'image', image: { caption: ${caption}, file_name: $binary.data?.fileName || '', mime_type: $binary.data?.mimeType || '', file_size: $binary.data?.fileSize || '' } }`;
  } else {
    body = `{ messaging_product: 'whatsapp', to: String(${to}), type: 'text', text: { body: String(${inner(p.textBody)}) } }`;
  }
  return {
    id: node.id,
    name: node.name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: node.position,
    parameters: {
      method: 'POST',
      url: `={{$env.WHATSAPP_API_BASE_URL + "/" + ($env.WHATSAPP_GRAPH_VERSION || "v23.0") + "/${phoneId}/messages"}}`,
      sendBody: true,
      specifyBody: 'json',
      jsonBody: `={{ JSON.stringify(${body}) }}`,
      options: {},
    },
  };
});

// SANDBOX_LLM=openrouter: node keputusan AI memakai OpenRouter ($env.OPENROUTER_MODEL)
if (process.env.SANDBOX_LLM === 'openrouter') {
  const llm = workflow.nodes.find((n) => n.name === 'LLM Ambil Keputusan');
  llm.parameters.url = 'https://openrouter.ai/api/v1/chat/completions';
  llm.parameters.headerParameters = { parameters: [{ name: 'Authorization', value: '=Bearer {{$env.OPENROUTER_API_KEY}}' }] };
  llm.parameters.jsonBody = '={{ JSON.stringify({ ...$json.requestBody, model: $env.OPENROUTER_MODEL }) }}';
  llm.parameters.options = { ...(llm.parameters.options || {}), timeout: 60000 };
  process.stdout.write('LLM Ambil Keputusan -> OpenRouter\n');
}

const leftover =workflow.nodes.filter((n) => /whatsApp$/i.test(n.type) && !n.type.endsWith('Trigger'));
if (leftover.length) throw new Error(`Masih ada node WhatsApp: ${leftover.map((n) => n.name).join(', ')}`);

workflow.name = `${workflow.name} [SANDBOX TEST]`;
workflow.active = true;
delete workflow.shared;
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
process.stdout.write(`sandbox workflow: ${out} (${replaced} node WhatsApp diganti ke mock)\n`);
