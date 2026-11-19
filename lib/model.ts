// Tide Table's model. One sealed snapshot in; a ranked board, a calibrated value model, an honest
// validation record and costed farm plans out. No name is ever special-cased.
//
// The value model is fitted, not asserted. The 128 protocols whose DefiLlama record carries a token and
// a market cap are the calibration set. Their log market cap is regressed on log TVL, seven-day TVL
// change, listing age and chain breadth, with four category indicators and a small ridge penalty. The
// target is winsorised at the 5th/95th percentile so one extraordinary token cannot dictate the fit.
// That fit is blended with a TVL-ratio baseline; the blend weight is chosen by 5-fold cross-validation,
// never by hand. The same folds, and a separate walk-forward split by listing date, report R-squared
// and median absolute log error. Pre-token protocols are then scored by that one fitted function.
//
// Farm plans are derived from each protocol's own category, chains, TVL and age. Every step names a
// cost and a duration; the plan also reports gross yield, an impermanent-loss reserve, gas at the
// chain's typical rate, a 4 percent cash benchmark and the net APR left after all of them.

export interface SnapshotProtocol {
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
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface Coefficients {
  names: string[];
  beta: number[];
  mu: number[];
  sd: number[];
}

export interface FitModel extends Coefficients {
  ridge: number;
  blend: number;
  ratio0: number;
  lo: number;
  hi: number;
  n: number;
}

export interface Metrics {
  n: number;
  r2: number;
  medAE: number;
  factor: number;
  mae: number;
}

export interface WalkFold {
  label: string;
  train: number;
  test: number;
  from: string;
  to: string;
  metrics: Metrics;
}

export interface Validation {
  cv: Metrics;
  cvFit: Metrics;
  cvBaseline: Metrics;
  cvFolds: number;
  walk: Metrics;
  walkFolds: WalkFold[];
  blend: number;
  residual: { p10: number; p90: number };
}

export interface FarmPlan {
  chain: string;
  capital: number;
  holdDays: number;
  grossApy: number;
  ilReserve: number;
  gasPerTx: number;
  txPerYear: number;
  gasYear: number;
  netApr: number;
  excessApr: number;
  netUsd: number;
  breakEven: number | null;
  action: string;
  steps: string[];
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  multiple: number;
  watchlisted: boolean;
  eligible: boolean;
  fit_log: number;
  baseline_log: number;
  net_apr_pct: number;
  net_usd_year: number;
  farm: FarmPlan;
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl: number;
  change: number;
  age: number | null;
  implied: number;
  low: number;
  high: number;
  multiple: number;
  watchlisted: boolean;
  eligible: boolean;
  netApr: number;
  excessApr: number;
  netUsd: number;
  capital: number;
  holdDays: number;
  gasPerTx: number;
  txPerYear: number;
  gasYear: number;
  grossApy: number;
  ilReserve: number;
  fitLog: number;
  baseLog: number;
  action: string;
  steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string;
  tvl: number;
  mcap: number;
  ratio: number;
  change: number;
  listed: string | null;
}

export interface RadarData {
  version: string;
  as_of: string;
  source: string;
  floor: number;
  counts: { protocols: number; pretoken: number; live: number; watchlist: number; ranked: number; early: number };
  features: string[];
  model: FitModel;
  validation: Validation;
  calibration: { median_ratio: number; median_mcap: number; median_tvl: number };
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY = 86_400_000;
const LN = Math.log;
const RIDGE = 1;
const FOLDS = 5;
const BLENDS = [0, 0.25, 0.5, 0.75, 1];
const BENCHMARK_APR = 4;

/** A finite number or a fallback, so a null in the snapshot never becomes NaN. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Whole days from listing to the snapshot date, or null when the record has no date. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY));
}

/** A stable 32-bit hash: deterministic fold assignment without Math.random or a clock. */
function slugHash(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** DefiLlama's record carries no token when all three token fields are null. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVED = /\b(wrapped|staked|staking|bridged)\b/i;
const WRAPPED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Cross Chain Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A pre-token row that is a derivative product or a versioned pool is still listed, but flagged. */
function eligibility(p: SnapshotProtocol): boolean {
  return !VERSIONED.test(p.name) && !DERIVED.test(p.name) && !WRAPPED_CATEGORIES.has(p.category ?? '');
}

/** Feature names are shown in the dashboard so the model can be read as arithmetic. */
export const FEATURE_NAMES = ['intercept', 'log TVL', '7d growth', 'log listing age', 'log chain breadth', 'lending / CDP', 'dex / yield', 'RWA', 'staking / restaking'];

/** The design matrix: nine deterministic columns from the snapshot's own fields. */
function features(p: SnapshotProtocol, asOf: string): number[] {
  const c = (p.category ?? '').toLowerCase();
  const growth = Math.max(-60, Math.min(120, num(p.change_7d, 0))) / 100;
  const age = ageDays(asOf, p.listed_at) ?? 365;
  const years = Math.min(5, age / 365);
  return [
    1,
    LN(Math.max(1, p.tvl_usd)),
    growth,
    LN1P(years),
    LN1P(p.chains.length),
    c.includes('lend') || c.includes('cdp') ? 1 : 0,
    c.includes('dex') || c.includes('yield') || c.includes('farm') ? 1 : 0,
    c.includes('rwa') ? 1 : 0,
    c.includes('stak') || c.includes('restak') ? 1 : 0,
  ];
}

function LN1P(x: number): number {
  return Math.log1p(x);
}

/** Gaussian elimination with partial pivoting; the normal equations are small and well conditioned after scaling. */
function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row) => row.slice());
  const b = rhs.slice();
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j]![i]!) > Math.abs(a[pivot]![i]!)) pivot = j;
    [a[i], a[pivot]] = [a[pivot]!, a[i]!];
    [b[i], b[pivot]] = [b[pivot]!, b[i]!];
    const d = a[i]![i]! || 1e-9;
    for (let j = i; j < n; j++) a[i]![j]! /= d;
    b[i]! /= d;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const f = a[j]![i]!;
      for (let k = i; k < n; k++) a[j]![k]! -= f * a[i]![k]!;
      b[j]! -= f * b[i]!;
    }
  }
  return b;
}

