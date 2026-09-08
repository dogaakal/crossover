import fs from 'node:fs';
import vm from 'node:vm';

const ORIGIN = 'https://dogaakal.github.io';
const PAGE   = ORIGIN + '/crossover/';

class Res {
  constructor(url, {ok = true, status = 200, type = 'basic'} = {}) {
    this.url = url; this.ok = ok; this.status = status; this.type = type;
  }
  clone() { return new Res(this.url, {ok: this.ok, status: this.status, type: this.type}); }
}
const key = r => (typeof r === 'string' ? new URL(r, PAGE).href : r.url);

class Cache {
  constructor() { this.m = new Map(); }
  async put(req, res) { this.m.set(key(req), res); }
  async match(req)    { return this.m.get(key(req)); }
  async keys()        { return [...this.m.keys()].map(u => ({url: u})); }
  async add(req)      { const r = await ctx.fetch(key(req)); if (!r.ok) throw new Error('bad'); this.m.set(key(req), r); }
}
const store = new Map();
const caches = {
  async open(n) { if (!store.has(n)) store.set(n, new Cache()); return store.get(n); },
  async keys()  { return [...store.keys()]; },
  async delete(n) { return store.delete(n); },
  async match(req) { for (const c of store.values()) { const h = await c.match(req); if (h) return h; } }
};

let offline = false;
const fetched = [];
const handlers = {};
const ctx = {
  caches, console, URL,
  Response: Object.assign(function (b, i) { return new Res('synthetic', i); }, { error: () => new Res('err', {ok: false}) }),
  fetch: async (req) => {
    const u = key(req); fetched.push(u);
    if (offline) throw new TypeError('Failed to fetch');
    return new Res(u);
  },
  self: {
    location: new URL(PAGE + 'sw.js'),
    addEventListener: (t, fn) => { handlers[t] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} }
  }
};
ctx.self.caches = caches; ctx.self.fetch = ctx.fetch; ctx.self.Response = ctx.Response;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), ctx);

const fire = async (type, ev) => {
  const waits = []; let responded = null;
  const e = {...ev, waitUntil: p => waits.push(p), respondWith: p => { responded = p; }};
  handlers[type](e);
  await Promise.all(waits);
  return {responded: responded !== null, value: responded ? await responded : null};
};

const req = (url, mode = 'no-cors', method = 'GET') => ({url: new URL(url, PAGE).href, mode, method});
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}${extra ? '  — ' + extra : ''}`);
};

// ── install ──────────────────────────────────────────────────
await fire('install', {});
const shellName = (await caches.keys()).find(n => n.startsWith('shell'));
const cached = (await (await caches.open(shellName)).keys()).map(r => r.url);
check('install precaches the shell', cached.length >= 6, `${cached.length} entries`);
check('precache includes index/app.css/app.js',
  ['index.html', 'app.css', 'app.js'].every(f => cached.some(u => u.endsWith(f))));
check('precache is scoped under /crossover/', cached.every(u => u.startsWith(PAGE)));

// ── activate drops stale caches ──────────────────────────────
store.set('shell-crossover-OLD', new Cache());
await fire('activate', {});
check('activate deletes superseded caches', !(await caches.keys()).includes('shell-crossover-OLD'));
check('activate keeps the current cache', (await caches.keys()).includes(shellName));

// ── the critical guarantee: Wikidata is never intercepted ────
for (const host of ['https://query.wikidata.org/sparql?query=x',
                    'https://en.wikipedia.org/w/api.php?x=1',
                    'https://commons.wikimedia.org/wiki/Special:FilePath/a.jpg']) {
  const r = await fire('fetch', {request: req(host)});
  check(`passes through untouched: ${new URL(host).host}`, !r.responded);
}
const anyApiCached = [...store.values()].some(c => [...c.m.keys()].some(u => /wikidata|wikipedia|wikimedia/.test(u)));
check('no API response ever lands in a cache', !anyApiCached);

// ── fonts are cached, since the design depends on them ───────
await fire('fetch', {request: req('https://fonts.gstatic.com/s/syne/x.woff2')});
const fontsName = (await caches.keys()).find(n => n.startsWith('fonts'));
check('google fonts are cached for offline use', !!fontsName &&
  (await (await caches.open(fontsName)).keys()).length === 1);

// ── navigation: network first, cache as fallback ─────────────
fetched.length = 0;
await fire('fetch', {request: req(PAGE, 'navigate')});
check('navigation hits the network first', fetched.some(u => u === PAGE));
offline = true;
const off = await fire('fetch', {request: req(PAGE, 'navigate')});
check('navigation falls back to cache when offline', off.responded && off.value && off.value.ok);
offline = false;

// ── non-GET is left alone ────────────────────────────────────
const post = await fire('fetch', {request: req(PAGE + 'app.js', 'no-cors', 'POST')});
check('POST requests are not intercepted', !post.responded);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
