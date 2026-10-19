import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CampaignStore } from './campaigns.js';
import { Bidder } from './bidder.js';
import { Exchange } from './exchange.js';
import { Metrics } from './metrics.js';
import { Simulator, competitorBidder } from './simulator.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const MAX_BODY = 1_000_000;

export function createApp({ baseUrl = 'http://localhost:8080', secret, auctionType = 2 } = {}) {
  const store = new CampaignStore();
  const bidder = new Bidder({ store, baseUrl, secret });
  const metrics = new Metrics();

  bidder.on('win', ({ price }) => { metrics.inc('wins'); metrics.inc('spend', price / 1000); });
  bidder.on('impression', () => metrics.inc('impressions'));
  bidder.on('click', () => metrics.inc('clicks'));
  bidder.on('conversion', () => metrics.inc('conversions'));

  const dsp = {
    id: 'dsp-1',
    bid: (req) => {
      const r = bidder.handle(req);
      return r.status === 200 ? r.body : null;
    },
  };
  const exchange = new Exchange({
    auctionType,
    bidders: [dsp, competitorBidder('dsp-2', { aggression: 1.0 }), competitorBidder('dsp-3', { aggression: 1.2, bidRate: 0.6 })],
    fireWin(bidderId, bid, price) {
      if (bidderId !== 'dsp-1') return;
      bid.nurl = bid.nurl.replace('${AUCTION_PRICE}', String(price));
      const url = new URL(bid.nurl);
      bidder.onWin(url.searchParams.get('t'), url.searchParams.get('price'));
    },
    onMarket(bidderId, bid, marketPrice, won) {
      if (bidderId === 'dsp-1') bidder.observeMarket(new URL(bid.nurl).searchParams.get('t'), marketPrice, won);
    },
    onResult(out) {
      for (const r of out.results) {
        metrics.inc('requests');
        if (r.filled) metrics.inc('filled'); else metrics.inc('noBid');
      }
      if (out.timeouts) metrics.inc('timeouts', out.timeouts);
      metrics.latency(out.latencyMs);
    },
  });
  const simulator = new Simulator({ exchange, bidder });
  const sse = new Set();

  const campaignView = (c) => ({
    ...c,
    ctr: c.stats.impressions ? c.stats.clicks / c.stats.impressions : 0,
    pctr: bidder.predictCtr(c),
    cvr: c.stats.clicks ? c.stats.conversions / c.stats.clicks : 0,
    multiplier: bidder.mult.get(c.id)?.m ?? 1,
    spendToday: c.day.spend,
  });
  const snapshot = () => ({
    ...metrics.snapshot(),
    series: metrics.series(60),
    campaigns: store.list().map(campaignView),
    simulator: { running: simulator.running, rps: simulator.rps, inflight: simulator.inflight },
  });

  const sseTimer = setInterval(() => {
    if (!sse.size) return;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of sse) res.write(msg);
  }, 1000);
  sseTimer.unref();

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const ch of req) {
      size += ch.length;
      if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
      chunks.push(ch);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || 'null'); }
    catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  }

  const send = (res, status, body, headers = {}) => {
    const isBuf = Buffer.isBuffer(body);
    res.writeHead(status, { 'content-type': isBuf ? headers['content-type'] : 'application/json', ...headers });
    res.end(body == null ? undefined : isBuf ? body : JSON.stringify(body));
  };

  async function route(req, res) {
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;
    const m = req.method;

    if (pathname === '/health') return send(res, 200, { status: 'ok' });

    if (pathname === '/openrtb/bid' && m === 'POST') {
      const r = bidder.handle(await readJson(req));
      if (r.status === 200) return send(res, 200, r.body);
      if (r.status === 204) return send(res, 204, null, { 'x-openrtb-nbr': String(r.nbr) });
      return send(res, r.status, { error: r.error, nbr: r.nbr });
    }
    if (pathname === '/exchange/auction' && m === 'POST') {
      const out = await exchange.auction(await readJson(req));
      return send(res, out.status || 200, out);
    }

    if (pathname.startsWith('/track/') && m === 'GET') {
      const t = url.searchParams.get('t');
      const kind = pathname.slice(7);
      if (kind === 'win') {
        const r = bidder.onWin(t, url.searchParams.get('price'));
        return send(res, r.ok ? 200 : 400, r);
      }
      if (kind === 'imp') {
        const r = bidder.onImpression(t);
        return send(res, r.ok ? 200 : 400, GIF, { 'content-type': 'image/gif', 'cache-control': 'no-store' });
      }
      if (kind === 'conv') {
        const r = bidder.onConversion(t);
        return send(res, r.ok ? 200 : 400, r);
      }
      if (kind === 'click') {
        const r = bidder.onClick(t);
        return send(res, r.ok ? 200 : 400, r);
      }
    }

    if (pathname === '/api/campaigns' && m === 'GET') return send(res, 200, store.list().map(campaignView));
    if (pathname === '/api/campaigns' && m === 'POST') return send(res, 201, campaignView(store.create(await readJson(req))));
    const cm = pathname.match(/^\/api\/campaigns\/([\w-]+)$/);
    if (cm) {
      const c = store.get(cm[1]);
      if (!c) return send(res, 404, { error: 'not found' });
      if (m === 'GET') return send(res, 200, campaignView(c));
      if (m === 'PATCH') return send(res, 200, campaignView(store.update(c.id, (await readJson(req)) || {})));
      if (m === 'DELETE') { store.remove(c.id); return send(res, 204, null); }
    }

    if (pathname === '/api/stats' && m === 'GET') return send(res, 200, snapshot());
    if (pathname === '/api/stream' && m === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      sse.add(res);
      req.on('close', () => sse.delete(res));
      return;
    }
    if (pathname === '/api/simulator/start' && m === 'POST') {
      const body = (await readJson(req)) || {};
      simulator.start(Number(body.rps) || simulator.rps);
      return send(res, 200, { running: true, rps: simulator.rps });
    }
    if (pathname === '/api/simulator/stop' && m === 'POST') {
      simulator.stop();
      return send(res, 200, { running: false });
    }

    if (m === 'GET') {
      const file = pathname === '/' ? 'index.html' : pathname.slice(1);
      const full = path.join(PUBLIC, file);
      if (full.startsWith(PUBLIC + path.sep)) {
        try { return send(res, 200, await readFile(full), { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); }
        catch { /* fall through */ }
      }
    }
    send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) console.error(e);
    });
  });
  server.keepAliveTimeout = 30_000;
  server.on('close', () => { clearInterval(sseTimer); simulator.stop(); });

  return { server, store, bidder, exchange, metrics, simulator, snapshot };
}

