// Ported unchanged from plotkit-ts (github.com/HoseungChoi51/tga_plot, branch lib/plotkit-ts, commit 18bfc289, src/peaks.ts),
// MIT License, Copyright (c) 2026 the plotkit authors. Its savgol_filter / find_peaks / peak_prominences are ports of
// SciPy 1.18 scipy.signal (BSD 3-Clause, Copyright (c) 2001-2002 Enthought, Inc. 2003, SciPy Developers). See THIRD_PARTY_NOTICES.md.

// The numbers behind the curve labels: the value at an x (plotkit.core.value_at_x) and the peaks of a curve
// (plotkit.core.find_peaks_xy), with the two scipy routines it calls ported for the arguments plotkit gives them:
// scipy.signal.savgol_filter(y, window, polyorder) with mode "interp" (deriv 0) and
// scipy.signal.find_peaks(y, height=..., prominence=...).
//
// scipy solves its least-squares problems with LAPACK (gelsd), whose filter coefficients are off the exact ones by up to
// a few hundred ulps (for windows 33, 75 and 121 asymmetric enough that ndimage takes its general loop); here they are
// solved exactly in rational arithmetic and rounded once. Smoothed values agree with scipy's to ~1e-13 relative, and
// the peaks (indices into the data) are the same unless two candidates tie exactly (coarsely rounded or clipped
// data), where scipy's pick comes from that rounding noise.

type Arr = ArrayLike<number>;

// =================================================================== exact rationals
interface Q { n: bigint; d: bigint }        // d > 0, reduced

function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) [a, b] = [b, a % b];
  return a;
}

