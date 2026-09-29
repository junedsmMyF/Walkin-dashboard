// Store master — the single key across Sales (Store ID), DSR (store name) and Bigin (Store_Location / owner name).
// Agreed mapping and store format (Mall / High street), Sep 2026. Add aliases here when a new name shows up in /api/status → unmapped.
export const STORE_MASTER = [
  { id: 'FRIDO_0001', format: 'Mall', name: 'Phoenix Marketcity Vimannagar', city: 'Pune', dsr: ['Phoenix Marketcity, Vimannagar', 'Phoenix, Viman Nagar'], bigin: ['PMC Vimannagar Store', 'Phoenix marketcity Viman Nagar Pune'] },
  { id: 'FRIDO_0002', format: 'Mall', name: 'Amanora Experience Store', city: 'Pune', dsr: ['Amanora Mall, Magarpatta'], bigin: ['Amanora Mall Store', 'Amanora Mall Hadapsar Pune'] },
  { id: 'FRIDO_0003', format: 'High street', name: 'Amar Tech Park', city: 'Pune', dsr: ['Amar Tech Park, Balewadi'], bigin: ['Amar Tech Park Store', 'Amar Tech Park Balewadi Pune'] },
  { id: 'FRIDO_0005', format: 'Mall', name: 'Elpro PCMC', city: 'Pune', dsr: ['Elpro Mall, PCMC'], bigin: ['Elpro mall Store', 'Elpro Mall PCMC Pune'] },
  { id: 'FRIDO_0006', format: 'Mall', name: 'Nexus Westend, Aundh', city: 'Pune', dsr: ['Nexus Westend, Aundh', 'Westend Mall, Pune'], bigin: ['Nexus Westend Store', 'Nexus Westend Aundh Pune'] },
  { id: 'FRIDO_0008', format: 'Mall', name: 'Kopa Mall', city: 'Pune', dsr: ['Kopa Mall, Ghorpadi, KP', 'KOPA Mall, Pune'], bigin: ['KOPA MALL Store', 'Kopa Mall Mundhwa Rd Pune'] },
  { id: 'FRIDO_0009', format: 'Mall', name: 'Phoenix Mall of Asia', city: 'Bangalore', dsr: ['Mall of Asia'], bigin: ['Mall Of Asia Bengaluru', 'Mall of Asia Bangalore'] },
  { id: 'FRIDO_0010', format: 'Mall', name: 'SkyCity Borivali', city: 'Mumbai', dsr: ['Sky City Mall, Borivali', 'SkyCity Mall, Mumbai'], bigin: ['sky city borivali 009', 'Skycity Borivali Mumbai'] },
  { id: 'FRIDO_0011', format: 'Mall', name: 'Lakeshore Y junction', city: 'Hyderabad', dsr: ['Lakeshore, Y junction', 'Lakeshore Mall, Y Jn'], bigin: ['lakeshore', 'Lakeshore Y Junction'] },
  { id: 'FRIDO_0012', format: 'High street', name: 'Frido Experience Store Gachibowli', city: 'Hyderabad', dsr: ['Gachibowli, Hyderabad', 'Gachibowli, HYD'], bigin: ['Gachibowli Hyderabad'] },
  { id: 'FRIDO_0013', format: 'High street', name: 'Frido Store Banjara Hills', city: 'Hyderabad', dsr: ['Banjara Hills', 'Banjara Hills, HYD'], bigin: ['Banjara Hills Hyderabad'] },
  { id: 'FRIDO_0014', format: 'High street', name: 'Kompally Store', city: 'Hyderabad', dsr: ['Kompally, Hyderabad'], bigin: ['Kompally Store', 'Kompally Hyderabad'] },
  { id: 'FRIDO_0015', format: 'Mall', name: 'Bhartiya Mall Store', city: 'Bangalore', dsr: ['Bhartiya Mall, Bangalore'], bigin: ['Bhartiya Mall Bangalore'] },
  { id: 'FRIDO_0016', format: 'Mall', name: 'Lulu Mall', city: 'Bangalore', dsr: ['Lulu Mall, Bangalore', 'LuLu Mall, BLR'], bigin: ['LuLu Mall Bangalore'] },
  { id: 'FRIDO_0017', format: 'Mall', name: 'Vegas Mall', city: 'Delhi', dsr: ['Vegas Mall, Dwarka'], bigin: ['Vegas Mall Delhi', 'Vegas Mall Dwarka'] },
  { id: 'FRIDO_0018', format: 'High street', name: 'Golf Course Road', city: 'Gurgaon', dsr: ['Golfcourse Road, Gurgaon'], bigin: ['Golf Course Road Gurugram', 'Golf Course Road'] },
  { id: 'FRIDO_0019', format: 'High street', name: 'Omaxe Store', city: 'Faridabad', dsr: ['Omaxe world street, Faridabad'], bigin: ['Omaxe World Street Faridabad'] },
  { id: 'FRIDO_0020', format: 'Mall', name: 'PMC Whitefield', city: 'Bangalore', dsr: ['PMC, Whitefield Bangalore'], bigin: ['PMC Whitefield Mall Store', 'Phoenix Marketcity Bangalore'] },
  { id: 'FRIDO_0021', format: 'Mall', name: 'Felix Plaza', city: 'Gurgaon', dsr: ['Felix plaza, Gurgaon', 'Felix Plaza, Gurugram'], bigin: ['Felix Plaza Gurugram'] },
  { id: 'FRIDO_0022', format: 'High street', name: 'DLF summit', city: 'Gurgaon', dsr: [], bigin: ['DLF Summit Plaza', 'DLF Summit Plaza Gurugram'] },
  { id: 'FRIDO_0023', format: 'Mall', name: 'M5 Bangalore', city: 'Bangalore', dsr: ['M5 Bangalore Mall'], bigin: ['M5 Ecity Mall', 'M5 Mall Bangalore'] },
  { id: 'FRIDO_0024', format: 'Mall', name: 'Elan Miracle', city: 'Gurgaon', dsr: ['Elan Miracle Store'], bigin: ['Elan Miracle Gurugram'] },
  { id: 'FRIDO_0025', format: 'Mall', name: 'Royal Meenakshi', city: 'Bangalore', dsr: [], bigin: ['Royal Meenakshi Mall Bangalore', 'Royal Minakshi Mall Bangalore'] },
];
export const EXCLUDED_STORE_IDS = new Set(['FRIDO_0000']); // TESTSTORE

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const DSR_INDEX = new Map(); const BIGIN_INDEX = new Map();
for (const s of STORE_MASTER) {
  for (const n of [...s.dsr, s.name]) DSR_INDEX.set(norm(n), s.id);
  for (const n of s.bigin) BIGIN_INDEX.set(norm(n), s.id);
}
export const storeFromDsr = (name) => DSR_INDEX.get(norm(name)) || null;
export const storeFromBigin = (location, owner) => BIGIN_INDEX.get(norm(location)) || BIGIN_INDEX.get(norm(owner)) || null;
