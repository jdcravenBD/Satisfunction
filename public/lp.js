/* Satisfunction — a small linear-programming solver.
 *
 * Two-phase simplex on a dense tableau: maximise c·x subject to rows of
 * a·x (<=, >= or =) b, with every x >= 0. Plans have at most a few hundred
 * recipes and items, which a dense tableau handles in milliseconds.
 *
 * Pivoting picks the most improving column until a run of zero-progress
 * pivots, then switches to Bland's rule (lowest index) for good, which rules
 * out cycling on degenerate problems.
 */

(function (root) {
  'use strict';

  var EPS = 1e-9;       // reduced costs and right-hand sides
  var PIVOT = 1e-8;     // smallest entry trusted as a pivot

  /**
   * nVars: number of variables.
   * objective: array of nVars coefficients to maximise.
   * rows: [{ a: { index: coefficient }, op: '<=' | '>=' | '=', b: number }].
   * Returns { status: 'optimal' | 'infeasible' | 'unbounded', x, value }.
   */
  function maximize(nVars, objective, rows) {
    rows = rows.map(function (r, i) {
      // Scaled so the largest coefficient is 1, which keeps pivots sane when
      // one row counts in thousands and another in fractions.
      var big = 0;
      Object.keys(r.a).forEach(function (k) { big = Math.max(big, Math.abs(r.a[k])); });
      var f = big > 0 ? 1 / big : 1;
      var a = {};
      Object.keys(r.a).forEach(function (k) { a[k] = r.a[k] * f; });
      var op = r.op;
      var b = r.b * f;
      // Right-hand sides non-negative. A ">= 0" row flips to "<= 0", which a
      // plain slack satisfies at the start, so it needs no artificial.
      if (b < 0 || (b === 0 && op === '>=')) {
        Object.keys(a).forEach(function (k) { a[k] = -a[k]; });
        b = -b;
        op = op === '<=' ? '>=' : op === '>=' ? '<=' : '=';
      }
      // Most rows sit at zero, which is heavily degenerate. Nudging each by
      // a different sliver breaks the ties that make simplex stall. The
      // answer is read back with the nudges taken out again, or the solver
      // treats them as free goods (a recipe run at a sliver of a machine).
      var exact = b;
      if (op === '<=') b += 1e-7 * (1 + (i * 7919) % 997 / 997);
      return { a: a, op: op, b: b, exact: exact };
    });

    var m = rows.length;
    var nSlack = rows.filter(function (r) { return r.op !== '='; }).length;
    var nArt = rows.filter(function (r) { return r.op !== '<='; }).length;
    var cols = nVars + nSlack + nArt;
    var RHS = cols;
    var artStart = nVars + nSlack;

    var T = [];
    var basis = [];
    var s = nVars;
    var art = artStart;
    rows.forEach(function (r, i) {
      var row = new Float64Array(cols + 1);
      Object.keys(r.a).forEach(function (k) { row[k] = r.a[k]; });
      row[RHS] = r.b;
      if (r.op === '<=') {
        row[s] = 1;
        basis[i] = s++;
      } else if (r.op === '>=') {
        row[s++] = -1;
        row[art] = 1;
        basis[i] = art++;
      } else {
        row[art] = 1;
        basis[i] = art++;
      }
      T.push(row);
    });

    var z = new Float64Array(cols + 1);
    // The starting tableau, kept so the working one can be rebuilt from it:
    // every pivot adds a little rounding, and over hundreds they add up.
    var T0 = T.map(function (row) { return Float64Array.from(row); });
    var current = null;

    function setObjective(c) {
      current = c;
      z.fill(0);
      for (var j = 0; j < c.length; j++) z[j] = -c[j];
      for (var i = 0; i < m; i++) {
        var f = z[basis[i]];
        if (f !== 0) {
          var row = T[i];
          for (var k = 0; k <= cols; k++) z[k] -= f * row[k];
        }
      }
    }

    function pivot(pi, pj) {
      var prow = T[pi];
      var p = prow[pj];
      for (var k = 0; k <= cols; k++) prow[k] /= p;
      for (var i = 0; i < m; i++) {
        if (i === pi) continue;
        var f = T[i][pj];
        if (f !== 0) {
          var row = T[i];
          for (var k2 = 0; k2 <= cols; k2++) row[k2] -= f * prow[k2];
        }
      }
      var fz = z[pj];
      if (fz !== 0) for (var k3 = 0; k3 <= cols; k3++) z[k3] -= fz * prow[k3];
      basis[pi] = pj;
    }

    /**
     * Rebuilds the tableau as B⁻¹ times the original, B being the columns in
     * the basis, by elimination with partial pivoting. Drift gone.
     */
    function reinvert() {
      var M = [];
      for (var i = 0; i < m; i++) {
        var row = new Float64Array(m + cols + 1);
        for (var q = 0; q < m; q++) row[q] = T0[i][basis[q]];
        row.set(T0[i], m);
        M.push(row);
      }
      var width = m + cols + 1;
      for (var c = 0; c < m; c++) {
        var p = c;
        for (var r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-12) return;  // leave the tableau as it is
        var t = M[c]; M[c] = M[p]; M[p] = t;
        var pv = M[c][c];
        for (var k = c; k < width; k++) M[c][k] /= pv;
        for (var r2 = 0; r2 < m; r2++) {
          if (r2 === c) continue;
          var f = M[r2][c];
          if (f === 0) continue;
          for (var k2 = c; k2 < width; k2++) M[r2][k2] -= f * M[c][k2];
        }
      }
      // Row q of the result belongs to basis column q.
      for (var i2 = 0; i2 < m; i2++) T[i2] = M[i2].slice(m);
      if (current) setObjective(current);
    }

    /** Runs simplex over columns below `limit`. */
    function run(limit) {
      var stalls = 0;
      var bland = false;
      var banned = {};
      for (var iter = 0; iter < 50000; iter++) {
        if (stalls > 50) bland = true;
        var enter = -1;
        var best = -EPS;
        for (var j = 0; j < limit; j++) {
          if (z[j] < best && !banned[j]) {
            enter = j;
            best = z[j];
            if (bland) break;
          }
        }
        if (enter < 0) return 'optimal';

        var leave = -1;
        var ratio = Infinity;
        for (var i = 0; i < m; i++) {
          var a = T[i][enter];
          if (a > PIVOT) {
            var r = T[i][RHS] / a;
            if (r < ratio - EPS || (Math.abs(r - ratio) <= EPS && basis[i] < basis[leave])) {
              ratio = r;
              leave = i;
            }
          }
        }
        if (leave < 0) {
          // A column that looks like it improves forever but only by a
          // rounding speck is a zero-cost loop, not a real direction: set it
          // aside rather than give up.
          if (z[enter] > -1e-6) {
            banned[enter] = true;
            continue;
          }
          return 'unbounded';
        }
        stalls = ratio < EPS ? stalls + 1 : 0;
        pivot(leave, enter);
        if (iter % 50 === 49) reinvert();
      }
      return 'stuck';
    }

    // Phase one: find a feasible point by driving the artificials to zero.
    if (nArt) {
      var c1 = new Array(cols).fill(0);
      for (var j = artStart; j < cols; j++) c1[j] = -1;
      setObjective(c1);
      if (run(cols) === 'stuck') return { status: 'stuck' };
      var scale = rows.reduce(function (s2, r) { return Math.max(s2, Math.abs(r.b)); }, 1);
      if (z[RHS] < -1e-7 * scale) return { status: 'infeasible' };
      // Any artificial still basic (at zero) is swapped for a real column,
      // on the largest entry in its row so the pivot is a sound one.
      for (var i = 0; i < m; i++) {
        if (basis[i] < artStart) continue;
        var bestK = -1;
        for (var k = 0; k < artStart; k++) {
          if (Math.abs(T[i][k]) > 1e-6 && (bestK < 0 || Math.abs(T[i][k]) > Math.abs(T[i][bestK]))) bestK = k;
        }
        if (bestK >= 0) pivot(i, bestK);
      }
      reinvert();
    }

    // Phase two: the real objective, artificials out of play.
    var c2 = new Array(cols).fill(0);
    for (var v = 0; v < nVars; v++) c2[v] = objective[v] || 0;
    setObjective(c2);
    var status = run(artStart);
    if (status !== 'optimal') return { status: status };
    reinvert();
    var nudged = T.map(function (row) { return row[RHS]; });

    // The same basis without the nudges. It's still the best one, as long
    // as it stays feasible; if it doesn't, the nudged answer stands.
    for (var i4 = 0; i4 < m; i4++) T0[i4][RHS] = rows[i4].exact;
    reinvert();
    var bScale = rows.reduce(function (s3, r) { return Math.max(s3, Math.abs(r.b)); }, 1);
    var exactOk = T.every(function (row) { return row[RHS] > -1e-9 * bScale; });

    var x = new Array(nVars).fill(0);
    for (var r2 = 0; r2 < m; r2++) {
      if (basis[r2] < nVars) x[basis[r2]] = Math.max(0, exactOk ? T[r2][RHS] : nudged[r2]);
    }

    // Trust nothing: the answer has to meet the rows it was given.
    for (var i3 = 0; i3 < m; i3++) {
      var lhs = 0;
      var row3 = rows[i3];
      Object.keys(row3.a).forEach(function (k) { lhs += row3.a[k] * x[k]; });
      var b = row3.b;
      var off = row3.op === '<=' ? lhs - b : row3.op === '>=' ? b - lhs : Math.abs(lhs - b);
      if (off > 1e-6 * Math.max(1, Math.abs(b))) return { status: 'numerical' };
    }
    var value = 0;
    for (var q = 0; q < nVars; q++) value += (objective[q] || 0) * x[q];
    return { status: 'optimal', x: x, value: value };
  }

  var api = { maximize: maximize };
  root.SF_LP = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
