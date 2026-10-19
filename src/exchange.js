import { validateBidRequest, impSizes } from './openrtb.js';

/**
 * Ad exchange: fans a bid request out to bidders in parallel with a timeout (tmax),
 * runs a first- or second-price auction per impression, then fires win notices.
 *
 * A bidder is { id, bid(request) => Promise<OpenRTB response | null> }.
 */
export class Exchange {
  constructor({ bidders = [], auctionType = 2, tmaxMs = 120, onResult = () => {}, fireWin, onMarket }) {
    this.bidders = bidders;
    this.auctionType = auctionType; // 1 = first price, 2 = second price
    this.tmaxMs = tmaxMs;
    this.onResult = onResult;
    this.fireWin = fireWin; // (bidderId, bid, clearingPrice) => void
    // (bidderId, bid, marketPrice, won) => void. marketPrice is the highest competing bid
    // (or the floor), i.e. the price this bidder had to beat. Sent to winners and losers.
    this.onMarket = onMarket;
  }

  async auction(req) {
    const t0 = performance.now();
    const err = validateBidRequest(req);
    if (err) return { error: err, status: 400 };
    const tmax = Math.min(req.tmax || this.tmaxMs, this.tmaxMs);
    req = { ...req, at: this.auctionType };

    const settled = await Promise.all(this.bidders.map((b) => this.callBidder(b, req, tmax)));
    const timeouts = settled.filter((s) => s.timedOut).length;

    const results = [];
    for (const imp of req.imp) {
      const floor = Number(imp.bidfloor) || 0;
      const sizes = impSizes(imp);
      const entries = [];
      for (const s of settled) {
        for (const sb of s.res?.seatbid || []) {
          for (const bid of sb.bid || []) {
            if (bid.impid !== imp.id || !(bid.price >= floor) || !(bid.price > 0)) continue;
            if (sizes.length && !sizes.some(([w, h]) => w === bid.w && h === bid.h)) continue;
            entries.push({ bidder: s.bidder.id, bid });
          }
        }
      }
      entries.sort((a, b) => b.bid.price - a.bid.price);
      if (!entries.length) { results.push({ impid: imp.id, filled: false }); continue; }

      const [win, runnerUp] = entries;
      const clearing = this.auctionType === 1
        ? win.bid.price
        : Math.min(win.bid.price, Math.max(floor, runnerUp ? runnerUp.bid.price + 0.01 : floor));
      const price = Math.round(clearing * 10000) / 10000;
      this.fireWin?.(win.bidder, win.bid, price);
      entries.forEach((e, i) => {
        const others = i === 0 ? runnerUp : win;
        this.onMarket?.(e.bidder, e.bid, Math.max(floor, others ? others.bid.price : 0), i === 0);
      });
      results.push({ impid: imp.id, filled: true, winner: win.bidder, bid: { ...win.bid, price }, bidPrice: win.bid.price, clearingPrice: price, numBids: entries.length });
    }

    const out = { id: req.id, results, timeouts, latencyMs: performance.now() - t0 };
    this.onResult(out);
    return out;
  }

  async callBidder(bidder, req, tmax) {
    let timer;
    try {
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), tmax); });
      const res = await Promise.race([Promise.resolve().then(() => bidder.bid(structuredClone(req))), timeout]);
      if (res === 'timeout') return { bidder, timedOut: true };
      return { bidder, res };
    } catch {
      return { bidder, error: true };
    } finally {
      clearTimeout(timer);
    }
  }
}
