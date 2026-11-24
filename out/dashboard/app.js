// Pre-Token Radar page logic: reads window.RADAR (written by main.ts as data.js), renders the board,
// the live-token view and the methodology, with sort, filter, search and a live model sandbox.
'use strict';

const $ = (id) => document.getElementById(id);
const fmt$ = (n) => '$' + n.toLocaleString('en-US');
const fmtM = (n) => (n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : fmt$(n));
const pct = (n) => (n === null || n === undefined) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

const RADAR = window.RADAR;
let model = { ...RADAR.model };
let sortKey = 'rank', sortDir = 1, openSlug = null;

function rescore(r) {
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, r.change_7d ?? 0));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const age = r.age_days ?? model.unknown_age_days;
  const maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const chainMult = 1 + model.chain_weight * Math.min(Math.max(r.chains.length - 1, 0), model.chain_cap);
  return Math.max(1, Math.round(r.tvl_usd * model.base_multiple * growthMult * maturity * chainMult * r.sector_multiplier));
}

function chip(text) { const s = document.createElement('span'); s.className = 'chip'; s.textContent = text; return s; }

function renderMeta() {
  $('meta').innerHTML =
    `Snapshot <b>${RADAR.as_of}</b> · floor <b>${fmtM(RADAR.floor_usd)}</b><br>` +
    `<b>${RADAR.watchlist_size}</b> watchlist · <b>${RADAR.board_size}</b> ranked · <b>${RADAR.early_size}</b> early · <b>${RADAR.live_size}</b> live`;
  $('mversion').textContent = RADAR.model_version;
  $('mformula').textContent = `implied = TVL × ${model.base_multiple} × growth × maturity × chains × sector`;
  $('f-asof').textContent = RADAR.as_of;
}

function renderRows() {
  const q = $('q').value.trim().toLowerCase();
  const cat = $('f-cat').value, chain = $('f-chain').value, watch = $('f-watch').value;
  let rows = RADAR.rows.filter((r) => {
    if (cat && r.category !== cat) return false;
    if (chain && !r.chains.includes(chain)) return false;
    if (watch === 'watch' && !isWatchlist(r)) return false;
    if (watch === 'early' && isWatchlist(r)) return false;
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q) || r.chains.join(' ').toLowerCase().includes(q))) return false;
    return true;
  });
  const useModel = sortKey === 'implied_value_usd' && sandboxOn();
  const keyed = rows.map((r) => ({ r, iv: useModel ? rescore(r) : r.implied_value_usd }));
  keyed.sort((a, b) => {
    const ka = sortKey === 'implied_value_usd' ? a.iv : a.r[sortKey], kb = sortKey === 'implied_value_usd' ? b.iv : b.r[sortKey];
    return ((ka ?? -1) < (kb ?? -1) ? -1 : (ka ?? -1) > (kb ?? -1) ? 1 : a.r.rank - b.r.rank) * sortDir;
  });
  const tbody = $('rows'); tbody.textContent = '';
  for (const { r, iv } of keyed.slice(0, 400)) {
    const tr = document.createElement('tr');
    if (isWatchlist(r)) tr.className = 'watchlist';
    tr.dataset.slug = r.slug;
    const nameTd = document.createElement('td'); nameTd.className = 'proto';
    nameTd.append(r.name, document.createElement('small'));
    nameTd.querySelector('small').textContent = r.slug + (isWatchlist(r) ? ' · watchlist' : ' · early');
    const catTd = document.createElement('td'); catTd.append(chip(r.category ?? 'uncategorized'));
    const chTd = document.createElement('td'); chTd.className = 'num';
    chTd.textContent = (r.change_7d ?? 0) >= 0 ? '+' + (r.change_7d ?? 0).toFixed(1) + '%' : (r.change_7d ?? 0).toFixed(1) + '%';
    chTd.className += (r.change_7d ?? 0) >= 0 ? ' up' : ' down';
    const cells = [
      String(useModel ? rankOf(iv, keyed) : r.rank),
      nameTd, catTd,
      fmtM(r.tvl_usd), chTd,
      r.age_days === null ? 'unknown' : Math.round(r.age_days / 30) + ' mo',
    ];
    const first = document.createElement('td'); first.className = 'num'; first.textContent = cells[0]; tr.append(first);
    tr.append(nameTd, catTd);
    const tvlTd = document.createElement('td'); tvlTd.className = 'num'; tvlTd.textContent = fmtM(r.tvl_usd); tr.append(tvlTd);
    tr.append(chTd);
    const ageTd = document.createElement('td'); ageTd.className = 'num';
    ageTd.textContent = r.age_days === null ? 'unknown' : Math.round(r.age_days / 30) + ' mo'; tr.append(ageTd);
    const ivTd = document.createElement('td'); ivTd.className = 'num iv'; ivTd.textContent = fmtM(iv); tr.append(ivTd);
    tr.addEventListener('click', () => openDetail(r.slug));
    tbody.append(tr);
  }
  $('count').textContent = `${keyed.length} of ${RADAR.board_size} protocols` + (useModel ? ' · rescored live' : '');
}

