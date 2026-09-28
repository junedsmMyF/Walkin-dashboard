// Product → category mapping (myfrido.com shop categories), approved 28 Sep 2026.
// First matching rule wins; product names are matched case-insensitively. Unmatched products fall into Accessories.
// To move one product, add it to CATEGORY_OVERRIDES (exact product name → category).
export const CATEGORIES = ['Chairs', 'Workspace', 'Cushions', 'Pillows', 'Mattress', 'Insoles', 'Orthotics', 'Footwear', 'Barefoot', 'Socks', 'Personal Care', 'Maternity', 'Accessories', 'Masks', 'Combos', 'Services'];
export const CATEGORY_OVERRIDES = new Map([
  ['3D Foot Scan', 'Services'],
]);
const RULES = [
  ['Combos', [/\bcombo\b/, /\bbundle\b/, /\bduo\b/, /\bkit\b/]],
  ['Maternity', [/maternity/, /pregnan/]],
  ['Barefoot', [/barefoot/]],
  ['Workspace', [/\bdesk\b/, /monitor arm/, /footrest/, /laptop/, /keyboard/, /\bmouse\b/]],
  ['Chairs', [/\bchair\b/, /\bstool\b/]],
  ['Mattress', [/mattress/, /topper/]],
  ['Pillows', [/pillow/]],
  ['Cushions', [/cushion/, /\bwedge\b/, /backrest/, /coccyx/, /seat\b/]],
  ['Insoles', [/insole/]],
  ['Socks', [/\bsocks?\b/]],
  ['Footwear', [/sandal/, /slipper/, /slides?\b/, /shoes?\b/, /sneaker/, /flip/, /clog/, /chappal/]],
  ['Masks', [/\bmask\b/]],
  ['Personal Care', [/therapy/, /nasal/, /massag/, /bath/]],
  ['Orthotics', [/orthotic/, /orthopaedic/, /orthopedic/, /posture corrector/, /\bknee\b/, /brace/, /heel protector/, /toe separator/, /\bbelt\b/, /wrist/, /elbow/, /\btape\b/, /gloves/]],
];
const cache = new Map();
export function categoryOf(name) {
  const n = String(name || '').trim();
  if (cache.has(n)) return cache.get(n);
  let c = CATEGORY_OVERRIDES.get(n);
  if (!c) { const l = n.toLowerCase(); c = 'Accessories'; outer: for (const [cat, res] of RULES) for (const re of res) if (re.test(l)) { c = cat; break outer; } }
  cache.set(n, c); return c;
}
