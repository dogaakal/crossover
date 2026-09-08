/* ══ CROSSOVER ══ live football crossover ledger, powered by Wikidata ══ */
'use strict';

const WDQS = 'https://query.wikidata.org/sparql';
const WIKI = 'https://en.wikipedia.org/w/api.php';
const $ = (s, r = document) => r.querySelector(s);

/* ── 1. data layer ──────────────────────────────────────────── */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The public endpoint throws the occasional 429/502 under load, so retry the
   transient ones twice before surfacing a failure. */
async function sparql(query, signal, tries = 3) {
  const url = `${WDQS}?format=json&query=${encodeURIComponent(query)}`;
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'application/sparql-results+json' } });
      if (res.ok) {
        const json = await res.json();
        return json.results.bindings.map(row => {
          const o = {};
          for (const k in row) o[k] = row[k].value;
          return o;
        });
      }
      last = new Error(`Wikidata replied ${res.status}`);
      if (res.status < 500 && res.status !== 429) throw last;   // our fault, don't retry
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      last = e;
    }
    if (attempt < tries) await sleep(400 * attempt);
  }
  throw last;
}

const qid = uri => (uri || '').split('/').pop();
const https = u => (u || '').replace(/^http:\/\//i, 'https://');
/* Commons serves a scaled copy via Special:FilePath?width= — ask for a small one */
const thumb = (u, w) => { u = https(u); return u ? u + (u.includes('?') ? '&' : '?') + 'width=' + w : ''; };

/* Search clubs. The type taxonomy on Wikidata is unreliable (FC Barcelona is
   not even an "association football club"), so we filter on the thing that
   actually matters: somebody, somewhere, played for it. */
const SEARCH_Q = term => `
SELECT DISTINCT ?item ?itemLabel ?itemDescription ?logo ?countryLabel ?wpTitle ?links ?ord WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "EntitySearch" ; wikibase:endpoint "www.wikidata.org" ;
      mwapi:search ${JSON.stringify(term)} ; mwapi:language "en" ; mwapi:limit "50" .
    ?item wikibase:apiOutputItem mwapi:item . ?ord wikibase:apiOrdinal true .
  }
  FILTER EXISTS { ?someone p:P54/ps:P54 ?item }
  OPTIONAL { ?item wikibase:sitelinks ?links }   # how many Wikipedias cover it = notability
  OPTIONAL { ?item wdt:P154 ?logo }
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?wp schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?wpTitle }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?ord LIMIT 14`;

const FOOTY = /football|soccer|fútbol|futebol|calcio/i;
const NOT_FOOTY = /basketball|handball|volleyball|ice hockey|rugby|cricket|futsal|table tennis|water polo|baseball|athletics/i;

/* fold accents and drop the club-type noise so "Besiktas" matches "Beşiktaş J.K." */
const norm = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/\b(fc|cf|sk|jk|afc|sc|ac|cd|f\.c\.|c\.f\.)\b/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

async function searchClubs(term, signal) {
  const rows = await sparql(SEARCH_Q(term), signal);
  const q = norm(term);
  const seen = new Map();
  rows.forEach((r, i) => {
    const id = qid(r.item);
    if (seen.has(id)) return;
    const desc = r.itemDescription || '';
    const label = norm(r.itemLabel);
    let score = i;
    // Wikidata's own relevance order puts "Boca Juniors de Cali" above "Boca
    // Juniors", so weight how closely the name actually matches what was typed
    if (label === q) score -= 18;
    else if (label.startsWith(q + ' ')) score -= 12;
    else if (label.startsWith(q)) score -= 8;
    score += Math.min(label.length - q.length, 30) * 0.25;
    if (r.wpTitle) score -= 4;
    // name similarity alone promotes tiny namesakes over the famous club, so
    // weigh how many Wikipedias bother to cover the item
    score -= Math.min(+(r.links || 0), 140) * 0.22;
    // things that are plainly not clubs still slip past the has-players test
    if (/\b(district|city|town|village|municipality|neighbou?rhood|province|station|region|county)\b/i.test(desc))
      score += 60;
    if (NOT_FOOTY.test(desc)) score += 100;      // demote other sports
    if (FOOTY.test(desc)) score -= 6;            // promote football
    if (/women|female|femen|vrouwen|féminine|women's/i.test(desc + r.itemLabel)) score += 14;
    if (/\bU-?\d\d\b|youth|reserve|academy|amateur|\bB\b|Castilla|Next Gen/i.test(r.itemLabel)) score += 12;
    seen.set(id, {
      id, score,
      name: r.itemLabel || id,
      desc,
      country: r.countryLabel || '',
      logo: r.logo || '',
      wp: r.wpTitle || ''
    });
  });
  return [...seen.values()].sort((a, b) => a.score - b.score).slice(0, 8);
}

/* Crests: Wikipedia's page image is the club badge and covers non-free crests
   (PSG, Real, United) that Wikidata's P154 is missing. */
const crestCache = new Map();
async function crestUrl(club) {
  if (crestCache.has(club.id)) return crestCache.get(club.id);
  let url = '';
  if (club.wp) {
    try {
      const u = `${WIKI}?action=query&format=json&origin=*&prop=pageimages&piprop=thumbnail` +
                `&pithumbsize=320&pilicense=any&redirects=1&titles=${encodeURIComponent(club.wp)}`;
      const j = await (await fetch(u)).json();
      const pages = j?.query?.pages || {};
      for (const p of Object.values(pages)) if (p.thumbnail?.source) url = https(p.thumbnail.source);
    } catch { /* fall through to Wikidata's logo */ }
  }
  if (!url && club.logo) url = thumb(club.logo, 320);
  crestCache.set(club.id, url);
  return url;
}

/* The crossover query. Two direct joins instead of FILTER EXISTS — that alone
   took this from 21s to ~1s. */
const CROSS_Q = (a, b) => `
SELECT ?p ?pLabel ?img ?club ?start ?end ?apps ?goals ?posLabel ?natLabel WHERE {
  ?p p:P54/ps:P54 wd:${a} . ?p p:P54/ps:P54 wd:${b} .
  VALUES ?club { wd:${a} wd:${b} }
  ?p p:P54 ?st . ?st ps:P54 ?club .
  OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end }
  OPTIONAL { ?st pq:P1350 ?apps } OPTIONAL { ?st pq:P1351 ?goals }
  OPTIONAL { ?p wdt:P18 ?img }
  OPTIONAL { ?p wdt:P413 ?pos } OPTIONAL { ?p wdt:P27 ?nat }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,es,fr,de,pt,it,nl,tr,ca,sv,pl". }
}`;

const yr = d => (d && /^-?\d{4}/.test(d.replace('-', '')) ? parseInt(d.slice(0, 4), 10) : (d ? parseInt(d.slice(0, 5), 10) : null));

function groupPlayers(rows, aId, bId) {
  const map = new Map();
  for (const r of rows) {
    const id = qid(r.p);
    if (!map.has(id)) {
      map.set(id, {
        id, name: r.pLabel || id, img: r.img || '',
        pos: new Set(), nat: new Set(),
        spells: new Map()          // key → spell
      });
    }
    const pl = map.get(id);
    if (r.posLabel && !/^Q\d+$/.test(r.posLabel)) pl.pos.add(r.posLabel);
    if (r.natLabel && !/^Q\d+$/.test(r.natLabel)) pl.nat.add(r.natLabel);
    const club = qid(r.club);
    const key = `${club}|${r.start || ''}|${r.end || ''}`;
    const prev = pl.spells.get(key) || { club, from: yr(r.start), to: yr(r.end), apps: null, goals: null };
    if (r.apps != null) prev.apps = Math.max(prev.apps ?? 0, +r.apps);
    if (r.goals != null) prev.goals = Math.max(prev.goals ?? 0, +r.goals);
    pl.spells.set(key, prev);
  }

  return [...map.values()].map(p => {
    let spells = [...p.spells.values()];
    // drop a dateless duplicate when a dated spell for the same club exists
    for (const side of [aId, bId]) {
      const same = spells.filter(s => s.club === side);
      if (same.length > 1 && same.some(s => s.from != null))
        spells = spells.filter(s => s.club !== side || s.from != null || s.apps != null);
    }
    spells.sort((s, t) => (s.from ?? 9999) - (t.from ?? 9999));
    const firstAt = c => Math.min(...spells.filter(s => s.club === c).map(s => s.from ?? 9999));
    const fa = firstAt(aId), fb = firstAt(bId);
    const years = spells.map(s => s.from).filter(v => v != null);
    const ends = spells.map(s => s.to ?? s.from).filter(v => v != null);
    return {
      ...p,
      spells,
      pos: [...p.pos], nat: [...p.nat],
      dir: fa === fb ? 'ab' : (fa < fb ? 'ab' : 'ba'),
      first: years.length ? Math.min(...years) : null,
      last: ends.length ? Math.max(...ends) : null,
      apps: spells.reduce((n, s) => n + (s.apps || 0), 0),
      goals: spells.reduce((n, s) => n + (s.goals || 0), 0)
    };
  });
}

/* ── 2. colour: read the actual crest pixels ─────────────────── */

function pickColor(url) {
  return new Promise(resolve => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => resolve(null);
    img.onload = () => {
      try {
        const N = 46, c = document.createElement('canvas');
        c.width = c.height = N;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, N, N);
        const d = ctx.getImageData(0, 0, N, N).data;
        const bins = new Map();
        let opaque = 0, inked = 0;
        for (let i = 0; i < d.length; i += 4) {
          const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
          if (a < 200) continue;
          opaque++;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (mx > 232 && mn > 210) continue;                 // paper / white
          inked++;
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          const key = `${r >> 4},${g >> 4},${b >> 4}`;
          const o = bins.get(key) || { n: 0, r: 0, g: 0, b: 0, sat: 0 };
          o.n++; o.r += r; o.g += g; o.b += b; o.sat += sat;
          bins.set(key, o);
        }
        // almost nothing left once white is removed => a white/pale badge that
        // would vanish on a white plate, so it needs a dark one
        const pale = opaque > 0 && inked / opaque < 0.14;
        let best = null, bestScore = -1;
        for (const o of bins.values()) {
          const sat = o.sat / o.n;
          const score = o.n * (0.30 + sat * 1.9);
          if (score > bestScore) { bestScore = score; best = o; }
        }
        if (!best) return resolve({ rgb: null, pale });
        resolve({ rgb: [best.r / best.n, best.g / best.n, best.b / best.n].map(Math.round), pale });
      } catch { resolve(null); }
    };
    img.src = url;
  });
}

