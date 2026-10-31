// Bigin over MCP (Zoho's Bigin MCP server) — read-only.
// Auth: the Worker is its own MCP client. A one-time "Connect Bigin" click runs the standard MCP OAuth flow
// (discovery → dynamic client registration → PKCE authorise → token), then tokens are stored in KV and refreshed.
// If BIGIN_MCP_URL is a keyed URL from Zoho's MCP console, no OAuth is needed and the flow is skipped.
const KV_TOKENS = 'bigin:oauth';
const KV_LEADS = 'bigin:leads';
const KV_META = 'bigin:meta';
const KV_CALLBACK = 'bigin:callback'; // website "Call Store" pop-up leads (Callback Requests pipeline) — PDP inventories
const KV_METAADS = 'bigin:metaads'; // Meta Lead Gen leads (Meta Ergo Workspace Assessment pipeline) — Meta ads
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

// Zoho's reply text: one JSON document, or (since Oct 2026) several text parts / a JSON document followed by more text.
// Prefer the part that carries records (data / users), else the first JSON value in the text.
function parseReply(text, parts) {
  try { return JSON.parse(text); } catch (e) {
    const docs = []; for (const p of parts) { try { docs.push(JSON.parse(p)); } catch { /* not JSON */ } }
    for (const p of parts.length > 1 ? [] : [text]) docs.push(...jsonValues(p));
    const best = docs.find((d) => d && typeof d === 'object' && ('data' in d || 'users' in d)) || docs.find((d) => d && typeof d === 'object');
    if (best) return best;
    throw e;
  }
}
// Every top-level JSON object/array in a string (e.g. "{...}{...}" or "{...} note").
function jsonValues(t) {
  const out = []; let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') { if (!depth++) start = i; }
    else if ((c === '}' || c === ']') && depth && !--depth) { try { out.push(JSON.parse(t.slice(start, i + 1))); } catch { /* skip */ } }
  }
  return out;
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
    const parts = (msg.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text); const text = parts.join('');
    if (msg.result?.isError) throw new Error(`${toolName}: ${text.slice(0, 300)}`);
    if (msg.result?.structuredContent && typeof msg.result.structuredContent === 'object') return msg.result.structuredContent;
    return text ? parseReply(text, parts) : {};
  }
}

// COQL rows from a Zoho MCP reply. Zoho has wrapped the payload differently over time ({ data: [...] }, { data: { data: [...] } },
// a JSON string, { response: ... }); anything else fails with its shape (keys only, never values) so the admin page says what changed.
function coqlPage(r) {
  for (let x = r, depth = 0; x && depth < 4; depth++) {
    if (typeof x === 'string') { try { x = JSON.parse(x); } catch { break; } continue; }
    if (Array.isArray(x.data)) return { rows: x.data, more: !!x.info?.more_records };
    if (x.code && !x.data) throw new Error(`COQL ${x.code}: ${String(x.message || '').slice(0, 200)}`);
    x = x.data ?? x.response ?? x.result ?? null;
  }
  if (r && typeof r === 'object' && !('data' in r) && !Object.keys(r).length) return { rows: [], more: false }; // empty reply = no more records
  const shape = (o) => (o && typeof o === 'object' ? (Array.isArray(o) ? 'array' : '{' + Object.keys(o).slice(0, 8).join(',') + '}') : typeof o);
  throw new Error(`Unexpected COQL reply: ${shape(r)}${r && typeof r === 'object' && 'data' in r ? ' · data=' + shape(r.data) : ''}`);
}

