import { randomUUID } from 'node:crypto';

const DAY_MS = 86_400_000;

export function validateCampaign(c) {
  if (!c || typeof c !== 'object') return 'body must be an object';
  if (!c.name || typeof c.name !== 'string') return 'name required';
  if (!(c.bidCpm > 0)) return 'bidCpm must be > 0';
  if (!(c.dailyBudget > 0)) return 'dailyBudget must be > 0';
  if (c.totalBudget != null && !(c.totalBudget > 0)) return 'totalBudget must be > 0';
  if (c.maxBidCpm != null && !(c.maxBidCpm >= c.bidCpm)) return 'maxBidCpm must be >= bidCpm';
  if (c.goal === 'cpc' && !(c.targetCpc > 0)) return 'targetCpc required for cpc goal';
  if (!Array.isArray(c.creatives) || c.creatives.length === 0) return 'at least one creative required';
  for (const cr of c.creatives) {
    if (!(cr.w > 0 && cr.h > 0)) return 'creative w/h required';
    if (!cr.markup && !cr.adm) return 'creative markup required';
  }
  if (c.frequencyCap && !(c.frequencyCap.count > 0 && c.frequencyCap.windowSec > 0)) return 'invalid frequencyCap';
  return null;
}

export function dayStart(t) {
  return Math.floor(t / DAY_MS) * DAY_MS;
}

function lower(a) { return Array.isArray(a) ? a.map((s) => String(s).toLowerCase()) : []; }

function normalizeTargeting(t = {}) {
  return {
    countries: (t.countries || []).map((s) => String(s).toUpperCase()),
    devices: lower(t.devices),
    os: lower(t.os),
    categories: (t.categories || []).map(String),
    domainAllow: lower(t.domainAllow),
    domainBlock: lower(t.domainBlock),
    hours: Array.isArray(t.hours) ? t.hours : null, // UTC hours 0-23
  };
}

export class CampaignStore {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.campaigns = new Map();
  }

  create(input) {
    const err = validateCampaign(input);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    const t = this.now();
    const id = randomUUID();
    const c = {
      id,
      name: input.name,
      status: input.status === 'paused' ? 'paused' : 'active',
      bidCpm: input.bidCpm,
      maxBidCpm: input.maxBidCpm ?? input.bidCpm,
      // 'cpm' = fixed bid; 'cpc' = bid derived from targetCpc * predicted CTR
      goal: input.goal === 'cpc' ? 'cpc' : 'cpm',
      targetCpc: input.targetCpc ?? null,
      dailyBudget: input.dailyBudget,
      totalBudget: input.totalBudget ?? null,
      pacing: input.pacing === 'asap' ? 'asap' : 'even',
      frequencyCap: input.frequencyCap || null,
      targeting: normalizeTargeting(input.targeting),
      creatives: input.creatives.map((cr, i) => ({
        id: cr.id || `${id.slice(0, 8)}-cr${i}`,
        w: cr.w,
        h: cr.h,
        markup: cr.markup || cr.adm,
        adomain: cr.adomain || [],
      })),
      createdAt: t,
      stats: { bids: 0, wins: 0, impressions: 0, clicks: 0, spend: 0 },
      day: { start: dayStart(t), spend: 0 },
    };
    this.campaigns.set(id, c);
    return c;
  }

  get(id) { return this.campaigns.get(id); }
  list() { return [...this.campaigns.values()]; }
  remove(id) { return this.campaigns.delete(id); }

  update(id, patch) {
    const c = this.get(id);
    if (!c) throw Object.assign(new Error('not found'), { status: 404 });
    const err = validateCampaign({ ...c, ...patch });
    if (err) throw Object.assign(new Error(err), { status: 400 });
    for (const k of ['name', 'status', 'bidCpm', 'maxBidCpm', 'dailyBudget', 'totalBudget', 'frequencyCap', 'pacing', 'goal', 'targetCpc']) {
      if (k in patch) c[k] = patch[k];
    }
    if (patch.targeting) c.targeting = normalizeTargeting(patch.targeting);
    return c;
  }

  rollDay(c) {
    const ds = dayStart(this.now());
    if (c.day.start !== ds) c.day = { start: ds, spend: 0 };
  }
}
