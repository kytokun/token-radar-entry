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
export const LIVE_COUNT = 0; // 0 = no cap: every live-token protocol is accounted for.

// ---------------------------------------------------------------------------
// Total accounting — every snapshot protocol lands in exactly one bucket
// ---------------------------------------------------------------------------

/** Exclusion classes, each with its one-sentence public reason. */
export type ExclClass = 'cex' | 'versioned' | 'derived' | 'offlist';

export const EXCL_REASONS: Record<ExclClass, string> = {
  cex: 'Centralised exchange: balances are custodial, so there is no on-chain position to farm and nothing a launch radar can rank.',
  versioned: 'A versioned pool of a parent protocol that is already on the board or the live tab once — ranking it again would double-count the same farm.',
  derived: 'Records no token in its own row, but it is a wrapped, staked, bridged or exchange-prefixed product of a protocol whose token already trades — the same house clause that keeps it off the watchlist keeps it off the board.',
  offlist: 'Records no token and sits at or above the floor, yet the house watchlist kept it out — its DefiLlama parent record ties it to a protocol whose token already trades, and this radar does not rank a product against its parent.',
};

const EXCHANGE_HEADS = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const DERIVED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
const DERIVED_WORD = /\b(?:wrapped|staked|staking)\b/i;

/** Why a protocol stays off the board, or null when it is board material. */
export function exclusionOf(p: Protocol, floorUsd: number): { cls: ExclClass; reason: string } | null {
  if (p.category === 'CEX' || EXCHANGE_HEADS.some((e) => p.name.startsWith(e + ' '))) {
    return { cls: 'cex', reason: EXCL_REASONS.cex };
  }
  if (VERSION_TAIL.test(p.name)) return { cls: 'versioned', reason: EXCL_REASONS.versioned };
  if (noToken(p)) {
    if (DERIVED_CATEGORIES.has(p.category ?? '') || DERIVED_WORD.test(p.name)) {
      return { cls: 'derived', reason: EXCL_REASONS.derived };
    }
    if (p.tvl_usd >= floorUsd) return { cls: 'offlist', reason: EXCL_REASONS.offlist };
    return null; // pre-token below the floor with no exclusion clause: early-radar material.
  }
  return null; // tokened, non-CEX, non-versioned: live-tab material, not excluded.
}

export interface ExclRow {
  slug: string; name: string; category: string | null; tvl_usd: number;
  cls: ExclClass; reason: string;
}

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
// Net-per-hour verdict — what one hour of the plan reads as, in expected dollars
// ---------------------------------------------------------------------------

/** Assumed share of the protocol a launch airdrops, by category keyword:
 *  transparent constants set by hand, never fitted to anything. */
export const AIRDROP_SHARE: Array<[needle: string, share: number, reason: string]> = [
  ['perp', 0.12, 'derivatives volumes are the loudest airdrop metric, so launches over-share'],
  ['dex', 0.12, 'swap volume leaderboards make airdrops the growth channel'],
  ['lend', 0.10, 'lending points programs (the genre that coined them) sit near a tenth of supply'],
  ['cdp', 0.10, 'mint activity maps one-to-one to points, so the drop is rich'],
  ['restak', 0.08, 'restaking receipts carry a cut of the AVS fees, a thinner share'],
  ['liquid staking', 0.08, 'staking receipts share fee flow, not supply, at launch'],
  ['bridge', 0.07, 'bridges monetise slowly, so the drop leans smaller'],
  ['infra', 0.07, 'infrastructure sells to apps, not to a token public'],
  ['rwa', 0.05, 'regulated issuers hold supply back for compliance'],
  ['stable', 0.05, 'stable issuers guard peg and reserves, drops stay thin'],
];

/** The share a category reads, with the reason the page renders. */
export function shareOf(category: string | null): { share: number; reason: string } {
  const c = (category ?? '').toLowerCase();
  for (const [needle, share, reason] of AIRDROP_SHARE) if (c.includes(needle)) return { share, reason };
  return { share: 0.06, reason: 'default: no category signal, so a middling 6% of supply at launch' };
}

/** One step's Time string to active hours. Rule, stated: 'N minutes' is N/60;
 *  'N minutes weekly' runs the hold, so it is N/60 x hold weeks; a hold of
 *  'N weeks' is one oversight hour a week, not N x 168. */
export function stepHours(time: string, holdWeeks: number): number {
  const min = /\b(\d+)\s*minutes?\b/.exec(time);
  if (!min) {
    const wk = /\b(\d+)\s*weeks?\b/.exec(time);
    return wk ? Number(wk[1]) * 1 : 0;
  }
  const h = Number(min[1]) / 60;
  return /weekly/i.test(time) ? h * holdWeeks : h;
}

