window.__ModuleLoader__.load({ id: "@dsh-external/dsh-token-ledger", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;

// 独立悬浮面板：不依赖任何 slot 契约，纯 DOM 注入，卸载即净。
exports.inject = [];

var API = '/@dsh-external/dsh-token-ledger/api';
var LS_KEY = 'dsh-token-ledger-panel';
var FAB_ID = 'dsh-token-ledger-fab';
var PANEL_ID = 'dsh-token-ledger-panel';

// 统一以「亿」为单位（1亿 = 1e8 tokens）
function yi(n) {
  var v = n / 1e8;
  if (v >= 1) return v.toFixed(2) + '亿';
  if (v >= 0.01) return v.toFixed(3) + '亿';
  return v.toFixed(4) + '亿';
}

function todayKey() {
  var d = new Date();
  var p = function (x) { return String(x).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// 本地时区的 Date → 'YYYY-MM-DD'（避免 toISOString 的 UTC 偏移导致日期错一天）
function dstr(dt) {
  var p = function (x) { return String(x).padStart(2, '0'); };
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

// Civil dates use UTC only for calendar arithmetic, never elapsed local milliseconds (DST).
function parseDay(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  var d = new Date(key + 'T00:00:00Z');
  return isFinite(d.getTime()) && d.toISOString().slice(0, 10) === key ? d : null;
}
function dayShift(key, count) {
  var d = parseDay(key);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}
function calendarKey(year, month, day) {
  var d = new Date(0);
  d.setUTCFullYear(year, month, day);
  return d.toISOString().slice(0, 10);
}
function periodIndex(anchor, step, key) {
  var a = parseDay(anchor), d = parseDay(key);
  if (!a || !d) return -1;
  if (step === 'year') return d.getUTCFullYear() - a.getUTCFullYear();
  if (step === 'month') return (d.getUTCFullYear() - a.getUTCFullYear()) * 12 + d.getUTCMonth() - a.getUTCMonth();
  return Math.floor((d - a) / 86400000 / (step === 'week' ? 7 : 1));
}
// One contract for heatmap, trend, drill-down and navigation. 'end' is the nominal
// boundary; 'to' is the observed boundary so requests never include future days.
function periodAt(anchor, step, index, today) {
  var a = parseDay(anchor);
  if (!a || !parseDay(today) || index < 0 || !Number.isInteger(index)) return null;
  var start, end;
  if (step === 'month') {
    start = calendarKey(a.getUTCFullYear(), a.getUTCMonth() + index, 1);
    end = dayShift(calendarKey(a.getUTCFullYear(), a.getUTCMonth() + index + 1, 1), -1);
  } else if (step === 'year') {
    start = calendarKey(a.getUTCFullYear() + index, 0, 1);
    end = calendarKey(a.getUTCFullYear() + index, 11, 31);
  } else {
    start = dayShift(anchor, index * (step === 'week' ? 7 : 1));
    end = dayShift(start, step === 'week' ? 6 : 0);
  }
  var from = start < anchor ? anchor : start;
  if (from > today) return null;
  var to = end > today ? today : end;
  return { from: from, to: to, end: end, index: index, total: 0, cnt: 0,
    partialStart: start < anchor, current: from <= today && today <= end,
    incomplete: start < anchor || today <= end,
    label: step === 'year' ? from.slice(0, 4) : step === 'month' ? from.slice(0, 7)
      : step === 'week' ? from.slice(5) + '~' + end.slice(5) : from.slice(5),
    full: from === to ? from : from + ' ~ ' + to };
}
function recordedDays(days, today) {
  return (days || []).filter(function (d) {
    return d && parseDay(d.day) && d.day <= today && Number.isFinite(d.total) && d.total >= 0;
  }).slice().sort(function (a, b) { return a.day.localeCompare(b.day); });
}
function buildPeriods(days, step, today) {
  var records = recordedDays(days, today);
  if (!records.length) return [];
  var anchor = records[0].day, count = periodIndex(anchor, step, today) + 1, periods = [];
  for (var i = 0; i < count; i++) periods.push(periodAt(anchor, step, i, today));
  records.forEach(function (d) {
    var p = periods[periodIndex(anchor, step, d.day)];
    p.total += d.total;
    if (d.total > 0) p.cnt++;
  });
  return periods;
}
// 日历热力图专用：按「周一~周日」对齐的周（首次记录所在周从周一开始，之前的空档透明不显示）
  function buildCalendarWeeks(days, today) {
    var records = recordedDays(days, today);
    if (!records.length) return [];
    var first = records[0].day;
    var dow = parseDay(first).getUTCDay();            // 0=周日 ... 6=周六
    var monday = dayShift(first, -((dow + 6) % 7));   // 回退到最近一个周一
    var dayMap = {}; records.forEach(function (d) { dayMap[d.day] = d.total; });
    var weeks = [];
    var cur = monday;
    while (cur <= today) {
      var end = dayShift(cur, 6);
      var wk = { from: cur, end: end, index: weeks.length, total: 0, cnt: 0,
        current: cur <= today && today <= end, incomplete: today <= end,
        label: cur.slice(5) + '~' + end.slice(5), full: cur + ' ~ ' + end };
      for (var i = 0; i < 7; i++) {
        var dd = dayShift(cur, i);
        if (dayMap[dd]) { wk.total += dayMap[dd]; if (dayMap[dd] > 0) wk.cnt++; }
      }
      weeks.push(wk);
      cur = dayShift(end, 1);
    }
    return weeks;
  }

  function periodCaption(p) {
  if (!p) return '';
  return p.full;
}

// 趋势图悬停提示层（页面级单例）
var chartTipEl = null;

function loadState() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) { return {}; }
}
function saveState(s) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (_) {}
}

// ─── 按「模型」着色：同模型同色（跨账号/提供商一致），不同模型不同色 ───
var MODEL_PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#db2777',
  '#0891b2', '#65a30d', '#9333ea', '#ea580c', '#4f46e5', '#be123c',
];
// 用户指定配色（精确匹配优先于哈希）
var MODEL_COLOR_OVERRIDES = {
  'qwen3.8-max': '#14b8a6',
  'qwen3.8-max-0902': '#14b8a6',
};
function modelOf(route) {
  var i = String(route || '').indexOf('/');
  return i < 0 ? String(route || '') : String(route).slice(i + 1);
}
function colorForModel(model) {
  if (Object.prototype.hasOwnProperty.call(MODEL_COLOR_OVERRIDES, model)) return MODEL_COLOR_OVERRIDES[model];
  var h = 0;
  for (var i = 0; i < model.length; i++) h = ((h << 5) - h + model.charCodeAt(i)) | 0;
  return MODEL_PALETTE[Math.abs(h) % MODEL_PALETTE.length];
}
// 账号着色：不同账号不同色（与模型配色共用调色板，按账号名哈希，稳定不变）
function colorForAccount(account) {
  var h = 0;
  for (var i = 0; i < account.length; i++) h = ((h << 5) - h + account.charCodeAt(i)) | 0;
  return MODEL_PALETTE[(Math.abs(h) + 5) % MODEL_PALETTE.length];
}

/** 拖动 handle 移动 moveEl：位移超 5px 视为拖动，否则视为点击；位置写回 state。 */
function makeDraggable(handle, moveEl, posKey, state, onClick) {
  handle.addEventListener('mousedown', function (e) {
    e.preventDefault();
    var startX = e.clientX, startY = e.clientY;
    var rect = moveEl.getBoundingClientRect();
    var dx = e.clientX - rect.left, dy = e.clientY - rect.top;
    var moved = false;
    function move(ev) {
      if (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5) moved = true;
      if (!moved) return;
      var x = Math.max(0, Math.min(window.innerWidth - 40, ev.clientX - dx));
      var y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - dy));
      moveEl.style.left = x + 'px'; moveEl.style.top = y + 'px';
      moveEl.style.right = 'auto'; moveEl.style.bottom = 'auto';
      state[posKey] = { x: x, y: y };
    }
    function up(ev) {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('mouseup', up, true);
      if (moved) saveState(state);
      else if (onClick) onClick(ev);
    }
    document.addEventListener('mousemove', move, true);
    document.addEventListener('mouseup', up, true);
  });
}

