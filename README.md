# RTB Platform

Real-time ad bidding platform (zero dependencies, Node ≥ 20): an OpenRTB 2.5 DSP bidder, an ad exchange running
first/second-price auctions, signed win/impression/click tracking, budget pacing, frequency capping, and a live dashboard.

```
npm start        # http://localhost:8080 (dashboard; click "Start traffic")
npm test
```

## Architecture
| Module | Role |
|---|---|
| `src/bidder.js` | DSP: targeting, floors, CPM/CPC pricing (Bayesian pCTR), daily/total budgets, even/ASAP pacing, in-flight budget holds, frequency caps, HMAC-signed idempotent win/imp/click callbacks |
| `src/exchange.js` | Parallel fan-out with `tmax` timeout, per-impression auction (second price = runner-up + $0.01, or first price), floor and size checks, win notices |
| `src/campaigns.js` | Campaign store + validation |
| `src/metrics.js` | Rolling per-second counters, latency percentiles |
| `src/simulator.js` | Synthetic traffic, competing DSPs, impression/click simulation |
| `src/server.js` | HTTP API, SSE stream, static dashboard |

## API
- `POST /openrtb/bid` – OpenRTB request → bid response (204 = no bid)
- `POST /exchange/auction` – full auction across our DSP + simulated competitors
- `GET /track/{win,imp,click}?t=<signed token>` – win notice (`price` = clearing price), pixel, click
- `GET/POST /api/campaigns`, `GET/PATCH/DELETE /api/campaigns/:id`
- `GET /api/stats`, `GET /api/stream` (SSE), `POST /api/simulator/{start,stop}` (`{"rps":500}`)

Campaign example:
```json
{"name":"US mobile","bidCpm":2,"dailyBudget":500,"pacing":"even","goal":"cpm",
 "targeting":{"countries":["US"],"devices":["mobile"],"domainBlock":["bad.com"]},
 "frequencyCap":{"count":3,"windowSec":3600},
 "creatives":[{"w":300,"h":250,"markup":"<a href=\"{{CLICK_URL}}\">ad</a>"}]}
```

Env: `PORT`, `BASE_URL` (tracking host), `SIGNING_SECRET`, `AUCTION_TYPE` (1|2).

## Production notes
State is in-memory and single-process. For production scale-out, move budgets/frequency caps to Redis (atomic ops),
events to Kafka → a columnar store, and campaigns to a database; the bidder/exchange interfaces are stateless-friendly.
