// Bigin over MCP (Zoho's Bigin MCP server) — read-only.
// Auth: the Worker is its own MCP client. A one-time "Connect Bigin" click runs the standard MCP OAuth flow
// (discovery → dynamic client registration → PKCE authorise → token), then tokens are stored in KV and refreshed.
// If BIGIN_MCP_URL is a keyed URL from Zoho's MCP console, no OAuth is needed and the flow is skipped.
const KV_TOKENS = 'bigin:oauth';
const KV_LEADS = 'bigin:leads';
const KV_META = 'bigin:meta';
const PROTOCOL = '2025-06-18';

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

// ---------- OAuth discovery / registration ----------
async function discover(env) {
  const mcpUrl = new URL(env.BIGIN_MCP_URL);
  let resourceMeta = null;
  const probe = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(initBody(0)) });
  if (probe.status !== 401) return { noAuth: probe.ok };
  const hdr = probe.headers.get('www-authenticate') || '';
  const m = hdr.match(/resource_metadata="([^"]+)"/);
  const rmUrl = m ? m[1] : `${mcpUrl.origin}/.well-known/oauth-protected-resource${mcpUrl.pathname}`;
  for (const u of [rmUrl, `${mcpUrl.origin}/.well-known/oauth-protected-resource`]) {
    const r = await fetch(u); if (r.ok) { resourceMeta = await r.json(); break; }
  }
  const asBase = resourceMeta?.authorization_servers?.[0] || mcpUrl.origin;
  const asUrl = new URL(asBase);
  const candidates = [
    `${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname === '/' ? '' : asUrl.pathname}`,
    `${asUrl.origin}/.well-known/oauth-authorization-server`,
    `${asUrl.origin}/.well-known/openid-configuration`,
  ];
  let as = null;
  for (const u of candidates) { const r = await fetch(u); if (r.ok) { as = await r.json(); break; } }
  if (!as) throw new Error('Could not find the Bigin MCP authorisation server metadata.');
  return { as, resource: resourceMeta?.resource || env.BIGIN_MCP_URL, scopes: resourceMeta?.scopes_supported || as.scopes_supported || [] };
}

export async function startConnect(env, origin) {
  const d = await discover(env);
  if (d.noAuth) return { noAuth: true };
  if (!d.as.registration_endpoint) throw new Error('Zoho MCP does not allow automatic client registration. Use a keyed Bigin MCP URL from Zoho\'s MCP console as BIGIN_MCP_URL instead.');
  const redirect = `${origin}/admin/callback`;
  const reg = await fetch(d.as.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Frido Walk-in Dashboard (read-only)', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  if (!reg.ok) throw new Error(`Client registration failed (${reg.status}): ${await reg.text()}`);
  const client = await reg.json();
  const verifier = randomString(48); const state = randomString(24);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  await env.DASH_KV.put(`oauth:state:${state}`, JSON.stringify({ verifier, client, token_endpoint: d.as.token_endpoint, redirect, resource: d.resource }), { expirationTtl: 900 });
  const u = new URL(d.as.authorization_endpoint);
  u.searchParams.set('response_type', 'code'); u.searchParams.set('client_id', client.client_id);
  u.searchParams.set('redirect_uri', redirect); u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256'); u.searchParams.set('state', state);
  u.searchParams.set('resource', d.resource);
  if (d.scopes.length) u.searchParams.set('scope', d.scopes.join(' '));
  return { authorizeUrl: u.toString() };
}

export async function finishConnect(env, url) {
  const state = url.searchParams.get('state'); const code = url.searchParams.get('code');
  if (!state || !code) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || 'Missing code');
  const saved = await env.DASH_KV.get(`oauth:state:${state}`, 'json');
  if (!saved) throw new Error('This connect link has expired. Start again from the admin page.');
  await env.DASH_KV.delete(`oauth:state:${state}`);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: saved.redirect, client_id: saved.client.client_id, code_verifier: saved.verifier, resource: saved.resource });
  if (saved.client.client_secret) body.set('client_secret', saved.client.client_secret);
  const r = await fetch(saved.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Token exchange failed (${r.status}): ${await r.text()}`);
  const t = await r.json();
  await env.DASH_KV.put(KV_TOKENS, JSON.stringify({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (t.expires_in || 3600) * 1000, client: saved.client, token_endpoint: saved.token_endpoint, resource: saved.resource, connected_at: new Date().toISOString() }));
}

async function accessToken(env) {
  const t = await env.DASH_KV.get(KV_TOKENS, 'json');
  if (!t) return null; // keyed URL mode, or not connected yet
  if (Date.now() < t.expires_at - 60000) return t.access_token;
  if (!t.refresh_token) throw new Error('Bigin connection expired. Reconnect from the admin page.');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client.client_id, resource: t.resource });
  if (t.client.client_secret) body.set('client_secret', t.client.client_secret);
  const r = await fetch(t.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Bigin token refresh failed (${r.status}). Reconnect from the admin page.`);
  const n = await r.json();
  Object.assign(t, { access_token: n.access_token, refresh_token: n.refresh_token || t.refresh_token, expires_at: Date.now() + (n.expires_in || 3600) * 1000 });
  await env.DASH_KV.put(KV_TOKENS, JSON.stringify(t));
  return t.access_token;
}

