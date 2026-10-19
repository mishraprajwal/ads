import test from 'node:test';
import assert from 'node:assert/strict';
import { CampaignStore } from '../src/campaigns.js';
import { Bidder } from '../src/bidder.js';
import { Exchange } from '../src/exchange.js';
import { createApp } from '../src/server.js';
import { extractFeatures } from '../src/ctr.js';
import { BidLandscape } from '../src/landscape.js';

const creative = { w: 300, h: 250, markup: '<a href="{{CLICK_URL}}">ad</a>', adomain: ['a.com'] };
const camp = (o = {}) => ({ name: 'c', bidCpm: 2, dailyBudget: 100, pacing: 'asap', creatives: [creative], ...o });
const req = (o = {}) => ({
  id: 'r1', imp: [{ id: '1', banner: { w: 300, h: 250 }, bidfloor: 0.5 }],
  site: { domain: 'news.example.com', cat: ['IAB12'] },
  device: { devicetype: 4, os: 'iOS', geo: { country: 'US' } }, user: { id: 'u1' }, ...o,
});
const setup = (now = () => 1_700_000_000_000) => {
  const store = new CampaignStore(now);
  return { store, bidder: new Bidder({ store, secret: 's', now }) };
};
const tokenOf = (bid) => new URL(bid.nurl).searchParams.get('t');

test('bids on matching request, no-bids on invalid / mismatched', () => {
  const { store, bidder } = setup();
  store.create(camp({ targeting: { countries: ['US'], devices: ['mobile'] } }));
  const r = bidder.handle(req());
  assert.equal(r.status, 200);
  assert.equal(r.body.seatbid[0].bid[0].price, 2);
  assert.equal(bidder.handle(req({ device: { devicetype: 2, geo: { country: 'US' } } })).status, 204);
  assert.equal(bidder.handle({ id: 'x' }).status, 400);
});

test('respects floor, domain block, size and bcat', () => {
  const { store, bidder } = setup();
  store.create(camp({ targeting: { domainBlock: ['news.example.com'] } }));
  assert.equal(bidder.handle(req()).status, 204);
  const s2 = setup();
  s2.store.create(camp());
  assert.equal(s2.bidder.handle(req({ imp: [{ id: '1', banner: { w: 300, h: 250 }, bidfloor: 5 }] })).status, 204);
  assert.equal(s2.bidder.handle(req({ imp: [{ id: '1', banner: { w: 728, h: 90 } }] })).status, 204);
  assert.equal(s2.bidder.handle(req({ bcat: ['IAB12'] })).status, 204);
});

test('win charges clearing price once, never above bid; budget stops bidding', () => {
  const { store, bidder } = setup();
  const c = store.create(camp({ bidCpm: 10, dailyBudget: 0.02 }));
  const bid = bidder.handle(req()).body.seatbid[0].bid[0];
  // budget hold prevents a second concurrent bid (0.01 held + 0.01 > 0.02 is ok, third is not)
  assert.equal(bidder.onWin(tokenOf(bid), 99).ok, true);
  assert.equal(c.stats.spend, 0.01); // capped at own bid 10 CPM
  assert.equal(bidder.onWin(tokenOf(bid), 99).duplicate, true);
  assert.equal(c.stats.spend, 0.01);
  assert.equal(bidder.handle(req()).status, 200);
  const third = bidder.handle(req());
  assert.equal(third.status, 204);
});

