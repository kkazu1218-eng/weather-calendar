'use strict';

const HOURLY = 'weather_code,temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,uv_index_max';
const DEFAULTS = {
  origin: { name: '松戸市', lat: 35.7876, lon: 139.9032 },
  dest: { name: '千代田区', lat: 35.694, lon: 139.7536 },
  go: [8, 10],
  back: [18, 21],
};
// 判定のしきい値
const RULES = {
  needProb: 60, needMm: 1.0, foldProb: 30, windMs: 10, uv: 6, layerGap: 7,
  dayHours: [6, 23], // 「通勤時間帯以外」を見る範囲
  wear: [
    [28, '👕', '半袖。熱中症に注意'],
    [24, '👕', '半袖、または薄手の長袖'],
    [20, '👔', '長袖シャツ'],
    [16, '🧶', '長袖＋カーディガンか薄手ジャケット'],
    [12, '🧥', 'ジャケットかセーター'],
    [8, '🧥', '薄手のコート'],
    [-99, '🧣', '冬物コート、マフラー、手袋'],
  ],
};
const LIVE_CACHE_MS = 3 * 60 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても動かす */ } },
};

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

const state = {
  settings: { ...DEFAULTS, ...(store.get('settings') || {}) },
  view: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  days: new Map(), // 'YYYY-MM-DD' -> [地点ごとの {name, hours[24], daily}]
  updated: null,
  confirmed: null, // 前夜確定版として表示する日
  stored: false, // true: 23時取得の保存データを表示中
  months: new Set(),
};

// ---------- データ ----------

function locations() {
  return [state.settings.origin, state.settings.dest].filter(Boolean);
}

const samePlace = (a, b) => a && b && Math.abs(a.lat - b.lat) < 0.001 && Math.abs(a.lon - b.lon) < 0.001;

function ingest(data, index, name, overwrite = true) {
  const { hourly, daily } = data;
  const touched = new Map();
  const slot = (date) => {
    if (!touched.has(date)) {
      const locs = state.days.get(date) || [];
      if (locs[index] && !overwrite) touched.set(date, null);
      else {
        locs[index] = { name, hours: [], daily: {} };
        state.days.set(date, locs);
        touched.set(date, locs[index]);
      }
    }
    return touched.get(date);
  };
  hourly.time.forEach((t, i) => {
    const loc = slot(t.slice(0, 10));
    if (!loc) return;
    loc.hours[Number(t.slice(11, 13))] = {
      code: hourly.weather_code[i], t: hourly.temperature_2m[i], at: hourly.apparent_temperature[i],
      pp: hourly.precipitation_probability[i], pr: hourly.precipitation[i], w: hourly.wind_speed_10m[i],
    };
  });
  daily.time.forEach((t, i) => {
    const loc = slot(t);
    if (!loc) return;
    loc.daily = {
      code: daily.weather_code[i], tmax: daily.temperature_2m_max[i],
      tmin: daily.temperature_2m_min[i], uv: daily.uv_index_max[i],
    };
  });
}