// ---------- Daily refresh: all walk-in leads → KV ----------
const FIELDS = 'id, Deal_Name, Stage, Pipeline, Walk_in_Date_Time, Created_Time, Modified_Time, Store_Location, Store_Name1, Owner, Amount, Call_Date, Close_Lost_Reason, Phone_Number, Email_ID, Product, Quantity, Product_Category, UTM_Source, UTM_Medium, UTM_Campaign, UTM_Content, City, Preferred_Store, Close_Won_Reason';

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
    // Zoho's MCP server caps each COQL query at 200 rows, so page by record ID (keyset paging):
    // "id > last id seen, order by id, 200 at a time" — no offset limits, stable while records are added.
    const leads = []; const callbacks = []; const metaads = []; let lastId = '0'; let pages = 0;
    for (;;) {
      const r = await mcp.bigin('Bigin_getRecordsUsingCoqlQuery', { body: { select_query: `select ${FIELDS} from Pipelines where id > ${lastId} order by id asc limit 0, 200` } });
      const { rows, more } = coqlPage(r); pages++;
      for (const x of rows) {
        if (env.CALLBACK_PIPELINE_ID && String(x.Pipeline) === String(env.CALLBACK_PIPELINE_ID)) {
          callbacks.push({ i: x.id, nm: x.Deal_Name || '', st: x.Stage, ct: x.Created_Time, mt: x.Modified_Time, web: x.Store_Name1 || '', loc: x.Store_Location || '', own: owners.get(x.Owner?.id) || '', p: x.Phone_Number, lr: x.Close_Lost_Reason || '', prod: Array.isArray(x.Product) ? x.Product.join(' || ') : (x.Product?.name || x.Product || ''), cat: x.Product_Category || '', us: x.UTM_Source || '', um: x.UTM_Medium || '', uc: x.UTM_Campaign || '', ux: x.UTM_Content || '' });
          continue;
        }
        if (env.META_PIPELINE_ID && String(x.Pipeline) === String(env.META_PIPELINE_ID)) {
          metaads.push({ i: x.id, st: x.Stage, ct: x.Created_Time, mt: x.Modified_Time, ps: x.Preferred_Store || '', city: x.City || '', p: x.Phone_Number, lr: x.Close_Lost_Reason || '', cw: x.Close_Won_Reason || '', us: x.UTM_Source || '', uc: x.UTM_Campaign || '', ux: x.UTM_Content || '' });
          continue;
        }
        if (String(x.Pipeline) !== String(env.WALKIN_PIPELINE_ID)) continue;
        leads.push({ i: x.id, st: x.Stage, d: x.Walk_in_Date_Time, ct: x.Created_Time, loc: x.Store_Location, own: owners.get(x.Owner?.id) || '', amt: x.Amount, call: x.Call_Date, lr: x.Close_Lost_Reason, p: x.Phone_Number, em: x.Email_ID || '', prod: Array.isArray(x.Product) ? x.Product.join(' || ') : (x.Product?.name || x.Product || ''), qty: x.Quantity, cat: x.Product_Category || '' });
      }
      if (!rows.length || !more || pages >= 45) break; // 45 × 200 = 9,000 records per run (Worker subrequest budget)
      lastId = rows[rows.length - 1].id;
    }
    await env.DASH_KV.put(KV_LEADS, JSON.stringify(leads));
    if (env.CALLBACK_PIPELINE_ID) await env.DASH_KV.put(KV_CALLBACK, JSON.stringify(callbacks));
    if (env.META_PIPELINE_ID) await env.DASH_KV.put(KV_METAADS, JSON.stringify(metaads));
    await env.DASH_KV.put(KV_META, JSON.stringify({ status: 'ok', refreshedAt: new Date().toISOString(), started, count: leads.length, callbacks: callbacks.length, metaads: metaads.length, pages }));
    return { ok: true, count: leads.length };
  } catch (e) {
    const prev = (await env.DASH_KV.get(KV_META, 'json')) || {};
    await env.DASH_KV.put(KV_META, JSON.stringify({ ...prev, status: 'error', error: String(e.message || e), failedAt: new Date().toISOString() }));
    return { ok: false, error: String(e.message || e) };
  }
}
export const biginLeads = (env) => env.DASH_KV.get(KV_LEADS, 'json');
export const biginCallbacks = (env) => env.DASH_KV.get(KV_CALLBACK, 'json');
export const biginMetaAds = (env) => env.DASH_KV.get(KV_METAADS, 'json');
export const biginMeta = (env) => env.DASH_KV.get(KV_META, 'json');
export const biginConnected = async (env) => !!(await env.DASH_KV.get(KV_TOKENS));

// ---------- PDP Inventories pipeline (LimeChat → Bigin, live since 21 Oct 2026) — read-only ----------
// Own query (Limechat_Conversation_ID is only filled on this pipeline), so it never competes with the 9,000-record cap of
// the full refresh. Bigin's stage history is not exposed over MCP, so each read keeps the first time a stage was seen.
// Phones, names and remarks stay in KV (server side) — never sent to the browser.
const KV_PDPINV = 'bigin:pdpinv';
const KV_PDPHIST = 'bigin:pdpinv:hist'; // id → [[stage, firstSeenIso, approx?], …]
const KV_PDPMETA = 'bigin:pdpinv:meta';
// Field sets, widest first: a COQL query fails as a whole if one field does not exist, so fall back to narrower sets.
const PDP_FIELD_SETS = [
  'id, Deal_Name, Stage, Pipeline, Owner, Created_Time, Modified_Time, Last_Activity_Time, Ticket_Created, Limechat_Conversation_ID, Phone_Number, Store_Location, Conversation_Tag, Tag, Amount, Remarks, Close_Lost_Reason, Product_Category',
  'id, Deal_Name, Stage, Pipeline, Owner, Created_Time, Modified_Time, Last_Activity_Time, Ticket_Created, Limechat_Conversation_ID, Phone_Number, Store_Location, Conversation_Tag, Tag, Amount, Remarks',
  'id, Stage, Pipeline, Owner, Created_Time, Modified_Time, Limechat_Conversation_ID, Phone_Number',
];