/* cache the read so the same badge is only decoded once */
const paletteCache = new Map();
function palette(url) {
  if (!url) return Promise.resolve(null);
  if (!paletteCache.has(url)) paletteCache.set(url, pickColor(url));
  return paletteCache.get(url);
}
/* paint a crest onto whichever plate keeps it visible */
async function dressCrest(el, url) {
  el.style.backgroundImage = url ? `url("${url}")` : '';
  el.classList.remove('on-dark');
  el.classList.toggle('no-crest', !url);
  if (!url) return null;
  const pal = await palette(url);
  if (pal?.pale) el.classList.add('on-dark');
  return pal;
}

const hex = rgb => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = ([r, g, b]) => {
  const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  return .2126 * f(r) + .7152 * f(g) + .0722 * f(b);
};
const readable = rgb => (lum(rgb) > .42 ? '#16120E' : '#ffffff');
/* keep the disc dark enough that a white crest still reads on it */
const tame = rgb => (lum(rgb) > .62 ? rgb.map(v => v * .72) : rgb);

/* ── 3. state ───────────────────────────────────────────────── */

const S = { a: null, b: null, players: [], sort: 'recent', dir: 'all', q: '' };

/* ── 4. club pickers ────────────────────────────────────────── */

function initPicker(side) {
  const input = $('#in' + side.toUpperCase());
  const list = $('#ac' + side.toUpperCase());
  const crest = $('#crest' + side.toUpperCase());
  const picked = $('#pick' + side.toUpperCase());
  const clear = $('#clear' + side.toUpperCase());
  let ctrl = null, timer = null, items = [], cursor = -1;

  const close = () => { list.hidden = true; cursor = -1; };

  const choose = async club => {
    S[side] = club;
    input.value = club.name;
    close();
    picked.hidden = false;
    picked.innerHTML = `<span class="tick">✓</span> ${esc(club.desc || club.country || 'club')}`;
    const url = await crestUrl(club);
    club.crest = url;
    crest.dataset.empty = url ? '0' : '1';
    const pal = await dressCrest(crest, url);
    club.rgb = pal?.rgb || null;
    club.pale = !!pal?.pale;
    if (club.rgb) {
      document.documentElement.style.setProperty('--' + side, hex(tame(club.rgb)));
      document.documentElement.style.setProperty(`--${side}-ink`, readable(tame(club.rgb)));
    }
    syncGo();
  };

  const render = () => {
    if (!items.length) { list.innerHTML = '<li class="ac-msg">No club by that name has any players on record.</li>'; list.hidden = false; return; }
    list.innerHTML = items.map((c, i) => `
      <li role="option" data-i="${i}" aria-selected="${i === cursor}">
        <span class="ac-crest" data-id="${c.id}"></span>
        <span class="ac-body">
          <span class="ac-name">${esc(c.name)}</span>
          <span class="ac-sub">${esc([c.country, c.desc].filter(Boolean).join(' · ')) || 'club'}</span>
        </span>
      </li>`).join('');
    list.hidden = false;
    items.forEach(async (c, i) => {
      const u = await crestUrl(c);
      const el = list.querySelector(`li[data-i="${i}"] .ac-crest`);
      if (el && u) dressCrest(el, u);
    });
  };

  input.addEventListener('input', () => {
    S[side] = null; picked.hidden = true;
    crest.dataset.empty = '1'; crest.style.backgroundImage = '';
    syncGo();
    clearTimeout(timer); ctrl?.abort();
    const term = input.value.trim();
    if (term.length < 2) { close(); return; }
    list.innerHTML = '<li class="ac-msg">searching…</li>'; list.hidden = false;
    timer = setTimeout(async () => {
      ctrl = new AbortController();
      try {
        items = await searchClubs(term, ctrl.signal);
        cursor = -1;
        render();
      } catch (e) { if (e.name !== 'AbortError') list.innerHTML = '<li class="ac-msg">Search failed — try again.</li>'; }
    }, 260);
  });

  input.addEventListener('keydown', e => {
    if (list.hidden) { if (e.key === 'Enter' && S.a && S.b) run(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = (cursor + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      render();
      list.children[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[cursor >= 0 ? cursor : 0]) choose(items[cursor >= 0 ? cursor : 0]);
    } else if (e.key === 'Escape') close();
  });

  // pointerdown fires before the input blurs (preventDefault keeps focus put) and
  // covers touch and pen; click is the belt-and-braces fallback. Once chosen the
  // list is closed, so the second event finds no row and does nothing.
  const pick = e => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    const club = items[+li.dataset.i];
    if (club) choose(club);
  };
  list.addEventListener('pointerdown', pick);
  list.addEventListener('click', pick);
  input.addEventListener('blur', () => setTimeout(close, 140));
  clear.addEventListener('click', () => {
    input.value = ''; S[side] = null; picked.hidden = true;
    crest.dataset.empty = '1'; crest.style.backgroundImage = ''; close(); syncGo(); input.focus();
  });

  return { choose, input };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const syncGo = () => { $('#go').disabled = !(S.a && S.b && S.a.id !== S.b.id); };

/* ── 5. the run ─────────────────────────────────────────────── */

async function run() {
  if (!S.a || !S.b || S.a.id === S.b.id) return;
  const go = $('#go'), status = $('#status');
  go.classList.add('busy');
  status.hidden = false; status.className = 'status';
  status.textContent = `Reading every career on file for ${S.a.name} and ${S.b.name}…`;
  $('#results').hidden = true;
  $('#stage').hidden = true;

  const t0 = performance.now();
  try {
    const rows = await sparql(CROSS_Q(S.a.id, S.b.id));
    S.players = groupPlayers(rows, S.a.id, S.b.id);
    const ms = Math.round(performance.now() - t0);
    $('#qtime').textContent = `${S.players.length} records · ${ms} ms · wdqs`;
    status.hidden = true;
    paintStage();
    paintResults();
    location.hash = `${S.a.id}-${S.b.id}`;
    $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    status.className = 'status err';
    status.textContent = navigator.onLine === false
      ? 'You are offline. Crossover reads every result live from Wikidata, so it needs a connection.'
      : `Couldn't reach Wikidata — ${e.message}. Try again in a moment.`;
  } finally {
    go.classList.remove('busy');
  }
}

/* ── 6. the stage: venn, odometer, ticker, facts ─────────────── */

function paintStage() {
  const stage = $('#stage'), venn = $('#venn');
  stage.hidden = false;
  venn.classList.remove('in');

  const set = (sel, club) => dressCrest($(sel).querySelector('.disc-crest'), club.crest);
  set('#discA', S.a); set('#discB', S.b);

  const n = S.players.length;
  $('#tallyCap').textContent = n === 0
    ? 'no player has worn both shirts'
    : `player${n === 1 ? ' has' : 's have'} worn both shirts`;
  const band = c => (c.rgb ? hex(c.rgb) : 'transparent');
  $('#tallyClubs').innerHTML =
    `<b><i style="--band:${band(S.a)}"></i>${esc(S.a.name)}</b>` +
    `&nbsp; × &nbsp;` +
    `<b><i style="--band:${band(S.b)}"></i>${esc(S.b.name)}</b>`;

  odometer($('#odo'), S.players.length);
  // rAF is throttled in background tabs, so guarantee the reveal with a timer too
  const reveal = () => venn.classList.add('in');
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  setTimeout(reveal, 120);

  // ticker
  const names = S.players.map(p => p.name);
  const tick = $('#ticker');
  if (names.length > 3) {
    const strip = names.map(n => `<b>${esc(n)}</b>`).join('');
    $('#tickerIn').innerHTML = strip + strip;
    tick.hidden = false;
  } else tick.hidden = true;

  // facts
  const dated = S.players.filter(p => p.first != null);
  const earliest = dated.length ? dated.reduce((m, p) => p.first < m.first ? p : m) : null;
  const topApps = S.players.reduce((m, p) => (p.apps > (m?.apps ?? -1) ? p : m), null);
  const ab = S.players.filter(p => p.dir === 'ab').length;
  const facts = [
    ['Shared players', S.players.length],
    earliest ? ['First on record', `${earliest.first} · ${earliest.name.split(' ').pop()}`] : null,
    topApps && topApps.apps > 0 ? ['Most appearances', `${topApps.name.split(' ').pop()} · ${topApps.apps}`] : null,
    ['Direction', `${ab} →  ·  ${S.players.length - ab} ←`]
  ].filter(Boolean);
  $('#facts').innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
}

function odometer(el, n) {
  const digits = String(n).split('');
  el.innerHTML = digits.map(() =>
    `<span class="reel"><span class="reel-in">${'0123456789'.split('').map(d => `<span>${d}</span>`).join('')}</span></span>`
  ).join('');
  const spin = () => el.querySelectorAll('.reel-in').forEach((r, i) => {
    r.style.transitionDelay = `${0.5 + i * 0.09}s`;
    r.style.transform = `translateY(-${digits[i] * 10}%)`;
  });
  requestAnimationFrame(spin);
  setTimeout(spin, 120);
}

/* ── 7. results ─────────────────────────────────────────────── */

function paintResults() {
  $('#results').hidden = false;
  $('#dirAB').textContent = `${tiny(S.a.name)} → ${tiny(S.b.name)}`;
  $('#dirBA').textContent = `${tiny(S.b.name)} → ${tiny(S.a.name)}`;
  $('#dirAB').title = `Moved from ${S.a.name} to ${S.b.name}`;
  $('#dirBA').title = `Moved from ${S.b.name} to ${S.a.name}`;
  paintGrid();
}

const short = n => n.replace(/\b(FC|CF|SK|JK|AFC|F\.C\.|C\.F\.|Club de Fútbol|Football Club)\b/g, '').trim().split(/\s+/).slice(0, 2).join(' ');
/* the A→B / B→A buttons sit three-across on a phone, so they get one word each */
const tiny = n => {
  const w = short(n).split(/\s+/);
  return (w[0].length > 11 ? w[0].slice(0, 10) + '.' : w[0]);
};

function paintGrid() {
  let list = S.players.slice();
  if (S.q) list = list.filter(p => p.name.toLowerCase().includes(S.q));
  if (S.dir !== 'all') list = list.filter(p => p.dir === S.dir);

  const cmp = {
    recent: (x, y) => (y.last ?? y.first ?? -9999) - (x.last ?? x.first ?? -9999),
    oldest: (x, y) => (x.first ?? 9999) - (y.first ?? 9999),
    apps: (x, y) => y.apps - x.apps,
    goals: (x, y) => y.goals - x.goals,
    az: (x, y) => x.name.localeCompare(y.name)
  }[S.sort];
  list.sort(cmp);

  $('#resCount').textContent = list.length;
  const grid = $('#grid'), empty = $('#empty');
  if (!list.length) {
    grid.innerHTML = '';
    empty.hidden = false;
    empty.textContent = S.players.length
      ? 'No player matches that filter.'
      : `No player in Wikidata has ever appeared for both ${S.a.name} and ${S.b.name}.`;
    return;
  }
  empty.hidden = true;
  grid.innerHTML = list.map((p, i) => card(p, i)).join('');
}

const CLR = id => (id === S.a.id ? (S.a.rgb ? hex(S.a.rgb) : 'var(--a)') : (S.b.rgb ? hex(S.b.rgb) : 'var(--b)'));
const NAME = id => (id === S.a.id ? S.a.name : S.b.name);

function card(p, i) {
  const accent = p.dir === 'ab' ? CLR(S.a.id) : CLR(S.b.id);
  const initials = p.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const tilt = (i % 3 - 1) * 1.4;
  // initials always sit underneath, so a slow or dead portrait never leaves a hole
  const shot = `<span class="mono">${esc(initials)}</span>` + (p.img
    ? `<img src="${esc(thumb(p.img, 220))}" alt="" decoding="async"
           loading="${i < 8 ? 'eager' : 'lazy'}" onerror="this.remove()">` : '');

  const tags = [
    ...p.pos.slice(0, 1).map(v => `<span class="tagx pos">${esc(v)}</span>`),
    ...p.nat.slice(0, 2).map(v => `<span class="tagx">${esc(v)}</span>`)
  ].join('');

  const spells = p.spells.map(s => `
    <li>
      <span class="sw" style="background:${CLR(s.club)}"></span>
      <span class="sp-club">${esc(short(NAME(s.club)))}<i>${s.from ? s.from + (s.to && s.to !== s.from ? '–' + s.to : (s.to ? '' : '–')) : 'dates unknown'}</i></span>
      <span class="sp-num">${s.apps != null ? `<b>${s.apps}</b> app${s.apps === 1 ? '' : 's'}` : '—'}${s.goals ? ` · <b>${s.goals}</b> g` : ''}</span>
    </li>`).join('');

  return `
  <article class="card" style="--tilt:${tilt}deg;--accent:${accent};animation-delay:${Math.min(i, 24) * 32}ms">
    <div class="card-top">
      <div class="shot">${shot}</div>
      <div class="card-id">
        <h3 class="p-name"><a href="https://www.wikidata.org/wiki/${p.id}" target="_blank" rel="noopener">${esc(p.name)}</a></h3>
        <div class="p-meta">${tags}</div>
      </div>
    </div>
    ${bridge(p)}
    <ul class="spells">${spells}</ul>
    <div class="card-foot"><span>${p.dir === 'ab' ? short(S.a.name) + ' → ' + short(S.b.name) : short(S.b.name) + ' → ' + short(S.a.name)}</span><span class="no">${String(i + 1).padStart(3, '0')}</span></div>
  </article>`;
}

/* a little career-bridge chart: two bars on a shared year axis, joined by an arc */
function bridge(p) {
  const dated = p.spells.filter(s => s.from != null);
  if (dated.length < 2) return '';
  const lo = Math.min(...dated.map(s => s.from));
  const hi = Math.max(...dated.map(s => (s.to ?? s.from) + 1));
  if (hi <= lo) return '';
  const W = 246, PAD = 8;
  const x = v => PAD + ((v - lo) / (hi - lo)) * (W - PAD * 2);

  const bars = dated.map(s => {
    const y = s.club === S.a.id ? 40 : 20;
    const x1 = x(s.from), x2 = Math.max(x(( s.to ?? s.from) + 1), x1 + 3);
    return `<line class="bar" x1="${x1.toFixed(1)}" y1="${y}" x2="${x2.toFixed(1)}" y2="${y}" stroke="${CLR(s.club)}"/>`;
  }).join('');

  // arc from the last spell of the first club to the first spell of the second
  const aS = dated.filter(s => s.club === S.a.id), bS = dated.filter(s => s.club === S.b.id);
  let arc = '';
  if (aS.length && bS.length) {
    const fromA = p.dir === 'ab';
    const src = fromA ? aS[aS.length - 1] : bS[bS.length - 1];
    const dst = fromA ? bS[0] : aS[0];
    const x1 = x((src.to ?? src.from) + 1), y1 = src.club === S.a.id ? 40 : 20;
    const x2 = x(dst.from), y2 = dst.club === S.a.id ? 40 : 20;
    const mid = (y1 + y2) / 2 + (y1 > y2 ? -13 : 13);
    const d = `M${x1.toFixed(1)},${y1} C${((x1 + x2) / 2).toFixed(1)},${mid} ${((x1 + x2) / 2).toFixed(1)},${mid} ${x2.toFixed(1)},${y2}`;
    const len = Math.hypot(x2 - x1, y2 - y1) + 40;
    arc = `<path class="arc" d="${d}" style="--len:${len.toFixed(0)}"/>
           <circle class="head" cx="${x2.toFixed(1)}" cy="${y2}" r="2.6"/>`;
  }

  return `<div class="bridge"><svg viewBox="0 0 ${W} 66" preserveAspectRatio="none" aria-hidden="true">
    <line x1="${PAD}" y1="56" x2="${W - PAD}" y2="56" stroke="#16120E" stroke-width="1" opacity=".3"/>
    ${bars}${arc}
    <text class="yr" x="${PAD}" y="65">${lo}</text>
    <text class="yr" x="${W - PAD}" y="65" text-anchor="end">${hi - 1}</text>
  </svg></div>`;
}

/* ── 8. presets, cursor, wiring ─────────────────────────────── */

const PRESETS = [
  ['Barcelona × Paris SG',  { id: 'Q7156', name: 'FC Barcelona', wp: 'FC Barcelona' },        { id: 'Q483020', name: 'Paris Saint-Germain FC', wp: 'Paris Saint-Germain F.C.' }],
  ['Real Madrid × United',  { id: 'Q8682', name: 'Real Madrid CF', wp: 'Real Madrid CF' },     { id: 'Q18656', name: 'Manchester United FC', wp: 'Manchester United F.C.' }],
  ['Inter × Juventus',      { id: 'Q631',  name: 'Inter Milan', wp: 'Inter Milan' },           { id: 'Q1422',  name: 'Juventus FC', wp: 'Juventus FC' }],
  ['Liverpool × United',    { id: 'Q1130849', name: 'Liverpool FC', wp: 'Liverpool F.C.' },    { id: 'Q18656', name: 'Manchester United FC', wp: 'Manchester United F.C.' }],
  ['Ajax × Barcelona',      { id: 'Q81888', name: 'AFC Ajax', wp: 'AFC Ajax' },                { id: 'Q7156',  name: 'FC Barcelona', wp: 'FC Barcelona' }],
  ['Galatasaray × Inter',   { id: 'Q495299', name: 'Galatasaray SK', wp: 'Galatasaray S.K. (football)' }, { id: 'Q631', name: 'Inter Milan', wp: 'Inter Milan' }]
];

let pickers;

async function loadPair(a, b, go = true) {
  await pickers.a.choose(a);
  await pickers.b.choose(b);
  if (go) run();
}

function initCursor() {
  const dot = $('.cursor');
  if (window.matchMedia('(pointer:coarse)').matches) return;
  let x = 0, y = 0, cx = 0, cy = 0;
  addEventListener('pointermove', e => {
    x = e.clientX; y = e.clientY;
    const t = e.target;
    dot.classList.toggle('hot', !!t.closest('button,a,li[data-i],.chip,.card'));
    dot.classList.toggle('txt', !!t.closest('input,select'));
  }, { passive: true });
  (function loop() {
    cx += (x - cx) * .22; cy += (y - cy) * .22;
    dot.style.transform = `translate(${cx}px,${cy}px)`;
    requestAnimationFrame(loop);
  })();
}

/* ── installing to a home screen ────────────────────────────── */

const standalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: minimal-ui)').matches ||
  navigator.standalone === true;              // iOS Safari's own flag

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.platform || '') ||
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);  // iPadOS