async function loadStored() {
  const res = await fetch('data/latest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('保存データがありません');
  const latest = await res.json();
  const locs = locations();
  if (latest.locations.length !== locs.length || !locs.every((l, i) => samePlace(l, latest.locations[i]))) return false;
  state.days.clear();
  state.months.clear();
  latest.locations.forEach((l, i) => ingest(l, i, locs[i].name));
  state.updated = new Date(latest.updated);
  const next = new Date(state.updated);
  next.setDate(next.getDate() + 1);
  state.confirmed = ymd(next);
  state.stored = true;
  return true;
}

async function loadHistoryMonth() {
  const key = `${state.view.getFullYear()}-${pad(state.view.getMonth() + 1)}`;
  if (!state.stored || state.months.has(key)) return;
  state.months.add(key);
  const res = await fetch(`data/history/${key}.json`, { cache: 'no-store' }).catch(() => null);
  if (!res || !res.ok) return;
  const month = await res.json();
  const locs = locations();
  for (const day of Object.values(month)) {
    day.locations.forEach((l, i) => {
      if (samePlace(l, locs[i])) ingest(l, i, locs[i].name, false);
    });
  }
}

async function loadLive(force) {
  const locs = locations();
  const cache = store.get('live');
  const fresh = cache && Date.now() - cache.at < LIVE_CACHE_MS
    && cache.locs.length === locs.length && locs.every((l, i) => samePlace(l, cache.locs[i]));
  let data;
  if (fresh && !force) {
    data = cache.data;
    state.updated = new Date(cache.at);
  } else {
    data = await Promise.all(locs.map(async (l) => {
      const q = new URLSearchParams({
        latitude: l.lat, longitude: l.lon, hourly: HOURLY, daily: DAILY, timezone: 'Asia/Tokyo',
        forecast_days: 16, past_days: 31, wind_speed_unit: 'ms',
      });
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
      if (!res.ok) throw new Error(`天気の取得に失敗しました (${res.status})`);
      const json = await res.json();
      return { hourly: json.hourly, daily: json.daily };
    }));
    state.updated = new Date();
    store.set('live', { at: state.updated.getTime(), locs, data });
  }
  state.days.clear();
  data.forEach((d, i) => ingest(d, i, locs[i].name));
  state.confirmed = null;
  state.stored = false;
}

async function load(forceLive = false) {
  $('error').hidden = true;
  try {
    const stored = !forceLive && await loadStored().catch(() => false);
    if (!stored) await loadLive(forceLive);
    await loadHistoryMonth();
  } catch (e) {
    $('error').textContent = e.message;
    $('error').hidden = false;
  }
  render();
}

// ---------- 判定 ----------

const WX = [
  [0, '☀️', '快晴'], [1, '🌤️', '晴れ'], [2, '⛅', '晴れ時々くもり'], [3, '☁️', 'くもり'], [48, '🌫️', '霧'],
  [57, '🌦️', '霧雨'], [67, '🌧️', '雨'], [77, '🌨️', '雪'], [82, '🌧️', 'にわか雨'], [86, '🌨️', 'にわか雪'], [99, '⛈️', '雷雨'],
];
const wx = (code) => (code == null ? ['', ''] : WX.find(([max]) => code <= max).slice(1));
const isSnow = (code) => (code >= 71 && code <= 77) || code === 85 || code === 86;
const num = (v, digits = 0) => (v == null ? '–' : v.toFixed(digits));
const max = (values) => { const v = values.filter((x) => x != null); return v.length ? Math.max(...v) : null; };
const min = (values) => { const v = values.filter((x) => x != null); return v.length ? Math.min(...v) : null; };

function inCommute(h) {
  const { go, back } = state.settings;
  return (h >= go[0] && h < go[1]) || (h >= back[0] && h < back[1]);
}

function judge(locs) {
  const all = locs.flatMap((l) => l.hours.map((x, h) => ({ ...x, h, name: l.name }))).filter((x) => x.code != null || x.t != null);
  if (!all.length) return null;
  const commute = all.filter((x) => inCommute(x.h));
  const day = all.filter((x) => x.h >= RULES.dayHours[0] && x.h < RULES.dayHours[1]);
  const wet = (x, prob) => (x.pp != null && x.pp >= prob) || (x.pr != null && x.pr >= RULES.needMm);
  const worst = (list) => list.reduce((a, b) => (((b.pp ?? 0) > (a.pp ?? 0) || ((b.pp ?? 0) === (a.pp ?? 0) && (b.pr ?? 0) > (a.pr ?? 0))) ? b : a));
  const why = (x) => `${x.name} ${x.h}時：降水確率 ${num(x.pp)}%・${num(x.pr, 1)} mm`;

  const umb = { level: 'none', icon: '', label: '傘は不要', reason: '通勤時間帯も日中も雨の予報なし', notes: [] };
  const needC = commute.filter((x) => wet(x, RULES.needProb));
  const foldC = commute.filter((x) => x.pp != null && x.pp >= RULES.foldProb);
  const needD = day.filter((x) => wet(x, RULES.needProb));
  if (needC.length) Object.assign(umb, { level: 'need', icon: '☔', label: '傘必要', reason: why(worst(needC)) });
  else if (foldC.length) Object.assign(umb, { level: 'fold', icon: '🌂', label: '折りたたみ傘', reason: why(worst(foldC)) });
  else if (needD.length) Object.assign(umb, { level: 'fold', icon: '🌂', label: '折りたたみ傘', reason: `通勤時間帯以外に雨（${why(worst(needD))}）` });
  const snow = commute.some((x) => isSnow(x.code));
  if (snow) { umb.icon = '❄'; umb.notes.push('雪の予報。足元に注意'); if (umb.level === 'none') Object.assign(umb, { level: 'fold', label: '雪' }); }
  const wind = max(day.map((x) => x.w));
  if (wind != null && wind >= RULES.windMs) umb.notes.push(`強風（最大 ${num(wind)} m/s）。傘が壊れやすい`);

  const dayMax = max(all.filter((x) => x.h >= 9 && x.h < 18).map((x) => x.at));
  const commuteMin = min(commute.map((x) => x.at));
  let wear = null;
  if (dayMax != null) {
    const [, icon, label] = RULES.wear.find(([from]) => Math.round(dayMax) >= from);
    wear = { icon, label, notes: [`日中の体感 最高 ${num(dayMax)}℃`] };
    if (commuteMin != null) {
      wear.notes.push(`通勤時の体感 最低 ${num(commuteMin)}℃`);
      if (dayMax - commuteMin >= RULES.layerGap) wear.notes.push('朝晩は冷えるので羽織りを持つ');
    }
    if (umb.level === 'need') wear.notes.push('濡れてもよい靴');
    const uv = max(locs.map((l) => l.daily.uv));
    if (uv != null && uv >= RULES.uv) wear.notes.push(`紫外線が強い（指数 ${num(uv)}）。日傘・帽子`);
  }

  return {
    code: max(locs.map((l) => l.daily.code)) ?? max(day.map((x) => x.code)),
    tmax: max(locs.map((l) => l.daily.tmax)) ?? max(all.map((x) => x.t)),
    tmin: min(locs.map((l) => l.daily.tmin)) ?? min(all.map((x) => x.t)),
    umb, wear,
  };
}

// ---------- 画面 ----------

function render() {
  const s = state.settings;
  $('place').textContent = s.dest ? `${s.origin.name} → ${s.dest.name}` : s.origin.name;
  $('updated').textContent = state.updated
    ? `最終更新 ${state.updated.getMonth() + 1}/${state.updated.getDate()} ${pad(state.updated.getHours())}:${pad(state.updated.getMinutes())}${state.stored ? '（23時定時取得）' : ''}`
    : '';
  const y = state.view.getFullYear();
  const m = state.view.getMonth();
  $('month').textContent = `${y}年 ${m + 1}月`;
  const grid = $('grid');
  grid.replaceChildren();
  for (let i = 0; i < new Date(y, m, 1).getDay(); i++) grid.append(el('div', { className: 'cell empty' }));
  const today = ymd(new Date());
  const last = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= last; d++) {
    const date = `${y}-${pad(m + 1)}-${pad(d)}`;
    const locs = state.days.get(date);
    const j = locs && judge(locs);
    const cell = el('button', { type: 'button', className: 'cell' });
    if (date === today) cell.classList.add('today');
    const badge = j && state.stored && date === state.confirmed ? el('span', { className: 'badge', textContent: '前夜確定' }) : null;
    cell.append(el('span', { className: 'num' }, String(d), badge));
    if (j) {
      const [icon, label] = wx(j.code);
      cell.classList.add(j.umb.level);
      cell.title = `${label}／${j.umb.label}${j.wear ? `／${j.wear.label}` : ''}`;
      cell.append(...[
        el('span', { className: 'wx', textContent: icon }),
        el('span', { className: 'temp' }, el('span', { className: 'hi', textContent: num(j.tmax) }), ' / ', el('span', { className: 'lo', textContent: num(j.tmin) }), '℃'),
        j.umb.level !== 'none' ? el('span', { className: 'umb', textContent: `${j.umb.icon} ${j.umb.label}` }) : null,
        j.wear ? el('span', { className: 'wear', textContent: `${j.wear.icon} ${j.wear.label}` }) : null,
      ].filter(Boolean));
      cell.addEventListener('click', () => showDetail(date));
    } else {
      cell.classList.add('nodata');
      cell.disabled = true;
    }
    grid.append(cell);
  }
}

