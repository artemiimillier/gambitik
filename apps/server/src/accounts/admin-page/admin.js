// The owner's dashboard: reads /api/admin/stats every 15 s and draws it. Plain script (the CSP allows 'self' only).
'use strict';

const BOTS = { petya: 'Петя', sonya: 'Соня', grisha: 'Гриша', sasha: 'Саша', vika: 'Вика', lyova: 'Лёва', nika: 'Ника', dima: 'Дима' };
const TIME_CONTROLS = { bullet1: '1 минута', blitz5: '5 минут', rapid10: '10 минут', training: 'Без часов' };
const SCREENS = {
  play: 'Играют партию', puzzles: 'Решают задачи', review: 'Разбор партии', home: 'Главная', new: 'Выбирают игру',
  progress: 'Успехи', path: 'Путь пешки', settings: 'Настройки', playground: 'Площадка', auth: 'Вход',
};
const REFRESH_MS = 15_000;

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
};
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

function ago(ms) {
  if (ms === null || ms === undefined) return '—';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}
const dateShort = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function kpi(label, value, sub, cls = '') {
  return el('div', { class: `card kpi ${cls}` }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value), el('div', { class: 'sub' }, sub));
}

function hbars(target, entries, names) {
  target.replaceChildren();
  const list = Object.entries(entries).sort((a, b) => b[1] - a[1]);
  if (list.length === 0) {
    target.append(el('div', { class: 'empty' }, 'Пока пусто'));
    return;
  }
  const max = Math.max(...list.map(([, n]) => n));
  for (const [key, n] of list) {
    const fill = el('div', { class: 'fill', style: `width:${Math.max(3, (n / max) * 100)}%` });
    target.append(el('div', { class: 'hbar' }, el('span', {}, names[key] ?? key), el('div', { class: 'track' }, fill), el('span', { class: 'n' }, n)));
  }
}

