// Tide Table's dashboard. Reads window.RADAR, written beside this page by main.ts, and renders a
// sortable, filterable board plus a full detail view. No fetch, no network, no framework.
(function () {
  'use strict';
  var D = window.RADAR;
  if (!D) return;
  var rows = D.rows;
  var bySlug = {};
  for (var i = 0; i < rows.length; i++) bySlug[rows[i].slug] = rows[i];

  var state = { q: '', cat: 'all', sort: 'rank', dir: 'asc', eligible: true, watch: false, positive: false, detail: null };
  var $ = function (id) { return document.getElementById(id); };

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e12) return s + '$' + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
    if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'K';
    return s + '$' + Math.round(a);
  }
  function pct(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var d = digits === undefined ? 1 : digits;
    return (n > 0 ? '+' : '') + n.toFixed(d) + '%';
  }
  function plain(n, digits) { return (n === null || n === undefined || !isFinite(n)) ? 'n/a' : Number(n).toFixed(digits === undefined ? 2 : digits); }
  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ageText(days) {
    if (days === null || days === undefined) return 'undated';
    if (days < 60) return days + ' d';
    if (days < 730) return Math.round(days / 30) + ' mo';
    return plain(days / 365, 1) + ' y';
  }

  function readHash() {
    var h = location.hash.replace(/^#/, '');
    var parts = h.split('&');
    for (var k = 0; k < parts.length; k++) {
      var at = parts[k].indexOf('=');
      if (at < 0) continue;
      var key = parts[k].slice(0, at), value = decodeURIComponent(parts[k].slice(at + 1));
      if (key === 'detail') state.detail = bySlug[value] ? value : null;
      else if (key === 'category') state.cat = value;
      else if (key === 'q') state.q = value;
      else if (key === 'sort') state.sort = value;
      else if (key === 'dir') state.dir = value;
      else if (key === 'watch') state.watch = value === '1';
      else if (key === 'positive') state.positive = value === '1';
      else if (key === 'screen') state.eligible = value !== 'off';
    }
  }

  function setHash(detail) {
    var p = [];
    if (detail) p.push('detail=' + encodeURIComponent(detail));
    else {
      if (state.cat !== 'all') p.push('category=' + encodeURIComponent(state.cat));
      if (state.q) p.push('q=' + encodeURIComponent(state.q));
      if (state.sort !== 'rank') p.push('sort=' + state.sort);
      if (state.dir !== 'asc') p.push('dir=' + state.dir);
      if (state.watch) p.push('watch=1');
      if (state.positive) p.push('positive=1');
      if (!state.eligible) p.push('screen=off');
    }
    var next = p.length ? '#' + p.join('&') : '#';
    if (location.hash !== next) { location.hash = next; return; }
    render();
  }

  function kpi(label, value, sub, cls) {
    return '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div><div class="kpi-value ' + (cls || '') + '">' + esc(value) + '</div><div class="kpi-sub">' + esc(sub) + '</div></div>';
  }

  function renderKpis() {
    var c = D.counts, v = D.validation;
    $('kpis').innerHTML =
      kpi('SNAPSHOT RECORDS', String(c.protocols), 'all at or above the $5M TVL line') +
      kpi('PRE-TOKEN RANKED', String(c.ranked), c.early + ' outside the watchlist') +
      kpi('WATCHLIST COVERED', c.watchlist + ' / ' + c.watchlist, 'the floor, never the ceiling', 'signal') +
      kpi('CROSS-VALIDATED R2', plain(v.cv.r2, 3), v.cvFolds + '-fold out-of-sample, n=' + v.cv.n, 'teal') +
      kpi('WALK-FORWARD R2', plain(v.walk.r2, 3), v.walkFolds.length + ' expanding windows', 'teal') +
      kpi('MEDIAN OOS ERROR', plain(v.cv.factor, 1) + 'x', 'naive TVL ratio: ' + plain(v.cvBaseline.factor, 1) + 'x', 'signal');
    $('stamp').textContent = D.as_of;
    $('stamp-sub').textContent = 'SEALED SNAPSHOT';
    $('asof-line').textContent = D.as_of;
    $('source-line').textContent = D.source;
    $('count-line').textContent = c.protocols + ' protocols · ' + c.live + ' in the calibration set';
    $('spine-depth').style.backgroundPosition = '0 ' + Math.round(v.cv.r2 * 40) + '%';
  }

  function renderMethod() {
    var v = D.validation, m = D.model;
    var fit = '<b>THE FIT · 9 FEATURES</b><p>Winsorised ridge on ' + m.n + ' records that carry a token: log market cap from log TVL, seven-day change, listing age, chain breadth and four category flags. Blended ' + plain(v.blend, 2) + ' with a median TVL-ratio anchor. No protocol name is special-cased.</p>';
    var check = '<b>THE CHECK · OUT OF SAMPLE</b><p>Five-fold R2 ' + plain(v.cv.r2, 3) + ' and median error ' + plain(v.cv.factor, 1) + 'x; walk-forward R2 ' + plain(v.walk.r2, 3) + '. Naive TVL ratio: R2 ' + plain(v.cvBaseline.r2, 3) + ', ' + plain(v.cvBaseline.factor, 1) + 'x. The blend was picked by out-of-fold error.</p>';
    var warn = '<b class="warn">THE CAVEAT · READ THIS</b><p>The 80% band is wide because tokens are scarce in this record; implied value is this entry\'s claim, not a forecast. Wrapped, staked, versioned and exchange products remain in board.json but are screened out of this view: ' + (D.counts.ranked - D.rows.filter(function (r) { return r.eligible; }).length) + ' rows.</p>';
    $('method').innerHTML = '<div>' + fit + '</div><div>' + check + '</div><div class="warn">' + warn + '</div>';
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.eligible && !r.eligible) return false;
      if (state.watch && !r.watchlisted) return false;
      if (state.positive && !(r.netApr > 0)) return false;
      if (state.cat !== 'all' && r.category !== state.cat) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0 && r.category.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    var sign = state.dir === 'asc' ? 1 : -1;
    out.sort(function (a, b) {
      var x = a[key], y = b[key];
      if (typeof x === 'string') return x.localeCompare(y) * sign || a.rank - b.rank;
      return ((x === null ? -Infinity : x) - (y === null ? -Infinity : y)) * sign || a.rank - b.rank;
    });
    return out;
  }

  function renderTable() {
    var list = filtered();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var flags = (r.watchlisted ? '<span class="flag watch">WATCH</span>' : '') + (!r.eligible ? '<span class="flag screen">SCREENED</span>' : '');
      var netCls = r.netApr < 0 ? 'neg' : '';
      html += '<tr data-slug="' + esc(r.slug) + '"' + (r.watchlisted ? ' class="watchlisted"' : '') + '>' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td class="name">' + esc(r.name) + flags + '</td>' +
        '<td class="cat">' + esc(r.category) + '</td>' +
        '<td class="num">' + money(r.tvl) + '</td>' +
        '<td class="num ' + (r.change >= 0 ? 'up' : 'down') + '">' + pct(r.change) + '</td>' +
        '<td class="num strong">' + money(r.implied) + '</td>' +
        '<td class="num band">' + money(r.low) + ' – ' + money(r.high) + '</td>' +
        '<td class="num">' + plain(r.multiple, 2) + 'x</td>' +
        '<td class="num"><span class="net ' + netCls + '">' + pct(r.netApr) + '</span></td>' +
        '<td class="farm">' + esc(r.action.replace(/\.$/, '')) + '</td></tr>';
    }
    $('board-body').innerHTML = html || '<tr><td colspan="10" class="note">No protocol matches these filters. Widen the view to see the full field.</td></tr>';
    var positive = list.filter(function (r) { return r.netApr > 4; }).length;
    $('table-foot').innerHTML = '<span>SHOWING ' + list.length + ' OF ' + rows.length + ' RANKED ROWS · ' + positive + ' CLEAR A 4% CASH BENCHMARK</span><span class="legend"><i>WATCH</i> house watchlist <i>SCREENED</i> wrapped / staked / versioned</span>';
    var body = $('board-body');
    body.onclick = function (e) {
      var tr = e.target;
      while (tr && tr.tagName !== 'TR') tr = tr.parentNode;
      if (tr && tr.getAttribute('data-slug')) setHash(tr.getAttribute('data-slug'));
    };
  }

  function renderLive() {
    var out = D.live.slice(0, 8);
    var html = '';
    for (var i = 0; i < out.length; i++) {
      var r = out[i];
      html += '<tr><td class="rank">' + (i + 1) + '</td><td class="name">' + esc(r.name) + '</td><td class="cat">' + esc(r.category) + '</td>' +
        '<td class="num">' + money(r.tvl) + '</td><td class="num">' + money(r.mcap) + '</td><td class="num">' + plain(r.ratio, 2) + 'x</td>' +
        '<td class="num ' + (r.change >= 0 ? 'up' : 'down') + '">' + pct(r.change) + '</td></tr>';
    }
    $('live-body').innerHTML = html;
    $('live-foot').innerHTML = '<span>TOP ' + out.length + ' BY MARKET CAP · ' + D.counts.live + ' RECORDS IN THE FITTING SET</span><span>MEDIAN CAP / TVL ' + plain(D.calibration.median_ratio, 2) + 'x · MEDIAN CAP ' + money(D.calibration.median_mcap) + '</span>';
  }

  function renderDetail(r) {
    var v = D.validation, m = D.model;
    var coef = '';
    for (var j = 0; j < D.features.length; j++) {
      var b = m.beta[j];
      coef += '<tr><td>' + esc(D.features[j]) + '</td><td class="num">' + (b >= 0 ? '+' : '') + plain(b, 3) + '</td></tr>';
    }
    var steps = '';
    for (var k = 0; k < r.steps.length; k++) {
      steps += '<div class="step"><span class="n">' + (k + 1) + '</span><span class="t">' + esc(r.steps[k]) + '</span></div>';
    }
    var html =
      '<div class="detail-top"><div><div class="section-kicker">SOUNDING NO. ' + r.rank + ' / ' + rows.length + '</div>' +
      '<h3>' + esc(r.name) + '</h3><div class="kpi-sub">' + esc(r.category) + ' · ' + esc(r.chains.join(' / ')) + ' · ' + (r.watchlisted ? 'on the house watchlist' : 'found below the watchlist') + (r.eligible ? '' : ' · screened: derivative or versioned record') + '</div></div>' +
      '<div style="text-align:right"><button class="back" id="back">← BACK TO BOARD</button><div class="big-value" style="margin-top:10px">' + money(r.implied) + '</div><div class="kpi-sub">IMPLIED VALUE · ' + money(r.low) + ' TO ' + money(r.high) + ' (80%)</div></div></div>' +
      '<div class="detail-kpis">' +
        kpi('TVL', money(r.tvl), money(r.implied) + ' implied') +
        kpi('VALUE / TVL', plain(r.multiple, 2) + 'x', 'fitted multiple') +
        kpi('7-DAY TVL', pct(r.change), 'snapshot field') +
        kpi('LISTED', ageText(r.age), r.age === null ? 'no date on record' : 'days tracked') +
        kpi('NET APR', pct(r.netApr), 'after gas + IL reserve', r.netApr > 4 ? 'teal' : 'signal') +
        kpi('VS CASH', pct(r.excessApr), 'over a 4% benchmark') +
      '</div>' +
      '<div class="detail-grid"><section><h4>HOW THE NUMBER WAS MADE</h4>' +
        '<div class="eq">log implied = ' + plain(v.blend, 2) + ' × ' + plain(r.fitLog, 3) + ' (fitted) + ' + plain(1 - v.blend, 2) + ' × ' + plain(r.baseLog, 3) + ' (log TVL + median ratio)<br>' +
        '= ' + plain(v.blend * r.fitLog + (1 - v.blend) * r.baseLog, 3) + ' → ' + money(r.implied) + ' · ' + esc(m.n) + ' token records in the fit, ratio anchor ' + plain(m.ratio0, 2) + ' log points<br>' +
        'cross-validated R2 ' + plain(v.cv.r2, 3) + ' · median out-of-fold error ' + plain(v.cv.factor, 1) + 'x · 80% residual band ' + plain(v.residual.p10, 2) + ' to +' + plain(v.residual.p90, 2) + ' log points</div>' +
        '<table class="coef"><thead><tr><th>FEATURE</th><th class="num">COEFFICIENT</th></tr></thead><tbody>' + coef + '</tbody></table>' +
        '<p class="note">Inputs: TVL ' + money(r.tvl) + ', seven-day change ' + pct(r.change) + ', listing age ' + ageText(r.age) + ', ' + r.chains.length + ' chain(s). Ridge penalty ' + plain(m.ridge, 1) + '; target winsorised at the 5th and 95th percentile. This is this entry\'s fitted claim, not make.fun\'s.</p>' +
        '<div class="valgrid"><div><span>WALK-FORWARD R2</span><strong>' + plain(v.walk.r2, 3) + '</strong></div><div><span>OUT-OF-FOLD R2</span><strong>' + plain(v.cv.r2, 3) + '</strong></div><div><span>NAIVE BASELINE</span><strong>' + plain(v.cvBaseline.factor, 1) + 'x</strong></div></div>' +
      '</section><section><h4>THE FARM · $' + r.capital + ' ON ' + esc(r.chains[0] || 'MAIN CHAIN') + ' · HOLD ' + r.holdDays + ' DAYS</h4>' +
        '<div class="eq">gross ' + plain(r.grossApy, 1) + '% − IL reserve ' + plain(r.ilReserve, 1) + '% − gas ' + money(r.gasYear) + '/yr on $' + r.capital + ' = <strong>' + pct(r.netApr) + '</strong> net · ' + pct(r.excessApr) + ' above cash</div>' + steps +
        '<p class="note">Gross yield is a category starting estimate, not an offer. Gas is ' + money(r.gasPerTx) + ' per transaction × ' + r.txPerYear + ' upkeep actions a year. Nothing here is financial advice: check the protocol\'s own site before you commit capital.</p>' +
      '</section></div>';
    $('detail').innerHTML = html;
    $('back').onclick = function () { setHash(null); };
  }

  function render() {
    $('board-section').hidden = !!state.detail;
    $('live-section').hidden = !!state.detail;
    $('detail').hidden = !state.detail;
    if (state.detail) {
      renderDetail(bySlug[state.detail]);
      window.scrollTo(0, 0);
      return;
    }
    $('q').value = state.q;
    $('category').value = state.cat;
    $('sort').value = state.sort;
    $('dir').value = state.dir;
    $('eligible').checked = state.eligible;
    $('watch').checked = state.watch;
    $('positive').checked = state.positive;
    renderTable();
  }

  function categories() {
    var seen = {}, out = [];
    for (var i = 0; i < rows.length; i++) seen[rows[i].category] = (seen[rows[i].category] || 0) + 1;
    for (var key in seen) if (Object.prototype.hasOwnProperty.call(seen, key)) out.push([key, seen[key]]);
    out.sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); });
    var html = '<option value="all">All categories (' + rows.length + ')</option>';
    for (var j = 0; j < out.length; j++) html += '<option value="' + esc(out[j][0]) + '">' + esc(out[j][0]) + ' (' + out[j][1] + ')</option>';
    $('category').innerHTML = html;
    $('section-meta').textContent = rows.length + ' rows · ' + D.validation.cvFolds + '-fold validation · ' + D.counts.live + ' token records in the fit · sorted and filtered locally';
  }

  function bind() {
    $('q').oninput = function () { state.q = this.value; renderTable(); };
    $('category').onchange = function () { state.cat = this.value; renderTable(); };
    $('sort').onchange = function () { state.sort = this.value; state.dir = this.value === 'rank' ? 'asc' : 'desc'; renderTable(); };
    $('dir').onchange = function () { state.dir = this.value; renderTable(); };
    $('eligible').onchange = function () { state.eligible = this.checked; renderTable(); };
    $('watch').onchange = function () { state.watch = this.checked; renderTable(); };
    $('positive').onchange = function () { state.positive = this.checked; renderTable(); };
    window.addEventListener('hashchange', function () {
      state.detail = null; state.cat = 'all'; state.q = ''; state.sort = 'rank'; state.dir = 'asc';
      state.watch = false; state.positive = false; state.eligible = true;
      readHash(); render();
    });
  }

  categories();
  renderKpis();
  renderMethod();
  renderLive();
  readHash();
  bind();
  render();
})();
