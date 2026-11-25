// TokenRadar page logic. Reads window.RADAR (data.js, written by main.ts):
// renders the ranked board, the live-token comparison and the model write-up,
// with sort, filter, search and a per-protocol dossier card.
'use strict';

const $ = (id) => document.getElementById(id);
const R = window.RADAR;

const money = (n) =>
  n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M'
  : '$' + Math.round(n).toLocaleString('en-US');
const pct = (n) => n === null || n === undefined ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
const ageTxt = (d) => d === null ? 'unknown' : Math.round(d / 30.44) + ' mo';

let sortK = 'rank', sortD = 1, openSlug = null;

const isWl = (r) => r.tier === 'watchlist';

function tag(txt, wl, extra) {
  const s = document.createElement('span');
  s.className = 'tag' + (wl ? ' wl' : '') + (extra ? ' ' + extra : '');
  s.textContent = txt;
  return s;
}

function td(txt, cls) {
  const d = document.createElement('td');
  d.textContent = txt;
  if (cls) d.className = cls;
  return d;
}

function renderHeadline() {
  $('headline').innerHTML =
    `Snapshot <b>${R.as_of}</b> · floor <b>${money(R.floor_usd)}</b><br>` +
    `<b>${R.counts.watchlist}</b> watchlist · <b>${R.counts.early}</b> early · <b>${R.counts.live}</b> live set aside`;
  $('strip-version').textContent = R.model_version;
  $('strip-formula').textContent = 'implied = TVL × ' + R.consts.fdv_multiple +
    ' × growth × maturity × chain × sector';
  $('strip-asof').textContent = 'floor $' + Math.round(R.floor_usd / 1e6) + 'M TVL · ' + R.counts.board + ' ranked';
  $('g-asof').textContent = R.as_of;
}