/** Watchlist membership: the board's first watchlist_size rows were the watchlist before the early fill,
    but rank order mixes them — the honest test is the slug set main.ts ranked first, which it embeds
    in the radar data as watchlist slugs are all present; mark early = below floor at score time. */
function isWatchlist(r) { return r.tvl_usd >= RADAR.floor_usd; }

function rankOf(iv, keyed) {
  let n = 0;
  for (const k of keyed) if (k.iv > iv) n++;
  return n + 1;
}

function sandboxOn() {
  return model.base_multiple !== RADAR.model.base_multiple || model.growth_weight !== RADAR.model.growth_weight || model.chain_weight !== RADAR.model.chain_weight;
}

function renderLive() {
  const tbody = $('liverows'); tbody.textContent = '';
  for (const r of RADAR.live) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td'); nameTd.className = 'proto';
    nameTd.append(r.name, document.createElement('small'));
    nameTd.querySelector('small').textContent = (r.symbol ?? r.slug);
    const catTd = document.createElement('td'); catTd.append(chip(r.category ?? 'uncategorized'));
    const mt = r.mcap_usd && r.tvl_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : '—';
    const cells = [nameTd, catTd, fmtM(r.tvl_usd), fmtM(r.mcap_usd ?? 0), mt, pct(r.change_7d)];
    for (const [i, c] of cells.entries()) {
      const td = c instanceof Node ? c : (() => { const td = document.createElement('td'); td.textContent = c; if (i >= 2) td.className = 'num'; return td; })();
      if (c instanceof Node === false && c.startsWith('+')) td.className += ' up';
      if (c instanceof Node === false && c.startsWith('-') && i === 5) td.className += ' down';
      tr.append(td);
    }
    tbody.append(tr);
  }
}

function openDetail(slug) {
  const r = RADAR.rows.find((x) => x.slug === slug);
  if (!r) return;
  openSlug = slug;
  $('d-name').textContent = r.name;
  $('d-subline').textContent = `${r.slug} · ${r.category ?? 'uncategorized'} · ${r.chains.join(', ')}`;
  const live = sandboxOn() ? rescore(r) : r.implied_value_usd;
  $('d-body').innerHTML = '';
  const facts = document.createElement('div'); facts.className = 'factrow';
  for (const [label, val] of [['TVL', fmtM(r.tvl_usd)], ['7d change', pct(r.change_7d)], ['Age', r.age_days === null ? 'unknown' : Math.round(r.age_days / 30) + ' months'], ['Implied value', fmtM(live)], ['Status', isWatchlist(r) ? 'watchlist' : 'early (below floor)']]) {
    const f = document.createElement('div'); f.className = 'fact';
    f.innerHTML = `<span>${label}</span><b></b>`;
    f.querySelector('b').textContent = val;
    facts.append(f);
  }
  $('d-body').append(facts);
  const bars = document.createElement('div'); bars.className = 'bar';
  const parts = [['Growth ×', r.growth_multiplier, 2], ['Maturity ×', r.maturity_multiplier, 2], ['Chains ×', r.chain_multiplier, 2], ['Sector ×', r.sector_multiplier, 2]];
  for (const [label, v] of parts) {
    const lab = document.createElement('div'); lab.className = 'lab';
    lab.innerHTML = `<span>${label}</span><span></span>`;
    lab.lastChild.textContent = v.toFixed(2);
    const track = document.createElement('div'); track.className = 'track';
    const fill = document.createElement('div'); fill.className = 'fill';
    fill.style.width = Math.min(100, (v / 2.5) * 100) + '%';
    track.append(fill);
    const bar = document.createElement('div'); bar.className = 'bar'; bar.append(lab, track);
    $('d-body').append(bar);
  }
  const steps = document.createElement('div'); steps.className = 'steps';
  steps.innerHTML = '<h3>Farm plan</h3>';
  r.farm_steps.forEach((s, i) => {
    const div = document.createElement('div'); div.className = 'step';
    div.innerHTML = `<div class="n">${i + 1}</div><div class="st"></div>`;
    const [head, ...rest] = s.split('. Cost: ');
    div.querySelector('.st').textContent = head + '.';
    const small = document.createElement('small');
    small.textContent = rest.length ? 'Cost: ' + rest.join('. Cost: ') : '';
    div.querySelector('.st').append(small);
    steps.append(div);
  });
  $('d-body').append(steps);
  const drawer = $('drawer');
  drawer.classList.remove('hidden');
  drawer.setAttribute('aria-hidden', 'false');
}