/** Ridge fit of log market cap on the standardised feature matrix, with a winsorised target. */
function fit(rows: SnapshotProtocol[], asOf: string): Coefficients {
  const x = rows.map((p) => features(p, asOf));
  const k = x[0]!.length;
  const mu = new Array<number>(k).fill(0);
  const sd = new Array<number>(k).fill(1);
  for (let j = 1; j < k; j++) {
    mu[j] = x.reduce((a, v) => a + v[j]!, 0) / x.length;
    const variance = x.reduce((a, v) => a + (v[j]! - mu[j]!) ** 2, 0) / x.length;
    sd[j] = Math.sqrt(variance) || 1;
  }
  const z = x.map((row) => row.map((v, j) => (j === 0 ? v : (v - mu[j]!) / sd[j]!)));
  const target = rows.map((p) => LN(Math.max(1, p.mcap_usd ?? 1))).sort((a, b) => a - b);
  const lo = target[Math.floor(target.length * 0.05)]!;
  const hi = target[Math.floor(target.length * 0.95)]!;
  const a = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const y = Math.min(hi, Math.max(lo, LN(Math.max(1, rows[i]!.mcap_usd ?? 1))));
    for (let j = 0; j < k; j++) {
      b[j]! += z[i]![j]! * y;
      for (let d = 0; d < k; d++) a[j]![d]! += z[i]![j]! * z[i]![d]!;
    }
  }
  for (let j = 1; j < k; j++) a[j]![j]! += RIDGE;
  return { names: FEATURE_NAMES.slice(), beta: solve(a, b), mu, sd };
}

/** The fitted log value one protocol gets; the caller may blend it with the TVL-ratio anchor. */
function predictLog(model: Coefficients, p: SnapshotProtocol, asOf: string): number {
  const x = features(p, asOf);
  let total = 0;
  for (let j = 0; j < model.beta.length; j++) {
    const v = j === 0 ? x[j]! : (x[j]! - model.mu[j]!) / model.sd[j]!;
    total += v * model.beta[j]!;
  }
  return total;
}

