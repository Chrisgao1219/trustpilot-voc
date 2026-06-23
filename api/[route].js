// Vercel serverless function — Trustpilot VOC API
// Uses GitHub API to read/update brands.json in the repo
// Routes: GET /api/health, GET /api/brands, POST /api/submit

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const REPO_OWNER = 'Chrisgao1219';
const REPO_NAME = process.env.GITHUB_REPO || 'ai-marketing-workbench';
const BRANDS_PATH = process.env.BRANDS_PATH || 'projects/trustpilot/brands.json';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'master';
const API_KEY = process.env.API_KEY || '';

const GH_API = 'https://api.github.com';
const BRANDS_URL = `${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${BRANDS_PATH}`;

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function ghHeaders() {
  return {
    'Authorization': `Bearer ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'trustpilot-voc-api'
  };
}

async function loadBrands() {
  const res = await fetchWithTimeout(BRANDS_URL + '?ref=' + encodeURIComponent(GITHUB_BRANCH), { headers: ghHeaders() });
  if (!res.ok) return { sha: '', config: { focus: '', categories: {} } };
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { sha: data.sha, config: JSON.parse(content) };
}

async function saveBrands(config, sha) {
  const content = Buffer.from(JSON.stringify(config, null, 2) + '\n', 'utf-8').toString('base64');
  const body = JSON.stringify({
    message: 'Update brands.json via API',
    content: content,
    sha: sha,
    branch: GITHUB_BRANCH
  });
  const res = await fetchWithTimeout(BRANDS_URL, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: body
  });
  return res.ok;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key'
  };
}

function normalizeTrustpilotUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch (e) {
    return null;
  }
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  if (host !== 'trustpilot.com') return null;
  const prefix = '/review/';
  if (!u.pathname.startsWith(prefix)) return null;
  const domain = u.pathname.slice(prefix.length).replace(/\/+$/g, '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) return null;
  return `https://www.trustpilot.com/review/${domain}`;
}

function nameFromUrl(url) {
  const domain = url.split('/review/')[1] || '';
  const first = domain.split('.')[0] || 'Unknown';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function nameKey(name) {
  return String(name || '').trim().toLocaleLowerCase();
}

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Parse route from URL path
  var path = req.url.split('?')[0];

  // Health check
  if (path === '/api/health' && req.method === 'GET') {
    const { config } = await loadBrands();
    const total = Object.values(config.categories || {}).reduce((s, v) => s + v.length, 0);
    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      total_brands: total,
      categories: Object.keys(config.categories || {}),
      focus: config.focus || ''
    }));
    return;
  }

  // List brands
  if (path === '/api/brands' && req.method === 'GET') {
    const { config } = await loadBrands();
    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));
    return;
  }

  // Submit brands
  if (path === '/api/submit' && req.method === 'POST') {
    if (!API_KEY) {
      res.writeHead(503, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API key is not configured' }));
      return;
    }
    // Auth
    const key = req.headers['x-api-key'] || '';
    if (key !== API_KEY) {
      res.writeHead(401, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Parse body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    let data;
    try { data = JSON.parse(body); } catch (e) {
      res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
      return;
    }

    if (!data.brands || !Array.isArray(data.brands)) {
      res.writeHead(400, { ...corsHeaders(), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: "missing 'brands' array" }));
      return;
    }

    const { sha, config } = await loadBrands();
    if (!config.categories) config.categories = {};

    let added = 0;
    let skipped = 0;

    for (const item of data.brands) {
      const url = normalizeTrustpilotUrl(item.url || '');
      let name = (item.name || '').trim();
      const category = (item.category || '其他').trim();

      if (!url) {
        skipped++;
        continue;
      }

      if (!name) {
        name = nameFromUrl(url);
      }

      // Dedup
      let found = false;
      const wantedName = nameKey(name);
      for (const catName of Object.keys(config.categories)) {
        for (const b of config.categories[catName]) {
          if (normalizeTrustpilotUrl(b.url || '') === url || (wantedName && nameKey(b.name) === wantedName)) {
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (found) {
        skipped++;
        continue;
      }

      if (!config.categories[category]) {
        config.categories[category] = [];
      }
      config.categories[category].push({ name: name, url: url });
      added++;
    }

    if (added > 0) {
      const ok = await saveBrands(config, sha);
      if (!ok) {
        res.writeHead(500, { ...corsHeaders(), 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'failed to save' }));
        return;
      }
    }

    const total = Object.values(config.categories).reduce((s, v) => s + v.length, 0);

    res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      added: added,
      skipped: skipped,
      total: total
    }));
    return;
  }

  res.writeHead(404, { ...corsHeaders(), 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
};
