import { createServer } from 'node:http';
import https from 'node:https';
import { TextEncoder } from 'node:util';

const PORT = Number(process.env.PORT || 8787);
const PROXY_SECRET = process.env.ABF_REFERENCE_PROXY_SECRET || '';
const legacyTlsAgent = new https.Agent({
  // CCF's older server only negotiates this legacy cipher over TLS 1.2.
  ciphers: 'AES128-SHA',
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  honorCipherOrder: true,
});
// abf.gov.au sits behind a modern WAF that rejects the legacy AES128-SHA cipher (TLS alert 40 handshake
// failure). Use Node's default modern suite (ECDHE/GCM) and allow up to TLS 1.3.
const modernTlsAgent = new https.Agent({ minVersion: 'TLSv1.2' });

// Allowed upstream sources: origin + path prefix + which TLS agent to use for that host.
const ALLOWED_SOURCES = [
  { origin: 'https://www.ccf.customs.gov.au', pathPrefix: '/reference/', agent: legacyTlsAgent },
  {
    origin: 'https://www.abf.gov.au',
    pathPrefix: '/importing-exporting-and-manufacturing/tariff-classification/',
    agent: modernTlsAgent,
  },
];

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function validateAbfUrl(value) {
  const url = new URL(value);
  const source = ALLOWED_SOURCES.find(
    (s) => url.origin === s.origin && url.pathname.startsWith(s.pathPrefix),
  );
  if (!source) {
    throw new Error('Only ABF CCF reference and ABF tariff-schedule URLs are allowed');
  }
  return { url, agent: source.agent };
}

function fetchAbfText(url, agent) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    console.log(`[abf-reference-fetch-proxy] fetching ${url}`);

    const req = https.get(url, {
      agent,
      timeout: 120_000,
      headers: {
        // Browser-like UA: abf.gov.au's WAF can also reject the non-browser UA after the TLS handshake.
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/plain,text/html,application/xhtml+xml,*/*',
      },
    }, (res) => {
      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        console.error(`[abf-reference-fetch-proxy] ABF returned HTTP ${res.statusCode} url=${url}`);
        reject(new Error(`ABF returned HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      let totalBytes = 0;
      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        chunks.push(chunk);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks, totalBytes).toString('utf8');
        console.log(
          `[abf-reference-fetch-proxy] fetched ${url} status=${res.statusCode} bytes=${totalBytes} elapsedMs=${Date.now() - startedAt}`,
        );
        resolve({
          text,
          sizeBytes: new TextEncoder().encode(text).length,
        });
      });
    });

    req.on('timeout', () => {
      console.error(`[abf-reference-fetch-proxy] timeout url=${url}`);
      req.destroy(new Error('ABF request timed out'));
    });
    req.on('error', (error) => {
      console.error(`[abf-reference-fetch-proxy] fetch error url=${url} error=${error.message}`);
      reject(error);
    });
  });
}

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      console.log('[abf-reference-fetch-proxy] health check');
      json(res, 200, { ok: true });
      return;
    }

    if (req.method !== 'POST') {
      console.warn(`[abf-reference-fetch-proxy] rejected method=${req.method} url=${req.url}`);
      json(res, 405, { error: 'Method not allowed' });
      return;
    }

    if (PROXY_SECRET && req.headers['x-abf-proxy-secret'] !== PROXY_SECRET) {
      console.warn('[abf-reference-fetch-proxy] rejected request: invalid proxy secret');
      json(res, 401, { error: 'Invalid proxy secret' });
      return;
    }

    const body = await readJson(req);
    const { url, agent } = validateAbfUrl(body.url);
    console.log(`[abf-reference-fetch-proxy] accepted request url=${url}`);
    const result = await fetchAbfText(url, agent);

    json(res, 200, {
      url: url.toString(),
      ...result,
    });
  } catch (error) {
    console.error(`[abf-reference-fetch-proxy] request failed error=${error instanceof Error ? error.message : String(error)}`);
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(PORT, () => {
  console.log(`ABF reference fetch proxy listening on port ${PORT}`);
});