/** The naive anchor: the training set's median market-cap-to-TVL ratio applied to TVL. */
function ratioAnchor(rows: SnapshotProtocol[]): number {
  const ratios = rows.map((p) => LN(Math.max(1, p.mcap_usd ?? 1)) - LN(Math.max(1, p.tvl_usd))).sort((a, b) => a - b);
  return ratios[ratios.length >> 1]!;
}

interface Pair {
  y: number;
  p: number;
}

function metrics(pairs: Pair[]): Metrics {
  const ys = pairs.map((v) => v.y);
  const mean = ys.reduce((a, v) => a + v, 0) / (ys.length || 1);
  const sst = ys.reduce((a, v) => a + (v - mean) ** 2, 0) || 1;
  const sse = pairs.reduce((a, v) => a + (v.y - v.p) ** 2, 0);
  const errors = pairs.map((v) => Math.abs(v.y - v.p)).sort((a, b) => a - b);
  const medAE = errors[errors.length >> 1] ?? 0;
  const mae = errors.reduce((a, v) => a + v, 0) / (errors.length || 1);
  return { n: pairs.length, r2: round4(1 - sse / sst), medAE: round4(medAE), factor: round4(Math.exp(medAE)), mae: round4(mae) };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

/** Deterministic 5-fold out-of-fold predictions for the fit, the baseline and each blend weight. */
function crossValidate(live: SnapshotProtocol[], asOf: string): { cv: Metrics; cvFit: Metrics; cvBaseline: Metrics; chosen: number; residuals: number[]; folds: number } {
  const assignments = live.map((p) => slugHash(p.slug) % FOLDS);
  const buckets: Pair[][] = Array.from({ length: FOLDS }, () => []);
  const baseBuckets: Pair[][] = Array.from({ length: FOLDS }, () => []);
  for (let f = 0; f < FOLDS; f++) {
    const train = live.filter((_, i) => assignments[i] !== f);
    const c = fit(train, asOf);
    const ratio = ratioAnchor(train);
    for (let i = 0; i < live.length; i++) {
      if (assignments[i] !== f) continue;
      const p = live[i]!;
      const y = LN(Math.max(1, p.mcap_usd ?? 1));
      const fitted = predictLog(c, p, asOf);
      const baseline = LN(Math.max(1, p.tvl_usd)) + ratio;
      buckets[f]!.push({ y, p: fitted });
      baseBuckets[f]!.push({ y, p: baseline });
    }
  }
  const fittedPairs = buckets.flat();
  const baselinePairs = baseBuckets.flat();
  const cvFit = metrics(fittedPairs);
  const cvBaseline = metrics(baselinePairs);
  // Choose the blend that minimises out-of-fold median error, with mean error as a tie-break.
  // A single hold-out would be noise; these are five disjoint out-of-sample windows.
  let chosen = BLENDS[0]!;
  let cv = cvFit;
  let blendPairs = fittedPairs;
  let best = { medAE: Infinity, mae: Infinity };
  for (const w of BLENDS) {
    const pairs = fittedPairs.map((v, i) => {
      const baseline = baselinePairs[i]!.p;
      return { y: v.y, p: w * v.p + (1 - w) * baseline };
    });
    const m = metrics(pairs);
    if (m.medAE < best.medAE || (m.medAE === best.medAE && m.mae < best.mae)) {
      best = { medAE: m.medAE, mae: m.mae };
      chosen = w;
      cv = m;
      blendPairs = pairs;
    }
  }
  return { cv, cvFit, cvBaseline, chosen, residuals: blendPairs.map((v) => v.p - v.y).sort((a, b) => a - b), folds: FOLDS };
}

/** Expanding-window validation by listing date: train on earlier protocols, test on the next slice. */
function walkForward(live: SnapshotProtocol[], asOf: string, blend: number): { metrics: Metrics; folds: WalkFold[] } {
  const ordered = live.slice().sort((a, b) => (a.listed_at ?? '9999').localeCompare(b.listed_at ?? '9999') || a.slug.localeCompare(b.slug));
  const folds: WalkFold[] = [];
  const all: Pair[] = [];
  for (let f = 0; f < 4; f++) {
    const cut = Math.floor((ordered.length * (f + 2)) / 6);
    const train = ordered.slice(0, cut);
    const test = ordered.slice(cut, Math.floor((ordered.length * (f + 3)) / 6));
    if (train.length < 20 || test.length < 5) continue;
    const c = fit(train, asOf);
    const ratio = ratioAnchor(train);
    const pairs = test.map((p) => ({
      y: LN(Math.max(1, p.mcap_usd ?? 1)),
      p: blend * predictLog(c, p, asOf) + (1 - blend) * (LN(Math.max(1, p.tvl_usd)) + ratio),
    }));
    all.push(...pairs);
    folds.push({
      label: `W${f + 1}`,
      train: train.length,
      test: test.length,
      from: test[0]!.listed_at ?? 'undated',
      to: test[test.length - 1]!.listed_at ?? 'undated',
      metrics: metrics(pairs),
    });
  }
  return { metrics: metrics(all), folds };
}

/** Category yield assumptions, stated openly: a starting estimate, not an offer or a promise. */
function grossApy(category: string | null, tvl: number, growth: number): number {
  const c = (category ?? '').toLowerCase();
  let base = 6;
  if (c.includes('perpetual') || c.includes('derivative')) base = 13;
  else if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('basis')) base = 11;
  else if (c.includes('risk curat') || c.includes('allocator')) base = 9;
  else if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) base = 6.5;
  else if (c.includes('rwa')) base = 7;
  else if (c.includes('restak')) base = 6.5;
  else if (c.includes('stak')) base = 4.5;
  else if (c.includes('bridge')) base = 3;
  else if (c.includes('chain')) base = 4;
  else if (c.includes('insurance')) base = 5;
  const size = tvl < 1e8 ? 1.2 : tvl < 1e9 ? 0.6 : 0;
  return round2(Math.max(0, base + size + Math.max(-2, Math.min(2, growth * 0.04))));
}

