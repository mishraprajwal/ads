/** In-memory rolling metrics: per-second buckets for the last 5 minutes plus a latency reservoir. */
export class Metrics {
  constructor(now = () => Date.now(), windowSec = 300) {
    this.now = now;
    this.windowSec = windowSec;
    this.buckets = new Map(); // second -> counters
    this.totals = { requests: 0, filled: 0, noBid: 0, timeouts: 0, wins: 0, impressions: 0, clicks: 0, conversions: 0, spend: 0, revenue: 0 };
    this.lat = new Array(2048).fill(0);
    this.latN = 0;
  }

  inc(key, n = 1) {
    this.totals[key] += n;
    const s = Math.floor(this.now() / 1000);
    let b = this.buckets.get(s);
    if (!b) {
      b = { requests: 0, filled: 0, wins: 0, impressions: 0, clicks: 0, spend: 0 };
      this.buckets.set(s, b);
      for (const k of this.buckets.keys()) if (k < s - this.windowSec) this.buckets.delete(k);
    }
    if (key in b) b[key] += n;
  }

  latency(ms) {
    this.lat[this.latN++ % this.lat.length] = ms;
  }

  percentile(p) {
    const n = Math.min(this.latN, this.lat.length);
    if (!n) return 0;
    const a = this.lat.slice(0, n).sort((x, y) => x - y);
    return a[Math.min(n - 1, Math.floor((p / 100) * n))];
  }

  series(seconds = 60) {
    const end = Math.floor(this.now() / 1000);
    const out = [];
    for (let s = end - seconds + 1; s <= end; s++) {
      const b = this.buckets.get(s) || {};
      out.push({ t: s * 1000, requests: b.requests || 0, filled: b.filled || 0, wins: b.wins || 0, impressions: b.impressions || 0, clicks: b.clicks || 0, spend: b.spend || 0 });
    }
    return out;
  }

  snapshot() {
    const t = this.totals;
    return {
      ...t,
      fillRate: t.requests ? t.filled / t.requests : 0,
      ctr: t.impressions ? t.clicks / t.impressions : 0,
      ecpm: t.impressions ? (t.spend / t.impressions) * 1000 : 0,
      latencyMs: { p50: this.percentile(50), p95: this.percentile(95), p99: this.percentile(99) },
    };
  }
}
