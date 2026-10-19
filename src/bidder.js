import { EventEmitter } from 'node:events';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { NBR, validateBidRequest, impSizes, requestDomain, requestCategories, userId, deviceType } from './openrtb.js';
import { CtrModel, extractFeatures } from './ctr.js';

const DAY_MS = 86_400_000;
const HOLD_TTL_MS = 60_000; // how long an unresolved bid reserves budget
const PRIOR_CTR = 0.01;
const PRIOR_WEIGHT = 200;

/**
 * DSP bidder: evaluates OpenRTB bid requests against campaigns and handles
 * win / impression / click callbacks. Emits 'bid', 'win', 'impression', 'click'.
 */
export class Bidder extends EventEmitter {
  constructor({ store, secret, baseUrl = 'http://localhost:8080', now = () => Date.now(), model = new CtrModel() }) {
    super();
    this.model = model;
    this.store = store;
    this.secret = secret || randomUUID();
    this.baseUrl = baseUrl;
    this.now = now;
    this.freq = new Map(); // `${user}|${campaign}` -> impression timestamps
    this.holds = new Map(); // bidId -> { campaignId, amount, expires }
    this.holdTotals = new Map(); // campaignId -> reserved $
    this.seen = { win: new Set(), imp: new Set(), click: new Set() }; // idempotency
    this.seenOrder = [];
  }

  // ---- bidding -----------------------------------------------------------

  handle(req) {
    const err = validateBidRequest(req);
    if (err) return { status: 400, error: err, nbr: NBR.INVALID_REQUEST };
    this.sweep();
    const seatbid = [];
    for (const imp of req.imp) {
      const bid = this.bidForImp(req, imp);
      if (bid) seatbid.push(bid);
    }
    if (!seatbid.length) return { status: 204, nbr: NBR.NO_MATCH };
    return {
      status: 200,
      body: { id: req.id, cur: 'USD', seatbid: [{ seat: 'dsp-1', bid: seatbid }] },
    };
  }

  bidForImp(req, imp) {
    const t = this.now();
    const user = userId(req);
    const floor = Number(imp.bidfloor) || 0;
    let best = null;
    for (const c of this.store.list()) {
      const cand = this.evaluate(c, req, imp, user, floor, t);
      if (cand && (!best || cand.price > best.price)) best = cand;
    }
    if (!best) return null;

    const { campaign: c, creative, price } = best;
    const bidId = randomUUID();
    const token = this.sign({ b: bidId, c: c.id, cr: creative.id, u: user, p: price, t, f: best.feats });
    const amount = price / 1000;
    this.holds.set(bidId, { campaignId: c.id, amount, expires: t + HOLD_TTL_MS });
    this.holdTotals.set(c.id, (this.holdTotals.get(c.id) || 0) + amount);
    c.stats.bids++;
    this.emit('bid', { campaignId: c.id, price });

    const q = encodeURIComponent(token);
    const clickUrl = `${this.baseUrl}/track/click?t=${q}`;
    const adm = creative.markup.replaceAll('{{CLICK_URL}}', clickUrl) +
      `<img src="${this.baseUrl}/track/imp?t=${q}" width="1" height="1" style="display:none" alt="">`;
    return {
      id: bidId,
      impid: imp.id,
      price: round(price),
      nurl: `${this.baseUrl}/track/win?t=${q}&price=\${AUCTION_PRICE}`,
      adm,
      adomain: creative.adomain,
      cid: c.id,
      crid: creative.id,
      w: creative.w,
      h: creative.h,
    };
  }

  /** Returns { campaign, creative, price } if the campaign may bid on this impression. */
  evaluate(c, req, imp, user, floor, t) {
    if (c.status !== 'active') return null;
    const tg = c.targeting;

    const creative = c.creatives.find((cr) => impSizes(imp).some(([w, h]) => w === cr.w && h === cr.h));
    if (!creative || !imp.banner) return null;

    const country = (req.device?.geo?.country || req.user?.geo?.country || '').toUpperCase();
    if (tg.countries.length && !tg.countries.includes(country)) return null;
    if (tg.devices.length && !tg.devices.includes(deviceType(req))) return null;
    if (tg.os.length && !tg.os.includes((req.device?.os || '').toLowerCase())) return null;
    if (tg.hours && !tg.hours.includes(new Date(t).getUTCHours())) return null;

    const domain = requestDomain(req);
    if (tg.domainBlock.some((d) => domain === d || domain.endsWith('.' + d))) return null;
    if (tg.domainAllow.length && !tg.domainAllow.some((d) => domain === d || domain.endsWith('.' + d))) return null;
    if (tg.categories.length && !requestCategories(req).some((k) => tg.categories.includes(k))) return null;
    if ((req.bcat || []).some((k) => requestCategories(req).includes(k))) return null;
    if ((req.badv || []).some((a) => creative.adomain.includes(a))) return null;

    if (c.frequencyCap && this.freqCount(user, c, t) >= c.frequencyCap.count) return null;

    const feats = c.goal === 'cpc' ? extractFeatures(req, imp, c.id, t) : null;
    const price = this.price(c, feats);
    if (price < floor || price <= 0) return null;
    if (!this.budgetOk(c, price, t)) return null;
    return { campaign: c, creative, price, feats };
  }