function hourlyChart(target, hourly) {
  target.replaceChildren();
  const series = [
    { key: 'signups', color: 'var(--bar3)', name: 'регистрации' },
    { key: 'games', color: 'var(--bar)', name: 'партии' },
    { key: 'puzzles', color: 'var(--bar2)', name: 'задачи' },
  ];
  const W = 640, rowH = 58, gap = 14, left = 34, bottom = 20;
  const H = series.length * (rowH + gap) + bottom;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Регистрации, партии и задачи по часам за 48 часов' });
  const bw = (W - left) / hourly.length;
  series.forEach((s, i) => {
    const top = i * (rowH + gap);
    const max = Math.max(1, ...hourly.map((h) => h[s.key]));
    svg.append(svgEl('line', { x1: left, x2: W, y1: top + rowH, y2: top + rowH, stroke: 'var(--line)' }));
    const label = svgEl('text', { x: left - 6, y: top + 12, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' });
    label.textContent = String(max);
    svg.append(label);
    const total = hourly.reduce((n, h) => n + h[s.key], 0);
    const name = svgEl('text', { x: left + 4, y: top + 12, 'font-size': 12, fill: 'var(--muted)' });
    name.textContent = `${s.name}: ${total}`;
    svg.append(name);
    hourly.forEach((h, j) => {
      const v = h[s.key];
      if (v === 0) return;
      const bh = Math.max(2, (v / max) * rowH);
      const rect = svgEl('rect', { x: left + j * bw + 1, y: top + rowH - bh, width: Math.max(1, bw - 2), height: bh, rx: 2, fill: s.color });
      const title = svgEl('title');
      title.textContent = `${new Date(h.hour).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}: ${v}`;
      rect.append(title);
      svg.append(rect);
    });
  });
  // hour marks every 6 hours
  hourly.forEach((h, j) => {
    const d = new Date(h.hour);
    if (d.getHours() % 6 !== 0) return;
    const t = svgEl('text', { x: left + j * bw + bw / 2, y: H - 4, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' });
    t.textContent = d.getHours() === 0 ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : `${d.getHours()}:00`;
    svg.append(t);
  });
  target.append(svg);
}

function resultsBar(target, r) {
  target.replaceChildren();
  const total = r.wins + r.losses + r.draws;
  if (total === 0) {
    target.append(el('div', { class: 'empty' }, 'Партий пока нет'));
    return;
  }
  const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
  target.append(
    el('div', { class: 'results' },
      el('div', { style: `width:${pct(r.wins)};background:var(--win)`, title: `победы ${r.wins}` }),
      el('div', { style: `width:${pct(r.draws)};background:var(--draw)`, title: `ничьи ${r.draws}` }),
      el('div', { style: `width:${pct(r.losses)};background:var(--loss)`, title: `поражения ${r.losses}` })),
    el('div', { class: 'legend' },
      el('span', {}, el('i', { style: 'background:var(--win)' }), `победы ${r.wins}`),
      el('span', {}, el('i', { style: 'background:var(--draw)' }), `ничьи ${r.draws}`),
      el('span', {}, el('i', { style: 'background:var(--loss)' }), `поражения ${r.losses}`)),
  );
}

const COLUMNS = [
  { key: 'online', title: '', sort: (a) => (a.online ? 1 : 0) },
  { key: 'login', title: 'Ник', sort: (a) => a.login.toLowerCase() },
  { key: 'screen', title: 'Сейчас', sort: (a) => a.screen ?? '' },
  { key: 'stage', title: 'Ступень', num: true, sort: (a) => a.stage ?? 0 },
  { key: 'games', title: 'Партии', num: true, sort: (a) => a.games },
  { key: 'wld', title: 'Победы / ничьи / поражения', num: true, sort: (a) => a.wins },
  { key: 'puzzles', title: 'Задачи', num: true, sort: (a) => a.puzzles },
  { key: 'rating', title: 'Рейтинг задач', num: true, sort: (a) => a.puzzleRating ?? 0 },
  { key: 'active', title: 'Был', sort: (a) => a.lastActiveAt ?? 0 },
  { key: 'created', title: 'Регистрация', sort: (a) => a.createdAt },
  { key: 'invite', title: 'Код', sort: (a) => a.invite ?? '' },
];
let sortBy = { key: 'active', dir: -1 };
let lastStats = null;

function table(rows) {
  const t = $('table');
  t.replaceChildren();
  const head = el('tr');
  for (const c of COLUMNS) {
    const arrow = sortBy.key === c.key ? (sortBy.dir < 0 ? ' ↓' : ' ↑') : '';
    const th = el('th', { class: c.num ? 'num' : '' }, c.title + arrow);
    th.addEventListener('click', () => {
      sortBy = { key: c.key, dir: sortBy.key === c.key ? -sortBy.dir : -1 };
      if (lastStats) table(lastStats.accounts);
    });
    head.append(th);
  }
  t.append(el('thead', {}, head));
  const col = COLUMNS.find((c) => c.key === sortBy.key) ?? COLUMNS[0];
  const sorted = [...rows].sort((a, b) => {
    const x = col.sort(a), y = col.sort(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sortBy.dir || (b.online - a.online);
  });
  const body = el('tbody');
  for (const a of sorted) {
    const screen = a.online && a.screen ? el('span', { class: `pill ${a.screen === 'play' ? 'play' : ''}` }, SCREENS[a.screen] ?? a.screen) : el('span', { class: 'muted' }, a.unfinishedGame ? 'партия не доиграна' : '—');
    body.append(el('tr', {},
      el('td', {}, el('span', { class: `dot ${a.online ? 'on' : ''}`, title: a.online ? 'на сайте' : 'не на сайте' })),
      el('td', {}, a.login, a.address === 'f' ? el('span', { class: 'muted' }, ' ♀') : a.address === 'm' ? el('span', { class: 'muted' }, ' ♂') : ''),
      el('td', {}, screen),
      el('td', { class: 'num' }, a.stage ?? '—'),
      el('td', { class: 'num' }, a.games),
      el('td', { class: 'num' }, `${a.wins} / ${a.draws} / ${a.losses}`),
      el('td', { class: 'num' }, a.puzzles ? `${a.puzzlesSolved} из ${a.puzzles}` : '0'),
      el('td', { class: 'num' }, a.puzzles > 0 && a.puzzleRating !== null ? a.puzzleRating : '—'),
      el('td', {}, ago(a.lastActiveAt)),
      el('td', { class: 'muted' }, dateShort(a.createdAt)),
      el('td', { class: 'muted' }, a.invite ?? '—'),
    ));
  }
  t.append(body);
}

function invitesTable(invites) {
  const t = $('invites');
  t.replaceChildren(el('thead', {}, el('tr', {}, el('th', {}, 'Метка'), el('th', {}, 'Статус'), el('th', { class: 'num' }, 'Учеников'), el('th', { class: 'num' }, 'Использован'))));
  const body = el('tbody');
  for (const i of invites) {
    body.append(el('tr', {},
      el('td', {}, i.label),
      el('td', {}, el('span', { class: `pill ${i.open ? '' : 'play'}` }, i.open ? 'открыт' : 'закрыт')),
      el('td', { class: 'num' }, i.accounts),
      el('td', { class: 'num' }, i.uses === null ? '—' : i.maxUses === null ? i.uses : `${i.uses} из ${i.maxUses}`),
    ));
  }
  t.append(body);
}

function render(s) {
  lastStats = s;
  const t = s.totals;
  $('kpis').replaceChildren(
    kpi('Сейчас на сайте', t.online, 'за последние 2–3 минуты', 'live'),
    kpi('Играют партию', t.playing, 'прямо сейчас', 'play'),
    kpi('Ученики', t.accounts, `мест всего ${t.maxAccounts}`),
    kpi('Были за сутки', t.activeToday, 'заходили или играли'),
    kpi('Партии', t.games, 'сыграно всего'),
    kpi('Задачи', t.puzzles, `решено ${t.puzzlesSolved}`),
  );
  hourlyChart($('hourly'), s.hourly);
  hbars($('screens'), s.screens, SCREENS);
  if (Object.keys(s.screens).length === 0) $('screens').replaceChildren(el('div', { class: 'empty' }, 'Сейчас на сайте никого'));
  hbars($('tc'), s.byTimeControl, TIME_CONTROLS);
  hbars($('bots'), s.byBot, BOTS);
  resultsBar($('results'), s.results);
  const stages = {};
  for (const a of s.accounts) if (a.stage !== null) stages[`Ступень ${a.stage}`] = (stages[`Ступень ${a.stage}`] ?? 0) + 1;
  hbars($('stages'), stages, {});
  invitesTable(s.invites ?? []);
  table(s.accounts);
  $('updated').textContent = `обновлено ${new Date(s.generatedAt).toLocaleTimeString('ru-RU')} · само обновляется каждые 15 с`;
}

async function load() {
  try {
    const res = await fetch('/api/admin/stats', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (res.status === 401 || res.status === 404) {
      $('app').hidden = true;
      $('denied').hidden = false;
      if (res.status === 404) $('denied-text').textContent = 'Этот аккаунт не владелец сайта. Войдите под аккаунтом владельца.';
      return;
    }
    if (!res.ok) throw new Error(String(res.status));
    const stats = await res.json();
    $('denied').hidden = true;
    $('app').hidden = false;
    render(stats);
  } catch {
    $('updated').textContent = 'нет связи с сервером — повторю через 15 с';
  }
}

void load();
setInterval(() => {
  if (!document.hidden) void load();
}, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void load();
});