function showDetail(date) {
  const locs = state.days.get(date);
  const j = locs && judge(locs);
  if (!j) return;
  const d = new Date(`${date}T00:00`);
  const shift = (n) => { const x = new Date(d); x.setDate(x.getDate() + n); return ymd(x); };
  const nav = (label, target) => {
    const b = el('button', { type: 'button', textContent: label, disabled: !state.days.has(target) });
    b.addEventListener('click', () => showDetail(target));
    return b;
  };
  const close = el('button', { type: 'button', textContent: '閉じる' });
  close.addEventListener('click', () => $('detail').close());
  const [icon, label] = wx(j.code);
  const box = (title, notes) => el('div', {}, el('b', { textContent: title }), el('small', { textContent: notes.join('　／　') }));

  const tables = locs.map((l) => {
    const rows = l.hours.map((x, h) => ({ ...x, h })).filter((x) => x.h >= 6 && (x.t != null || x.code != null));
    const table = el('table', {}, el('caption', { textContent: l.name }),
      el('tr', {}, ...['時', '天気', '気温', '体感', '降水確率', '降水量', '風'].map((t) => el('th', { textContent: t }))));
    for (const x of rows) {
      const cells = [`${x.h}時`, wx(x.code)[0], `${num(x.t)}℃`, `${num(x.at)}℃`, `${num(x.pp)}%`, `${num(x.pr, 1)} mm`, `${num(x.w)} m/s`];
      table.append(el('tr', { className: inCommute(x.h) ? 'commute' : '' }, ...cells.map((t) => el('td', { textContent: t }))));
    }
    return table;
  });

  $('detail').replaceChildren(
    el('div', { className: 'detail-head' },
      el('h3', { textContent: `${d.getMonth() + 1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）` }),
      el('span', {}, nav('‹ 前日', shift(-1)), ' ', nav('翌日 ›', shift(1)), ' ', close)),
    el('div', { className: 'summary' },
      box(`${icon} ${label}　${num(j.tmax)} / ${num(j.tmin)}℃`, [state.stored && date === state.confirmed ? '前夜確定版' : '色付きの行が通勤時間帯']),
      box(`${j.umb.icon} ${j.umb.label}`, [j.umb.reason, ...j.umb.notes]),
      j.wear ? box(`${j.wear.icon} ${j.wear.label}`, j.wear.notes) : null),
    el('div', { className: 'tables' }, ...tables),
  );
  if (!$('detail').open) $('detail').showModal();
}