export async function refreshPdpInventories(env) {
  const pid = String(env.PDP_INV_PIPELINE_ID || '1371203000000675914');
  const now = new Date().toISOString();
  try {
    const mcp = new McpSession(env); await mcp.open();
    const owners = new Map();
    for (let page = 1; page <= 5; page++) {
      const r = await mcp.bigin('Bigin_getNewUsers', { query_params: { type: 'AllUsers', per_page: 200, page } });
      for (const u of r.users || []) owners.set(u.id, u.full_name);
      if (!r.info?.more_records) break;
    }
    let fieldSet = -1, lastErr = null;
    const read = async (fields) => {
      const out = []; let lastId = '0';
      for (let page = 0; page < 40; page++) { // 40 × 200 = 8,000 tickets per read
        const r = await mcp.bigin('Bigin_getRecordsUsingCoqlQuery', { body: { select_query: `select ${fields} from Pipelines where Limechat_Conversation_ID is not null and id > ${lastId} order by id asc limit 0, 200` } });
        if (!r.data && (r.code || r.status === 'error')) throw new Error(`COQL ${r.code || 'error'}: ${String(r.message || '').slice(0, 200)}`); // e.g. unknown field
        const { rows, more } = coqlPage(r);
        out.push(...rows);
        if (!rows.length || !more) break;
        lastId = rows[rows.length - 1].id;
      }
      return out;
    };
    let rows = null;
    for (let k = 0; k < PDP_FIELD_SETS.length && !rows; k++) { try { rows = await read(PDP_FIELD_SETS[k]); fieldSet = k; } catch (e) { lastErr = e; } }
    if (!rows) throw lastErr || new Error('PDP Inventories query failed');
    const pipeOf = (x) => String(x.Pipeline?.id ?? x.Pipeline ?? '');
    const recs = rows.filter((x) => pipeOf(x) === pid).map((x) => ({
      i: x.id, st: String(x.Stage || '').trim(), ct: x.Created_Time, mt: x.Modified_Time, la: x.Last_Activity_Time || null, tc: x.Ticket_Created || x.Created_Time,
      cid: String(x.Limechat_Conversation_ID || '').trim(), p: x.Phone_Number || '', nm: x.Deal_Name || '', own: owners.get(x.Owner?.id) || '',
      loc: x.Store_Location || '', ctag: x.Conversation_Tag || '', tags: (Array.isArray(x.Tag) ? x.Tag : []).map((t) => t.name || t).filter(Boolean),
      amt: Number(x.Amount) || 0, rem: x.Remarks || '', lr: x.Close_Lost_Reason || '', cat: x.Product_Category || '',
    }));
    const otherPipelines = rows.length - recs.length;
    const hist = (await env.DASH_KV.get(KV_PDPHIST, 'json')) || {};
    let histChanged = false;
    for (const x of recs) {
      const h = hist[x.i];
      if (!h) { hist[x.i] = /^new enquiry$/i.test(x.st) ? [[x.st, x.ct]] : [['New Enquiry', x.ct], [x.st, x.mt || now, 'approx']]; histChanged = true; } // moved before the first read
      else if (h[h.length - 1][0] !== x.st) { h.push([x.st, x.mt && x.mt > h[h.length - 1][1] ? x.mt : now]); histChanged = true; }
    }
    // Read every 15 min (stage times to +-15 min). Write only what changed so KV stays inside the free daily write limit.
    const body = JSON.stringify(recs);
    const changed = body !== (await env.DASH_KV.get(KV_PDPINV));
    const prev = (await env.DASH_KV.get(KV_PDPMETA, 'json')) || {};
    if (changed) await env.DASH_KV.put(KV_PDPINV, body);
    if (histChanged) await env.DASH_KV.put(KV_PDPHIST, JSON.stringify(hist));
    const changedAt = changed || histChanged || !prev.changedAt ? now : prev.changedAt;
    if (changed || histChanged || prev.status !== 'ok' || !prev.refreshedAt || Date.parse(now) - Date.parse(prev.refreshedAt) >= 55 * 60e3)
      await env.DASH_KV.put(KV_PDPMETA, JSON.stringify({ status: 'ok', refreshedAt: now, changedAt, count: recs.length, otherPipelines, fieldSet }));
    return { ok: true, count: recs.length, fieldSet, changed: changed || histChanged };
  } catch (e) {
    const prev = (await env.DASH_KV.get(KV_PDPMETA, 'json')) || {};
    await env.DASH_KV.put(KV_PDPMETA, JSON.stringify({ ...prev, status: 'error', error: String(e.message || e), failedAt: now }));
    return { ok: false, error: String(e.message || e) };
  }
}
export const pdpInventories = async (env) => ({ recs: (await env.DASH_KV.get(KV_PDPINV, 'json')) || null, hist: (await env.DASH_KV.get(KV_PDPHIST, 'json')) || {}, meta: (await env.DASH_KV.get(KV_PDPMETA, 'json')) || null });