function apply(ctx) {
  // HMR/重注入幂等：先清掉旧元素
  var old = document.getElementById(FAB_ID); if (old) old.remove();
  var oldP = document.getElementById(PANEL_ID); if (oldP) oldP.remove();

  var state = loadState();
  var disposers = [];
  var panel = null;
  var pollTimer = null;
  var view = { mode: 'total' };
  var lastTotalData = null;
  var lastDayData = null;
  var lastRangeData = null;
  var chartScroll = {};
  var chartHover = null;
  var activeChart = null;
  var pendingScrollToDate = false;

  // ─── FAB（可自由拖动；点击开/关面板；默认右下角） ───
  var fab = document.createElement('button');
  fab.id = FAB_ID;
  fab.textContent = '📊 用量';
  fab.title = 'Token 累积账本';
  var fabPos = state.fabPos;
  fab.style.cssText =
    'position:fixed;z-index:9998;' +
    'font:13px/1.6 sans-serif;padding:5px 13px;border-radius:14px;cursor:pointer;' +
    'border:1px solid rgba(0,0,0,.15);color:#333;' +
    'background:rgba(255,255,255,.92);backdrop-filter:blur(6px);user-select:none;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.12);' +
    (fabPos && typeof fabPos.x === 'number'
      ? 'left:' + fabPos.x + 'px;top:' + fabPos.y + 'px;'
      : 'right:16px;bottom:150px;') +
    (state.open ? 'outline:2px solid rgba(37,99,235,.7);' : '');
  document.body.appendChild(fab);
  disposers.push(function () { fab.remove(); });

  // 旋转动画（手动刷新反馈用，只注入一次）
  var styleEl = document.getElementById('dsh-token-ledger-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'dsh-token-ledger-style';
    styleEl.textContent =
      '@keyframes dshTlSpin{to{transform:rotate(360deg)}}' +
      '.dsh-tl-spin{display:inline-block;animation:dshTlSpin .7s linear infinite}' +
      '@keyframes dshTlPulse{0%{opacity:1}50%{opacity:.35}100%{opacity:1}}' +
      '.dsh-tl-pulse{animation:dshTlPulse .35s ease}' +
      // 滚动条加深：拇指清晰可见
      '#' + PANEL_ID + ' ::-webkit-scrollbar{width:9px}' +
      '#' + PANEL_ID + ' ::-webkit-scrollbar-thumb{background:rgba(0,0,0,.38);border-radius:5px}' +
      '#' + PANEL_ID + ' ::-webkit-scrollbar-thumb:hover{background:rgba(0,0,0,.58)}' +
      '#' + PANEL_ID + ' ::-webkit-scrollbar-track{background:rgba(0,0,0,.04)}' +
      '';
    document.head.appendChild(styleEl);
  }
  disposers.push(function () { styleEl.remove(); });

  // ─── 面板构建 ───
  function buildPanel() {
    var el = document.createElement('div');
    el.id = PANEL_ID;
    var p = state.panelPos;
    var sz = state.panelSize;
    el.style.cssText =
      'position:fixed;z-index:9999;display:flex;flex-direction:column;' +
      'width:' + (sz && sz.w ? sz.w + 'px' : '560px') + ';' +
      (sz && sz.h ? 'height:' + sz.h + 'px;' : 'max-height:78vh;') +
      'min-width:400px;max-width:92vw;min-height:220px;resize:both;overflow:hidden;' +
      'border-radius:12px;border:1px solid rgba(0,0,0,.12);' +
      'background:rgba(255,255,255,.97);backdrop-filter:blur(10px);color:#333;' +
      'font:14px/1.8 sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.18);' +
      (p && typeof p.x === 'number' ? 'left:' + p.x + 'px;top:' + p.y + 'px;' : 'right:20px;top:80px;');

    var header = document.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:move;flex:none;' +
      'border-bottom:1px solid rgba(0,0,0,.08);background:rgba(0,0,0,.03);user-select:none';
    header.innerHTML =
      '<span data-act="back" title="返回总计" style="cursor:pointer;color:#333;font-weight:700;font-size:15px;opacity:.9;padding:0 6px;display:none">←</span>' +
      '<span data-role="title" style="font-weight:600;flex:1;color:#222">📊 Token 累积账本</span>' +
      '<span data-act="refresh" title="立即刷新" style="cursor:pointer;color:#333;font-weight:700;font-size:15px;opacity:.9;padding:0 6px">⟳</span>' +
      '<span data-act="close" title="关闭" style="cursor:pointer;color:#333;font-weight:700;font-size:15px;opacity:.9;padding:0 6px">✕</span>';
    el.appendChild(header);

    var body = document.createElement('div');
    body.style.cssText = 'padding:10px 14px;overflow-y:auto;flex:1';
    body.textContent = '加载中…';
    el.appendChild(body);

    header.addEventListener('click', function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'close') setOpen(false);
      else if (act === 'refresh') void manualRefresh();
      else if (act === 'back') { view = { mode: 'total' }; void refresh(); }
    });
    header.querySelectorAll('[data-act]').forEach(function (btn) {
      btn.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    });
    makeDraggable(header, el, 'panelPos', state, null);

    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        if (!el.isConnected) { ro.disconnect(); return; }
        var w = el.offsetWidth, h = el.offsetHeight;
        if (w > 0 && h > 0) { state.panelSize = { w: w, h: h }; saveState(state); }
      });
      ro.observe(el);
    }

    el._body = body;
    el._title = header.querySelector('[data-role="title"]');
    el._back = header.querySelector('[data-act="back"]');
    el._refreshBtn = header.querySelector('[data-act="refresh"]');
    return el;
  }

  // ─── 手动刷新：旋转动画 → 成功打勾 → 面板脉冲 + 时间戳 ───
  var refreshing = false;
  function manualRefresh() {
    if (!panel || refreshing) return;
    refreshing = true;
    var btn = panel._refreshBtn;
    var oldText = btn.textContent;
    btn.classList.add('dsh-tl-spin');
    refresh()
      .then(function () {
        btn.classList.remove('dsh-tl-spin');
        btn.textContent = '✓';
        btn.style.color = '#16a34a';
        panel._body.classList.add('dsh-tl-pulse');
        setTimeout(function () {
          if (!panel) return;
          btn.textContent = oldText;
          btn.style.color = '';
          panel._body.classList.remove('dsh-tl-pulse');
        }, 1200);
      })
      .catch(function () {
        btn.classList.remove('dsh-tl-spin');
        btn.textContent = oldText;
      })
      .finally(function () { refreshing = false; });
  }

  function el(tag, css, text) {
    var d = document.createElement(tag);
    if (css) d.style.cssText = css;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function hideChartTip() { if (chartTipEl) chartTipEl.style.display = 'none'; }
  function showChartTip(ev, text) {
    if (!chartTipEl) {
      chartTipEl = el('div', 'position:fixed;z-index:10002;max-width:260px;padding:5px 8px;border-radius:6px;background:#111;color:#fff;font-size:12px;line-height:1.45;pointer-events:none;white-space:pre-line;box-shadow:0 2px 10px rgba(0,0,0,.3)');
      document.body.appendChild(chartTipEl);
    }
    chartTipEl.textContent = text;
    chartTipEl.style.display = 'block';
    var r = chartTipEl.getBoundingClientRect();
    var x = Math.max(6, Math.min(window.innerWidth - r.width - 6, ev.clientX + 12));
    var y = Math.max(6, Math.min(window.innerHeight - r.height - 6, ev.clientY + 12));
    chartTipEl.style.left = x + 'px'; chartTipEl.style.top = y + 'px';
  }
  function clearChartHover() {
    chartHover = null;
    hideChartTip();
    if (activeChart && activeChart.hide) activeChart.hide();
  }

  // ─── 分组聚合：route=细分 / account=按账号 / model=按模型种类 ───
  function accountLabel(r) {
    var l = r.label || r.route;
    var i = l.indexOf('/');
    var acc = i < 0 ? l : l.slice(0, i);
    // modlens 只是转发桥，不是独立账号：按账号汇总时去掉前缀归并
    return acc.replace(/^modlens·/, '');
  }
  // 细分归并键：modlens 只是桥——modlens·阿里云（X）/M 与 阿里云（X）/M 是同一行
  function canonicalLabel(r) {
    return (r.label || r.route).replace(/^modlens·/, '');
  }
  function aggregateRoutes(routes, mode) {
    var keyFn = mode === 'model' ? function (r) { return modelOf(r.route); }
      : mode === 'account' ? function (r) { return accountLabel(r); }
      : function (r) { return canonicalLabel(r); };
    var map = {};
    var order = [];
    routes.forEach(function (r) {
      var key = keyFn(r);
      var a = map[key];
      if (!a) {
        a = map[key] = { route: mode === 'model' ? key : String(r.route).replace(/^modlens-/, ''), label: key, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, total: 0 };
        order.push(key);
      }
      a.input += r.input; a.output += r.output; a.cacheRead += r.cacheRead; a.cacheWrite += r.cacheWrite;
      a.calls += r.calls; a.total += r.total;
    });
    return order.map(function (k) { return map[k]; }).sort(function (a, b) { return b.total - a.total; });
  }

  // ─── 分布区块：标题 + 两模式切换按钮（账号 / 模型） ───
  var GROUP_MODES = [['account', '账号'], ['model', '模型']];
  var GROUP_TITLES = { account: '按账号', model: '按模型种类' };

  // ─── 右键确认弹层（防误触：隐藏/恢复前都要点一下确认） ───
  var activePopup = null;
  function closePopup() { if (activePopup) { activePopup.remove(); activePopup = null; } }
  disposers.push(function () { closePopup(); });
  function confirmPopup(x, y, message, confirmText, onConfirm) {
    closePopup();
    var pop = el('div', 'position:fixed;z-index:10001;background:#fff;border:1px solid rgba(0,0,0,.15);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.2);padding:10px 12px;font:13px/1.6 sans-serif;color:#222;max-width:280px');
    pop.appendChild(el('div', 'margin-bottom:8px;word-break:break-all', message));
    var btnRow = el('div', 'display:flex;gap:8px;justify-content:flex-end');
    var cancel = el('span', 'padding:2px 12px;border-radius:5px;cursor:pointer;border:1px solid rgba(0,0,0,.18);color:#555', '取消');
    var ok = el('span', 'padding:2px 12px;border-radius:5px;cursor:pointer;background:#2563eb;color:#fff;font-weight:600', confirmText);
    cancel.onclick = closePopup;
    ok.onclick = function () { closePopup(); onConfirm(); };
    btnRow.appendChild(cancel); btnRow.appendChild(ok);
    pop.appendChild(btnRow);
    document.body.appendChild(pop);
    var w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 8)) + 'px';
    pop.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 8)) + 'px';
    activePopup = pop;
    setTimeout(function () {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
    function onDocDown(e) { if (!pop.contains(e.target)) cleanup(); }
    function onEsc(e) { if (e.key === 'Escape') cleanup(); }
    function cleanup() {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onEsc, true);
      closePopup();
    }
  }

  // 已隐藏条目管理弹窗：图表里永不出现隐藏项，恢复从这里点
  function openHiddenPopup(title, entries, onRestore) {
    closePopup();
    var pop = el('div', 'position:fixed;z-index:10001;background:#fff;border:1px solid rgba(0,0,0,.15);border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.2);padding:12px 14px;font:13px/1.7 sans-serif;color:#222;width:300px;max-height:50vh;overflow-y:auto;left:50%;top:25%;transform:translateX(-50%)');
    pop.appendChild(el('div', 'font-weight:700;margin-bottom:8px', title));
    entries.forEach(function (ent) {
      var line = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:8px;padding:3px 0;border-bottom:1px dashed rgba(0,0,0,.08)');
      line.appendChild(el('span', 'word-break:break-all;min-width:0', ent.label));
      var btn = el('span', 'flex:none;padding:1px 10px;border-radius:5px;cursor:pointer;background:#2563eb;color:#fff;font-size:12px', '恢复');
      btn.onclick = function () { onRestore(ent.key); closePopup(); };
      line.appendChild(btn);
      pop.appendChild(line);
    });
    var foot = el('div', 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px');
    var allBtn = el('span', 'padding:2px 12px;border-radius:5px;cursor:pointer;border:1px solid rgba(0,0,0,.18);color:#333', '全部恢复');
    allBtn.onclick = function () { entries.forEach(function (ent) { onRestore(ent.key); }); closePopup(); };
    var closeBtn = el('span', 'padding:2px 12px;border-radius:5px;cursor:pointer;border:1px solid rgba(0,0,0,.18);color:#555', '关闭');
    closeBtn.onclick = closePopup;
    foot.appendChild(allBtn); foot.appendChild(closeBtn);
    pop.appendChild(foot);
    document.body.appendChild(pop);
    activePopup = pop;
    setTimeout(function () {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onEsc, true);
    }, 0);
    function onDocDown(e) { if (!pop.contains(e.target)) cleanup(); }
    function onEsc(e) { if (e.key === 'Escape') cleanup(); }
    function cleanup() {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onEsc, true);
      closePopup();
    }
  }

  /** 右键隐藏条目（弹确认防误触；隐藏后彻底从图表消失；恢复走 👁 管理弹窗）。 */
  function attachHider(row, nm, key, opts) {
    if (!opts) return;
    if (nm) nm.title = (nm.title ? nm.title + '\n' : '') + '右键：隐藏此项';
    row.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var label = nm && nm.textContent ? nm.textContent : key;
      confirmPopup(
        e.clientX,
        e.clientY,
        '要隐藏「' + label + '」吗？（彻底不显示，不影响统计，可随时恢复）',
        '隐藏',
        function () {
          opts.hidden[key] = true;
          saveState(state);
          rerenderView();
        }
      );
    });
  }

  function routesSection(body, routes, periodTotal) {
    var mode = state.groupMode || 'account';
    if (mode !== 'account' && mode !== 'model') mode = 'account';
    var hidden = (state.hidden = state.hidden || {});
    var routeTotal = routes.reduce(function (n, r) { return n + r.total; }, 0);
    var opts = { mode: mode, hidden: hidden, sum: Number.isFinite(periodTotal) ? periodTotal : routeTotal };
    var all = aggregateRoutes(routes, mode);
    var hiddenEntries = [];
    all.forEach(function (r) {
      var key = mode + ':' + (r.label || r.route);
      if (hidden[key]) hiddenEntries.push({ key: key, label: r.label || r.route });
    });
    // 隐藏 = 彻底从图表消失（连半透明影子都不留）
    var visible = all.filter(function (r) { return !hidden[mode + ':' + (r.label || r.route)]; });

    var wrap = el('div', 'margin-top:10px;border-top:1px dashed rgba(0,0,0,.15);padding-top:6px');
    var head = el('div', 'display:flex;align-items:center;gap:8px;margin-bottom:6px');
    head.appendChild(el('span', 'opacity:.55', GROUP_TITLES[mode]));
    if (hiddenEntries.length > 0) {
      var eye = el('span', 'cursor:pointer;font-size:12px;opacity:.75;user-select:none', '👁 已隐藏 ' + hiddenEntries.length + ' 项');
      eye.title = '查看并恢复被隐藏的条目';
      eye.onclick = function () {
        openHiddenPopup('已隐藏的条目（点「恢复」重新显示）', hiddenEntries, function (key) {
          delete hidden[key];
          saveState(state);
          rerenderView();
        });
      };
      head.appendChild(eye);
    }
    var seg = el('span', 'display:inline-flex;border:1px solid rgba(0,0,0,.18);border-radius:6px;overflow:hidden;margin-left:auto;user-select:none');
    GROUP_MODES.forEach(function (pair) {
      var active = mode === pair[0];
      var b = el('span', 'padding:1px 12px;cursor:pointer;font-size:12px;' + (active ? 'background:#2563eb;color:#fff;font-weight:600' : 'background:transparent;color:#555'), pair[1]);
      b.onclick = function () { state.groupMode = pair[0]; saveState(state); void refresh(); };
      seg.appendChild(b);
    });
    head.appendChild(seg);
    wrap.appendChild(head);
    if (routeTotal !== opts.sum) wrap.appendChild(el('div', 'font-size:11px;color:#9a6700',
      '路由明细合计 ' + yi(routeTotal) + ' 与本视图总量 ' + yi(opts.sum) + ' 不一致（历史明细可能缺失）；占比未重新归一化，合计可能不为 100%。'));
    if (mode === 'account') {
      accountRows(wrap, visible, routes, opts);
    } else {
      routeRows(wrap, visible, 'model', true, opts);
    }
    if (all.length > 0 && visible.length === 0) {
      wrap.appendChild(el('div', 'opacity:.5', '全部已隐藏——点上方 👁 查看并恢复'));
    }
    body.appendChild(wrap);
  }

  // ─── 账号行：点击展开/收起该账号的模型明细（手风琴） ───
  function accountRows(wrap, accounts, rawRoutes, opts) {
    var max = 1;
    var sum = 0;
    accounts.forEach(function (a) { if (a.total > max) max = a.total; sum += a.total; });
    if (opts && Number.isFinite(opts.sum)) sum = opts.sum;
    accounts.forEach(function (a) {
      var color = colorForAccount(a.label);
      var open = !!(state.expanded && state.expanded[a.label]);
      var row = el('div', 'margin:5px 0;cursor:pointer;user-select:none');
      var label = el('div', 'display:flex;justify-content:space-between;gap:6px;align-items:baseline');
      var left = el('span', 'display:flex;align-items:center;gap:4px;min-width:0;opacity:.95');
      var chevron = el('span', 'flex:none;font-size:17px;line-height:1;font-weight:700;color:' + color, open ? '▾' : '▸');
      var dot = el('span', 'flex:none;width:8px;height:8px;border-radius:50%;display:inline-block');
      dot.style.background = color;
      var nm = el('span', 'word-break:break-all;font-weight:600', a.label);
      nm.title = '点击' + (open ? '收起' : '展开') + '该账号的模型明细';
      left.appendChild(chevron); left.appendChild(dot); left.appendChild(nm);
      attachHider(row, nm, opts ? opts.mode + ':' + a.label : '', opts);
      var pct = sum > 0 ? (a.total / sum * 100) : 0;
      var pctText = (pct >= 10 ? String(Math.round(pct)) : pct.toFixed(1)) + '%';
      var val = el('span', 'flex:none;opacity:.8;padding-left:4px;white-space:nowrap', yi(a.total) + '（' + a.calls + '次·' + pctText + '）');
      label.appendChild(left); label.appendChild(val);
      row.appendChild(label);
      var barWrap = el('div', 'height:8px;border-radius:4px;background:rgba(0,0,0,.07);margin-top:3px');
      var bar = el('div', 'position:relative;height:100%;border-radius:4px;width:' + Math.max(1, Math.round(a.total / max * 100)) + '%');
      bar.style.background = color;
      barWrap.appendChild(bar);
      row.appendChild(barWrap);
      row.appendChild(el('div', 'opacity:.65;font-size:12px;margin-top:1px',
        '入 ' + yi(a.input) + ' · 出 ' + yi(a.output) + ' · 缓存 ' + yi(a.cacheRead + a.cacheWrite)));
      row.onclick = function () {
        state.expanded = state.expanded || {};
        state.expanded[a.label] = !open;
        saveState(state);
        rerenderView();
      };
      wrap.appendChild(row);
      if (open) {
        // 子行同样归并 modlens：账号内按"同模型"合并展示
        var children = aggregateRoutes(
          rawRoutes.filter(function (r) { return accountLabel(r) === a.label; }),
          'route'
        );
        var sub = el('div', 'margin:2px 0 8px 22px;padding-left:10px;border-left:2px solid ' + color + '33');
        routeRows(sub, children, 'model', true);
        wrap.appendChild(sub);
      }
    });
    if (accounts.length === 0) wrap.appendChild(el('div', 'opacity:.5', '无记录'));
  }

  // 不重新拉数据，直接用缓存重渲染当前视图（手风琴展开用）
  function rerenderView() {
    if (view.mode === 'day' && lastDayData) renderDay(lastDayData);
    else if (view.mode === 'range' && lastRangeData) renderRange(lastRangeData);
    else if (view.mode === 'total' && lastTotalData) renderTotal(lastTotalData);
    else void refresh();
  }

  // ─── 路由行（色点 + 彩色条形；colorBasis='model' 按模型着色，'account' 按账号着色） ───
  function routeRows(body, routes, colorBasis, showBuckets, opts) {
    var max = 1;
    var sum = 0;
    routes.forEach(function (r) { if (r.total > max) max = r.total; sum += r.total; });
    if (opts && Number.isFinite(opts.sum)) sum = opts.sum;
    routes.forEach(function (r) {
      var color = colorBasis === 'account' ? colorForAccount(r.label || r.route) : colorForModel(modelOf(r.route));
      var row = el('div', 'margin:5px 0');
      var label = el('div', 'display:flex;justify-content:space-between;gap:6px;align-items:baseline');
      var left = el('span', 'display:flex;align-items:center;gap:5px;min-width:0;opacity:.95');
      var dot = el('span', 'flex:none;width:8px;height:8px;border-radius:50%;display:inline-block');
      dot.style.background = color;
      var nm = el('span', 'word-break:break-all', r.label || r.route);
      nm.title = r.route + '\n入 ' + r.input + ' · 出 ' + r.output + ' · 缓存 ' + (r.cacheRead + r.cacheWrite);
      left.appendChild(dot); left.appendChild(nm);
      attachHider(row, nm, opts ? opts.mode + ':' + (r.label || r.route) : '', opts);
      var pct = sum > 0 ? (r.total / sum * 100) : 0;
      var pctText = (pct >= 10 ? String(Math.round(pct)) : pct.toFixed(1)) + '%';
      var val = el('span', 'flex:none;opacity:.8;padding-left:4px;white-space:nowrap', yi(r.total) + '（' + r.calls + '次·' + pctText + '）');
      label.appendChild(left); label.appendChild(val);
      row.appendChild(label);
      var barWrap = el('div', 'height:8px;border-radius:4px;background:rgba(0,0,0,.07);margin-top:3px');
      var bar = el('div', 'position:relative;height:100%;border-radius:4px;width:' + Math.max(1, Math.round(r.total / max * 100)) + '%');
      bar.style.background = color;
      barWrap.appendChild(bar);
      row.appendChild(barWrap);
      if (showBuckets) {
        row.appendChild(el('div', 'opacity:.65;font-size:12px;margin-top:1px',
          '入 ' + yi(r.input) + ' · 出 ' + yi(r.output) + ' · 缓存 ' + yi(r.cacheRead + r.cacheWrite)));
      }
      body.appendChild(row);
    });
    if (routes.length === 0) body.appendChild(el('div', 'opacity:.5', '无记录'));
  }

  function sectionTitle(body, text) {
    body.appendChild(el('div', 'opacity:1;color:#333;font-weight:600;margin:10px 0 4px;border-top:1px dashed rgba(0,0,0,.15);padding-top:6px', text));
  }

  // ─── 总计视图 ───
  function renderTotal(s) {
    if (!panel) return;
    lastTotalData = s;
    panel._title.textContent = '📊 Token 累积账本';
    panel._back.style.display = 'none';
    var body = panel._body;
    var _st = body.scrollTop;
    clearChartHover();
    body.innerHTML = '';

    body.appendChild(el('div', 'font-size:18px;font-weight:700;margin-bottom:2px;color:#111', '累计 ' + yi(s.grandTotal) + ' tokens'));

    var today = null, tk = todayKey();
    for (var i = 0; i < (s.days || []).length; i++) if (s.days[i].day === tk) { today = s.days[i]; break; }
    body.appendChild(el('div', 'opacity:1;color:#222;font-weight:700;margin-bottom:6px',
      '入 ' + yi(s.totals.input) + ' · 出 ' + yi(s.totals.output) +
      ' · 缓存 ' + yi(s.totals.cacheRead + s.totals.cacheWrite) +
      ' · ' + s.totals.calls + ' 次调用' +
      (today ? ' · 今日 ' + yi(today.total) : '')));

    routesSection(body, s.routes || [], s.grandTotal);

    sectionTitle(body, '按日期 · Token 活动');

    var days = recordedDays(s.days, tk);
    if (!days.length) { pendingScrollToDate = false; body.scrollTop = _st; return; }

    var sumAll = 0; days.forEach(function (d) { sumAll += d.total; });
    var dayMap = {};
    days.forEach(function (d) { dayMap[d.day] = d.total; });

    var weeks = buildCalendarWeeks(days, tk);
    var firstDay = days[0].day;
    weeks.forEach(function (wk) {
      wk.start = wk.from;
      wk.days = [];
      for (var i = 0; i < 7; i++) {
        var dd = dayShift(wk.from, i);
        wk.days.push({ day: dd, total: dayMap[dd] || 0, future: dd > tk, beforeStart: dd < firstDay });
      }
    });

    var trend = state.trend || 'day';
    if (trend !== 'day' && trend !== 'week' && trend !== 'month' && trend !== 'line') trend = 'day';

    var maxDay = 1; weeks.forEach(function (w) { w.days.forEach(function (c) { if (c.total > maxDay) maxDay = c.total; }); });
    var maxWeek = 1; weeks.forEach(function (w) { if (w.total > maxWeek) maxWeek = w.total; });

    function heatColor(v, m) {
      if (v <= 0) return '#eef1f4';
      var t = Math.sqrt(v / m);
      var blues = ['#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#2563eb'];
      return blues[Math.min(4, Math.floor(t * 5))];
    }
    function monthOf(dayStr) { return parseInt(dayStr.slice(5, 7), 10) + '月'; }

    // 标题行：每日/每周/每月/趋势 切换
    var th = el('div', 'display:flex;align-items:center;margin-bottom:8px');
    var seg = el('span', 'display:inline-flex;border:1px solid rgba(0,0,0,.18);border-radius:6px;overflow:hidden;user-select:none');
    [['day', '每日'], ['week', '每周'], ['month', '每月'], ['line', '趋势']].forEach(function (p) {
      var active = trend === p[0];
      var b = el('span', 'padding:1px 12px;cursor:pointer;font-size:12px;' + (active ? 'background:#2563eb;color:#fff;font-weight:600' : 'color:#555'), p[1]);
      b.onclick = function () { state.trend = p[0]; saveState(state); pendingScrollToDate = true; rerenderView(); };
      seg.appendChild(b);
    });
    th.appendChild(seg);
    body.appendChild(th);

    var gap = 2, gutter = 22;
    var avail = Math.max(120, (body.clientWidth || 520) - 30 - gutter);
    var n = weeks.length;
    var cellSize = Math.max(3, Math.min(12, Math.floor((avail - (n - 1) * gap) / n)));

    // 月份标签行（每日/每周共用）
    function monthRow(leftPad) {
      var mrow = el('div', 'display:flex;height:14px;' + (leftPad ? 'padding-left:' + leftPad + 'px' : ''));
      var lastM = '';
      weeks.forEach(function (w) {
        var slot = el('div', 'flex:0 0 ' + (cellSize + gap) + 'px;font-size:10px;color:#999;line-height:14px;white-space:nowrap');
        var mon = monthOf(w.start);
        if (mon !== lastM) { slot.textContent = mon; lastM = mon; }
        mrow.appendChild(slot);
      });
      return mrow;
    }

    if (trend === 'day') {
      var main = el('div', 'display:flex');
      var gut = el('div', 'flex:0 0 ' + gutter + 'px;display:flex;flex-direction:column;');
      var weekdayNames = ['一', '二', '三', '四', '五', '六', '日'];
      weekdayNames.forEach(function (label, ri) {
        var g = el('div', 'width:100%;height:' + cellSize + 'px;line-height:' + cellSize + 'px;font-size:10px;color:#aaa;' + (ri < 6 ? 'margin-bottom:' + gap + 'px' : ''));
        g.textContent = label;
        gut.appendChild(g);
      });
      main.appendChild(gut);
      weeks.forEach(function (w, wi) {
        var col = el('div', 'display:flex;flex-direction:column;' + (wi > 0 ? 'margin-left:' + gap + 'px' : ''));
        w.days.forEach(function (c, ci) {
          var cell = el('div', 'width:' + cellSize + 'px;height:' + cellSize + 'px;border-radius:2px;' + (ci < 6 ? 'margin-bottom:' + gap + 'px' : ''));
          var renderable = !(c.future || c.beforeStart);
          cell.style.background = renderable ? heatColor(c.total, maxDay) : 'transparent';
          if (c.day === tk) {
            cell.style.boxShadow = '0 0 0 2.5px #f97316, inset 0 0 0 1px #fff';
            if (!c.total) cell.style.background = '#ffe4cc';
          }
          if (renderable) {
            var pct = sumAll > 0 ? (c.total / sumAll * 100) : 0;
            var pctText = (pct >= 10 ? String(Math.round(pct)) : pct.toFixed(1)) + '%';
            cell.title = c.day + (c.day === tk ? '（今天）' : '') + ' · ' + yi(c.total) + ' · ' + pctText;
            cell.style.cursor = 'pointer';
            cell.onclick = function () { view = { mode: 'day', day: c.day }; void refresh(); };
            cell.addEventListener('mouseenter', function () { cell.style.boxShadow = '0 0 0 2px #ef4444, inset 0 0 0 1px #fff'; });
            cell.addEventListener('mouseleave', function () {
              if (c.day === tk) {
                cell.style.boxShadow = '0 0 0 2.5px #f97316, inset 0 0 0 1px #fff';
                if (!c.total) cell.style.background = '#ffe4cc';
              } else { cell.style.boxShadow = ''; }
            });
          }
          col.appendChild(cell);
        });
        main.appendChild(col);
      });
      body.appendChild(main);
      body.appendChild(monthRow(gutter));
    } else if (trend === 'week') {
      var wr = el('div', 'display:flex;');
      weeks.forEach(function (w, wi) {
        var cell = el('div', 'width:' + cellSize + 'px;height:18px;border-radius:3px;' + (wi > 0 ? 'margin-left:' + gap + 'px' : ''));
        cell.style.background = heatColor(w.total, maxWeek);
        if (w.start <= tk && tk <= w.end) cell.style.boxShadow = '0 0 0 2px #f97316';
        cell.title = '第 ' + (wi + 1) + ' 周 · ' + periodCaption(w) + ' · ' + yi(w.total);
        cell.style.cursor = 'pointer';
        cell.onclick = function () { view = { mode: 'range', from: w.from, to: w.end, step: 'week' }; void refresh(); };
        cell.addEventListener('mouseenter', function () { cell.style.boxShadow = '0 0 0 2px #ef4444'; });
        cell.addEventListener('mouseleave', function () { cell.style.boxShadow = (w.start <= tk && tk <= w.end) ? '0 0 0 2px #f97316' : ''; });
        wr.appendChild(cell);
      });
      body.appendChild(wr);
      body.appendChild(monthRow(0));
    } else if (trend === 'month') {
      // 每月一格：点开看该月模型明细
      var months = buildPeriods(days, 'month', tk);
      months.forEach(function (m) { m.short = m.label; m.isCur = m.current; });
      var maxM = 1; months.forEach(function (m) { if (m.total > maxM) maxM = m.total; });
      var mrow = el('div', 'display:flex;align-items:flex-end;');
      months.forEach(function (m, mi) {
        var col = el('div', 'display:flex;flex-direction:column;align-items:center;' + (mi > 0 ? 'margin-left:10px' : ''));
        col.appendChild(el('div', 'font-size:10px;color:#999;margin-bottom:2px', m.short));
        var cell = el('div', 'width:24px;height:24px;border-radius:6px;');
        cell.style.background = heatColor(m.total, maxM);
        if (m.isCur) cell.style.boxShadow = '0 0 0 2px #f97316';
        cell.title = m.short + ' · ' + yi(m.total) + (m.cnt ? ' · ' + m.cnt + ' 天有使用' : '');
        cell.style.cursor = 'pointer';
        cell.onclick = function () { view = { mode: 'range', from: m.from, to: m.end, step: 'month' }; void refresh(); };
        cell.addEventListener('mouseenter', function () { cell.style.boxShadow = '0 0 0 2px #ef4444'; });
        cell.addEventListener('mouseleave', function () { cell.style.boxShadow = m.isCur ? '0 0 0 2px #f97316' : ''; });
        col.appendChild(cell);
        mrow.appendChild(col);
      });
      body.appendChild(mrow);
    } else {
      // 趋势：可切 每天/每周/每月/每年 粒度，连续时间轴（无数据补 0），带 Y 轴坐标
      var tline = state.tline || 'day';
      if (tline !== 'day' && tline !== 'week' && tline !== 'month' && tline !== 'year') tline = 'day';

      var tseg = el('div', 'display:inline-flex;border:1px solid rgba(0,0,0,.18);border-radius:6px;overflow:hidden;user-select:none;margin-bottom:6px');
      [['day', '每天'], ['week', '每周'], ['month', '每月'], ['year', '每年']].forEach(function (p) {
        var active = tline === p[0];
        var b = el('span', 'padding:1px 10px;cursor:pointer;font-size:12px;' + (active ? 'background:#2563eb;color:#fff;font-weight:600' : 'color:#555'), p[1]);
        b.onclick = function () { state.tline = p[0]; saveState(state); pendingScrollToDate = true; rerenderView(); };
        tseg.appendChild(b);
      });
      body.appendChild(tseg);

      var buckets = buildPeriods(days, tline, tk);

      var maxBV = 1; buckets.forEach(function (b) { if (b.total > maxBV) maxBV = b.total; });
      var nB = buckets.length;
      var gutterY = 46;
      var columnWidth = tline === 'week' ? 100 : tline === 'month' ? 66 : 52;
      var W = Math.max(nB * columnWidth, (body.clientWidth || 520) - 30 - gutterY);
      var pitch = W / Math.max(1, nB);
      var H = 100;
      var padTop = 10, padBottom = 3;   // 顶部留白，峰值点不会顶到上边界/越过最高刻度
      var plotH = H - padTop - padBottom;
      function bx(i) { return (i + 0.5) * pitch; }
      function by(v) { return padTop + plotH - v / maxBV * plotH; }

      var SVGNS = 'http://www.w3.org/2000/svg';
      var chartRow = el('div', 'display:flex;align-items:stretch;min-width:0;');
      var scrollKey = 'trend-' + tline;
      var savedScroll = Number.isFinite(chartScroll[scrollKey]) ? chartScroll[scrollKey] : 0;
      var scroller = el('div', 'flex:1;min-width:0;overflow-x:auto;overflow-y:hidden;padding-top:5px;');
      scroller.setAttribute('data-scroll-key', scrollKey);
      var plot = el('div', 'width:' + W + 'px;');
      scroller.appendChild(plot);
      // 仅在 scroller 真正挂到文档后记录滚动位置，避免重建瞬间把保存值覆盖成 0
      scroller.addEventListener('scroll', function () {
        if (scroller.isConnected) chartScroll[scrollKey] = scroller.scrollLeft;
        clearChartHover();
      });

      // 左 Y 轴坐标（顶=峰值，中=一半，底=0）
      var yax = el('div', 'flex:0 0 ' + gutterY + 'px;display:flex;flex-direction:column;justify-content:space-between;text-align:right;font-size:10px;color:#999;padding:0 5px 0 0;height:' + H + 'px;box-sizing:border-box');
      yax.appendChild(el('div', '', yi(maxBV)));
      yax.appendChild(el('div', '', yi(maxBV / 2)));
      yax.appendChild(el('div', '', '0'));
      yax.style.marginTop = '5px';
      chartRow.appendChild(yax);

      var svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);
      svg.style.cssText = 'display:block;overflow:visible;';

      function gridLine(yv) {
        var l = document.createElementNS(SVGNS, 'line');
        l.setAttribute('x1', 0); l.setAttribute('x2', W); l.setAttribute('y1', yv); l.setAttribute('y2', yv);
        l.setAttribute('stroke', 'rgba(0,0,0,.08)'); l.setAttribute('stroke-width', '1');
        svg.appendChild(l);
      }
      gridLine(by(maxBV)); gridLine(by(maxBV / 2)); gridLine(by(0));

      var areaPts = bx(0) + ',' + by(0) + ' ';
      buckets.forEach(function (b, i) { areaPts += bx(i) + ',' + by(b.total) + ' '; });
      areaPts += bx(nB - 1) + ',' + by(0);
      var area = document.createElementNS(SVGNS, 'polygon');
      area.setAttribute('points', areaPts);
      area.setAttribute('fill', 'rgba(37,99,235,.12)');
      svg.appendChild(area);

      var linePts = buckets.map(function (b, i) { return bx(i) + ',' + by(b.total); }).join(' ');
      var ln = document.createElementNS(SVGNS, 'polyline');
      ln.setAttribute('points', linePts);
      ln.setAttribute('fill', 'none');
      ln.setAttribute('stroke', '#2563eb');
      ln.setAttribute('stroke-width', '2');
      ln.setAttribute('stroke-linejoin', 'round');
      ln.setAttribute('stroke-linecap', 'round');
      svg.appendChild(ln);

      buckets.forEach(function (b, i) {
        var c = document.createElementNS(SVGNS, 'circle');
        c.setAttribute('cx', bx(i)); c.setAttribute('cy', by(b.total));
        c.setAttribute('r', b.current ? 3.2 : 2.2);
        c.setAttribute('fill', b.current ? '#f97316' : '#2563eb');
        svg.appendChild(c);
      });
      var crosshair = document.createElementNS(SVGNS, 'line');
      // 红线只从「悬停的数据点」往下连到 0 基线，顶端=当前点值，永不越过最高点
      crosshair.setAttribute('y1', by(0)); crosshair.setAttribute('y2', by(0));
      crosshair.setAttribute('stroke', '#ef4444'); crosshair.setAttribute('stroke-dasharray', '3 3');
      crosshair.style.cssText = 'display:none;pointer-events:none';
      svg.appendChild(crosshair);
      var focusDot = document.createElementNS(SVGNS, 'circle');
      focusDot.setAttribute('r', 4); focusDot.setAttribute('fill', '#ef4444');
      focusDot.style.cssText = 'display:none;pointer-events:none';
      svg.appendChild(focusDot);
      plot.appendChild(svg);
      chartRow.appendChild(scroller);
      body.appendChild(chartRow);
      // 恢复横向滚动位置：必须等 scroller 挂载进文档后再设，否则会回到最左。
      if (savedScroll > 0) {
        scroller.scrollLeft = savedScroll;
        requestAnimationFrame(function () { scroller.scrollLeft = savedScroll; });
      }

      // Every label owns a readable fixed-minimum-width column; never sample ticks.
      var axis = el('div', 'position:relative;width:' + W + 'px;height:34px;margin-top:4px;font-size:10px;color:#666');
      buckets.forEach(function (b, idx) {
        var lab = el('div', 'position:absolute;top:0;text-align:center;white-space:nowrap;line-height:1.4;transform:translateX(-50%)');
        if (tline === 'week') lab.appendChild(el('div', 'font-weight:600;color:#333', '第' + (idx + 1) + '周'));
        lab.appendChild(el('div', '', b.label));
        if (tline === 'day') lab.appendChild(el('div', 'font-size:9px;color:#999', b.from.slice(0, 4)));
        lab.title = periodCaption(b);
        lab.style.left = bx(idx) + 'px';
        axis.appendChild(lab);
      });
      plot.appendChild(axis);

      function columnAt(ev) {
        var rect = svg.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
        if (ev.clientX < viewport.left || ev.clientX >= viewport.right || ev.clientY < rect.top || ev.clientY > rect.bottom) return -1;
        return Math.max(0, Math.min(nB - 1, Math.floor((ev.clientX - rect.left) / rect.width * W / pitch)));
      }
      function hover(ev) {
        var i = columnAt(ev);
        if (i < 0) { clearChartHover(); return; }
        var b = buckets[i];
        chartHover = { x: ev.clientX, y: ev.clientY, key: 'trend-' + tline };
        crosshair.setAttribute('x1', bx(i)); crosshair.setAttribute('x2', bx(i));
        crosshair.setAttribute('y1', by(b.total)); crosshair.setAttribute('y2', by(0));
        crosshair.style.display = '';
        var fy = Math.max(padTop + 2, Math.min(H - padBottom - 2, by(b.total)));
        focusDot.setAttribute('cx', bx(i)); focusDot.setAttribute('cy', fy); focusDot.style.display = '';
        showChartTip(ev, (tline === 'week' ? '第' + (i + 1) + '周 · ' : '') + periodCaption(b) + '\n' + yi(b.total));
      }
      activeChart = { key: 'trend-' + tline, hover: hover, hide: function () { crosshair.style.display = 'none'; focusDot.style.display = 'none'; } };
      svg.style.cursor = 'pointer';
      svg.addEventListener('mousemove', hover);
      svg.addEventListener('mouseleave', clearChartHover);
      svg.addEventListener('click', function (ev) {
        var i = columnAt(ev);
        if (i < 0) return;
        var b = buckets[i];
        clearChartHover();
        view = tline === 'day' ? { mode: 'day', day: b.from } : { mode: 'range', from: b.from, to: b.end, step: tline };
        void refresh();
      });
    }

    if (pendingScrollToDate) {
      pendingScrollToDate = false;
      body.scrollTop = body.scrollHeight;
    } else {
      body.scrollTop = _st;
    }
  }

  // ─── 单日明细视图（与总计视图同一布局，只是日期不同） ───
  function renderDay(d) {
    if (!panel) return;
    lastDayData = d;
    panel._title.textContent = '📅 ' + d.day + (d.day === todayKey() ? '（今天）' : '');
    panel._back.style.display = '';
    var body = panel._body;
    var _st = body.scrollTop;
    clearChartHover();
    body.innerHTML = '';

    // 上一天 / 下一天导航（整体居中：◀ 前一天 ｜ 当天日期 ｜ 后一天 ▶）
    var idx = (d.allDays || []).indexOf(d.day);
    var prev = idx > 0 ? d.allDays[idx - 1] : null;
    var next = idx >= 0 && idx < d.allDays.length - 1 ? d.allDays[idx + 1] : null;
    var nav = el('div', 'display:flex;align-items:baseline;justify-content:center;gap:18px;margin:2px 0 8px;user-select:none');
    var prevEl = el('span', 'cursor:pointer;line-height:1;' + (prev ? 'opacity:1;color:#333;font-weight:600' : 'opacity:.3'), '◀ ' + (prev || '无'));
    if (prev) prevEl.onclick = function () { view = { mode: 'day', day: prev }; void refresh(); };
    var curEl = el('span', 'font-weight:700;color:#111;padding:0 4px;font-size:18px;line-height:1', d.day);
    var nextEl = el('span', 'cursor:pointer;line-height:1;' + (next ? 'opacity:1;color:#333;font-weight:600' : 'opacity:.3'), (next || '无') + ' ▶');
    if (next) nextEl.onclick = function () { view = { mode: 'day', day: next }; void refresh(); };
    nav.appendChild(prevEl);
    nav.appendChild(curEl);
    nav.appendChild(nextEl);
    body.appendChild(nav);

    body.appendChild(el('div', 'font-size:18px;font-weight:700;margin-bottom:2px;color:#111', '当天 ' + yi(d.totals.total) + ' tokens'));
    body.appendChild(el('div', 'opacity:1;color:#222;font-weight:700;margin-bottom:2px',
      '入 ' + yi(d.totals.input) + ' · 出 ' + yi(d.totals.output) +
      ' · 缓存 ' + yi(d.totals.cacheRead + d.totals.cacheWrite) +
      ' · ' + d.totals.calls + ' 次调用'));
    body.appendChild(el('div', 'opacity:.55;margin-bottom:6px',
      '历史累计 ' + yi(d.grandTotal) + ' tokens'));

    routesSection(body, d.routes || [], d.totals.total);

    body.scrollTop = _st;
  }

  // ─── 区间明细视图（周/月/年钻取：区间累计 + 各模型分布） ───
  function renderRange(d) {
    if (!panel) return;
    lastRangeData = d;
    var step = view.step || 'week';
    function p2(n) { return String(n).padStart(2, '0'); }
    function rangeTitle() {
      if (step === 'month') return '📅 ' + d.from.slice(0, 7) + '（月）';
      if (step === 'year') return '📅 ' + d.from.slice(0, 4) + '（年）';
      return '📅 ' + d.from.slice(5) + ' ~ ' + d.to.slice(5) + '（周）';
    }
    function anchorForRange() {
      var first = lastTotalData && lastTotalData.firstRecordedDay;
      return parseDay(first) ? first : d.from;
    }
    function periodRange(index) {
      return periodAt(anchorForRange(), step, index, todayKey());
    }
    panel._title.textContent = rangeTitle();
    panel._back.style.display = '';
    var body = panel._body;
    var _st = body.scrollTop;
    clearChartHover();
    body.innerHTML = '';

    function navRange(dir) {
      var anchor = anchorForRange();
      var idx = periodIndex(anchor, step, d.from);
      if (!Number.isInteger(idx) || idx < 0) idx = 0;
      var p = periodAt(anchor, step, idx + dir, todayKey());
      if (!p) return;
      view = { mode: 'range', from: p.from, to: p.end, step: step };
      void refresh();
    }
    var nav = el('div', 'display:flex;align-items:baseline;justify-content:center;gap:16px;margin:2px 0 8px;user-select:none');
    var prevLabel = step === 'month' ? '◀ 上月' : step === 'year' ? '◀ 去年' : '◀ 上一周';
    var nextLabel = step === 'month' ? '下月 ▶' : step === 'year' ? '明年 ▶' : '下一周 ▶';
    var prevEl = el('span', 'cursor:pointer;line-height:1;color:#333;font-weight:600', prevLabel);
    prevEl.onclick = function () { navRange(-1); };
    var curTxt = step === 'month' ? d.from.slice(0, 7) : step === 'year' ? d.from.slice(0, 4) : d.from.slice(5) + ' ~ ' + d.to.slice(5);
    var curEl = el('span', 'font-weight:700;color:#111;padding:0 4px;font-size:16px;line-height:1', curTxt);
    var nextEl = el('span', 'cursor:pointer;line-height:1;color:#333;font-weight:600', nextLabel);
    nextEl.onclick = function () { navRange(1); };
    nav.appendChild(prevEl); nav.appendChild(curEl); nav.appendChild(nextEl);
    body.appendChild(nav);

    var headWord = step === 'month' ? '本月累计' : step === 'year' ? '本年累计' : '本周累计';
    body.appendChild(el('div', 'font-size:18px;font-weight:700;margin-bottom:2px;color:#111', headWord + ' ' + yi(d.totals.total) + ' tokens'));
    body.appendChild(el('div', 'opacity:1;color:#222;font-weight:700;margin-bottom:2px',
      '入 ' + yi(d.totals.input) + ' · 出 ' + yi(d.totals.output) +
      ' · 缓存 ' + yi(d.totals.cacheRead + d.totals.cacheWrite) +
      ' · ' + d.totals.calls + ' 次调用'));
    body.appendChild(el('div', 'opacity:.55;margin-bottom:6px', '历史累计 ' + yi(d.grandTotal) + ' tokens'));

    routesSection(body, d.routes || [], d.totals.total);

    body.scrollTop = _st;
  }

  function refresh() {
    var url = view.mode === 'day' ? API + '?day=' + view.day
      : view.mode === 'range' ? API + '?from=' + view.from + '&to=' + view.to
      : API;
    return fetch(url, { cache: 'no-store' })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (s) {
        if (view.mode === 'day') renderDay(s);
        else if (view.mode === 'range') renderRange(s);
        else renderTotal(s);
      })
      .catch(function () { if (panel) panel._body.textContent = '账本 API 不可用（插件未运行？）'; });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(function () {
      if (!panel || !panel.isConnected) { stopPolling(); return; }
      void refresh();
    }, 5000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function setOpen(open) {
    state.open = open; saveState(state);
    fab.style.outline = open ? '2px solid rgba(37,99,235,.7)' : '';
    if (open) {
      if (!panel) { panel = buildPanel(); document.body.appendChild(panel); }
      panel.style.display = 'flex';
      if (lastTotalData && view.mode === 'total') renderTotal(lastTotalData);
      void refresh();
      startPolling();
    } else if (panel) {
      panel.style.display = 'none';
      stopPolling();
    }
  }

  makeDraggable(fab, fab, 'fabPos', state, function () { setOpen(!(panel && panel.style.display !== 'none')); });
  disposers.push(function () { stopPolling(); if (panel) panel.remove(); if (chartTipEl) { chartTipEl.remove(); chartTipEl = null; } });

  ctx.effect(function () {
    return function () {
      disposers.forEach(function (d) { try { d(); } catch (_) {} });
    };
  }, '@dsh-external/dsh-token-ledger: floating panel');

  if (state.open) setOpen(true);
}

exports.apply = apply;

return module.exports; } });