function visibleRows() {
  const q = $('search').value.trim().toLowerCase();
  const cat = $('pick-cat').value, chain = $('pick-chain').value, tier = $('pick-tier').value;
  const out = R.rows.filter((r) => {
    if (cat && r.category !== cat) return false;
    if (chain && !r.chains.includes(chain)) return false;
    if (tier && r.tier !== tier) return false;
    if (q) {
      const hay = (r.name + ' ' + r.slug + ' ' + (r.category ?? '') + ' ' + r.chains.join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (sortK !== 'rank') {
    out.sort((a, b) => {
      const ka = a[sortK] ?? -1, kb = b[sortK] ?? -1;
      return ((ka < kb ? -1 : ka > kb ? 1 : a.rank - b.rank)) * sortD;
    });
  }
  return out;
}

function renderBoard() {
  const rows = visibleRows();
  const body = $('board-body');
  body.textContent = '';
  for (const r of rows.slice(0, 500)) {
    const tr = document.createElement('tr');
    tr.className = 't-' + r.tier;
    tr.dataset.slug = r.slug;
    tr.append(td(String(r.rank), 'r'));
    const name = document.createElement('td');
    name.className = 'proto';
    name.append(r.name, document.createElement('small'));
    name.lastChild.textContent = r.slug + ' · ' + r.tier;
    name.append(tag('pre-token', false, 'pt'));
    tr.append(name);
    const cat = document.createElement('td');
    cat.append(tag(r.category ?? 'uncategorized', false));
    tr.append(cat);
    tr.append(td(money(r.tvl_usd), 'r'));
    const ch = td(pct(r.change_7d), 'r ' + ((r.change_7d ?? 0) >= 0 ? 'up' : 'down'));
    tr.append(ch);
    tr.append(td(ageTxt(r.age_days), 'r'));
    tr.append(td(money(r.implied_value_usd), 'iv'));
    tr.addEventListener('click', () => openCard(r.slug));
    body.append(tr);
  }
  $('deck-count').textContent = rows.length + ' of ' + R.counts.board + ' protocols';
}

function renderLive() {
  const body = $('live-body');
  body.textContent = '';
  R.live.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'default';
    tr.append(td(String(i + 1), 'r'));
    const name = document.createElement('td');
    name.className = 'proto';
    name.append(r.name, document.createElement('small'));
    name.lastChild.textContent = r.symbol ?? r.slug;
    name.append(tag('already trading', false, 'pt live'));
    tr.append(name);
    const cat = document.createElement('td');
    cat.append(tag(r.category ?? 'uncategorized', false));
    tr.append(cat);
    tr.append(td(money(r.tvl_usd), 'r'));
    tr.append(td(money(r.mcap_usd ?? 0), 'r'));
    tr.append(td(r.mcap_usd && r.tvl_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + 'x' : '—', 'r'));
    const ch = td(pct(r.change_7d), 'r ' + ((r.change_7d ?? 0) >= 0 ? 'up' : 'down'));
    tr.append(ch);
    body.append(tr);
  });
}

function openCard(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  openSlug = slug;
  $('c-name').textContent = r.name;
  $('c-line').textContent = r.slug + ' · ' + (r.category ?? 'uncategorized') + ' · ' + r.chains.join(', ');
  const body = $('c-body');
  body.textContent = '';

  const facts = document.createElement('div');
  facts.className = 'facts';
  for (const [k, v] of [
    ['Rank', '#' + r.rank], ['TVL', money(r.tvl_usd)], ['7d change', pct(r.change_7d)],
    ['Tracked', ageTxt(r.age_days)], ['Implied value', money(r.implied_value_usd)],
    ['Tier', r.tier === 'watchlist' ? 'watchlist' : 'early radar'],
    ['Status', 'pre-token — records no token in the snapshot'],
  ]) {
    const f = document.createElement('div');
    f.className = 'fact';
    f.innerHTML = '<span></span><b></b>';
    f.firstChild.textContent = k;
    f.lastChild.textContent = v;
    facts.append(f);
  }
  body.append(facts);

  for (const [label, v, top] of [
    ['Growth ×', r.model.m_growth, 1.6], ['Maturity ×', r.model.m_maturity, 1.2],
    ['Chain ×', r.model.m_chain, 1.2], ['Sector ×', r.model.m_sector, 1.2],
  ]) {
    const g = document.createElement('div');
    g.className = 'gauge';
    g.innerHTML = '<div class="lab"><span></span><span></span></div><div class="lane"><div class="pour"></div></div>';
    g.firstChild.firstChild.textContent = label + ' (applied to TVL ' + money(r.tvl_usd) + ')';
    g.firstChild.lastChild.textContent = v.toFixed(3);
    g.querySelector('.pour').style.width = Math.min(100, (v / top) * 100) + '%';
    body.append(g);
  }

  const plan = document.createElement('div');
  plan.className = 'plan';
  plan.innerHTML = '<h3>Farm plan — how to act on this rank</h3>';
  r.farm_steps.forEach((s, i) => {
    const m = document.createElement('div');
    m.className = 'move';
    m.innerHTML = '<div class="no"></div><div class="tx"></div>';
    m.firstChild.textContent = String(i + 1);
    const [head, ...rest] = s.split('. Cost: ');
    m.lastChild.textContent = head + '.';
    if (rest.length) {
      const small = document.createElement('small');
      small.textContent = 'Cost: ' + rest.join('. Cost: ');
      m.lastChild.append(small);
    }
    plan.append(m);
  });
  body.append(plan);

  const card = $('card');
  card.classList.remove('off');
  card.classList.add('on');
}

function closeCard() {
  $('card').classList.remove('on');
  $('card').classList.add('off');
  openSlug = null;
}

function renderMethodo() {
  const m = R.methodology;
  const box = $('methodo');
  box.textContent = '';
  const h = document.createElement('h3');
  h.textContent = 'Methodology — how 0.205 was chosen, and what failed';
  box.append(h);
  const stats = document.createElement('div');
  stats.className = 'mstats';
  for (const [big, small] of [
    ['× ' + m.median_fdv_multiple, 'median market cap / TVL of the ' + m.median_n + ' priced protocols in the snapshot — the multiple the board uses'],
    ['RMSE ' + m.regression_rmse + ' vs ' + m.median_baseline_rmse, 'held-out 5-fold: the fitted regression lost to the median baseline, so we tested it and dropped it; only the median survives'],
    ['ρ ' + m.spearman_tvl_mcap, 'Spearman rank correlation, TVL vs market cap, same ' + m.median_n + ' protocols — TVL carries signal, not enough to lean a regression on'],
  ]) {
    const s = document.createElement('div');
    s.className = 'stat';
    s.innerHTML = '<b></b><span></span>';
    s.firstChild.textContent = big;
    s.lastChild.textContent = small;
    stats.append(s);
  }
  box.append(stats);
  const p = document.createElement('p');
  p.className = 'mnote';
  p.textContent = 'Every factor is read off the snapshot record — TVL, 7-day change, days tracked without a token, chains, category. No name is special-cased; one function scores all ' + R.counts.board + ' rows.';
  box.append(p);
}

function renderModelDoc() {
  const c = R.consts;
  const rows = [
    ['fdv_multiple', c.fdv_multiple, 'The median market cap / TVL of the 129 priced protocols in the snapshot. A regression we fitted on the same 129 failed held-out 5-fold (RMSE 2.68 vs the 2.28 median baseline), so it was dropped; only the median survives.'],
    ['growth clamp', c.growth_min + '% … +' + c.growth_max + '%', 'The 7-day TVL move is clamped here before weighting.'],
    ['growth_weight', c.growth_weight, 'How much of the clamped move flows into the multiple.'],
    ['maturity', c.maturity_base + ' → ' + (c.maturity_base + c.maturity_bonus) + ' over ' + c.maturity_span + ' days', 'Young protocols score lower on the launch read.'],
    ['age_default', c.age_default + ' days', 'The age assumed when listed_at is missing.'],
    ['chain', '+' + c.chain_step + ' per extra chain, capped at ' + c.chain_max, 'Multi-chain reach widens a launch.'],
  ];
  const tbl = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Constant</th><th>Value</th><th>Meaning</th></tr>';
  tbl.append(thead);
  const tb = document.createElement('tbody');
  for (const [k, v, why] of rows) {
    const tr = document.createElement('tr');
    tr.append(td(k), td(String(v)), td(why));
    tb.append(tr);
  }
  tbl.append(tb);

  const sectors = Object.entries(R.sectors).sort((a, b) => b[1] - a[1]);
  const stbl = document.createElement('table');
  const sth = document.createElement('thead');
  sth.innerHTML = '<tr><th>Category</th><th class="r">Sector ×</th></tr>';
  stbl.append(sth);
  const stb = document.createElement('tbody');
  for (const [k, v] of sectors) {
    const tr = document.createElement('tr');
    tr.append(td(k), td(v.toFixed(2), 'r'));
    stb.append(tr);
  }
  stbl.append(stb);

  const doc = $('model-doc');
  doc.textContent = '';
  const h = (t) => { const el = document.createElement('h2'); el.textContent = t; return el; };
  const p = (t) => { const el = document.createElement('p'); el.textContent = t; return el; };

  doc.append(h('What this board is'));
  doc.append(p('Every protocol in the sealed snapshot whose record shows no token — no market cap, no CoinGecko id, no symbol — and that is not a versioned pool or an exchange. It ranks them by what a launch would read if the protocol stayed exactly as recorded, then hands the reader a farm plan per protocol.'));
  doc.append(h('The model'));
  const f = document.createElement('p');
  f.innerHTML = '<code>implied = TVL × FDV_MULTIPLE × growth × maturity × chain × sector</code>';
  doc.append(f, tbl);
  doc.append(h('Sector multipliers'));
  doc.append(p('Each category carries a fee-structure multiple — cash-flow-rich sectors (lending, perps, options) score above 1; bridges and games, where fee capture is weakest, score below. The table covers every category in the snapshot; anything unlisted reads 1.0.'));
  doc.append(stbl);
  doc.append(h('What the board is not'));
  doc.append(p('It does not predict whether or when a token comes. "Records no token" is DefiLlama\'s record, not proof one is absent — pre-launches are excluded the moment any token field fills in. The implied value is this radar\'s own claim, never make.fun\'s, never a market price.'));
  doc.append(h('How to use it'));
  doc.append(p('Start at rank 1. Open the row: the gauges show which factor carried the claim, and the farm plan turns the rank into concrete steps, each with a cost and a time. Protocols already trading sit on the Live tokens tab at market values, kept apart from the model\'s rankings.'));
}

function fillFilters() {
  const cats = [...new Set(R.rows.map((r) => r.category).filter(Boolean))].sort();
  for (const c of cats) { const o = document.createElement('option'); o.value = c; o.textContent = c; $('pick-cat').append(o); }
  const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
  for (const c of chains) { const o = document.createElement('option'); o.value = c; o.textContent = c; $('pick-chain').append(o); }
}

function bind() {
  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.remove('active');
      b.classList.add('active');
      for (const v of document.querySelectorAll('.pane')) v.classList.remove('show');
      $('pane-' + b.dataset.tab).classList.add('show');
    });
  }
  for (const id of ['search', 'pick-cat', 'pick-chain', 'pick-tier']) {
    $(id).addEventListener('input', renderBoard);
  }
  for (const th of document.querySelectorAll('#board thead th')) {
    th.addEventListener('click', () => {
      const k = th.dataset.k;
      if (!k) return;
      if (sortK === k) sortD = -sortD;
      else { sortK = k; sortD = k === 'rank' ? 1 : -1; }
      renderBoard();
    });
  }
  $('c-close').addEventListener('click', closeCard);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCard(); });
}

fillFilters();
bind();
renderHeadline();
renderBoard();
renderLive();
renderMethodo();
renderModelDoc();
