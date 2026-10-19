// Minimal OpenRTB 2.5 request validation and helpers.

export const NBR = { INVALID_REQUEST: 2, BLOCKED: 8, NO_MATCH: 0 };

export function validateBidRequest(r) {
  if (!r || typeof r !== 'object') return 'body must be an object';
  if (typeof r.id !== 'string' || !r.id) return 'id required';
  if (!Array.isArray(r.imp) || r.imp.length === 0) return 'imp[] required';
  const seen = new Set();
  for (const imp of r.imp) {
    if (!imp || typeof imp.id !== 'string') return 'imp.id required';
    if (seen.has(imp.id)) return 'duplicate imp.id';
    seen.add(imp.id);
    if (!imp.banner && !imp.video && !imp.native) return 'imp needs banner, video or native';
    if (imp.bidfloor != null && !(Number(imp.bidfloor) >= 0)) return 'invalid bidfloor';
  }
  if (!r.site && !r.app) return 'site or app required';
  return null;
}

export function impSizes(imp) {
  const b = imp.banner;
  if (!b) return [];
  if (Array.isArray(b.format) && b.format.length) return b.format.map((f) => [f.w, f.h]);
  if (b.w && b.h) return [[b.w, b.h]];
  return [];
}

export function requestDomain(r) {
  const p = r.site || r.app || {};
  return (p.domain || p.bundle || '').toLowerCase();
}

export function requestCategories(r) {
  const p = r.site || r.app || {};
  return p.cat || [];
}

export function userId(r) {
  return r.user?.id || r.user?.buyeruid || r.device?.ifa || r.device?.ip || 'anon';
}

export function deviceType(r) {
  // OpenRTB devicetype: 1 mobile/tablet, 2 PC, 3 CTV, 4 phone, 5 tablet
  const t = r.device?.devicetype;
  if (t === 2) return 'desktop';
  if (t === 4 || t === 1) return 'mobile';
  if (t === 5) return 'tablet';
  if (t === 3) return 'ctv';
  return 'unknown';
}