function renderMethod() {
  const sectors = '';
  $('method').innerHTML = `
    <h2>What this board is</h2>
    <p>Every protocol in the sealed snapshot that records no token — no market cap, no CoinGecko id, no symbol — and is not a versioned pool or an exchange, ranked by what its launch would be worth if the protocol's record stayed as it is. The watchlist is the floor, never the ceiling: the board also ranks the strongest pre-token protocols below the $${fmtM(RADAR.floor_usd).slice(1)} floor.</p>
    <h2>The model</h2>
    <p><code>implied = TVL × base × growth × maturity × chains × sector</code></p>
    <ul>
      <li><strong>base = TVL × ${model.base_multiple}</strong> — a launch read off capital already committed.</li>
      <li><strong>growth</strong> — the 7-day TVL change, clamped to [−60%, +120%], weighted ${model.growth_weight}.</li>
      <li><strong>maturity</strong> — 0.6 to 1.0 over three years of age; age unknown reads as one year.</li>
      <li><strong>chains</strong> — +4% per extra chain beyond the first, capped at six: multi-chain reach widens a launch.</li>
      <li><strong>sector</strong> — the category's fee multiple: lending 1.15, perps and options 1.12, DEX/RWA/oracle/ZK 1.10, bridges and games 0.95.</li>
    </ul>
    ${sectors ? `<h2>Sector reasoning</h2><p>${sectors}</p>` : ''}
    <h2>What it is not</h2>
    <p>The board does not predict whether or when a token is issued. "Records no token" is DefiLlama's record, not proof a token is absent. The implied value is this radar's own claim, never make.fun's.</p>
    <h2>How to read it</h2>
    <p>Start at rank 1, open a row, and read its farm plan: each step carries a cost and a time. The sandbox above re-scores the whole board live when you move a slider — the ranking you see is the ranking you would get with your own weights.</p>`;
}

function bindSandbox() {
  const sliders = [['s-base', 'o-base', 'base_multiple'], ['s-growth', 'o-growth', 'growth_weight'], ['s-chain', 'o-chain', 'chain_weight']];
  for (const [sid, oid, key] of sliders) {
    const el = $(sid);
    el.value = model[key];
    $(oid).textContent = (+model[key]).toFixed(2);
    el.addEventListener('input', () => {
      model[key] = +el.value;
      $(oid).textContent = (+el.value).toFixed(2);
      $('mformula').textContent = `implied = TVL × ${model.base_multiple} × growth × maturity × chains × sector`;
      renderRows();
      if (openSlug) openDetail(openSlug);
    });
  }
  $('s-reset').addEventListener('click', () => {
    model = { ...RADAR.model };
    for (const [sid, oid, key] of sliders) { $(sid).value = model[key]; $(oid).textContent = (+model[key]).toFixed(2); }
    renderRows();
    if (openSlug) openDetail(openSlug);
  });
}

function bind() {
  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
      b.classList.add('active');
      for (const v of document.querySelectorAll('.view')) v.classList.add('hidden');
      $('view-' + b.dataset.tab).classList.remove('hidden');
    });
  }
  for (const id of ['q', 'f-cat', 'f-chain', 'f-watch']) $(id).addEventListener('input', renderRows);
  for (const th of document.querySelectorAll('#board thead th')) {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = k === 'rank' ? 1 : -1; }
      renderRows();
    });
  }
  $('d-close').addEventListener('click', () => { $('drawer').classList.add('hidden'); openSlug = null; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('drawer').classList.add('hidden'); openSlug = null; } });
}

function fillFilters() {
  const cats = [...new Set(RADAR.rows.map((r) => r.category).filter(Boolean))].sort();
  for (const c of cats) { const o = document.createElement('option'); o.value = c; o.textContent = c; $('f-cat').append(o); }
  const chains = [...new Set(RADAR.rows.flatMap((r) => r.chains))].sort();
  for (const c of chains) { const o = document.createElement('option'); o.value = c; o.textContent = c; $('f-chain').append(o); }
}

renderMeta();
fillFilters();
bindSandbox();
bind();
renderRows();
renderLive();
renderMethod();