function q(n: bigint, d = 1n): Q {
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

const add = (a: Q, b: Q): Q => q(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const ZERO: Q = { n: 0n, d: 1n };
const ONE: Q = { n: 1n, d: 1n };

function qpow(a: Q, k: number): Q {
  let r = ONE;
  for (let i = 0; i < k; i++) r = mul(r, a);
  return r;
}

const F64 = new DataView(new ArrayBuffer(8));

/** A finite double as an exact rational. */
function fromDouble(x: number): Q {
  if (x === 0) return ZERO;
  F64.setFloat64(0, x);
  const hi = F64.getUint32(0), lo = F64.getUint32(4);
  const neg = hi >>> 31 === 1;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2: number;
  if (exp === 0) e2 = -1074;
  else { mant |= 1n << 52n; e2 = exp - 1075; }
  if (neg) mant = -mant;
  return e2 >= 0 ? q(mant << BigInt(e2)) : q(mant, 1n << BigInt(-e2));
}

/** 2 ** e as a double, exactly (normal range). */
function pow2(e: number): number {
  F64.setUint32(0, ((e + 1023) & 0x7ff) << 20);
  F64.setUint32(4, 0);
  return F64.getFloat64(0);
}

const bitLength = (x: bigint): number => x.toString(2).length;

/** The double nearest to a rational (round half to even). */
function toDouble(a: Q): number {
  let n = a.n;
  const d = a.d;
  if (n === 0n) return 0;
  const neg = n < 0n;
  if (neg) n = -n;
  // q0 = floor(n / (d * 2^e)) with 2^52 <= q0 < 2^53
  let e = bitLength(n) - bitLength(d) - 53;
  for (;;) {
    const num = e >= 0 ? n : n << BigInt(-e);
    const den = e >= 0 ? d << BigInt(e) : d;
    let q0 = num / den;
    if (q0 >= 1n << 53n) { e++; continue; }
    if (q0 < 1n << 52n) { e--; continue; }
    if (e < -1074) {                        // subnormal: fewer bits
      const den2 = den << BigInt(-1074 - e);
      q0 = num / den2;
      const r = num - q0 * den2;
      if (2n * r > den2 || (2n * r === den2 && (q0 & 1n) === 1n)) q0 += 1n;
      const v = Number(q0) * pow2(-537) * pow2(-537);
      return neg ? -v : v;
    }
    const r = num - q0 * den;
    if (2n * r > den || (2n * r === den && (q0 & 1n) === 1n)) q0 += 1n;
    if (e > 971) return neg ? -Infinity : Infinity;
    const v = e >= -1022 ? Number(q0) * pow2(e) : Number(q0) * pow2(e + 60) * pow2(-60);
    return neg ? -v : v;
  }
}

/** Solve M z = b exactly (M square, non-singular). */
function solve(M: Q[][], b: Q[]): Q[] {
  const n = M.length;
  const A = M.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    const piv = A.findIndex((row, r) => r >= i && row[i].n !== 0n);
    if (piv < 0) throw new Error("singular matrix");
    [A[i], A[piv]] = [A[piv], A[i]];
    for (let r = 0; r < n; r++) {
      if (r === i || A[r][i].n === 0n) continue;
      const f = div(A[r][i], A[i][i]);
      A[r] = A[r].map((v, c) => sub(v, mul(f, A[i][c])));
    }
  }
  return A.map((row, i) => div(row[n], row[i]));
}

// =================================================================== Savitzky-Golay
/** The exact filter coefficients of savgol_coeffs(windowLength, polyorder) (deriv 0, use "conv"): the minimum-norm
 *  solution of A c = e0, A[k][j] = x_j ** k for x = reversed(arange(-pos, windowLength - pos)). */
function savgolCoeffsExact(windowLength: number, polyorder: number): Q[] {
  if (polyorder >= windowLength) throw new Error("polyorder must be less than window_length.");
  const halflen = Math.floor(windowLength / 2), rem = windowLength % 2;
  const pos2 = rem === 0 ? 2 * halflen - 1 : 2 * halflen;          // 2 * pos
  const xs: Q[] = [];
  for (let j = 0; j < windowLength; j++) xs.push(q(BigInt(2 * j - pos2), 2n));
  xs.reverse();
  const m = polyorder + 1;
  // (A A^T)[a][b] = sum_j x_j ** (a + b); g = (A A^T)^-1 e0; c_j = sum_k x_j ** k g_k
  const powSums: Q[] = [];
  for (let s = 0; s <= 2 * polyorder; s++) powSums.push(xs.reduce((acc, x) => add(acc, qpow(x, s)), ZERO));
  const M = Array.from({ length: m }, (_, a) => Array.from({ length: m }, (_, b) => powSums[a + b]));
  const g = solve(M, Array.from({ length: m }, (_, k) => (k === 0 ? ONE : ZERO)));
  return xs.map(x => g.reduce((acc, gk, k) => add(acc, mul(qpow(x, k), gk)), ZERO));
}

const COEFFS = new Map<string, number[]>();

/** scipy.signal.savgol_coeffs(windowLength, polyorder) (deriv 0, delta 1, use "conv"). */
export function savgolCoeffs(windowLength: number, polyorder: number): number[] {
  const key = `${windowLength},${polyorder}`;
  let c = COEFFS.get(key);
  if (!c) {
    c = savgolCoeffsExact(windowLength, polyorder).map(toDouble);
    COEFFS.set(key, c);
  }
  return [...c];
}

const FIT = new Map<string, Q[][]>();

/** (V^T V)^-1 V^T for V = vander(arange(w), polyorder + 1) (decreasing powers): the polyfit solution is this times y. */
function polyfitMatrix(w: number, polyorder: number): Q[][] {
  const key = `${w},${polyorder}`;
  const hit = FIT.get(key);
  if (hit) return hit;
  const m = polyorder + 1;
  const V = Array.from({ length: w }, (_, i) => Array.from({ length: m }, (_, k) => qpow(q(BigInt(i)), polyorder - k)));
  const G = Array.from({ length: m }, (_, a) => Array.from({ length: m }, (_, b) =>
    V.reduce((acc, row) => add(acc, mul(row[a], row[b])), ZERO)));
  const inv = Array.from({ length: m }, (_, c) => solve(G, Array.from({ length: m }, (_, k) => (k === c ? ONE : ZERO))));
  // inv[c] is column c of G^-1; P[k][i] = sum_c G^-1[k][c] V[i][c]
  const P = Array.from({ length: m }, (_, k) => Array.from({ length: w }, (_, i) =>
    V[i].reduce((acc, v, c) => add(acc, mul(inv[c][k], v)), ZERO)));
  FIT.set(key, P);
  return P;
}

/** numpy-style polyfit of y on x = 0..len(y)-1 (least squares, exact, rounded once). Highest power first. */
function polyfitIndex(y: number[], polyorder: number): number[] {
  const P = polyfitMatrix(y.length, polyorder);
  const ys = y.map(fromDouble);
  return P.map(row => toDouble(row.reduce((acc, p, i) => add(acc, mul(p, ys[i])), ZERO)));
}

function polyval(p: number[], x: number): number {
  let y = 0;
  for (const c of p) y = y * x + c;
  return y;
}

/** scipy.signal.savgol_filter(x, windowLength, polyorder) with mode "interp" (deriv 0): the FIR filter inside
 *  (scipy.ndimage.convolve1d, whose symmetric-filter loop is reproduced), and a polynomial fitted to the first and
 *  last windowLength samples for the windowLength // 2 samples at each end. */
export function savgolFilter(x: Arr, windowLength: number, polyorder: number): number[] {
  const n = x.length;
  if (windowLength > n) throw new Error("If mode is 'interp', window_length must be less than or equal to the size of x.");
  const c = savgolCoeffs(windowLength, polyorder);
  const h = Math.floor(windowLength / 2);
  const fw = [...c].reverse();               // convolve1d = correlate1d with the weights reversed
  const y = new Array<number>(n).fill(0);
  if (windowLength % 2 === 1) {
    // ndimage's correlate1d for a symmetric filter: x[i] w[0] + sum over d = h..1 of (x[i-d] + x[i+d]) w[-d]
    for (let i = h; i < n - h; i++) {
      let v = x[i] * fw[h];
      for (let jj = -h; jj < 0; jj++) v += (x[i + jj] + x[i - jj]) * fw[h + jj];
      y[i] = v;
    }
  } else {
    throw new Error("savgolFilter: only odd window lengths are supported");
  }
  const xs = Array.from(x);
  const fit = (start: number, stop: number, iStart: number, iStop: number) => {
    const p = polyfitIndex(xs.slice(start, stop), polyorder);
    for (let i = iStart; i < iStop; i++) y[i] = polyval(p, i - start);
  };
  fit(0, windowLength, 0, h);
  fit(n - windowLength, n, n - h, n);
  return y;
}

// =================================================================== find_peaks
/** scipy.signal._peak_finding_utils._local_maxima_1d: local maxima, a flat top counting once (its middle). */
export function localMaxima1d(x: Arr): { peaks: number[]; leftEdges: number[]; rightEdges: number[] } {
  const peaks: number[] = [], leftEdges: number[] = [], rightEdges: number[] = [];
  let i = 1;
  const iMax = x.length - 1;
  while (i < iMax) {
    if (x[i - 1] < x[i]) {
      let iAhead = i + 1;
      while (iAhead < iMax && x[iAhead] === x[i]) iAhead++;
      if (x[iAhead] < x[i]) {
        leftEdges.push(i);
        rightEdges.push(iAhead - 1);
        peaks.push(Math.floor((i + iAhead - 1) / 2));
        i = iAhead;
      }
    }
    i++;
  }
  return { peaks, leftEdges, rightEdges };
}

/** scipy.signal._peak_finding_utils._peak_prominences (wlen -1 = the whole signal). */
export function peakProminences(x: Arr, peaks: number[], wlen = -1): { prominences: number[]; leftBases: number[]; rightBases: number[] } {
  const prominences: number[] = [], leftBases: number[] = [], rightBases: number[] = [];
  for (const peak of peaks) {
    let iMin = 0, iMax = x.length - 1;
    if (!(iMin <= peak && peak <= iMax)) throw new Error(`peak ${peak} is not a valid index for \`x\``);
    if (2 <= wlen) {
      iMin = Math.max(peak - Math.floor(wlen / 2), iMin);
      iMax = Math.min(peak + Math.floor(wlen / 2), iMax);
    }
    let i = peak, leftBase = peak, leftMin = x[peak];
    while (iMin <= i && x[i] <= x[peak]) {
      if (x[i] < leftMin) { leftMin = x[i]; leftBase = i; }
      i--;
    }
    i = peak;
    let rightBase = peak, rightMin = x[peak];
    while (i <= iMax && x[i] <= x[peak]) {
      if (x[i] < rightMin) { rightMin = x[i]; rightBase = i; }
      i++;
    }
    prominences.push(x[peak] - Math.max(leftMin, rightMin));
    leftBases.push(leftBase);
    rightBases.push(rightBase);
  }
  return { prominences, leftBases, rightBases };
}

/** scipy.signal.find_peaks(x, height=height, prominence=prominence) with scalar lower bounds; the peak indices. */
export function findPeaks(x: Arr, opts: { height?: number | null; prominence?: number | null } = {}): number[] {
  let peaks = localMaxima1d(x).peaks;
  if (opts.height != null) {
    const hmin = opts.height;
    peaks = peaks.filter(p => hmin <= x[p]);
  }
  if (opts.prominence != null) {
    const pmin = opts.prominence;
    const { prominences } = peakProminences(x, peaks);
    peaks = peaks.filter((_, k) => pmin <= prominences[k]);
  }
  return peaks;
}

// =================================================================== plotkit.core
function isFinite(v: number): boolean {
  return Number.isFinite(v);
}

/** numpy.interp(x0, xp, fp) for one x0 (xp increasing). */
export function interp(x0: number, xp: number[], fp: number[]): number {
  const n = xp.length;
  if (n === 0) throw new Error("array of sample points is empty");
  const lval = fp[0], rval = fp[n - 1];
  if (Number.isNaN(x0)) return x0;
  if (n === 1) return x0 < xp[0] ? lval : x0 > xp[0] ? rval : fp[0];
  let j: number;
  if (x0 > xp[n - 1]) j = n;
  else if (x0 < xp[0]) j = -1;
  else {
    let lo = 0, hi = n - 1;                 // largest j with xp[j] <= x0
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (xp[mid] <= x0) lo = mid; else hi = mid - 1;
    }
    j = lo;
  }
  if (j === -1) return lval;
  if (j === n) return rval;
  if (j === n - 1) return fp[j];
  if (xp[j] === x0) return fp[j];
  const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
  let r = slope * (x0 - xp[j]) + fp[j];
  if (Number.isNaN(r)) {
    r = slope * (x0 - xp[j + 1]) + fp[j + 1];
    if (Number.isNaN(r) && fp[j] === fp[j + 1]) r = fp[j];
  }
  return r;
}

