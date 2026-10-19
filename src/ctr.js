import { impSizes, requestDomain, deviceType } from './openrtb.js';

const BITS = 18;
const SIZE = 1 << BITS;
const MIN_P = 0.0005;
const MAX_P = 0.3;

function hash(str) {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & (SIZE - 1);
}

/** Turns an impression into hashed feature indices (including a few crosses). */
export function extractFeatures(req, imp, campaignId, t) {
  const [w, h] = impSizes(imp)[0] || [0, 0];
  const f = {
    dom: requestDomain(req),
    size: `${w}x${h}`,
    dev: deviceType(req),
    os: (req.device?.os || '').toLowerCase(),
    geo: (req.device?.geo?.country || '').toUpperCase(),
    hr: String(new Date(t).getUTCHours()),
  };
  const keys = [
    'bias',
    `c=${campaignId}`,
    ...Object.entries(f).map(([k, v]) => `${k}=${v}`),
    `c×dom=${campaignId}|${f.dom}`,
    `c×dev=${campaignId}|${f.dev}`,
    `dev×size=${f.dev}|${f.size}`,
    `dom×dev=${f.dom}|${f.dev}`,
  ];
  return keys.map(hash);
}

/**
 * Online logistic regression over hashed features, trained with per-weight
 * adaptive learning rates (AdaGrad). Cheap enough to score in the bid path.
 */
export class LogisticModel {
  constructor({ lr = 0.1, l2 = 1e-6, prior = 0.01 } = {}) {
    this.w = new Float32Array(SIZE);
    this.g = new Float32Array(SIZE).fill(1e-3);
    this.lr = lr;
    this.l2 = l2;
    const bias = hash('bias');
    this.w[bias] = Math.log(prior / (1 - prior));
    this.updates = 0;
  }

  predict(idx) {
    let z = 0;
    for (const i of idx) z += this.w[i];
    const p = 1 / (1 + Math.exp(-z));
    return Math.min(MAX_P, Math.max(MIN_P, p));
  }

  /** One SGD step on (features, label). `weight` scales the step. */
  train(idx, label, weight = 1) {
    const err = this.predict(idx) - label;
    this.step(idx, err * weight);
  }

  /**
   * A click arrives after its impression was already trained as a non-click.
   * Flipping the label from 0 to 1 at the same prediction changes the gradient
   * by exactly -1 per feature, so apply just that correction.
   */
  correctToClick(idx) {
    this.step(idx, -1);
  }

  step(idx, grad) {
    for (const i of idx) {
      const gi = grad + this.l2 * this.w[i];
      this.g[i] += gi * gi;
      this.w[i] -= (this.lr * gi) / Math.sqrt(this.g[i]);
    }
    this.updates++;
  }
}

/** P(click | impression). */
export class CtrModel extends LogisticModel {
  constructor(opts = {}) { super({ prior: 0.01, ...opts }); }
}

/** P(conversion | click). Trained only on clicks, so its base rate is much higher than CTR. */
export class CvrModel extends LogisticModel {
  constructor(opts = {}) { super({ prior: 0.05, ...opts }); }
}
