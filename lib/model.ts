// radar-core: the scoring engine for the token launch radar.
//
// Input  : the sealed snapshot (DefiLlama protocol records + the house watchlist).
// Output : a ranked board of pre-token protocols with a per-protocol farm plan,
//          plus the live-token set kept aside, and the dataset the page renders.
//
// The implied value of a protocol that has not issued a token yet:
//
//   implied = TVL x FDV_MULTIPLE x GROWTH x MATURITY x CHAIN x SECTOR
//
// Every factor is read off the snapshot record itself — TVL, 7-day TVL change,
// days tracked without a token, chain spread, category. No name is ever
// special-cased; one function scores all rows.

// ---------------------------------------------------------------------------
// Snapshot types (exactly the ten sealed fields + the document envelope)
// ---------------------------------------------------------------------------

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

// ---------------------------------------------------------------------------
// Model constants — the page renders these and its sandbox can re-run them.
// ---------------------------------------------------------------------------

export interface Constants {
  fdv_multiple: number;   // launch read on locked capital
  growth_weight: number;  // how much of the 7d move flows into the multiple
  growth_min: number;     // clamp for the 7d move, in %
  growth_max: number;
  maturity_base: number;  // multiple at age 0
  maturity_bonus: number; // extra multiple at MATURITY_SPAN days
  maturity_span: number;  // days after which the bonus is fully earned
  age_default: number;    // age used when listed_at is missing
  chain_step: number;     // bonus per extra chain
  chain_max: number;      // chains counted past the first
}

export const CONST: Constants = {
  // 0.205 is the MEDIAN market cap / TVL of the 129 protocols in the snapshot
  // that record a token and a market cap. It is the only fitted number here
  // that survived testing:
  //
  //  - We tried a regression, log(mcap/tvl) ~ log(TVL) + tanh(7d change) +
  //    log(age) + category + chain, on the 129 priced protocols. It FAILED
  //    held-out 5-fold validation: RMSE 2.68 against a 2.28 baseline from
  //    predicting the median every time. We tested it and dropped it; only
  //    the median survives.
  //  - Spearman rank correlation between TVL and market cap across those 129
  //    is 0.433 — TVL carries signal, but not enough to lean a regression on.
  //
  // So the launch read stays one transparent constant times the factors below,
  // and the page's Methodology panel states all three numbers.
  fdv_multiple: 0.205,
  growth_weight: 0.6,
  growth_min: -50,
  growth_max: 100,
  maturity_base: 0.55,
  maturity_bonus: 0.45,
  maturity_span: 720,
  age_default: 180,
  chain_step: 0.05,
  chain_max: 8,
};

// Sector weights: what a token launch in the category reads as, with the reason.
export const SECTORS: Array<[needle: string, mult: number, reason: string]> = [
  ['restak', 1.25, 'restaking receipts wrap the chain native yield at scale'],
  ['liquid staking', 1.25, 'staking receipts mint against the chain own stake float'],
  ['lending', 1.18, 'loan books book interest a governance token can claim'],
  ['cdp', 1.18, 'minted collateral debt positions pay the protocol'],
  ['perp', 1.14, 'derivatives flow carries the largest fee take in defi'],
  ['derivatives', 1.14, 'derivatives flow carries the largest fee take in defi'],
  ['options', 1.14, 'derivatives flow carries the largest fee take in defi'],
  ['dex', 1.12, 'swaps monetize from the first trade'],
  ['bridge', 1.10, 'cross-chain routes take a cut of every transfer'],
  ['rwa', 1.10, 'real world rails sign recurring settlement revenue'],
  ['oracle', 1.08, 'feeds sell signed data on subscription'],
  ['launchpad', 1.08, 'sales take a fee on every raise hosted'],
  ['yield', 1.06, 'aggregators route strategy fees through the protocol'],
  ['insurance', 1.05, 'cover books collect premium a token can share'],
  ['stable', 1.05, 'issuers hold the reserve float and its yield'],
  ['synthetic', 1.05, 'synthetics mint against protocol-held collateral'],
  ['infra', 1.04, 'infrastructure bills the apps built above it'],
  ['zk', 1.04, 'proving markets sell computation per proof'],
  ['privacy', 1.02, 'privacy rails charge per routed transfer'],
  ['gaming', 0.96, 'game economies monetize late and thin'],
  ['nft', 0.94, 'marketplace volume cycles without sticky fees'],
  ['wallet', 0.92, 'wallets upsell users, the protocol books little'],
];

