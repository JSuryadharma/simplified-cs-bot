import http from 'node:http';

const port = Number(process.env.PORT || 8080);
const sent = [];
const uploadedMedia = [];

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { status: 'ok', service: 'mock-whatsapp' });
  }

  if (req.method === 'GET' && url.pathname === '/messages') {
    return json(res, 200, { count: sent.length, messages: sent.slice().reverse() });
  }

  if (req.method === 'GET' && url.pathname === '/media') {
    return json(res, 200, { count: uploadedMedia.length, media: uploadedMedia.slice().reverse() });
  }

  if (req.method === 'DELETE' && url.pathname === '/messages') {
    sent.length = 0;
    return json(res, 200, { cleared: true });
  }

  if (req.method === 'POST' && /\/media$/.test(url.pathname)) {
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      const id = `media.mock.${Date.now()}.${Math.random().toString(16).slice(2)}`;
      uploadedMedia.push({
        id,
        received_at: new Date().toISOString(),
        path: url.pathname,
        content_type: req.headers['content-type'] || '',
        size,
      });
      if (uploadedMedia.length > 500) uploadedMedia.splice(0, uploadedMedia.length - 500);
      process.stdout.write(`[mock-whatsapp] media uploaded: ${id} (${size} bytes)\n`);
      return json(res, 200, { id });
    });
    return;
  }

  if (req.method === 'POST' && /\/messages$/.test(url.pathname)) {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }

      const id = `wamid.mock.${Date.now()}.${Math.random().toString(16).slice(2)}`;
      sent.push({ id, received_at: new Date().toISOString(), path: url.pathname, body });
      if (sent.length > 500) sent.splice(0, sent.length - 500);

      process.stdout.write(`[mock-whatsapp] -> ${body.to || '?'}: ${body.text?.body || body.image?.caption || '[non-text]'}\n`);
      return json(res, 200, {
        messaging_product: 'whatsapp',
        contacts: [{ input: body.to, wa_id: body.to }],
        messages: [{ id }],
      });
    });
    return;
  }

  return json(res, 404, { error: 'not_found', path: url.pathname });
});

server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`[mock-whatsapp] listening on :${port}\n`);
});