/** plotkit.core.value_at_x: (x used, y there) or [null, null] when x0 is outside the data.
 *  method "interp" interpolates (on the rising part of x); anything else takes the nearest point. */
export function valueAtX(X: Arr, Y: Arr, x0: number, method: string): [number, number] | [null, null] {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < X.length; i++) if (isFinite(X[i]) && isFinite(Y[i])) { xs.push(X[i]); ys.push(Y[i]); }
  if (!xs.length) return [null, null];
  let mn = xs[0], mx = xs[0];
  for (const v of xs) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (x0 < mn - 1e-9 || x0 > mx + 1e-9) return [null, null];
  if (method === "interp") {
    const kx: number[] = [], ky: number[] = [];
    let run = -Infinity;
    for (let i = 0; i < xs.length; i++) {
      const prev = run;
      run = i === 0 ? xs[0] : Math.max(run, xs[i]);
      if (i === 0 || run - prev > 0) { kx.push(xs[i]); ky.push(ys[i]); }
    }
    return [x0, interp(x0, kx, ky)];
  }
  let best = 0, bestD = Math.abs(xs[0] - x0);
  for (let i = 1; i < xs.length; i++) {
    const d = Math.abs(xs[i] - x0);
    if (d < bestD) { bestD = d; best = i; }
  }
  return [xs[best], ys[best]];
}