const L2_CHAIN = /arbitrum|base|optimism|polygon|avalanche|linea|scroll|zksync|blast|fantom/i;

/** The cheapest chain a protocol actually names: a farmer goes where the gas is lowest. */
function cheapestChain(chains: string[]): string {
  return chains.find((c) => /solana/i.test(c)) ?? chains.find((c) => L2_CHAIN.test(c)) ?? chains.find((c) => /ethereum|\beth\b/i.test(c)) ?? chains[0] ?? 'its main chain';
}

/** A rough all-in transaction cost per action, by the chain the plan actually uses. */
function gasPerTx(chain: string): number {
  const names = chain.toLowerCase();
  if (names.includes('solana')) return 0.08;
  if (L2_CHAIN.test(names)) return 0.55;
  if (names.includes('ethereum') || names.includes('eth')) return 9;
  return 1.6;
}

/** One category's concrete first action, in language a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${p.name} on ${chain} and borrow against it only if you can service the loan.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('basis')) return `Provide $${capital} of two-sided liquidity to ${p.name}'s main pool on ${chain}, in the pair the app publishes.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC through ${p.name} to ${chain}, then park it in the destination app the bridge recommends.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $${capital} of the ${chain} staking asset through ${p.name} and keep the receipt token in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${p.name} and open one small, fully collateralised hedge.`;
  if (c.includes('risk curat') || c.includes('allocator')) return `Deposit $${capital} into one ${p.name} vault on ${chain} and record the share price at entry.`;
  if (c.includes('rwa')) return `Mint or buy $${capital} of ${p.name}'s yield asset on ${chain} and hold it through one distribution cycle.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${p.name} on ${chain} and keep the policy receipt.`;
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/** A seven-step plan with a cost and a duration on every step, plus a net-APR calculation. */
export function farmPlan(p: SnapshotProtocol, age: number | null): FarmPlan {
  const chain = cheapestChain(p.chains);
  const names = chain.toLowerCase();
  // One standard $2,000 position: big enough that gas is a real but survivable drag on the yield.
  const capital = 2000;
  const growth = num(p.change_7d, 0);
  const holdDays = age === null ? 60 : age < 180 ? 90 : age < 365 ? 60 : 45;
  const gross = grossApy(p.category, p.tvl_usd, growth);
  const c = (p.category ?? '').toLowerCase();
  const ilReserve = c.includes('dex') || c.includes('basis') ? 2.5 : c.includes('perpetual') || c.includes('derivative') ? 3.5 : c.includes('yield') ? 1.2 : 0.4;
  const gas = gasPerTx(chain);
  // Cheap chains reward weekly upkeep; on Ethereum L1 the check is monthly so gas does not eat the yield.
  const cheap = names.includes('solana') || L2_CHAIN.test(names);
  const txPerYear = cheap ? 52 : names.includes('ethereum') || /\beth\b/.test(names) ? 12 : 24;
  const gasYear = round2(gas * txPerYear + 12);
  const netApr = round2(gross - ilReserve - (gasYear / capital) * 100);
  const excessApr = round2(netApr - BENCHMARK_APR);
  const netUsd = round2((capital * netApr) / 100);
  const breakEven = gross - ilReserve > 0 ? Math.ceil(gasYear / ((gross - ilReserve) / 100)) : null;
  const cadence = txPerYear === 52 ? 'every week' : txPerYear === 24 ? 'every two weeks' : 'every month';
  const action = actionFor(p, capital, chain);
  const steps = [
    `Open one dedicated wallet for ${p.name} on ${chain}, write the seed on paper and keep it offline. Cost: about $${round2(gas)} in first gas. Time: 5 minutes.`,
    `Fund that wallet with $${capital} of USDC from an exchange you already use and keep a separate $${round2(gas * 3)} gas float. Cost: $${capital} of capital plus transfer fees. Time: 10 minutes.`,
    `${action} Cost: $${capital} deployed and about $${round2(gas * 3)} in gas. Time: 15 minutes to set up.`,
    `Repeat one qualifying action ${cadence} - a deposit, swap, borrow or vote. Cost: about $${gasYear} a year in gas at $${gas} per transaction. Time: 10 minutes each time.`,
    `Check collateral and the published vault share price every month; top up if needed. Cost: $0 in fees. Time: 15 minutes a month.`,
    `If a points page appears, claim only from the link on ${p.name}'s own site. Cost: about $${round2(gas * 2)} in gas, never a claim fee. Time: 10 minutes.`,
    `Hold at least ${holdDays} days, then unwind, log every transaction and compare with holding cash. Cost: about $${round2(gas * 2)} in unwind gas. Time: 20 minutes. Modeled net APR after gas and a ${ilReserve}% IL reserve: ${netApr}% ($${netUsd} a year on $${capital}); ${excessApr}% above a ${BENCHMARK_APR}% cash yield.`,
  ];
  return { chain, capital, holdDays, grossApy: gross, ilReserve, gasPerTx: gas, txPerYear, gasYear, netApr, excessApr, netUsd, breakEven, action, steps };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The market-cap reference set: token fields present, CEX excluded from the display only. */
export function liveProtocols(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => !isPreToken(p) && (p.mcap_usd ?? 0) > 0);
}