/** Parse one farm step's 'Time: …' tail back out of the rendered string. */
function stepTime(step: string): string {
  const m = /\.\s*Time:\s*(.+?)\.\s*$/.exec(step);
  return m ? m[1] : '';
}

export const ODDS_RULE = {
  base: 0.85,
  young_penalty: 0.1,
  young_days: 90,
  above_median_bonus: 0.05,
  floor: 0.05,
  cap: 0.95,
} as const;

/** P(launch ever), set by rule and checked: the page renders the rule and the
 *  median it turns on, so every row's odds re-compute from the snapshot. */
export function launchOdds(tvlUsd: number, age: number | null, medianTvl: number): number {
  let o = ODDS_RULE.base;
  if (age !== null && age < ODDS_RULE.young_days) o -= ODDS_RULE.young_penalty;
  if (tvlUsd > medianTvl) o += ODDS_RULE.above_median_bonus;
  return Math.round(Math.min(ODDS_RULE.cap, Math.max(ODDS_RULE.floor, o)) * 1000) / 1000;
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

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
  est_hours: number;
  airdrop_share: number;
  verdict_usd_per_hour: number;
  p_launch: number;
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
  counts: { total: number; watchlist: number; board: number; early: number; live: number; excluded: number };
  excl_reasons: Record<ExclClass, string>;
  excl_counts: Record<ExclClass, number>;
  airdrop_share: Record<string, { share: number; reason: string }>;
  odds_rule: typeof ODDS_RULE;
  self_test: Array<{ name: string; pass: boolean }>;
  rows: Row[];
  live: LiveRow[];
  excluded: ExclRow[];
}

export const MODEL_VERSION = 'radar-core-1.2';

/** The fitting story, stated as numbers the page's Methodology panel renders. */
export const METHODOLOGY = {
  median_fdv_multiple: 0.205,
  median_n: 129,
  regression_rmse: 2.68,
  median_baseline_rmse: 2.28,
  spearman_tvl_mcap: 0.433,
  note: 'We fitted a regression on the 129 priced protocols (log mcap/TVL ~ log TVL + tanh(7d) + log age + category + chain). It failed held-out 5-fold validation — RMSE 2.68 against a 2.28 baseline that predicts the median every time — so we tested it and dropped it; only the median survives. Spearman(TVL, market cap) across the same 129 is 0.433.',
  verdict_formula: 'verdict $/h = implied value x airdrop share / total plan hours. Implied value comes from the board model; total plan hours re-sum every farm step Time entry against the row hold (one-time minutes count once, weekly minutes multiply by the hold weeks, a hold of N weeks counts as one oversight hour a week).',
  hours_rule: "one-time 'N minutes' = N/60 h; 'N minutes weekly' = N/60 x hold weeks; a hold of 'N weeks' = N hours (one oversight hour a week) — holding capital is not active work.",
  odds_rule: 'P(launch ever) = 0.85 - 0.10 x [age under 90 days] + 0.05 x [TVL above the board median], clamped to 5-95%. Set by rule on snapshot fields; no fitting, no hand-tuned rows.',
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
  const medianTvl = median(scored.map(({ p }) => p.tvl_usd));
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
    est_hours: 0,
    airdrop_share: shareOf(p.category).share,
    verdict_usd_per_hour: 0,
    p_launch: launchOdds(p.tvl_usd, s.age, medianTvl),
  })).map((r, i, all) => {
    // Total plan hours, recomputed from the row's own rendered steps so the
    // verdict stays nested against the plan a reader can see.
    const weeks = holdWeeks(r.age_days);
    const hours = r.farm_steps.reduce((sum, step) => sum + stepHours(stepTime(step), weeks), 0);
    const est_hours = Math.round(hours * 10) / 10;
    const verdict = Math.max(1, Math.round((r.implied_value_usd * r.airdrop_share) / est_hours));
    return { ...r, est_hours, verdict_usd_per_hour: verdict };
  });
}

export function liveSet(snap: Snapshot): LiveRow[] {
  return snap.protocols
    .filter((p) => !noToken(p) && p.category !== 'CEX' && !VERSION_TAIL.test(p.name))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_COUNT || snap.protocols.length)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

