// Sign-in (Cloudflare Access one-time PIN) + role-based, page-level access control.
// Deny by default: a signed-in email sees nothing until an admin approves it with a role.
// The Access login token is verified cryptographically (RS256, audience, issuer, expiry) — never trust headers alone.

export const PAGES = [
  ['home', 'Home: top highlights'],
  ['retail', 'Retail Revenue overview'],
  ['walkin.overview', 'Walk-in · Overview'],
  ['walkin.capture', 'Walk-in · Capture'],
  ['walkin.followup', 'Walk-in · Follow-up'],
  ['walkin.revenue', 'Walk-in · Revenue'],
  ['walkin.product', 'Walk-in · Product & category'],
  ['walkin.loss', 'Walk-in · Loss analysis'],
  ['walkin.definitions', 'Walk-in · Funnel & definitions'],
  ['bot', 'Ask-data bot'],
  ['admin', 'Admin & user management'],
];
const ALL = PAGES.map(([k]) => k);
const WALKIN = ALL.filter((k) => k.startsWith('walkin.'));
export const ROLES = {
  admin: { label: 'Admin (Founders Office)', perms: ALL },
  leadership: { label: 'Leadership — all dashboards, read-only', perms: ALL.filter((k) => k !== 'admin') },
  retail_vp: { label: 'Retail VP — Retail Revenue section only', perms: ['retail', ...WALKIN, 'bot'] },
  walkin_viewer: { label: 'Walk-in viewer — walk-in dashboard only', perms: [...WALKIN, 'bot'] },
  store_manager: { label: 'Store manager — own store(s), no revenue tabs', perms: ['walkin.overview', 'walkin.capture', 'walkin.followup', 'walkin.definitions'] },
};

const b64u = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); s += '='.repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); };
const jsonPart = (s) => JSON.parse(new TextDecoder().decode(b64u(s)));
let CERTS = { team: null, at: 0, keys: [] };
async function certs(team, fetcher = fetch, force = false) {
  if (!force && CERTS.team === team && Date.now() - CERTS.at < 3600e3 && CERTS.keys.length) return CERTS.keys;
  const r = await fetcher(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('could not load Access signing keys');
  const j = await r.json(); CERTS = { team, at: Date.now(), keys: j.keys || [] }; return CERTS.keys;
}
export async function verifyAccessJwt(token, env, fetcher) {
  const team = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const [h, p, sig] = String(token || '').split('.');
  if (!h || !p || !sig) throw new Error('malformed token');
  const header = jsonPart(h), payload = jsonPart(p);
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');
  // Try the cached signing keys; if they don't verify (e.g. Cloudflare rotated keys), re-fetch once and retry.
  const check = async (force) => {
    const jwk = (await certs(team, fetcher, force)).find((k) => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(sig), new TextEncoder().encode(`${h}.${p}`));
  };
  if (!(await check(false)) && !(await check(true))) throw new Error('bad signature');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new Error('token is for another application');
  if (payload.iss !== `https://${team}`) throw new Error('token from another team');
  const now = Date.now() / 1000;
  if (!(payload.exp > now) || (payload.nbf && payload.nbf > now + 60)) throw new Error('token expired');
  if (!payload.email) throw new Error('no email in token');
  return String(payload.email).trim().toLowerCase();
}
const cookie = (req, name) => (req.headers.get('cookie') || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];

export function resolvePerms(u) {
  const base = ROLES[u.role]?.perms || [];
  const deny = new Set(u.deny || []);
  return base.filter((p) => !deny.has(p));
}
// Who is this, and what may they see?
export async function identify(request, env, fetcher) {
  const enforced = !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
  if (!enforced) return { enforced: false, approved: true, email: null, role: 'open', perms: ALL.filter((k) => k !== 'admin'), stores: [] };
  const token = request.headers.get('cf-access-jwt-assertion') || cookie(request, 'CF_Authorization');
  if (!token) return { enforced, approved: false, reason: 'You are not signed in. If you were not asked for your email, Cloudflare Access is not switched on for this address yet — tell the Founders Office.' };
  let email; try { email = await verifyAccessJwt(token, env, fetcher); } catch (e) { return { enforced, approved: false, reason: 'Your sign-in could not be verified — please sign in again.' }; }
  const admins = String(env.ADMIN_EMAILS || '').split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (admins.includes(email)) return { enforced, approved: true, email, name: '', role: 'admin', perms: ROLES.admin.perms, stores: [] };
  const users = (await env.DASH_KV.get('rbac:users', 'json')) || {};
  const u = users[email];
  if (!u || u.disabled || !ROLES[u.role]) return { enforced, approved: false, email, reason: 'This email is not approved for the dashboard yet. Ask the Founders Office for access.' };
  return { enforced, approved: true, email, name: u.name || '', role: u.role, perms: resolvePerms(u), stores: Array.isArray(u.stores) ? u.stores : [] };
}
export const can = (id, perm) => !!id && id.approved && id.perms.includes(perm);
export const canWalkin = (id) => WALKIN.some((p) => can(id, p)) || can(id, 'home') || can(id, 'retail');
// The bot can see every walk-in number, so it is only for people with full, all-store walk-in access.
export const canBot = (id) => can(id, 'bot') && WALKIN.every((p) => can(id, p)) && !(id.stores || []).length;

// Trim the dashboard payload to what this person may see (server-side, so hidden pages cannot be read via browser tools).
const FOLLOWUP = ['pipeline', 'hygiene', 'aging', 'firstCall', 'atRisk'];
const PRODUCT_ROWS = ['productSales', 'productAttributed'];
const INTEREST = ['interestProd', 'interestCat', 'interestLead', 'interestMatrix'];
export function filterMetrics(m, id) {
  if (!canWalkin(id)) return null;
  const full = WALKIN.every((p) => can(id, p)) && !(id.stores || []).length;
  if (full) return m;
  const out = { ...m };
  const empty = (keys) => keys.forEach((k) => { if (k in out) out[k] = []; });
  if (!can(id, 'walkin.followup')) empty(FOLLOWUP);
  if (!can(id, 'walkin.loss')) empty(['loss']);
  if (!can(id, 'walkin.revenue')) empty(['cohorts', 'cohortRevenue']);
  if (!can(id, 'walkin.product') && !can(id, 'walkin.revenue')) empty([...PRODUCT_ROWS, 'products', 'productCats']);
  if (!can(id, 'walkin.product')) empty(INTEREST);
  const scope = new Set(id.stores || []);
  if (scope.size) {
    for (const [k, v] of Object.entries(out)) {
      if (!Array.isArray(v) || !v.length) continue;
      if (k === 'stores') out[k] = v.filter((s) => scope.has(s.id));
      else if (v[0] && typeof v[0] === 'object' && !Array.isArray(v[0]) && 's' in v[0]) out[k] = v.filter((x) => scope.has(x.s));
      else if (Array.isArray(v[0]) && typeof v[0][1] === 'string' && /^(FRIDO_|UNMAPPED)/.test(v[0][1])) out[k] = v.filter((x) => scope.has(x[1]));
    }
    out.quality = {}; out.counts = {};
  }
  return out;
}