/** Build the full radar: fit, validate, score every pre-token protocol, cost every plan. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const live = liveProtocols(snapshot);
  const cv = crossValidate(live, snapshot.as_of);
  const walk = walkForward(live, snapshot.as_of, cv.chosen);
  const all = fit(live, snapshot.as_of);
  const ratio = ratioAnchor(live);
  const model: FitModel = {
    ...all,
    ridge: RIDGE,
    blend: cv.chosen,
    ratio0: round4(ratio),
    lo: round4(quantile(cv.residuals, 0.1)),
    hi: round4(quantile(cv.residuals, 0.9)),
    n: live.length,
  };
  const validation: Validation = {
    cv: cv.cv,
    cvFit: cv.cvFit,
    cvBaseline: cv.cvBaseline,
    cvFolds: cv.folds,
    walk: walk.metrics,
    walkFolds: walk.folds,
    blend: cv.chosen,
    residual: { p10: model.lo, p90: model.hi },
  };
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols.filter(isPreToken).map((p) => {
    const fitted = predictLog(all, p, snapshot.as_of);
    const baseline = LN(Math.max(1, p.tvl_usd)) + ratio;
    const logValue = cv.chosen * fitted + (1 - cv.chosen) * baseline;
    const implied = Math.min(1e14, Math.max(1, Math.round(Math.exp(logValue))));
    const age = ageDays(snapshot.as_of, p.listed_at);
    const plan = farmPlan(p, age);
    return {
      rank: 0,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: age,
      implied_value_usd: implied,
      implied_low_usd: Math.max(1, Math.round(implied * Math.exp(model.lo))),
      implied_high_usd: Math.min(1e14, Math.round(implied * Math.exp(model.hi))),
      multiple: round4(implied / Math.max(1, p.tvl_usd)),
      watchlisted: watch.has(p.slug),
      eligible: eligibility(p),
      fit_log: round4(fitted),
      baseline_log: round4(baseline),
      net_apr_pct: plan.netApr,
      net_usd_year: plan.netUsd,
      farm: plan,
      farm_steps: plan.steps,
    } satisfies BoardRow;
  });
  scored.sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));
  const board = scored.map((row, i) => ({ ...row, rank: i + 1 }));

  const caps = live.map((p) => p.mcap_usd ?? 0).sort((a, b) => a - b);
  const tvls = live.map((p) => p.tvl_usd).sort((a, b) => a - b);
  const radar: RadarData = {
    version: 'tide-table-2',
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor: snapshot.floor_usd,
    counts: {
      protocols: snapshot.protocols.length,
      pretoken: snapshot.protocols.filter(isPreToken).length,
      live: live.length,
      watchlist: snapshot.watchlist.length,
      ranked: board.length,
      early: board.filter((r) => !watch.has(r.slug)).length,
    },
    features: FEATURE_NAMES.slice(),
    model,
    validation,
    calibration: { median_ratio: round4(Math.exp(ratio)), median_mcap: caps[caps.length >> 1]!, median_tvl: tvls[tvls.length >> 1]! },
    rows: board.map(radarRow),
    live: live
      .slice()
      .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || a.slug.localeCompare(b.slug))
      .map((p) => ({
        slug: p.slug,
        name: p.name,
        category: p.category ?? 'Unclassified',
        tvl: p.tvl_usd,
        mcap: p.mcap_usd ?? 0,
        ratio: round4((p.mcap_usd ?? 0) / Math.max(1, p.tvl_usd)),
        change: num(p.change_7d, 0),
        listed: p.listed_at,
      })),
  };
  return { board, radar };
}

/** The compact per-row view the page renders; farm steps travel with it so page and board agree. */
function radarRow(r: BoardRow): RadarRow {
  return {
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category ?? 'Unclassified',
    chains: r.chains,
    tvl: r.tvl_usd,
    change: num(r.change_7d, 0),
    age: r.age_days,
    implied: r.implied_value_usd,
    low: r.implied_low_usd,
    high: r.implied_high_usd,
    multiple: r.multiple,
    watchlisted: r.watchlisted,
    eligible: r.eligible,
    netApr: r.net_apr_pct,
    excessApr: round2(r.net_apr_pct - BENCHMARK_APR),
    netUsd: r.net_usd_year,
    capital: r.farm.capital,
    holdDays: r.farm.holdDays,
    gasPerTx: r.farm.gasPerTx,
    txPerYear: r.farm.txPerYear,
    gasYear: r.farm.gasYear,
    grossApy: r.farm.grossApy,
    ilReserve: r.farm.ilReserve,
    fitLog: r.fit_log,
    baseLog: r.baseline_log,
    action: r.farm.action,
    steps: r.farm.steps,
  };
}

/** Parse the sealed input, refusing a document the model cannot score. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((v) => typeof v !== 'string')) throw new SnapshotError('snapshot.json has no watchlist');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) throw new SnapshotError(`protocol ${i} lacks a slug, name or TVL`);
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    } satisfies SnapshotProtocol;
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** The gate's own board rules, checked before anything is written. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, not 100 to 4000`;
  const slugs = new Set<string>();
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) {
    if (!known.has(r.slug)) return `${r.slug} is not in the snapshot`;
    if (slugs.has(r.slug)) return `${r.slug} appears twice`;
    slugs.add(r.slug);
    if (r.rank <= 0 || !Number.isSafeInteger(r.rank)) return `${r.slug} has rank ${r.rank}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  for (const slug of snapshot.watchlist) if (!slugs.has(slug)) return `the board misses watchlist slug ${slug}`;
  for (let i = 0; i < board.length; i++) if (board[i]!.rank !== i + 1) return `rank ${i + 1} is ${board[i]!.rank}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i}`;
  if (board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'the board ranks nothing by value';
  return null;
}

/** One self-contained script: the whole dashboard dataset, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
