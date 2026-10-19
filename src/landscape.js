const MIN_P = 0.02;
const MAX_P = 100;
const N = 64;
const LOG_RANGE = Math.log(MAX_P / MIN_P);
const DECAY = 0.9995; // older observations fade so the model tracks the market
const MIN_SAMPLES = 30;
const BLEND_K = 20; // pseudo-observations of the global distribution mixed into each segment
const MAX_SEGMENTS = 5000;
const COLD_SHADE = 0.8;

const edge = (i) => MIN_P * Math.exp((i / N) * LOG_RANGE);
const bucket = (p) => Math.min(N - 1, Math.max(0, Math.floor((Math.log(Math.max(p, MIN_P) / MIN_P) / LOG_RANGE) * N)));

class Hist {
  constructor() { this.c = new Float64Array(N); this.n = 0; }
  add(p) {
    for (let i = 0; i < N; i++) this.c[i] *= DECAY;
    this.n = this.n * DECAY + 1;
    this.c[bucket(p)] += 1;
  }
  /** P(market price < b), interpolating inside the bucket. */
  cdf(b) {
    if (!this.n) return 0;
    if (b <= MIN_P) return 0;
    if (b >= MAX_P) return 1;
    const k = bucket(b);
    let s = 0;
    for (let i = 0; i < k; i++) s += this.c[i];
    s += this.c[k] * Math.min(1, Math.max(0, (b - edge(k)) / (edge(k + 1) - edge(k))));
    return s / this.n;
  }
}

/**
 * Bid landscape: learns the distribution of "price to beat" per segment from auction
 * feedback, then picks the bid that maximizes expected surplus (value - bid) * P(win | bid).
 *   - second-price auctions: bidding your value is optimal, so the bid is the value;
 *   - first-price auctions: the bid is shaded below value toward the learned market price.
 */
export class BidLandscape {
  constructor() {
    this.global = new Hist();
    this.segments = new Map();
  }

  observe(seg, marketPrice) {
    if (!(marketPrice > 0)) return;
    this.global.add(marketPrice);
    let h = this.segments.get(seg);
    if (!h && this.segments.size < MAX_SEGMENTS) { h = new Hist(); this.segments.set(seg, h); }
    h?.add(marketPrice);
  }

  /** Probability a bid of `b` CPM wins; null until there is enough data. */
  winProb(seg, b) {
    if (this.global.n < MIN_SAMPLES) return null;
    const g = this.global.cdf(b);
    const h = this.segments.get(seg);
    if (!h) return g;
    return (h.n * h.cdf(b) + BLEND_K * g) / (h.n + BLEND_K);
  }

  optimalBid({ value, floor = 0, at = 2, seg }) {
    if (at !== 1) return value;
    if (this.global.n < MIN_SAMPLES) {
      const b = value * COLD_SHADE;
      return b < floor && value >= floor ? floor : b;
    }
    const lo = Math.max(floor, MIN_P);
    if (lo >= value) return value;
    let best = value;
    let bestScore = -1;
    const STEPS = 40;
    for (let i = 0; i <= STEPS; i++) {
      const b = lo + ((value - lo) * i) / STEPS;
      const score = (value - b) * this.winProb(seg, b);
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return bestScore > 0 ? best : value;
  }
}
