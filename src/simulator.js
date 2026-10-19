import { randomUUID } from 'node:crypto';

const SITES = [
  { domain: 'news.example.com', cat: ['IAB12'], base: 1.2 },
  { domain: 'sports.example.com', cat: ['IAB17'], base: 1.8 },
  { domain: 'tech.example.org', cat: ['IAB19'], base: 2.4 },
  { domain: 'recipes.example.net', cat: ['IAB8'], base: 0.9 },
  { domain: 'shady-clicks.biz', cat: ['IAB25'], base: 0.3 },
];
const COUNTRIES = ['US', 'US', 'US', 'GB', 'DE', 'IN', 'BR'];
const DEVICES = [{ devicetype: 2, os: 'macOS' }, { devicetype: 4, os: 'iOS' }, { devicetype: 4, os: 'Android' }, { devicetype: 5, os: 'iOS' }];
const SIZES = [[300, 250], [728, 90], [320, 50], [160, 600]];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

export function randomBidRequest(userPool = 5000) {
  const site = pick(SITES);
  const [w, h] = pick(SIZES);
  const dev = pick(DEVICES);
  const floor = Math.round(site.base * (0.4 + Math.random() * 0.6) * 100) / 100;
  return {
    id: randomUUID(),
    at: 2,
    tmax: 100,
    imp: [{ id: '1', banner: { w, h, format: [{ w, h }] }, bidfloor: floor, bidfloorcur: 'USD' }],
    site: { id: site.domain, domain: site.domain, cat: site.cat, page: `https://${site.domain}/a/${Math.floor(Math.random() * 1000)}` },
    device: { devicetype: dev.devicetype, os: dev.os, ip: '203.0.113.1', geo: { country: pick(COUNTRIES) } },
    user: { id: `u${Math.floor(Math.random() * userPool)}` },
    cur: ['USD'],
  };
}

/** Competing DSP whose bid is a noisy function of the publisher's price level. */
export function competitorBidder(id, { aggression = 1, bidRate = 0.8, latencyMs = 5 } = {}) {
  return {
    id,
    async bid(req) {
      if (latencyMs) await new Promise((r) => setTimeout(r, Math.random() * latencyMs));
      if (Math.random() > bidRate) return null;
      const bids = [];
      for (const imp of req.imp) {
        const w = imp.banner.format?.[0]?.w ?? imp.banner.w;
        const h = imp.banner.format?.[0]?.h ?? imp.banner.h;
        const price = Math.max(0.05, (imp.bidfloor || 0.5) * (0.8 + Math.random() * 1.6) * aggression);
        bids.push({ id: randomUUID(), impid: imp.id, price: Math.round(price * 100) / 100, w, h, adm: '<div>competitor</div>' });
      }
      return { id: req.id, cur: 'USD', seatbid: [{ seat: id, bid: bids }] };
    },
  };
}

/** Drives synthetic traffic through the exchange and simulates impressions/clicks on won bids. */
export class Simulator {
  constructor({ exchange, bidder, rps = 200 }) {
    this.exchange = exchange;
    this.bidder = bidder;
    this.rps = rps;
    this.timer = null;
    this.sent = 0;
    this.inflight = 0;
    this.trueCtr = new Map();
    this.lastDomains = new Map();
    this.lastDevices = new Map();
    this.trueCvr = new Map();
  }

  get running() { return !!this.timer; }

  start(rps = this.rps) {
    this.stop();
    this.rps = Math.max(1, Math.min(rps, 5000));
    const tickMs = 50;
    let carry = 0;
    this.timer = setInterval(() => {
      carry += (this.rps * tickMs) / 1000;
      const n = Math.floor(carry);
      carry -= n;
      for (let i = 0; i < n; i++) if (this.inflight < 2000) this.fire();
    }, tickMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async fire() {
    this.inflight++;
    this.sent++;
    try {
      const request = randomBidRequest();
      const out = await this.exchange.auction(request);
      for (const r of out.results || []) {
        if (r.filled && r.winner === 'dsp-1') {
          this.lastDomains.set(r.bid.id, request.site.domain);
          this.lastDevices.set(r.bid.id, request.device.devicetype);
          this.simulateRender(r.bid);
        }
      }
    } finally {
      this.inflight--;
    }
  }

  /** Hidden ground truth: click propensity depends on campaign, site, device and ad size. */
  clickProb(c, bid) {
    if (!this.trueCtr.has(c.id)) this.trueCtr.set(c.id, 0.004 + Math.random() * 0.01);
    const dom = this.lastDomains.get(bid.id) || '';
    let p = this.trueCtr.get(c.id);
    if (dom.startsWith('sports')) p *= 2.5;
    if (dom.startsWith('shady')) p *= 0.2;
    if (bid.w === 320 && bid.h === 50) p *= 1.8;
    if (bid.w === 728) p *= 0.6;
    return p;
  }

  /** Hidden ground truth for P(convert | click): tech sites and desktop convert best. */
  convProb(c, bid) {
    if (!this.trueCvr.has(c.id)) this.trueCvr.set(c.id, 0.04 + Math.random() * 0.08);
    const dom = this.lastDomains.get(bid.id) || '';
    let p = this.trueCvr.get(c.id);
    if (dom.startsWith('tech')) p *= 2.5;
    if (dom.startsWith('shady')) p *= 0.2;
    if (this.lastDevices.get(bid.id) === 2) p *= 1.6;
    return p;
  }

  simulateRender(bid) {
    const token = new URL(bid.nurl).searchParams.get('t');
    if (Math.random() < 0.95) {
      this.bidder.onImpression(token);
      const c = this.bidder.store.get(bid.cid);
      if (c && Math.random() < this.clickProb(c, bid)) {
        this.bidder.onClick(token);
        if (Math.random() < this.convProb(c, bid)) this.bidder.onConversion(token);
      }
    }
    this.lastDomains.delete(bid.id);
    this.lastDevices.delete(bid.id);
  }
}