test('rejects forged tokens', () => {
  const { store, bidder } = setup();
  store.create(camp());
  const bid = bidder.handle(req()).body.seatbid[0].bid[0];
  const [body, mac] = tokenOf(bid).split('.');
  const forged = `${body}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  assert.equal(bidder.onWin(forged, 1).ok, false);
  assert.equal(bidder.onClick('garbage').ok, false);
});

test('frequency cap applies after impressions', () => {
  const { store, bidder } = setup();
  store.create(camp({ frequencyCap: { count: 2, windowSec: 3600 } }));
  for (let i = 0; i < 2; i++) {
    const bid = bidder.handle(req({ id: 'r' + i })).body.seatbid[0].bid[0];
    bidder.onImpression(tokenOf(bid));
  }
  assert.equal(bidder.handle(req()).status, 204);
  assert.equal(bidder.handle(req({ user: { id: 'other' } })).status, 200);
});

test('even pacing throttles early in the day', () => {
  const dayStartMs = Math.floor(1_700_000_000_000 / 86_400_000) * 86_400_000;
  let t = dayStartMs + 1000;
  const { store, bidder } = setup(() => t);
  const c = store.create(camp({ pacing: 'even', dailyBudget: 10, bidCpm: 5 }));
  c.day.spend = 1; // already ahead of schedule at 1s into the day
  assert.equal(bidder.handle(req()).status, 204);
  t = dayStartMs + 12 * 3_600_000; // half day: allowed 5
  assert.equal(bidder.handle(req()).status, 200);
});

test('cpc goal bids scale with learned CTR', () => {
  const { store, bidder } = setup();
  const c = store.create(camp({ goal: 'cpc', targetCpc: 1, maxBidCpm: 100 }));
  const before = bidder.price(c);
  c.stats.impressions = 10000; c.stats.clicks = 500;
  assert.ok(bidder.price(c) > before * 2);
});

test('second-price auction clears at runner-up + 0.01, floor respected, timeouts dropped', async () => {
  const mk = (id, price, delay = 0) => ({
    id,
    bid: async (r) => {
      if (delay) await new Promise((res) => setTimeout(res, delay));
      return { id: r.id, seatbid: [{ bid: [{ id: id + 'b', impid: '1', price, w: 300, h: 250 }] }] };
    },
  });
  const wins = [];
  const ex = new Exchange({ bidders: [mk('a', 5), mk('b', 3), mk('c', 9, 200), mk('d', 0.1)], tmaxMs: 50, fireWin: (id, bid, p) => wins.push([id, p]) });
  const out = await ex.auction(req());
  assert.equal(out.timeouts, 1);
  assert.deepEqual(wins, [['a', 3.01]]);
  assert.equal(out.results[0].numBids, 2);
  const ex1 = new Exchange({ bidders: [mk('a', 5), mk('b', 3)], auctionType: 1, fireWin: (id, b, p) => wins.push([id, p]) });
  await ex1.auction(req());
  assert.deepEqual(wins[1], ['a', 5]);
});

test('HTTP end-to-end: campaign, auction, tracking, stats', async () => {
  const app = createApp({ secret: 's' });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    let res = await fetch(base + '/api/campaigns', { method: 'POST', body: JSON.stringify(camp({ bidCpm: 50, maxBidCpm: 50 })) });
    assert.equal(res.status, 201);
    res = await fetch(base + '/api/campaigns', { method: 'POST', body: '{"name":"x"}' });
    assert.equal(res.status, 400);

    res = await fetch(base + '/openrtb/bid', { method: 'POST', body: JSON.stringify(req()) });
    assert.equal(res.status, 200);
    const bid = (await res.json()).seatbid[0].bid[0];
    const url = new URL(bid.nurl.replace('${AUCTION_PRICE}', '1.5'));
    assert.equal((await fetch(base + url.pathname + url.search)).status, 200);
    const t = encodeURIComponent(url.searchParams.get('t'));
    assert.equal((await fetch(`${base}/track/imp?t=${t}`)).headers.get('content-type'), 'image/gif');
    assert.equal((await fetch(`${base}/track/click?t=${t}`)).status, 200);

    const stats = await (await fetch(base + '/api/stats')).json();
    const c = stats.campaigns[0];
    assert.equal(c.stats.wins, 1);
    assert.equal(c.stats.impressions, 1);
    assert.equal(c.stats.clicks, 1);
    assert.ok(Math.abs(c.stats.spend - 0.0015) < 1e-9);

    res = await fetch(base + '/exchange/auction', { method: 'POST', body: JSON.stringify(req({ id: 'r2', user: { id: 'u2' } })) });
    const out = await res.json();
    assert.equal(out.results[0].filled, true);
    assert.equal((await fetch(base + '/exchange/auction', { method: 'POST', body: '{bad' })).status, 400);
  } finally {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
  }
});

test('CTR model learns segment differences and cpc bids follow them', () => {
  const { store, bidder } = setup();
  const c = store.create(camp({ goal: 'cpc', targetCpc: 1, maxBidCpm: 100, dailyBudget: 1e6 }));
  const sports = req({ site: { domain: 'sports.example.com', cat: [] } });
  const shady = req({ site: { domain: 'shady-clicks.biz', cat: [] } });
  const feats = (r) => extractFeatures(r, r.imp[0], c.id, 1_700_000_000_000);
  for (let i = 0; i < 20000; i++) {
    const hot = i % 2 === 0;
    const idx = feats(hot ? sports : shady);
    bidder.model.train(idx, 0);
    if (Math.random() < (hot ? 0.05 : 0.002)) bidder.model.correctToClick(idx);
  }
  const hot = bidder.model.predict(feats(sports));
  const cold = bidder.model.predict(feats(shady));
  assert.ok(hot > 0.03 && hot < 0.08, `hot ${hot}`);
  assert.ok(cold < 0.01, `cold ${cold}`);
  assert.ok(bidder.price(c, feats(sports)) > 5 * bidder.price(c, feats(shady)));
});

test('impression and click callbacks update the model via the signed token', () => {
  const { store, bidder } = setup();
  store.create(camp({ goal: 'cpc', targetCpc: 1, maxBidCpm: 100 }));
  const bid = bidder.handle(req()).body.seatbid[0].bid[0];
  const before = bidder.model.updates;
  bidder.onImpression(tokenOf(bid));
  bidder.onClick(tokenOf(bid));
  assert.equal(bidder.model.updates, before + 2);
});

test('CVR model learns from clicks/conversions and cpa bids follow it', () => {
  const { store, bidder } = setup();
  const c = store.create(camp({ goal: 'cpa', targetCpa: 10, maxBidCpm: 1000, dailyBudget: 1e6 }));
  const tech = req({ site: { domain: 'tech.example.org', cat: [] } });
  const shady = req({ site: { domain: 'shady-clicks.biz', cat: [] } });
  const feats = (r) => extractFeatures(r, r.imp[0], c.id, 1_700_000_000_000);
  for (let i = 0; i < 20000; i++) {
    const hot = i % 2 === 0;
    const idx = feats(hot ? tech : shady);
    bidder.cvrModel.train(idx, 0);
    if (Math.random() < (hot ? 0.3 : 0.01)) bidder.cvrModel.correctToClick(idx);
  }
  const hot = bidder.cvrModel.predict(feats(tech));
  assert.ok(hot > 0.2 && hot < 0.4, `hot ${hot}`);
  assert.ok(bidder.cvrModel.predict(feats(shady)) < 0.05);
  assert.ok(bidder.value(c, feats(tech)) > 5 * bidder.value(c, feats(shady)));
});

test('conversion callback requires a prior click, is idempotent, and counts once', () => {
  const { store, bidder } = setup();
  const c = store.create(camp({ goal: 'cpa', targetCpa: 10, maxBidCpm: 1000 }));
  const bid = bidder.handle(req()).body.seatbid[0].bid[0];
  const t = tokenOf(bid);
  assert.equal(bidder.onConversion(t).ok, false);
  bidder.onImpression(t);
  bidder.onClick(t);
  assert.equal(bidder.onConversion(t).ok, true);
  assert.equal(bidder.onConversion(t).duplicate, true);
  assert.equal(c.stats.conversions, 1);
  assert.equal(bidder.onConversion('bad').ok, false);
});

test('landscape: second price bids value; first price shades toward learned market', () => {
  const ls = new BidLandscape();
  for (let i = 0; i < 2000; i++) ls.observe('s', 0.5 + Math.random() * 2); // market ~ U[0.5, 2.5]
  assert.equal(ls.optimalBid({ value: 3, floor: 0, at: 2, seg: 's' }), 3);
  const b = ls.optimalBid({ value: 3, floor: 0, at: 1, seg: 's' });
  assert.ok(b > 1.5 && b < 2.1, `shaded bid ${b}`); // analytic optimum is 1.75
  assert.ok(ls.winProb('s', 0.3) < 0.05 && ls.winProb('s', 2.8) > 0.95);
  const cold = new BidLandscape();
  assert.ok(Math.abs(cold.optimalBid({ value: 3, floor: 0, at: 1, seg: 'x' }) - 2.4) < 1e-9);
  assert.equal(cold.optimalBid({ value: 3, floor: 0, at: 2, seg: 'x' }), 3);
});

test('budget multiplier shrinks when overspending and recovers when behind', () => {
  const dayStartMs = Math.floor(1_700_000_000_000 / 86_400_000) * 86_400_000;
  let t = dayStartMs + 12 * 3_600_000;
  const { store, bidder } = setup(() => t);
  const c = store.create(camp({ goal: 'cpc', targetCpc: 1, pacing: 'even', dailyBudget: 100 }));
  c.day.spend = 90; // way ahead of the 50 scheduled by noon
  bidder.multiplier(c, t);
  for (let i = 0; i < 30; i++) { t += 1000; bidder.multiplier(c, t); }
  const low = bidder.mult.get(c.id).m;
  assert.ok(low < 0.6, `m=${low}`);
  c.day.spend = 10;
  for (let i = 0; i < 60; i++) { t += 1000; bidder.multiplier(c, t); }
  assert.ok(bidder.mult.get(c.id).m > low);
});

test('exchange reports market price to winners and losers', async () => {
  const mk = (id, price) => ({ id, bid: async (r) => ({ id: r.id, seatbid: [{ bid: [{ id: id + 'b', impid: '1', price, w: 300, h: 250 }] }] }) });
  const seen = [];
  let at;
  const spy = { id: 'spy', bid: async (r) => { at = r.at; return null; } };
  const ex = new Exchange({ bidders: [mk('a', 5), mk('b', 3), spy], auctionType: 1, onMarket: (id, bid, mp, won) => seen.push([id, mp, won]) });
  await ex.auction(req());
  assert.equal(at, 1);
  assert.deepEqual(seen, [['a', 3, true], ['b', 5, false]]);
});

test('lost bids release held budget; win/market feedback trains landscape', () => {
  const { store, bidder } = setup();
  const c = store.create(camp({ goal: 'cpc', targetCpc: 1, maxBidCpm: 100 }));
  const bid = bidder.handle(req()).body.seatbid[0].bid[0];
  assert.ok(bidder.holdTotals.get(c.id) > 0);
  bidder.observeMarket(tokenOf(bid), 1.2, false);
  assert.equal(bidder.holdTotals.get(c.id) || 0, 0);
  assert.equal(bidder.landscape.global.n, 1);
});