/** numpy's nanmedian (the mean of the two middle values for an even count). */
function nanmedian(v: number[]): number {
  const s = v.filter(x => !Number.isNaN(x)).sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return v.length ? v[v.length - 1] : NaN;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** plotkit.core.find_peaks_xy: the count highest peaks (kind "max"; anything else finds dips) of a Savitzky-Golay
 *  smoothed curve between xMin and xMax, at least minRel of the curve's span above its median. Sorted [x, y] pairs
 *  of the data (not the smoothed curve); the highest point when no peak qualifies. */
export function findPeaksXY(X: Arr, Y: Arr, count = 1, kind = "max", xMin: number | null = null, xMax: number | null = null,
  minRel = 0.1): [number, number][] {
  const xs: number[] = [], Ys: number[] = [];
  for (let i = 0; i < X.length; i++) if (isFinite(X[i]) && isFinite(Y[i])) { xs.push(X[i]); Ys.push(Y[i]); }
  const y = kind === "max" ? Ys : Ys.map(v => -v);
  const n = y.length;
  let ys = [...y];
  const win = Math.max(5, Math.floor(n / 100) | 1);
  if (win < n) ys = savgolFilter(y, win, 2);
  const valid = xs.map(v => (xMin == null || v >= xMin) && (xMax == null || v <= xMax));
  if (!valid.some(Boolean)) return [];
  const inRange = ys.filter((_, i) => valid[i]);
  const base = nanmedian(inRange);
  let top = -Infinity;
  for (const v of inRange) {
    if (Number.isNaN(v)) { top = NaN; break; }
    if (v > top) top = v;
  }
  const span = top - base;
  if (span <= 0) return [];
  let idx = findPeaks(ys, { height: base + minRel * span, prominence: 0.5 * minRel * span }).filter(i => valid[i]);
  if (!idx.length) {
    let best = 0, bv = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = valid[i] ? ys[i] : -Infinity;
      if (v > bv || (Number.isNaN(v) && !Number.isNaN(bv))) { bv = v; best = i; }
    }
    idx = [best];
  }
  idx = [...idx].sort((a, b) => ys[b] - ys[a]).slice(0, Math.max(1, count));
  return idx.map(i => [xs[i], Ys[i]] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