export function seedDemo(store) {
  const ad = (w, h, label) => `<a href="{{CLICK_URL}}" target="_blank"><div style="width:${w}px;height:${h}px;background:#246;color:#fff;display:flex;align-items:center;justify-content:center">${label}</div></a>`;
  const creatives = (label) => [[300, 250], [728, 90], [320, 50], [160, 600]].map(([w, h]) => ({ w, h, markup: ad(w, h, label), adomain: ['brand.example'] }));
  store.create({ name: 'Brand Awareness (US, all devices)', bidCpm: 2.2, maxBidCpm: 3, dailyBudget: 2000, pacing: 'asap', targeting: { countries: ['US'] }, frequencyCap: { count: 3, windowSec: 3600 }, creatives: creatives('Brand') });
  store.create({ name: 'Performance (CPC $0.50, mobile)', goal: 'cpc', targetCpc: 0.5, bidCpm: 1, maxBidCpm: 6, dailyBudget: 1500, pacing: 'asap', targeting: { devices: ['mobile', 'tablet'] }, creatives: creatives('Install now') });
  store.create({ name: 'Lead Gen (CPA $12, value-based)', goal: 'cpa', targetCpa: 12, bidCpm: 1, maxBidCpm: 20, dailyBudget: 1200, pacing: 'even', creatives: creatives('Sign up') });
  store.create({ name: 'Sports Fans (EU/IN)', bidCpm: 3, dailyBudget: 1000, pacing: 'asap', targeting: { categories: ['IAB17'], countries: ['GB', 'DE', 'IN'] }, creatives: creatives('Game day') });
  store.create({ name: 'Retargeting Lite', bidCpm: 1.5, dailyBudget: 800, pacing: 'asap', targeting: { domainBlock: ['shady-clicks.biz'] }, frequencyCap: { count: 2, windowSec: 600 }, creatives: creatives('Come back') });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const app = createApp({ baseUrl: process.env.BASE_URL || `http://localhost:${port}`, secret: process.env.SIGNING_SECRET, auctionType: Number(process.env.AUCTION_TYPE) || 2 });
  seedDemo(app.store);
  app.server.listen(port, () => console.log(`RTB platform on http://localhost:${port}`));
}