const isAndroid = () => /Android/i.test(navigator.userAgent);
// iPadOS 13+ reports itself as a Mac and only the touch points give it away.
// Match "Macintosh", not "Mac": an iPhone's UA says "like Mac OS X" too, which
// would otherwise label every iPhone an iPad.
const isIPad = () => !/iPhone|iPod/.test(navigator.userAgent) &&
  (/iPad/.test(navigator.userAgent) ||
   (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/* Name the platform on the button, so nobody is left wondering whether it is
   meant for their phone. Saying "(Android)" to an iPhone user would be worse
   than saying nothing, so each platform is told only about itself. */
function installLabel() {
  if (isIOS()) return `Add to Home Screen (${isIPad() ? 'iPad' : 'iPhone'})`;
  if (isAndroid()) return 'Install app (Android)';
  return 'Install app';
}

const SHARE_GLYPH = '<span class="shareglyph" aria-hidden="true"></span>';
function installTip() {
  if (isIOS())
    return `<b>On iPhone or iPad:</b> tap <b>Share</b> ${SHARE_GLYPH} in Safari, then
            <b>Add to Home Screen</b>. It opens full-screen, like an app.`;
  if (isAndroid())
    // no ⋮ glyph: it renders as a colon in this typeface
    return `<b>On Android:</b> open the browser menu (top right) and choose
            <b>Install app</b>, or <b>Add to Home screen</b>.`;
  return `<b>To install:</b> use the install icon in your browser's address bar,
          or the browser menu.`;
}

function initInstall() {
  const btn = $('#install'), tip = $('#iosTip'), label = $('#installLabel');
  if (!btn) return;
  if (standalone()) return;                   // already installed, nothing to offer

  label.textContent = installLabel();
  $('#tipText').innerHTML = installTip();

  let deferred = null;

  // Chrome and Edge hand us a real prompt to fire.
  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });

  // Safari never fires that event, so offer the manual route straight away.
  if (isIOS()) btn.hidden = false;

  // Android browsers that give no prompt (Firefox, Samsung Internet, or Chrome
  // when it decides not to) still install from the menu — say so rather than
  // leaving the button missing.
  else if (isAndroid()) setTimeout(() => { if (!deferred) btn.hidden = false; }, 2500);

  btn.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      if (outcome === 'accepted') btn.hidden = true;
      return;
    }
    tip.hidden = !tip.hidden;                 // no prompt available: explain the manual route
  });

  $('#tipClose')?.addEventListener('click', () => { tip.hidden = true; });

  addEventListener('appinstalled', () => { btn.hidden = true; tip.hidden = true; });
}