  /** Bid price in CPM. CPC goals translate target CPC into eCPM via predicted CTR. */
  price(c, feats) {
    let p = c.bidCpm;
    if (c.goal === 'cpc') p = c.targetCpc * (feats ? this.model.predict(feats) : this.predictCtr(c)) * 1000;
    return Math.min(p, c.maxBidCpm);
  }

  predictCtr(c) {
    const { impressions, clicks } = c.stats;
    return (clicks + PRIOR_CTR * PRIOR_WEIGHT) / (impressions + PRIOR_WEIGHT);
  }

  budgetOk(c, price, t) {
    this.store.rollDay(c);
    const hold = this.holdTotals.get(c.id) || 0;
    const cost = price / 1000;
    if (c.day.spend + hold + cost > c.dailyBudget) return false;
    if (c.totalBudget != null && c.stats.spend + hold + cost > c.totalBudget) return false;
    if (c.pacing === 'even') {
      // Allow spend proportional to elapsed day (plus one bid of slack so day starts cleanly).
      const elapsed = (t - c.day.start) / DAY_MS;
      if (c.day.spend + hold > c.dailyBudget * elapsed + cost) return false;
    }
    return true;
  }

  freqCount(user, c, t) {
    const key = `${user}|${c.id}`;
    const arr = this.freq.get(key);
    if (!arr) return 0;
    const cutoff = t - c.frequencyCap.windowSec * 1000;
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (!arr.length) this.freq.delete(key);
    return arr.length;
  }

  // ---- callbacks ---------------------------------------------------------

  /** Win notice: charge the clearing price (second price or first price, as told by the exchange). */
  onWin(token, clearingPrice) {
    const p = this.verify(token);
    if (!p) return { ok: false, error: 'bad token' };
    if (this.once('win', p.b)) return { ok: true, duplicate: true };
    const c = this.store.get(p.c);
    this.release(p.b);
    let price = Number(clearingPrice);
    if (!(price >= 0)) return { ok: false, error: 'bad price' };
    price = Math.min(price, p.p); // never pay more than we bid
    if (!c) return { ok: false, error: 'campaign gone' };
    const cost = price / 1000;
    this.store.rollDay(c);
    c.day.spend += cost;
    c.stats.spend += cost;
    c.stats.wins++;
    this.emit('win', { campaignId: c.id, price, cost });
    return { ok: true };
  }

  onImpression(token) {
    const p = this.verify(token);
    if (!p) return { ok: false, error: 'bad token' };
    if (this.once('imp', p.b)) return { ok: true, duplicate: true };
    const c = this.store.get(p.c);
    if (!c) return { ok: false, error: 'campaign gone' };
    c.stats.impressions++;
    if (p.f) this.model.train(p.f, 0);
    const key = `${p.u}|${c.id}`;
    const arr = this.freq.get(key) || [];
    arr.push(this.now());
    this.freq.set(key, arr);
    this.emit('impression', { campaignId: c.id });
    return { ok: true };
  }

  onClick(token) {
    const p = this.verify(token);
    if (!p) return { ok: false, error: 'bad token' };
    if (this.once('click', p.b)) return { ok: true, duplicate: true };
    const c = this.store.get(p.c);
    if (!c) return { ok: false, error: 'campaign gone' };
    c.stats.clicks++;
    if (p.f) this.model.correctToClick(p.f);
    this.emit('click', { campaignId: c.id });
    return { ok: true };
  }

  // ---- internals ---------------------------------------------------------

  once(kind, id) {
    const set = this.seen[kind];
    if (set.has(id)) return true;
    set.add(id);
    this.seenOrder.push([kind, id]);
    if (this.seenOrder.length > 300_000) {
      for (const [k, i] of this.seenOrder.splice(0, 100_000)) this.seen[k].delete(i);
    }
    return false;
  }

  release(bidId) {
    const h = this.holds.get(bidId);
    if (!h) return;
    this.holds.delete(bidId);
    const left = (this.holdTotals.get(h.campaignId) || 0) - h.amount;
    if (left > 1e-12) this.holdTotals.set(h.campaignId, left);
    else this.holdTotals.delete(h.campaignId);
  }

  sweep() {
    const t = this.now();
    for (const [id, h] of this.holds) if (h.expires <= t) this.release(id);
  }

  sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verify(token) {
    if (typeof token !== 'string') return null;
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const want = createHmac('sha256', this.secret).update(body).digest();
    let got;
    try { got = Buffer.from(mac, 'base64url'); } catch { return null; }
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  }
}

const round = (n) => Math.round(n * 10000) / 10000;