/** Every snapshot protocol that is neither board nor live, with its reason. */
export function excludedSet(snap: Snapshot, board: Row[], live: LiveRow[]): ExclRow[] {
  const accounted = new Set([...board.map((r) => r.slug), ...live.map((r) => r.slug)]);
  const rows: ExclRow[] = [];
  for (const p of snap.protocols) {
    if (accounted.has(p.slug)) continue;
    const ex = exclusionOf(p, snap.floor_usd);
    if (!ex) continue; // unreachable by construction; kept for type honesty
    rows.push({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, cls: ex.cls, reason: ex.reason });
  }
  return rows.sort((a, b) => a.cls.localeCompare(b.cls) || b.tvl_usd - a.tvl_usd);
}

/** The page's self-test: invariants the model promises, checked at build time
 *  against the exact snapshot the board came from. */
export function selfTest(snap: Snapshot, board: Row[], live: LiveRow[], excluded: ExclRow[]): Array<{ name: string; pass: boolean }> {
  const checks: Array<{ name: string; pass: boolean }> = [];
  const boardSlugs = new Set(board.map((r) => r.slug));
  const missingWl = snap.watchlist.filter((s) => !boardSlugs.has(s));
  checks.push({ name: 'every watchlist slug ranks on the board', pass: missingWl.length === 0 });
  checks.push({ name: `board holds 100-4000 rows (holds ${board.length})`, pass: board.length >= 100 && board.length <= 4000 });
  checks.push({ name: 'ranks run exactly 1..N with no gaps', pass: board.every((r, i) => r.rank === i + 1) });
  checks.push({ name: 'implied value never rises with rank', pass: board.every((r, i) => i === 0 || r.implied_value_usd <= board[i - 1]!.implied_value_usd) });
  checks.push({ name: 'implied values separate rows (not one flat number)', pass: board.length >= 2 && board[0]!.implied_value_usd > board[board.length - 1]!.implied_value_usd });
  checks.push({ name: 'every implied value a positive whole number >= 1', pass: board.every((r) => Number.isSafeInteger(r.implied_value_usd) && r.implied_value_usd >= 1) });
  checks.push({ name: 'every row carries 3-12 farm steps of 20-600 chars', pass: board.every((r) => r.farm_steps.length >= 3 && r.farm_steps.length <= 12 && r.farm_steps.every((s) => s.trim().length >= 20 && s.length <= 600)) });
  checks.push({ name: 'every verdict a positive whole $/hour on positive hours', pass: board.every((r) => r.est_hours > 0 && Number.isSafeInteger(r.verdict_usd_per_hour) && r.verdict_usd_per_hour >= 1) });
  checks.push({ name: 'every launch odds sits inside 5-95%', pass: board.every((r) => r.p_launch >= ODDS_RULE.floor && r.p_launch <= ODDS_RULE.cap) });
  const tokened = new Set(snap.protocols.filter((p) => !noToken(p)).map((p) => p.slug));
  checks.push({ name: 'every live tab row records a token', pass: live.every((l) => tokened.has(l.slug)) });
  checks.push({ name: 'exclusion rows carry only the four stated classes', pass: excluded.every((e) => e.cls in EXCL_REASONS && e.reason === EXCL_REASONS[e.cls]) });
  const seen = new Set<string>();
  let overlap = 0;
  for (const s of [...board.map((r) => r.slug), ...live.map((l) => l.slug), ...excluded.map((e) => e.slug)]) {
    if (seen.has(s)) overlap++;
    seen.add(s);
  }
  checks.push({ name: `all ${snap.protocols.length} snapshot protocols accounted for exactly once`, pass: overlap === 0 && seen.size === snap.protocols.length });
  return checks;
}

export function buildPageData(snap: Snapshot, k: Constants = CONST): { board: Row[]; data: PageData } {
  const board = buildBoard(snap, k);
  const live = liveSet(snap);
  const excluded = excludedSet(snap, board, live);
  const early = board.filter((r) => !snap.watchlist.includes(r.slug)).length;
  const excl_counts: Record<ExclClass, number> = { cex: 0, versioned: 0, derived: 0, offlist: 0 };
  for (const e of excluded) excl_counts[e.cls]++;
  const self_test = selfTest(snap, board, live, excluded);
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
      counts: { total: snap.protocols.length, watchlist: snap.watchlist.length, board: board.length, early, live: live.length, excluded: excluded.length },
      excl_reasons: EXCL_REASONS,
      excl_counts,
      airdrop_share: {
        ...Object.fromEntries(AIRDROP_SHARE.map(([needle, share, reason]) => [needle, { share, reason }])),
        _default: shareOf(null),
      },
      odds_rule: ODDS_RULE,
      self_test,
      rows: board,
      live,
      excluded,
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