// ---------- 地域設定 ----------

let draft;

async function geocode(name) {
  for (const suffix of ['', '市', '区', '町', '村']) {
    const q = new URLSearchParams({ name: name + suffix, language: 'ja', count: 10, countryCode: 'JP' });
    const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${q}`);
    if (!res.ok) throw new Error('地名の検索に失敗しました');
    const results = ((await res.json()).results || []).filter((r) => r.country_code === 'JP');
    if (results.length) return results;
  }
  return [];
}

function renderDraft() {
  for (const box of document.querySelectorAll('.search')) {
    const place = draft[box.dataset.target];
    box.querySelector('.chosen').textContent = place ? `選択中：${place.name}` : '選択中：なし';
  }
  for (const [id, value] of [['go0', draft.go[0]], ['go1', draft.go[1]], ['back0', draft.back[0]], ['back1', draft.back[1]]]) $(id).value = value;
  const favs = store.get('favs') || [];
  $('favs').replaceChildren(...favs.map((f, i) => {
    const use = el('button', { type: 'button', textContent: f.dest ? `${f.origin.name} → ${f.dest.name}` : f.origin.name });
    use.addEventListener('click', () => { draft.origin = f.origin; draft.dest = f.dest; renderDraft(); });
    const del = el('button', { type: 'button', textContent: '×', title: '削除' });
    del.addEventListener('click', () => { favs.splice(i, 1); store.set('favs', favs); renderDraft(); });
    return el('span', {}, use, del);
  }));
  if (!favs.length) $('favs').textContent = 'まだありません';
}

function setupSettings() {
  for (const id of ['go0', 'go1', 'back0', 'back1']) {
    for (let h = 0; h <= 24; h++) $(id).append(el('option', { value: h, textContent: h }));
  }
  for (const box of document.querySelectorAll('.search')) {
    const [input, button] = [box.querySelector('input'), box.querySelector('button')];
    const list = box.querySelector('.results');
    const search = async () => {
      if (!input.value.trim()) return;
      list.replaceChildren(el('li', { textContent: '検索中…' }));
      try {
        const results = await geocode(input.value.trim());
        list.replaceChildren(...results.map((r) => {
          const pick = el('button', { type: 'button', textContent: `${r.name}（${[r.admin1, r.admin2].filter((a) => a && a !== r.name).join(' ')}）` });
          pick.addEventListener('click', () => {
            draft[box.dataset.target] = { name: r.name, lat: r.latitude, lon: r.longitude };
            list.replaceChildren();
            renderDraft();
          });
          return el('li', {}, pick);
        }));
        if (!results.length) list.replaceChildren(el('li', { textContent: '見つかりません。「〇〇市」「〇〇区」まで入れてみてください' }));
      } catch (e) {
        list.replaceChildren(el('li', { textContent: e.message }));
      }
    };
    button.addEventListener('click', search);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
    box.querySelector('.clear')?.addEventListener('click', () => { draft.dest = null; renderDraft(); });
  }
  const open = () => { draft = structuredClone(state.settings); renderDraft(); $('settings').showModal(); };
  $('open-settings').addEventListener('click', open);
  $('place').addEventListener('click', open);
  $('cancel').addEventListener('click', () => $('settings').close());
  $('reset').addEventListener('click', () => { draft = structuredClone(DEFAULTS); renderDraft(); });
  $('add-fav').addEventListener('click', () => {
    const favs = store.get('favs') || [];
    favs.push({ origin: draft.origin, dest: draft.dest });
    store.set('favs', favs);
    renderDraft();
  });
  $('save').addEventListener('click', () => {
    draft.go = [Number($('go0').value), Number($('go1').value)];
    draft.back = [Number($('back0').value), Number($('back1').value)];
    state.settings = draft;
    store.set('settings', draft);
    $('settings').close();
    load();
  });
}

// ---------- 起動 ----------

function moveMonth(n) {
  state.view = n === 0 ? new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    : new Date(state.view.getFullYear(), state.view.getMonth() + n, 1);
  render();
  loadHistoryMonth().then(render);
}

$('prev').addEventListener('click', () => moveMonth(-1));
$('next').addEventListener('click', () => moveMonth(1));
$('today').addEventListener('click', () => moveMonth(0));
$('refresh').addEventListener('click', () => load(true));
setupSettings();
load();