/* The worker only makes the shell installable and openable offline; it is set
   up never to cache Wikidata answers. */
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  // When a new worker takes over an already-controlled page, reload once so the
  // new build is actually the one running. Guarded on hadController, otherwise
  // the very first install would reload the page out from under the visitor.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });

  const register = () => navigator.serviceWorker.register('sw.js')
    .catch(err => console.warn('[crossover] service worker did not register:', err));
  // boot() frequently runs after 'load' has already fired, in which case a
  // listener for it would never run at all — register straight away instead.
  if (document.readyState === 'complete') register();
  else addEventListener('load', register, { once: true });
}

function boot() {
  pickers = { a: initPicker('a'), b: initPicker('b') };

  $('#issueDate').textContent = new Date().toLocaleDateString('en-GB',
    { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

  $('#presetList').innerHTML = PRESETS.map((p, i) =>
    `<button class="chip" data-i="${i}" type="button">${esc(p[0])}</button>`).join('');
  $('#presetList').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (b) loadPair(PRESETS[+b.dataset.i][1], PRESETS[+b.dataset.i][2]);
  });
  $('#dice').addEventListener('click', () => {
    const p = PRESETS[Math.floor(Math.random() * PRESETS.length)];
    loadPair(p[1], p[2]);
  });

  $('#go').addEventListener('click', run);
  $('#filterQ').addEventListener('input', e => { S.q = e.target.value.trim().toLowerCase(); paintGrid(); });
  $('#sortSel').addEventListener('change', e => { S.sort = e.target.value; paintGrid(); });
  $('#dirSeg').addEventListener('click', e => {
    const b = e.target.closest('button[data-dir]');
    if (!b) return;
    [...$('#dirSeg').children].forEach(x => x.classList.toggle('on', x === b));
    S.dir = b.dataset.dir; paintGrid();
  });

  addEventListener('keydown', e => {
    if (e.key === '/' && !/input|select|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault(); $('#inA').focus();
    }
  });

  initCursor();
  initInstall();
  initServiceWorker();

  // deep link: #Q7156-Q483020
  const m = location.hash.match(/^#(Q\d+)-(Q\d+)$/);
  if (m) {
    const mk = id => ({ id, name: id, wp: '' });
    (async () => {
      const rows = await sparql(`SELECT ?item ?itemLabel ?itemDescription ?logo ?wpTitle WHERE {
        VALUES ?item { wd:${m[1]} wd:${m[2]} }
        FILTER EXISTS { ?someone p:P54/ps:P54 ?item }
        OPTIONAL { ?item wdt:P154 ?logo }
        OPTIONAL { ?wp schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?wpTitle }
        SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`);
      const byId = {};
      rows.forEach(r => byId[qid(r.item)] = { id: qid(r.item), name: r.itemLabel, desc: r.itemDescription || '', logo: r.logo || '', wp: r.wpTitle || '' });
      if (byId[m[1]] && byId[m[2]]) { loadPair(byId[m[1]], byId[m[2]]); return; }
      const st = $('#status');
      st.hidden = false; st.className = 'status err';
      st.textContent = 'That link points at something that isn\u2019t a football club. Pick two clubs above.';
    })().catch(() => {});
  }
}

document.readyState === 'loading' ? addEventListener('DOMContentLoaded', boot) : boot();