// ---------- MCP JSON-RPC over Streamable HTTP ----------
const initBody = (id) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'frido-walkin-dashboard', version: '1.0.0' } } });

async function parseRpc(res, id) {
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) {
    for (const block of text.split(/\n\n/)) {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data) continue; const msg = JSON.parse(data); if (msg.id === id) return msg;
    }
    throw new Error('No MCP response in event stream');
  }
  return text ? JSON.parse(text) : {};
}

class McpSession {
  constructor(env) { this.env = env; this.id = 0; this.session = null; this.token = null; }
  async post(payload) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.session) headers['mcp-session-id'] = this.session;
    const res = await fetch(this.env.BIGIN_MCP_URL, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (res.status === 401) throw new Error('Bigin MCP refused the connection (401). Connect Bigin from the admin page.');
    if (!res.ok && res.status !== 202) throw new Error(`Bigin MCP error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const sid = res.headers.get('mcp-session-id'); if (sid) this.session = sid;
    return res;
  }
  async open() {
    this.token = await accessToken(this.env);
    const id = ++this.id; const res = await this.post(initBody(id)); const msg = await parseRpc(res, id);
    if (msg.error) throw new Error(`MCP initialize failed: ${msg.error.message}`);
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  // Zoho exposes Bigin tools behind ZohoMCP_executeTool({ body: { tool_name, arguments } }).
  async bigin(toolName, args) {
    const id = ++this.id;
    const res = await this.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ZohoMCP_executeTool', arguments: { body: { tool_name: toolName, arguments: args } } } });
    const msg = await parseRpc(res, id);
    if (msg.error) throw new Error(`${toolName}: ${msg.error.message}`);
    const text = (msg.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (msg.result?.isError) throw new Error(`${toolName}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }
}

// ---------- Daily refresh: all walk-in leads → KV ----------
const FIELDS = 'id, Stage, Pipeline, Walk_in_Date_Time, Store_Location, Owner, Amount, Call_Date, Close_Lost_Reason, Phone_Number, Product, Quantity, Product_Category';

export async function refreshBigin(env) {
  const started = new Date().toISOString();
  try {
    const mcp = new McpSession(env); await mcp.open();
    const owners = new Map();
    for (let page = 1; page <= 20; page++) {
      const r = await mcp.bigin('Bigin_getNewUsers', { query_params: { type: 'AllUsers', per_page: 200, page } });
      for (const u of r.users || []) owners.set(u.id, u.full_name);
      if (!r.info?.more_records) break;
    }
    const leads = [];
    for (let offset = 0; offset < 100000; offset += 2000) {
      const r = await mcp.bigin('Bigin_getRecordsUsingCoqlQuery', { body: { select_query: `select ${FIELDS} from Pipelines where Walk_in_Date_Time is not null order by id asc limit ${offset}, 2000` } });
      for (const x of r.data || []) {
        if (String(x.Pipeline) !== String(env.WALKIN_PIPELINE_ID)) continue;
        leads.push({ i: x.id, st: x.Stage, d: x.Walk_in_Date_Time, loc: x.Store_Location, own: owners.get(x.Owner?.id) || '', amt: x.Amount, call: x.Call_Date, lr: x.Close_Lost_Reason, p: x.Phone_Number, prod: Array.isArray(x.Product) ? x.Product.join(', ') : (x.Product?.name || x.Product || ''), qty: x.Quantity, cat: x.Product_Category || '' });
      }
      if (!r.info?.more_records) break;
    }
    await env.DASH_KV.put(KV_LEADS, JSON.stringify(leads));
    await env.DASH_KV.put(KV_META, JSON.stringify({ status: 'ok', refreshedAt: new Date().toISOString(), started, count: leads.length }));
    return { ok: true, count: leads.length };
  } catch (e) {
    const prev = (await env.DASH_KV.get(KV_META, 'json')) || {};
    await env.DASH_KV.put(KV_META, JSON.stringify({ ...prev, status: 'error', error: String(e.message || e), failedAt: new Date().toISOString() }));
    return { ok: false, error: String(e.message || e) };
  }
}
export const biginLeads = (env) => env.DASH_KV.get(KV_LEADS, 'json');
export const biginMeta = (env) => env.DASH_KV.get(KV_META, 'json');
export const biginConnected = async (env) => !!(await env.DASH_KV.get(KV_TOKENS));