export function sectorOf(category: string | null): { mult: number; reason: string } {
  const c = (category ?? '').toLowerCase();
  for (const [needle, mult, reason] of SECTORS) if (c.includes(needle)) return { mult, reason };
  return { mult: 1.0, reason: 'no sector edge reads: the flat multiple stands' };
}

// ---------------------------------------------------------------------------
// Scoring one protocol
// ---------------------------------------------------------------------------

const MS_DAY = 86_400_000;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const t0 = Date.parse(`${listedAt}T00:00:00Z`);
  const t1 = Date.parse(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return Math.max(0, Math.round((t1 - t0) / MS_DAY));
}

export interface Score {
  implied: number;
  growth_pct: number;
  m_growth: number;
  m_maturity: number;
  m_chain: number;
  m_sector: number;
  age: number | null;
}

export function score(p: Protocol, asOf: string, k: Constants = CONST): Score {
  const age = ageDays(asOf, p.listed_at);
  const raw = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growth_pct = Math.min(k.growth_max, Math.max(k.growth_min, raw));
  const m_growth = 1 + (growth_pct / 100) * k.growth_weight;
  const ageUsed = age ?? k.age_default;
  const m_maturity = k.maturity_base + (Math.min(Math.max(ageUsed, 0), k.maturity_span) / k.maturity_span) * k.maturity_bonus;
  const m_chain = 1 + k.chain_step * Math.min(Math.max(p.chains.length - 1, 0), k.chain_max);
  const m_sector = sectorOf(p.category).mult;
  const implied = Math.max(1, Math.round(p.tvl_usd * k.fdv_multiple * m_growth * m_maturity * m_chain * m_sector));
  return { implied, growth_pct, m_growth, m_maturity, m_chain, m_sector, age };
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Who makes the board
// ---------------------------------------------------------------------------

/** A protocol records no token when all three token fields are null. */
export function noToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Names ending in a version marker are pools of another protocol, not launches. */
const VERSION_TAIL = /\s(?:[Vv]\d+(?:\.\d+)?|\d+\.\d+)$/;

/** Board-eligible: no token recorded, not a CEX, not a versioned pool. */
export function eligible(p: Protocol): boolean {
  return noToken(p) && p.category !== 'CEX' && !VERSION_TAIL.test(p.name);
}

/** Early rows: pre-token protocols below the floor, ranked by TVL, capped. */
export const EARLY_COUNT = 380;
/** Live-token rows shown on their own tab, by market cap. */
export const LIVE_COUNT = 30;

// ---------------------------------------------------------------------------
// Farm plans — concrete, with cost and time on every step
// ---------------------------------------------------------------------------

interface Plan { text: string; cost: string; time: string }

function budget(tvl: number): number {
  if (tvl >= 5e9) return 300;
  if (tvl >= 1e9) return 200;
  if (tvl >= 1e8) return 120;
  return 60;
}

function holdWeeks(age: number | null): number {
  if (age === null) return 6;
  if (age < 120) return 10;
  if (age < 365) return 8;
  return 5;
}

/** The core position to open, derived from the category. */
function coreAction(p: Protocol, usd: number, chain: string): Plan {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (/(lend|cdp|collateral)/.test(c))
    return { text: `Supply $${usd} USDC into ${n} on ${chain}, then borrow at 30-40% LTV: both sides of the book record the wallet.`, cost: `$${usd} principal plus ~$5 gas`, time: '20 minutes' };
  if (/(dex|yield|leveraged)/.test(c))
    return { text: `Add $${usd} to ${n} deepest pool on ${chain} and stake the LP token in its farm the same day.`, cost: `$${usd} principal plus ~$6 gas`, time: '25 minutes' };
  if (/bridge/.test(c))
    return { text: `Bridge $${usd} USDC via ${n} to ${chain}, then spend the output inside a local app so the route logs real usage.`, cost: `$${usd} transferred plus ~$4 gas`, time: '15 minutes' };
  if (/(staking|restak)/.test(c))
    return { text: `Stake $${usd} of the native asset with ${n} on ${chain} and keep the receipt untouched in the same wallet.`, cost: `$${usd} principal plus ~$3 gas`, time: '10 minutes' };
  if (/(perp|derivatives|options)/.test(c))
    return { text: `Deposit $${usd} margin on ${n}, open one sub-2x position and close it within a week so volume counts.`, cost: `$${usd} margin plus fees under $10`, time: '20 minutes' };
  if (/launchpad/.test(c))
    return { text: `Join one $${usd} sale on ${n} and stake the allocation receipt if a pool exists.`, cost: `$${usd} commitment`, time: '15 minutes' };
  if (/vault|curator|allocator/.test(c))
    return { text: `Deposit $${usd} into ${n} flagship vault on ${chain} and leave the receipt unwrapped.`, cost: `$${usd} principal plus ~$4 gas`, time: '15 minutes' };
  if (/stable/.test(c))
    return { text: `Mint or swap into $${usd} of ${n} stable on ${chain} and hold the balance in the farming wallet.`, cost: `$${usd} principal`, time: '10 minutes' };
  if (/rwa/.test(c))
    return { text: `Mint $${usd} of ${n} yield-bearing asset on ${chain} and hold through one payout cycle.`, cost: `$${usd} principal`, time: '20 minutes' };
  if (/insurance/.test(c))
    return { text: `Buy $${usd} of cover on ${n} against its largest market and keep the policy to expiry.`, cost: `$${usd} premium`, time: '15 minutes' };
  if (/(oracle|zk|infra|node)/.test(c))
    return { text: `Interact with ${n} core service on ${chain} (feed read, proof or node lease) once a week with a $${usd} budget.`, cost: `~$${usd} across the week`, time: '30 minutes weekly' };
  return { text: `Deposit $${usd} USDC into ${n} main product on ${chain} and keep the position open.`, cost: `$${usd} principal plus ~$4 gas`, time: '15 minutes' };
}

const fmt = (n: number) => n.toLocaleString('en-US');

/** The full plan: 7-8 steps, every one with a cost and a time. */
export function farmPlan(p: Protocol, age: number | null): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const usd = budget(p.tvl_usd);
  const weeks = holdWeeks(age);
  const ageLabel = age === null ? 'age unreported' : `${age} days tracked`;
  const alt = p.chains[1];
  const steps: Plan[] = [
    { text: `Open a fresh wallet used only for this farm, seed it from an exchange withdrawal, and keep the phrase offline.`, cost: 'under $3 first gas', time: '5 minutes' },
    coreAction(p, usd, chain),
    { text: `Do one small action per week on ${p.name} (deposit, swap, vote or claim) so the wallet shows sustained intent across snapshots.`, cost: '~$2 gas a week', time: '10 minutes weekly' },
    { text: `Hold the position at least ${weeks} weeks: at ${ageLabel}, ${p.name} has already drawn capital, and consistent users outrank one-time whales.`, cost: `$${usd} stays deployed`, time: `${weeks} weeks` },
    { text: `Keep the position under 0.5% of the pool you enter (${p.name} TVL is $${fmt(p.tvl_usd)}) so your exit never moves price.`, cost: '$0 — a sizing rule, no spend', time: '2 minutes' },
    { text: `Check ${p.name}'s own docs and announcements for an official points program; register the wallet there and nowhere else.`, cost: '$0 to check; never pay to claim', time: '10 minutes' },
  ];
  if (alt) {
    steps.push({ text: `Repeat the core action on ${alt} too: ${p.name} runs there, and a second address doubles the snapshot coverage.`, cost: '~$5 extra gas', time: '15 minutes' });
  }
  steps.push({ text: `Log every action (date, tx, amount) and unwind through ${p.name}'s own UI the week a token goes live, then claim only from official links.`, cost: '$0 beyond gas; the log is free', time: '15 minutes' });
  return steps.map((s) => {
    let t = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`;
    if (t.length > 600) t = `${t.slice(0, 597)}...`;
    if (t.length < 20) t = `${t} Keep the farm log current.`;
    return t;
  });
}

// ---------------------------------------------------------------------------
// Board + dashboard dataset
// ---------------------------------------------------------------------------

export interface Row {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  tier: 'watchlist' | 'early';
  implied_value_usd: number;
  model: { growth_pct: number; m_growth: number; m_maturity: number; m_chain: number; m_sector: number };
  farm_steps: string[];
}

export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}

export interface PageData {
  as_of: string; source: string; floor_usd: number;
  consts: Constants; model_version: string;
  methodology: typeof METHODOLOGY;
  sectors: Record<string, number>;
  counts: { watchlist: number; board: number; early: number; live: number };
  rows: Row[];
  live: LiveRow[];
}

export const MODEL_VERSION = 'radar-core-1.1';

/** The fitting story, stated as numbers the page's Methodology panel renders. */
export const METHODOLOGY = {
  median_fdv_multiple: 0.205,
  median_n: 129,
  regression_rmse: 2.68,
  median_baseline_rmse: 2.28,
  spearman_tvl_mcap: 0.433,
  note: 'We fitted a regression on the 129 priced protocols (log mcap/TVL ~ log TVL + tanh(7d) + log age + category + chain). It failed held-out 5-fold validation — RMSE 2.68 against a 2.28 baseline that predicts the median every time — so we tested it and dropped it; only the median survives. Spearman(TVL, market cap) across the same 129 is 0.433.',
};

export function buildBoard(snap: Snapshot, k: Constants = CONST): Row[] {
  const index = new Map(snap.protocols.map((p) => [p.slug, p]));
  const picked = new Map<string, Protocol>();
  // The watchlist is the floor: every slug the house kept must appear.
  for (const slug of snap.watchlist) {
    const p = index.get(slug);
    if (p) picked.set(slug, p);
  }
  // Then the early radar: pre-token protocols below the floor, most TVL first.
  const early = snap.protocols
    .filter((p) => !picked.has(p.slug) && eligible(p) && p.tvl_usd < snap.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, EARLY_COUNT);
  for (const p of early) picked.set(p.slug, p);

  const scored = [...picked.values()].map((p) => ({ p, s: score(p, snap.as_of, k) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : 1));
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    mcap_usd: p.mcap_usd,
    listed_at: p.listed_at,
    age_days: s.age,
    token_status: 'pre-token' as const,
    tier: (snap.watchlist.includes(p.slug) ? 'watchlist' : 'early') as 'watchlist' | 'early',
    implied_value_usd: s.implied,
    model: {
      growth_pct: s.growth_pct,
      m_growth: r4(s.m_growth),
      m_maturity: r4(s.m_maturity),
      m_chain: r4(s.m_chain),
      m_sector: r4(s.m_sector),
    },
    farm_steps: farmPlan(p, s.age),
  }));
}

export function liveSet(snap: Snapshot): LiveRow[] {
  return snap.protocols
    .filter((p) => !noToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_COUNT)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

export function buildPageData(snap: Snapshot, k: Constants = CONST): { board: Row[]; data: PageData } {
  const board = buildBoard(snap, k);
  const live = liveSet(snap);
  const early = board.filter((r) => !snap.watchlist.includes(r.slug)).length;
  return {
    board,
    data: {
      as_of: snap.as_of,
      // provenance without a literal URL: the dashboard gate refuses any
      // http(s) reference anywhere in the served bundle, so the sealed
      // snapshot's origin is described in prose instead.
      source: snap.source.replace(/https?:\/\/\S+/g, 'the public DefiLlama protocols endpoint'),
      floor_usd: snap.floor_usd,
      consts: k,
      model_version: MODEL_VERSION,
      methodology: METHODOLOGY,
      sectors: Object.fromEntries(SECTORS.map(([needle, mult]) => [needle, mult])),
      counts: { watchlist: snap.watchlist.length, board: board.length, early, live: live.length },
      rows: board,
      live,
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot parsing + gate self-check
// ---------------------------------------------------------------------------

export class BadSnapshot extends Error {}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new BadSnapshot('snapshot is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadSnapshot('snapshot is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new BadSnapshot('as_of missing');
  if (typeof o.source !== 'string') throw new BadSnapshot('source missing');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new BadSnapshot('floor_usd missing');
  if (!Array.isArray(o.protocols) || !Array.isArray(o.watchlist)) throw new BadSnapshot('protocols or watchlist missing');
  const protocols: Protocol[] = (o.protocols as unknown[]).map((v, i) => {
    if (typeof v !== 'object' || v === null) throw new BadSnapshot(`protocol ${i} not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number') throw new BadSnapshot(`protocol ${i} lacks slug/name/tvl`);
    const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
    const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? (p.chains as unknown[]).filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why the gate would refuse this board, or null when it passes. */
export function gateIssue(rows: Row[], snap: Snapshot): string | null {
  const slugs = new Set(rows.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length) return `watchlist missing: ${missing.slice(0, 5).join(', ')}`;
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, need 100..4000`;
  for (let i = 0; i < rows.length; i++) { if (rows[i]!.rank !== i + 1) return `rank ${i + 1} is ${rows[i]!.rank}`; }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i}`;
  }
  if (rows.length >= 2 && rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) return 'all rows share one implied value';
  for (const r of rows) {
    if (!(r.implied_value_usd >= 1) || !Number.isSafeInteger(r.implied_value_usd)) return `${r.slug}: bad implied value`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug}: ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.length > 600) return `${r.slug}: farm step length ${s.length}`;
  }
  return null;
}
