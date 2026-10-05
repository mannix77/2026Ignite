// Ignite 2026 Planner — views, routing and event handling.

import * as store from './store.js';
import { fetchAll, buildModel, EVENT, diffKnown, snapshot, CUSTOM_DATA } from './data.js';
import { checkLive } from './live.js';
import { optimize, decisionGroups, transitions, fillers, nowNext, weigh, canBoth, overlaps, transition, whatIf, PRIORITY } from './planner.js';
import { fmtTime, fmtDay, fmtDuration, relTime, nowLocal } from './time.js';
import { BUILDINGS, BUILDING, PAIR_KEYS, parseLocation, walkMinutes } from './venue.js';
import { esc, attr, icon, bldgChip, recChip, prioPill, whenText, prioControl, sessionCard, toast, shareOrDownload, copyText, speakersLine } from './ui.js';

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const dialog = $('#detail');
const TABS = ['browse', 'triage', 'plan', 'now', 'changes', 'settings'];
const PAGE = 60;
const REFRESH_MS = 10 * 60 * 1000;

const app = {
  raw: null,        // { doc, meta, changes } the model is built from
  snapshot: null,   // last synced copy from data/
  live: null,       // result of the live check against the Ignite site
  liveError: null,
  sig: null,
  model: null,
  plan: null,
  alerts: [],
  nextKnown: {},
  local: false,
  tab: 'browse',
  browseLimit: PAGE,
  triage: null,
  openFill: null,
  nowTimer: null,
  dialogKey: null,
  rendered: false,
};

// ---------------------------------------------------------------- helpers

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function ctx() {
  const s = store.settings();
  return { walk: s.walk, buffer: num(s.buffer, 2), tolerance: num(s.tolerance, 5), weights: s.weights };
}

function groupOf(s) { return app.model.byGroup.get(s.group) || [s]; }

// Picks are stored on one record per repeat group; read whichever member holds it.
function pickOf(s) {
  const picks = store.get().picks;
  for (const m of groupOf(s)) if (picks[m.id]) return { id: m.id, ...picks[m.id] };
  return null;
}
function prioOf(s) { const p = pickOf(s); return p ? p.p ?? null : null; }
function pickIdFor(s) { return pickOf(s)?.id || groupOf(s)[0].id; }

function sessionById(id) { return app.model.byId.get(id)?.[0] || null; }

function isNew(s) {
  if (!s.firstSeen) return false;
  return Date.now() - new Date(s.firstSeen).getTime() < 7 * 86400000;
}

function interestProfile() {
  const prof = new Map();
  for (const [id, pk] of Object.entries(store.get().picks)) {
    if (!(pk.p > 0)) continue;
    const s = sessionById(id);
    if (!s) continue;
    for (const t of [...(s.topics || []), ...(s.tags || [])]) prof.set(t, (prof.get(t) || 0) + pk.p);
  }
  return prof;
}
function interest(s, prof) {
  const ts = [...(s.topics || []), ...(s.tags || [])];
  if (!ts.length) return 0;
  return ts.reduce((a, t) => a + (prof.get(t) || 0), 0) / Math.sqrt(ts.length);
}

function invalidate() { app.plan = null; }

// ---------------------------------------------------------------- plan model

function computePlan() {
  if (app.plan) return app.plan;
  const picks = store.get().picks;
  const groups = new Map();
  for (const [id, pk] of Object.entries(picks)) {
    if (!(pk.p > 0)) continue;
    const s = sessionById(id);
    if (!s) continue;
    const g = groups.get(s.group) || { p: 0, lock: null, pickId: id };
    if (pk.p > g.p) { g.p = pk.p; g.pickId = id; }
    if (pk.lock) { g.lock = pk.lock; g.pickId = id; }
    groups.set(s.group, g);
  }
  const items = [], online = [], tba = [];
  for (const [g, info] of groups) {
    for (const s of app.model.byGroup.get(g) || []) {
      const it = {
        key: s.key, id: g, code: s.code, title: s.title, type: s.type, day: s.day, startMin: s.startMin, endMin: s.endMin,
        loc: s.loc, recorded: s.recorded, priority: info.p, locked: info.lock === s.key, s, pickId: info.pickId,
      };
      if (s.onlineOnly) online.push(it);
      else if (!s.day || !(s.endMin > s.startMin)) tba.push(it);
      else items.push(it);
    }
  }
  const c = ctx();
  const res = optimize(items, c);
  const chosen = new Set(Object.values(res.plan).flat().map(x => x.key));
  const chosenGroups = new Set(Object.values(res.plan).flat().map(x => x.id));
  // An instance whose repeat is already in the plan isn't a real decision.
  const contested = items.filter(x => chosen.has(x.key) || !chosenGroups.has(x.id));
  const decisions = decisionGroups(contested, c).map(d => ({ ...d, resolved: d.items.some(x => x.locked) }));
  // Tidy tba/online lists: one row per group.
  const oneEach = list => [...new Map(list.map(x => [x.id, x])).values()];
  app.plan = {
    items, res, chosen, chosenGroups, decisions, contested,
    online: oneEach(online).filter(x => !chosenGroups.has(x.id)),
    tba: oneEach(tba).filter(x => !chosenGroups.has(x.id) && !items.some(i => i.id === x.id)),
    groupCount: groups.size,
  };
  return app.plan;
}

// ---------------------------------------------------------------- header / badges

function renderStatus() {
  if (!app.model) return;
  const meta = app.raw?.meta || {};
  const el = $('#sync-status');
  const sched = app.model.hasOfficial ? `schedule published (${app.model.officialCount} timed)` : 'dates & rooms not published yet';
  let src, ok = true;
  if (app.live) src = `Live from the Ignite site · ${relTime(app.live.at)}`;
  else if (CUSTOM_DATA) src = 'Test data';
  else { src = `Synced ${relTime(meta.lastChecked)}`; ok = meta.ok !== false; }
  el.innerHTML = `<span class="dot${ok ? '' : ' err'}"></span>${esc(src)} · ${app.model.sessions.length} sessions · ${esc(sched)}`;
  el.title = [app.live ? `Live check ${app.live.at}${app.live.same ? ' (matches the last sync)' : ' (newer than the last sync)'}` : '',
    app.liveError ? `Live check failed: ${app.liveError}` : '',
    `Cloud sync ${meta.lastChecked || '?'}${meta.error ? ` (${meta.error})` : ''}`].filter(Boolean).join(' · ');
}

function renderBadges() {
  const plan = app.model ? computePlan() : null;
  const open = plan ? plan.decisions.filter(d => !d.resolved).length : 0;
  const bp = $('#badge-plan');
  bp.hidden = !open; bp.textContent = open;
  bp.title = `${open} decision(s) to make`;
  const batches = app.raw?.changes?.batches || [];
  const seen = store.get().seenBatch;
  const unseen = batches.filter(b => !seen || b.at > seen).length;
  const n = app.alerts.length || unseen;
  const bc = $('#badge-changes');
  bc.hidden = !n; bc.textContent = n > 99 ? '99+' : n;
  bc.title = app.alerts.length ? `${app.alerts.length} of your sessions changed` : `${unseen} new catalog update(s)`;
}

// ---------------------------------------------------------------- browse

function filtersState() {
  const f = store.get().ui.filters || {};
  return { q: '', topics: [], types: [], levels: [], audience: [], days: [], buildings: [], inPerson: false, notRecorded: false, unrated: false, mine: false, fresh: false, sort: 'smart', ...f };
}

function applyFilters(f, { forTriage = false } = {}) {
  const toks = (f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const set = a => (a && a.length ? new Set(a.map(String)) : null);
  const topics = set(f.topics), types = set(f.types), levels = set(f.levels), aud = set(f.audience), days = set(f.days), blds = set(f.buildings);
  const out = [];
  for (const s of app.model.sessions) {
    const p = prioOf(s);
    if (forTriage && p != null) continue;
    if (f.inPerson && !s.inPerson) continue;
    if (store.settings().hideOnline && s.onlineOnly) continue;
    if (f.notRecorded && s.recorded !== false) continue;
    if (f.unrated && p != null) continue;
    if (f.mine && !(p > 0)) continue;
    if (f.fresh && !isNew(s)) continue;
    if (topics && !(s.topics || []).some(t => topics.has(t))) continue;
    if (types && !types.has(s.type)) continue;
    if (levels && !levels.has(String(s.level))) continue;
    if (aud && !(s.audience || []).some(t => aud.has(t))) continue;
    if (days && !days.has(s.day || 'tba')) continue;
    if (blds && !blds.has(s.loc.building)) continue;
    if (toks.length && !toks.every(t => s.hay.includes(t))) continue;
    out.push(s);
  }
  const byTime = (a, b) => (a.day || '9') < (b.day || '9') ? -1 : (a.day || '9') > (b.day || '9') ? 1 : (a.startMin ?? 1e9) - (b.startMin ?? 1e9) || a.code.localeCompare(b.code);
  let sort = f.sort;
  if (sort === 'smart') sort = toks.length ? 'relevance' : app.model.mode !== 'unscheduled' ? 'time' : 'code';
  if (sort === 'relevance') {
    const score = s => {
      let sc = 0; const t = s.title.toLowerCase();
      for (const k of toks) { if (s.code.toLowerCase() === k) sc += 100; if (t.includes(k)) sc += 10; }
      return sc;
    };
    out.sort((a, b) => score(b) - score(a) || a.code.localeCompare(b.code));
  } else if (sort === 'time') out.sort(byTime);
  else if (sort === 'title') out.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'priority') out.sort((a, b) => (prioOf(b) ?? -1) - (prioOf(a) ?? -1) || byTime(a, b));
  else out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
}

function facetBox(name, label, entries, selected, fmt = v => v) {
  const sel = new Set((selected || []).map(String));
  return `<fieldset><legend>${esc(label)}</legend><div class="scroll">${entries.map(([v, n]) =>
    `<label><input type="checkbox" data-facet="${name}" value="${attr(v)}" ${sel.has(String(v)) ? 'checked' : ''}> ${esc(fmt(v))}<span class="n">${n}</span></label>`).join('')}</div></fieldset>`;
}

function renderBrowse() {
  const f = filtersState();
  const results = applyFilters(f);
  const fc = app.model.facets;
  const sortDesc = m => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const levelName = { 100: '100 Foundational', 200: '200 Intermediate', 300: '300 Advanced', 400: '400 Expert' };
  const activeCount = ['topics', 'types', 'levels', 'audience', 'days', 'buildings'].reduce((a, k) => a + (f[k]?.length || 0), 0);
  const quick = [['inPerson', 'In person'], ['notRecorded', 'Not recorded'], ['unrated', 'Not rated yet'], ['mine', 'My picks'], ['fresh', 'New this week']];
  const dayEntries = app.model.days.map(d => [d, app.model.sessions.filter(s => s.day === d).length]);
  const bldEntries = [...BUILDINGS, BUILDING.U].map(b => [b.id, app.model.sessions.filter(s => s.loc.building === b.id).length]).filter(e => e[1]);
  const chips = [];
  for (const k of ['topics', 'types', 'levels', 'audience', 'days', 'buildings']) for (const v of f[k] || []) {
    const label = k === 'levels' ? levelName[v] || v : k === 'days' ? (v === 'tba' ? 'Date TBA' : fmtDay(v)) : k === 'buildings' ? (BUILDING[v]?.name || v) : v;
    chips.push(`<button type="button" class="chip removable" data-act="unfacet" data-k="${k}" data-v="${attr(v)}">${esc(label)} ${icon('x')}</button>`);
  }
  const shown = results.slice(0, app.browseLimit);
  return `${installBanner()}
  <div class="searchbar">
    <label class="search">${icon('search')}<span class="sr-only">Search sessions</span>
      <input id="q" type="search" placeholder="Search titles, speakers, tags, codes…" value="${attr(f.q)}" autocomplete="off" enterkeyhint="search"></label>
  </div>
  <div class="quick" role="group" aria-label="Quick filters">
    ${quick.map(([k, l]) => `<button type="button" class="chip btn-chip" data-act="quick" data-k="${k}" aria-pressed="${!!f[k]}">${l}</button>`).join('')}
  </div>
  <details class="filters" ${store.get().ui.filtersOpen ? 'open' : ''} id="filters">
    <summary>${icon('search')} More filters${activeCount ? ` (${activeCount})` : ''}</summary>
    <div class="filter-grid">
      ${facetBox('topics', 'Topic', sortDesc(fc.topics), f.topics)}
      ${facetBox('types', 'Session type', sortDesc(fc.types), f.types)}
      ${facetBox('levels', 'Level', [...fc.levels.entries()].sort((a, b) => a[0] - b[0]), f.levels, v => levelName[v] || v)}
      ${facetBox('audience', 'Audience', sortDesc(fc.audience), f.audience)}
      ${dayEntries.length ? facetBox('days', 'Day', [...dayEntries, ['tba', app.model.sessions.filter(s => !s.day).length]], f.days, v => (v === 'tba' ? 'Date TBA' : fmtDay(v))) : ''}
      ${app.model.mode !== 'unscheduled' ? facetBox('buildings', 'Building', bldEntries, f.buildings, v => BUILDING[v]?.name || v) : ''}
    </div>
  </details>
  ${chips.length ? `<div class="row" style="margin-bottom:8px">${chips.join('')}<button type="button" class="btn ghost small" data-act="clearfilters">Clear all</button></div>` : ''}
  <div class="result-meta">
    <span><b>${results.length}</b> of ${app.model.sessions.length} sessions</span>
    <span class="spacer"></span>
    <label>Sort <select id="sort">
      ${[['smart', 'Best match'], ['time', 'Time'], ['code', 'Code'], ['title', 'Title'], ['priority', 'My priority']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    ${results.length ? `<a class="btn small" href="#/triage">${icon('cards')}Triage these</a>` : ''}
  </div>
  <div class="list" id="results">
    ${shown.map(s => sessionCard(s, { p: prioOf(s), isNew: isNew(s) })).join('') || `<div class="empty"><h3>No sessions match</h3><p>Try fewer filters or a different search.</p></div>`}
  </div>
  ${results.length > shown.length ? `<div class="more"><button type="button" class="btn" data-act="more">Show ${Math.min(PAGE, results.length - shown.length)} more</button></div>` : ''}`;
}

function setFilters(patch, rerender = true) {
  store.setUI({ filters: { ...filtersState(), ...patch } });
  app.browseLimit = PAGE;
  app.triage = null;
  if (rerender) render();
}

// ---------------------------------------------------------------- triage

function triageQueue() {
  if (app.triage) return app.triage;
  const seenGroups = new Set();
  const queue = [];
  for (const s of applyFilters(filtersState(), { forTriage: true })) {
    if (seenGroups.has(s.group)) continue;
    seenGroups.add(s.group);
    queue.push(s.key);
  }
  app.triage = { queue, idx: 0, history: [] };
  return app.triage;
}

function renderTriage() {
  const t = triageQueue();
  const f = filtersState();
  const rated = Object.values(store.get().picks).filter(p => p.p != null).length;
  const activeFilters = ['topics', 'types', 'levels', 'audience', 'days', 'buildings'].some(k => f[k]?.length) || f.q || f.inPerson || f.notRecorded || f.fresh;
  const head = `<h1>Triage</h1>
    <p class="lede">Rate sessions one at a time to get through the catalog quickly. ${activeFilters ? `Using your Browse filters (<a href="#/browse">change</a>).` : `Tip: narrow it first in <a href="#/browse">Browse</a> (e.g. by topic), then come back.`}</p>`;
  if (t.idx >= t.queue.length) {
    return `${head}<div class="panel empty"><h3>All caught up</h3><p>${t.queue.length ? `You rated ${t.history.length} session(s) this round.` : 'Nothing unrated matches your filters.'} You've rated ${rated} sessions in total.</p>
      <div class="row" style="justify-content:center">${t.history.length ? `<button class="btn" data-act="t-undo">Undo last</button>` : ''}<a class="btn primary" href="#/plan">See my plan</a></div></div>`;
  }
  const s = app.model.byKey.get(t.queue[t.idx]);
  const pct = Math.round((t.idx / t.queue.length) * 100);
  const sp = speakersLine(s, 8);
  return `${head}
  <div class="triage">
    <div class="row small muted"><span>${t.idx + 1} of ${t.queue.length}</span><span class="spacer"></span><span>${rated} rated overall</span></div>
    <div class="progress" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <article class="card t-card">
      <div class="row small muted"><span class="code" style="font-family:var(--mono);font-weight:600">${esc(s.code)}</span>·${esc(s.type)}${s.level ? ` · ${s.level}` : ''}${s.dur ? ` · ${fmtDuration(s.dur)}` : ''} ${isNew(s) ? '<span class="chip new">New</span>' : ''}</div>
      <h2>${esc(s.title)}</h2>
      <div class="row">${s.timeSource === 'preview' ? '<span class="chip preview">Preview</span>' : ''}<span class="small">${esc(whenText(s))}</span>${!s.onlineOnly && s.day ? bldgChip(s.loc) : ''}${recChip(s)}</div>
      <p class="desc">${esc(s.desc)}</p>
      ${sp ? `<p class="small muted">${sp}</p>` : ''}
      <div class="row">${(s.topics || []).map(x => `<span class="chip">${esc(x)}</span>`).join('')}${(s.tags || []).slice(0, 6).map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>
    </article>
    <div class="t-actions">
      <button class="p-3" data-act="t-rate" data-p="3">Must<kbd>1</kbd></button>
      <button class="p-2" data-act="t-rate" data-p="2">Want<kbd>2</kbd></button>
      <button class="p-1" data-act="t-rate" data-p="1">Maybe<kbd>3</kbd></button>
      <button class="p-0" data-act="t-rate" data-p="0">Skip<kbd>0</kbd></button>
    </div>
    <div class="t-sub">
      <button class="btn small" data-act="t-undo" ${t.history.length ? '' : 'disabled'}>Undo <kbd>U</kbd></button>
      <button class="btn small" data-act="t-later">Decide later <kbd>→</kbd></button>
      <button class="btn small" data-act="open" data-key="${attr(s.key)}">Details</button>
    </div>
  </div>`;
}

function triageRate(p) {
  const t = triageQueue();
  const s = app.model.byKey.get(t.queue[t.idx]);
  if (!s) return;
  const id = pickIdFor(s);
  t.history.push({ id, prev: store.pick(id) ? { ...store.pick(id) } : null, idx: t.idx });
  t.idx++;
  store.setPriority(id, p);
}
function triageUndo() {
  const t = triageQueue();
  const h = t.history.pop();
  if (!h) return;
  t.idx = h.idx;
  if (h.prev) store.setPriority(h.id, h.prev.p); else store.setPriority(h.id, null);
}

// ---------------------------------------------------------------- plan

function renderPlan() {
  const plan = computePlan();
  const m = app.model;
  const picks = Object.entries(store.get().picks).filter(([id, p]) => p.p > 0 && m.byId.has(id)).length;
  if (!picks) {
    return `<h1>My plan</h1>${installBanner()}${missingPicksBanner()}
    <div class="panel empty"><h3>No picks yet</h3><p>Rate sessions as <b>Must</b>, <b>Want</b> or <b>Maybe</b> in Browse or Triage. Your plan builds itself from those ratings, using real walking times between buildings.</p>
    <div class="row" style="justify-content:center"><a class="btn primary" href="#/triage">${icon('cards')}Start triage</a><a class="btn" href="#/browse">Browse sessions</a></div></div>`;
  }
  if (m.mode === 'unscheduled') return renderShortlist(plan);
  return renderSchedule(plan);
}

function previewBanner() {
  return app.model.mode === 'preview'
    ? `<div class="banner warn">${icon('warn')}<div><b>Preview: days and rooms are simulated</b>
      <p>Rehearse with this until Microsoft publishes the real schedule. Your ratings carry over.</p>
      <button class="btn small" data-act="preview-off">Turn off preview</button></div></div>`
    : '';
}

const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

// iPhone: a Home Screen app has its own storage (and Safari may wipe site data after 7 days
// without a visit), so nudge people to install before they invest time rating sessions.
function installBanner() {
  if (!IS_IOS || STANDALONE || store.get().ui.installDismissed) return '';
  return `<div class="banner install">${icon('plan')}<div><b>Add to your Home Screen first</b>
    <p>Tap <b>Share → Add to Home Screen</b>. The installed app keeps its own copy of your picks and works offline.</p>
    <details><summary class="small">Already rated some in Safari?</summary><p class="small">Here: Settings → <b>Copy link to my picks</b>. In the installed app: Settings → <b>Import picks from a link</b>.</p></details></div>
    <button class="btn ghost small x" data-act="install-dismiss" aria-label="Dismiss">${icon('x')}</button></div>`;
}

function missingPicksBanner() {
  const known = store.get().known;
  const gone = Object.entries(store.get().picks).filter(([id, p]) => p.p > 0 && !app.model.byId.has(id));
  if (!gone.length) return '';
  const names = gone.map(([id]) => known[id] ? `${known[id].code} ${known[id].title}` : null).filter(Boolean);
  return `<div class="banner bad">${icon('warn')}<div><b>${gone.length} of your picks ${gone.length === 1 ? 'is' : 'are'} no longer in the catalog</b>
    <p>${names.length ? esc(names.slice(0, 6).join(' · ')) + (names.length > 6 ? ` +${names.length - 6} more` : '') : 'Microsoft removed or renamed them.'} Check <a href="#/changes">Changes</a> or search for a replacement.</p>
    <button class="btn small" data-act="forget-missing">Remove them from my picks</button></div></div>`;
}

function renderShortlist(plan) {
  const meta = app.raw.meta || {};
  const groups = [3, 2, 1].map(p => {
    const list = plan.tba.filter(x => x.priority === p).map(x => x.s)
      .sort((a, b) => (a.recorded === false ? 0 : 1) - (b.recorded === false ? 0 : 1) || a.code.localeCompare(b.code));
    return { p, list };
  });
  const minutes = plan.tba.reduce((a, x) => a + (x.s.dur || 0), 0);
  const notRec = plan.tba.filter(x => x.s.recorded === false && x.priority >= 2).length;
  const rec = plan.tba.filter(x => x.s.recorded === true).length;
  return `<h1>My plan</h1>${installBanner()}${missingPicksBanner()}${rsvpBanner(plan)}
  <div class="banner">${icon('clock')}<div><b>Waiting for Microsoft to publish dates and rooms.</b>
    <p>The catalog is checked automatically (last checked ${esc(relTime(meta.lastChecked))}). Once times appear, your plan builds itself. It flags sessions you can't reach in time and suggests what to give up. Want to try it now?</p>
    <button class="btn small" data-act="preview-on">Rehearse with a simulated schedule</button></div></div>
  <div class="stats">
    <div class="stat"><b>${plan.groupCount}</b><span>sessions picked</span></div>
    <div class="stat"><b>${fmtDuration(minutes) || '0 min'}</b><span>of content picked (about ${Math.round(minutes / 60 / 7 * 10) / 10} days)</span></div>
    <div class="stat"><b>${notRec}</b><span>Must/Want <b>not recorded</b> (in person only)</span></div>
    <div class="stat"><b>${rec}</b><span>picks you could watch later</span></div>
  </div>
  ${groups.map(g => g.list.length ? `<section class="prio-group"><h2>${prioPill(g.p)} ${g.list.length} session${g.list.length > 1 ? 's' : ''}</h2>
    <div class="list">${g.list.map(s => sessionCard(s, { p: g.p, compact: true })).join('')}</div></section>` : '').join('')}
  ${plan.online.length ? `<section><h2>Online / on demand</h2><div class="list">${plan.online.map(x => sessionCard(x.s, { p: x.priority, compact: true })).join('')}</div></section>` : ''}`;
}

function dayCounts(plan) {
  const out = {};
  for (const d of app.model.days) {
    const chosen = (plan.res.plan[d] || []).length;
    const open = plan.decisions.filter(x => x.day === d && !x.resolved).length;
    out[d] = { chosen, open };
  }
  return out;
}

function renderSchedule(plan) {
  const m = app.model;
  const ui = store.get().ui;
  const counts = dayCounts(plan);
  let day = ui.day && m.days.includes(ui.day) ? ui.day : null;
  if (!day) day = m.days.find(d => counts[d].chosen || counts[d].open) || m.days[0];
  const c = ctx();
  const dayPlan = plan.res.plan[day] || [];
  const trans = transitions(dayPlan, c);
  const decisions = plan.decisions.filter(d => d.day === day);
  const dropped = plan.res.dropped.filter(d => d.item.day === day && d.reason.kind !== 'repeat');
  const totalChosen = Object.values(plan.res.plan).flat().length;
  const tight = Object.values(plan.res.plan).reduce((a, dp) => a + transitions(dp, c).filter(t => t.status === 'tight').length, 0);
  const openDecisions = plan.decisions.filter(d => !d.resolved).length;
  const sacrificed = plan.res.dropped.filter(d => d.reason.kind !== 'repeat').length;

  const parts = [];
  parts.push(`<h1>My plan</h1>${installBanner()}${previewBanner()}${missingPicksBanner()}${rsvpBanner(plan)}`);
  if (plan.res.lockedConflicts.length) {
    parts.push(`<div class="banner bad">${icon('warn')}<div><b>Some sessions you locked can't all be attended.</b><p>${plan.res.lockedConflicts.map(x => esc(x.code)).join(', ')} clash with other locked sessions. Unlock one of them.</p></div></div>`);
  }
  parts.push(`<div class="stats">
    <div class="stat"><b>${totalChosen}</b><span>sessions in your plan</span></div>
    <div class="stat ${openDecisions ? 'warn' : ''}"><b>${openDecisions}</b><span>clashes to decide</span></div>
    <div class="stat ${tight ? 'warn' : ''}"><b>${tight}</b><span>tight transfers</span></div>
    <div class="stat"><b>${sacrificed}</b><span>picks you'll miss</span></div>
  </div>
  <div class="daytabs" role="group" aria-label="Day">${m.days.map(d => `<button type="button" data-act="day" data-day="${d}" aria-pressed="${d === day}">${esc(fmtDay(d))}<span class="n">${counts[d].chosen}</span>${counts[d].open ? `<span class="w">●</span>` : ''}</button>`).join('')}</div>`);

  if (decisions.length) {
    parts.push(`<h2>Clashes on ${esc(fmtDay(day, true))}</h2>`);
    for (const d of decisions) parts.push(renderDecision(d, plan, c));
  }

  parts.push(`<h2>Your day</h2>`);
  if (!dayPlan.length) {
    parts.push(`<div class="panel empty"><h3>Nothing planned on ${esc(fmtDay(day))}</h3><p>Here's what fits best given your interests.</p></div>`);
    parts.push(renderFillers(day, [], c));
  } else {
    const rows = [];
    dayPlan.forEach((x, i) => {
      if (i > 0) {
        const t = trans[i - 1];
        rows.push(renderMove(t, c));
        const free = t.gap - t.need;
        if (free >= 25) rows.push(renderFree(day, t.from, t.to, free, c));
      }
      rows.push(`<div class="t-item"><div class="t-time">${fmtTime(x.startMin)}<small>${fmtTime(x.endMin)}</small></div>
        ${sessionCard(x.s, { p: x.priority, compact: true, extra: lockRow(x) })}</div>`);
    });
    parts.push(`<div class="timeline">${rows.join('')}</div>`);
    parts.push(`<details class="panel" style="margin-top:14px" ${app.openFill === day + ':all' ? 'open' : ''} data-fill="${day}:all"><summary><b>More sessions that fit around this day</b></summary>${renderFillers(day, dayPlan, c)}</details>`);
  }

  const moved = plan.res.dropped.filter(d => d.item.day === day && d.reason.kind === 'repeat');
  if (moved.length) {
    const all = Object.values(plan.res.plan).flat();
    parts.push(`<div class="panel small" style="margin-top:14px"><b>Moved to a repeat:</b> ${moved.map(d => {
      const to = all.find(x => x.id === d.item.id);
      return to ? `${esc(d.item.code)} clashes here, so you'll catch <a href="#/plan" data-act="day" data-day="${to.day}">${esc(to.code)} on ${esc(fmtDay(to.day))} at ${fmtTime(to.startMin)}</a>` : esc(d.item.code);
    }).join(' · ')}</div>`);
  }
  if (dropped.length) {
    parts.push(`<h2>What you'll miss on ${esc(fmtDay(day))}</h2><p class="lede small">These picks don't fit. Recorded ones can be watched later. Tap <b>Go to this instead</b> to swap one in and the plan will reshuffle.</p>
    <div class="list sacrifices">${dropped.sort((a, b) => b.item.priority - a.item.priority || a.item.startMin - b.item.startMin).map(d => sessionCard(d.item.s, {
      p: d.item.priority, compact: true,
      extra: `<div class="reason">${icon('x')}<span>${esc(d.reason.text)}${d.item.recorded ? ' · <b>recorded: watch later</b>' : d.item.recorded === false ? ' · not recorded' : ''}</span></div>
        <div class="row" style="margin-top:8px"><button class="btn small" data-act="lock" data-pick="${attr(d.item.pickId)}" data-key="${attr(d.item.key)}">${icon('lock')}Go to this instead</button></div>`,
    })).join('')}</div>`);
  }
  if (plan.tba.length) {
    parts.push(`<h2>Picks without a time yet</h2><div class="list">${plan.tba.map(x => sessionCard(x.s, { p: x.priority, compact: true })).join('')}</div>`);
  }
  if (plan.online.length) {
    parts.push(`<h2>Online / on demand</h2><div class="list">${plan.online.map(x => sessionCard(x.s, { p: x.priority, compact: true })).join('')}</div>`);
  }
  parts.push(`<div class="row" style="margin-top:18px">
    <button class="btn" data-act="ics">${icon('plan')}Add plan to calendar (.ics)</button>
    <button class="btn ghost" data-act="unlock-all">Clear all locks</button></div>
    <p class="legend" style="margin-top:12px">Walking estimates use your Settings (buffer ${c.buffer} min, accept missing up to ${c.tolerance} min).
    ${[...BUILDINGS].filter(b => b.id !== 'O').map(b => `<span>${bldgChip({ building: b.id })} ${esc(b.name)}</span>`).join('')}</p>`);
  return parts.join('');
}

function lockRow(x) {
  return `<div class="row" style="margin-top:8px">${x.locked
    ? `<button class="btn small" data-act="unlock" data-pick="${attr(x.pickId)}">${icon('lock')}Locked, tap to unlock</button>`
    : `<button class="btn small ghost" data-act="lock" data-pick="${attr(x.pickId)}" data-key="${attr(x.key)}">${icon('lock')}Lock in</button>`}</div>`;
}

function renderMove(t, c) {
  const to = BUILDING[t.to.loc.building]?.short || 'TBA';
  let text;
  if (t.status === 'ok') {
    text = t.walk === 0 ? `Same room · ${t.gap} min break` : `${t.walk} min walk to ${esc(to)} · ${Math.max(0, t.slack)} min to spare`;
  } else if (t.status === 'tight') {
    text = `<b>Tight:</b> ${t.walk} min walk + ${c.buffer} min buffer, ${t.gap} min gap. Leave ${t.miss} min early or arrive late`;
  } else {
    text = `<b>Can't make it:</b> ${t.walk} min walk, ${t.gap} min gap`;
  }
  return `<div class="t-move ${t.status}"><div></div><div class="line">${icon(t.status === 'ok' ? 'walk' : 'warn')}<span>${text}</span></div></div>`;
}

function renderFree(day, from, to, free, c) {
  const id = `${day}:${from.key}`;
  const open = app.openFill === id;
  return `<div class="t-free"><div></div><div class="line">Free ${fmtTime(from.endMin)}–${fmtTime(to.startMin)}
    <button class="btn small ghost" data-act="fill" data-fill="${attr(id)}">${open ? 'Hide' : 'What fits?'}</button>
    ${open ? renderFillers(day, [from, to], c) : ''}</div></div>`;
}

function renderFillers(day, around, c) {
  const prof = interestProfile();
  const cands = app.model.sessions
    .filter(s => s.day === day && s.inPerson && Number.isFinite(s.startMin))
    .filter(s => { const p = prioOf(s); return p == null || (p > 0 && !app.plan.chosen.has(s.key) && !app.plan.chosenGroups.has(s.group)); })
    .map(s => ({ key: s.key, id: s.group, code: s.code, day: s.day, startMin: s.startMin, endMin: s.endMin, loc: s.loc, s }));
  let fit = fillers(around, cands, c);
  if (around.length === 2) fit = fit.filter(x => x.startMin >= around[0].endMin && x.endMin <= around[1].startMin);
  fit.sort((a, b) => interest(b.s, prof) - interest(a.s, prof) || a.startMin - b.startMin);
  const top = fit.slice(0, 8);
  if (!top.length) return `<p class="small muted" style="margin:8px 0">Nothing else fits${around.length ? ' without breaking your plan' : ''}.</p>`;
  return `<div class="list" style="margin:8px 0">${top.map(x => sessionCard(x.s, { p: prioOf(x.s), compact: true })).join('')}</div>
    ${fit.length > top.length ? `<p class="small muted">${fit.length - top.length} more fit. Filter Browse by this day to see them.</p>` : ''}`;
}

// Why y can't fit around the chosen chain: grouped by the session that blocks it.
function missSummary(missed, chain, c) {
  const overlapBy = new Map(), walks = [], other = [];
  for (const y of missed) {
    const z = chain.find(z => !canBoth(z, y, c));
    if (!z) other.push(y.code);
    else if (overlaps(z, y)) { if (!overlapBy.has(z.code)) overlapBy.set(z.code, []); overlapBy.get(z.code).push(y.code); }
    else {
      const [a, b] = z.startMin <= y.startMin ? [z, y] : [y, z];
      const t = transition(a, b, c);
      walks.push(`${y.code} (${t.walk} min walk ${BUILDING[a.loc.building]?.short || '?'} → ${BUILDING[b.loc.building]?.short || '?'}, ${Math.max(0, t.gap)} min gap)`);
    }
  }
  const parts = [...[...overlapBy].map(([by, codes]) => `${codes.join(', ')} (same time as ${by})`), ...walks];
  if (other.length) parts.push(`${other.join(', ')} (lower value)`);
  return parts.join(' · ');
}

function renderDecision(d, plan, c) {
  const dayItems = plan.contested.filter(x => x.day === d.day);
  const release = new Set(d.items.map(o => o.key));
  const outcome = new Map(d.items.map(x => [x.key, whatIf(dayItems, x.key, release, c)]));
  const feasibleVals = d.items.map(x => outcome.get(x.key)).filter(o => o.feasible).map(o => o.value);
  const best = feasibleVals.length ? Math.max(...feasibleVals) : 0;
  const isBest = x => outcome.get(x.key).feasible && outcome.get(x.key).value >= best - 0.5;
  const ties = d.items.filter(isBest).length;
  const decided = d.items.find(x => x.locked);
  // Best outcome first so the decision can be made at a glance.
  const opts = d.items.slice().sort((a, b) => (b.locked - a.locked) || (outcome.get(b.key).value - outcome.get(a.key).value) || a.startMin - b.startMin);
  const row = x => {
    const o = outcome.get(x.key);
    const inChain = new Set(o.chosen.map(y => y.key));
    const also = d.items.filter(y => y !== x && inChain.has(y.key));
    const miss = d.items.filter(y => y !== x && !inChain.has(y.key));
    const top = isBest(x);
    const label = x.locked ? 'Your choice' : decided ? '' : top ? (ties > 1 ? 'Toss-up: your call' : 'Best for your day') : '';
    const w = weigh(x, c);
    const repeat = (app.model.byGroup.get(x.s.group) || []).filter(r => r.key !== x.key && r.day);
    const diff = Math.round(best - o.value);
    return `<div class="option ${(x.locked || (!decided && top)) ? 'rec' : ''}">
      <div>
        ${label ? `<div class="tag-rec">${esc(label)}</div>` : ''}
        <div class="row small"><b>${fmtTime(x.startMin)}–${fmtTime(x.endMin)}</b>${prioPill(x.priority)}${bldgChip(x.loc)}${recChip(x)}</div>
        <a class="title" href="#/session/${encodeURIComponent(x.code)}" data-act="open" data-key="${attr(x.key)}" style="font-weight:700;display:block;margin:4px 0;color:var(--text);text-decoration:none">${esc(x.code)} · ${esc(x.title)}</a>
        <div class="why">${w.why.map(esc).join(' · ')}</div>
        ${!o.feasible ? `<div class="lose">Not possible with the sessions you've locked</div>` : `
        ${also.length ? `<div class="why">${icon('check')} Then you also make ${esc(also.map(y => y.code).join(', '))}</div>` : ''}
        ${miss.length ? `<div class="lose">You'd miss ${esc(missSummary(miss, o.chosen, c))}</div>` : ''}
        <div class="why">Day value ${Math.round(o.value)}${diff > 0 ? ` (${diff} less than the best option)` : ''}</div>`}
        ${repeat.length ? `<div class="why">Also runs ${repeat.map(r => `${r.code} ${fmtDay(r.day)} ${fmtTime(r.startMin)}`).map(esc).join(', ')}</div>` : ''}
      </div>
      <div class="btns">
        ${x.locked ? `<button class="btn small" data-act="unlock" data-pick="${attr(x.pickId)}">Undo choice</button>`
          : `<button class="btn small ${!decided && top && ties === 1 ? 'primary' : ''}" data-act="lock" data-pick="${attr(x.pickId)}" data-key="${attr(x.key)}" ${o.feasible ? '' : 'disabled'}>${icon('check')}Go to this</button>`}
        <button class="btn small ghost" data-act="prio" data-id="${attr(x.pickId)}" data-p="0" title="Mark as Skip">Not going</button>
      </div>
    </div>`;
  };
  const SHOW = 3;
  return `<section class="decision" aria-label="Clash">
    <header>${icon('warn')}${fmtTime(d.start)}–${fmtTime(d.end)} · ${opts.length} picks clash <span class="muted">${decided ? `· decided: ${esc(decided.code)}` : ties > 1 ? '· equally good options' : '· best option first'}</span></header>
    <div class="options">${opts.slice(0, SHOW).map(row).join('')}
      ${opts.length > SHOW ? `<details class="more-opts"><summary>${opts.length - SHOW} more option${opts.length - SHOW > 1 ? 's' : ''}</summary>${opts.slice(SHOW).map(row).join('')}</details>` : ''}</div></section>`;
}

// ---------------------------------------------------------------- now

function renderNow() {
  const s = store.settings();
  const t = nowLocal(s.simNow);
  const plan = computePlan();
  const c = ctx();
  const m = app.model;
  const days = m.days.length ? m.days : EVENT.days;
  const sim = `<div class="panel" style="margin-top:14px"><h3>Rehearse a moment</h3>
    <p class="small muted">Pick a day and time to see what this screen will tell you at the conference.</p>
    <div class="sim"><select id="sim-day">${days.map(d => `<option value="${d}" ${s.simNow?.day === d ? 'selected' : ''}>${esc(fmtDay(d))}</option>`).join('')}</select>
    <input id="sim-time" type="time" value="${s.simNow ? `${String(Math.floor(s.simNow.min / 60)).padStart(2, '0')}:${String(s.simNow.min % 60).padStart(2, '0')}` : '10:00'}">
    <button class="btn small" data-act="sim">Simulate</button>${s.simNow ? `<button class="btn small ghost" data-act="sim-off">Use real time</button>` : ''}</div></div>`;
  const clock = `<div class="row"><div class="big-time">${fmtTime(t.min)}</div><div class="muted">${esc(fmtDay(t.day, true))}${s.simNow ? ' · <span class="chip preview">Simulated</span>' : ' · Pacific time'}</div></div>`;
  if (m.mode === 'unscheduled') {
    return `<h1>Now</h1>${clock}<div class="panel empty"><h3>Available once the schedule is out</h3><p>At the conference this screen shows where you should be, when to leave, and what's starting nearby if a room is full. You can rehearse it with the simulated preview schedule.</p>
      <button class="btn primary" data-act="preview-on">Turn on preview</button></div>`;
  }
  const dayPlan = plan.res.plan[t.day] || [];
  const nn = nowNext(dayPlan, t.min, c);
  const parts = [`<h1>Now</h1>${previewBanner()}${clock}`];
  if (!m.days.includes(t.day)) {
    parts.push(`<div class="panel empty"><h3>No sessions today</h3><p>The conference runs ${esc(fmtDay(m.days[0]))} to ${esc(fmtDay(m.days[m.days.length - 1]))}.</p></div>`);
    parts.push(sim);
    return parts.join('');
  }
  const cards = [];
  if (nn.current) {
    cards.push(`<div class="card now-card"><div class="label">Now · until ${fmtTime(nn.current.endMin)}</div>${sessionCard(nn.current.s, { p: nn.current.priority, compact: true, noActions: true })}</div>`);
  }
  if (nn.next) {
    const left = nn.leaveBy - t.min;
    const cls = left < 0 ? 'late' : left <= 5 ? 'soon' : '';
    const msg = left < 0 ? `You should have left ${fmtDuration(-left)} ago (${nn.walk ?? '?'} min walk)` : `Leave by ${fmtTime(nn.leaveBy)}, ${left ? `in ${fmtDuration(left)}` : 'now'}${nn.walk != null ? ` · ${nn.walk} min walk` : ''}`;
    cards.push(`<div class="card now-card"><div class="label">Next · ${fmtTime(nn.next.startMin)} (in ${fmtDuration(nn.next.startMin - t.min)})</div>
      ${sessionCard(nn.next.s, { p: nn.next.priority, compact: true, noActions: true })}
      <div class="leave ${cls}">${icon('walk')}<span>${esc(msg)}</span></div></div>`);
  } else if (!nn.current) {
    cards.push(`<div class="panel"><h3>Nothing else planned today</h3><p class="muted">See what's starting soon on the right, or check tomorrow's plan.</p></div>`);
  }
  // Starting soon, ranked by priority, interest, then distance from where you are.
  const prof = interestProfile();
  const here = nn.current || nn.from;
  const soon = m.sessions
    .filter(x => x.day === t.day && x.inPerson && x.startMin >= t.min - 5 && x.startMin <= t.min + 45 && prioOf(x) !== 0)
    .map(x => ({ s: x, walk: here ? walkMinutes(here.loc, x.loc, c.walk) : null, p: prioOf(x) ?? 0, i: interest(x, prof) }))
    .sort((a, b) => b.p - a.p || b.i - a.i || (a.walk ?? 99) - (b.walk ?? 99))
    .slice(0, 10);
  const soonHtml = `<div><h2 style="margin-top:0">Starting soon nearby</h2><p class="small muted">Backups if a room is full, ranked by your priorities and interests, then distance.</p>
    <div class="list">${soon.map(x => sessionCard(x.s, { p: prioOf(x.s), compact: true, extra: x.walk != null ? `<div class="reason ok">${icon('walk')}<span>${x.walk} min walk · starts ${fmtTime(x.s.startMin)}</span></div>` : '' })).join('') || '<p class="muted">Nothing starting in the next 45 minutes.</p>'}</div></div>`;
  parts.push(`<div class="now-grid"><div class="stack">${cards.join('')}${sim}</div>${soonHtml}</div>`);
  return parts.join('');
}

// ---------------------------------------------------------------- changes

function fmtStamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

function rsvpBanner(plan) {
  const need = [...plan.items, ...plan.tba].filter(x => x.priority >= 2 && x.s.rsvp && (plan.chosen.has(x.key) || !plan.chosenGroups.has(x.id)));
  const groups = [...new Map(need.map(x => [x.id, x])).values()];
  if (!groups.length) return '';
  const opens = groups.map(x => x.s.rsvp).find(v => typeof v === 'string');
  const open = opens && new Date(opens).getTime() <= Date.now();
  const list = groups.map(x => `<a href="${attr(EVENT.sessionUrl(x.s))}" target="_blank" rel="noopener">${esc(x.code)}</a>`).join(', ');
  return `<div class="banner ${open ? 'warn' : ''}">${icon(open ? 'warn' : 'bell')}<div><b>${groups.length} of your Must/Want picks need an RSVP</b>
    <p>${open ? 'RSVPs are open now. Seats are limited: reserve on the Ignite site.' : opens ? `RSVPs open ${esc(fmtStamp(opens))} PT. Seats are limited.` : 'Seats are limited.'}</p>
    <details><summary class="small">Show which</summary><p class="small">${list}</p></details></div></div>`;
}

function fieldLabel(k) {
  return { start: 'Start', end: 'End', slot: 'Time slot', dur: 'Length', room: 'Room', title: 'Title', code: 'Code', type: 'Type', speakers: 'Speakers', level: 'Level', delivery: 'Format', recorded: 'Recorded', desc: 'Description' }[k] || k;
}
function fmtVal(k, v) {
  if (v == null || v === '') return '—';
  if ((k === 'start' || k === 'end') && typeof v === 'string') {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
      return p;
    }
  }
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}
function diffHtml(fields) {
  return Object.entries(fields).map(([k, v]) => v === true
    ? `${esc(fieldLabel(k))} updated`
    : `${esc(fieldLabel(k))}: <del>${esc(fmtVal(k, v[0]))}</del> → <ins>${esc(fmtVal(k, v[1]))}</ins>`).join('<br>');
}

function myGroups() {
  const set = new Set();
  for (const [id, pk] of Object.entries(store.get().picks)) {
    if (!(pk.p > 0)) continue;
    const s = sessionById(id);
    if (s) set.add(s.group);
  }
  return set;
}

function changeItems(b) {
  return [
    ...b.added.map(x => ({ ...x, k: 'Added' })),
    ...b.removed.map(x => ({ ...x, k: 'Removed' })),
    ...b.changed.map(x => ({ ...x, k: 'Changed' })),
  ];
}

function changeList(items, isMine) {
  return `<ul>${items.slice(0, 60).map(x => `<li class="${isMine(x) ? 'mine' : ''}"><span class="chip">${x.k}</span> <a href="#/session/${encodeURIComponent(x.code)}" data-act="open-code" data-code="${attr(x.code)}"><b>${esc(x.code)}</b></a> ${esc(x.title)}
    ${x.f ? `<div class="diff">${diffHtml(x.f)}</div>` : ''}</li>`).join('')}
    ${items.length > 60 ? `<li class="muted">…and ${items.length - 60} more</li>` : ''}</ul>`;
}

function flagsLine(flags) {
  if (!flags) return '';
  const on = (k, yes, no) => (flags[k] ? `<b style="color:var(--ok)">${yes}</b>` : no);
  return `Ignite site: ${on('showSessionTimeSlots', 'times shown', 'times hidden')} · ${on('showLocations', 'locations shown', 'locations hidden')} · ${on('enableMySchedule', 'schedule builder open', 'schedule builder off')}`;
}

function renderChanges() {
  const meta = app.raw.meta || {};
  const batches = app.raw.changes?.batches || [];
  const mine = myGroups();
  const onlyMine = !!store.get().ui.onlyMine;
  const isMine = x => { const s = app.model.byId.get(x.id)?.[0] || app.model.byCode.get(x.code); return s ? mine.has(s.group) : false; };
  const st = app.raw.doc.stats || meta.stats || {};
  const repo = store.settings().repo;
  const parts = [`<h1>Changes</h1><p class="lede">The app checks the Ignite site directly every few minutes while it's open. A scheduled cloud sync also logs every difference here and posts it to GitHub, which can email you. Changes to your picks are highlighted.</p>`];
  if (app.alerts.length) {
    parts.push(`<section class="card batch"><header><b>${icon('warn')} ${app.alerts.length} of your picks changed since you last looked</b><span class="spacer"></span><button class="btn small primary" data-act="ack">Got it</button></header><ul>
      ${app.alerts.map(a => `<li class="mine"><b>${esc(a.code)}</b> ${esc(a.title)}${a.kind === 'removed' ? ' <b style="color:var(--bad)">was removed from the catalog</b>' : `<div class="diff">${diffHtml(a.fields)}</div>`}</li>`).join('')}</ul></section>`);
  }
  const liveLine = CUSTOM_DATA ? 'Live check is off while viewing test data.'
    : app.live ? `Live check ${esc(relTime(app.live.at))}: ${app.live.same ? 'matches the last sync' : '<b>the Ignite site has changes newer than the last sync</b> (shown below)'}`
    : app.liveError ? `<span style="color:var(--bad)">Live check failed: ${esc(app.liveError)}</span>. Showing the synced copy.` : 'Live check running…';
  parts.push(`<div class="panel stack"><div class="row"><b>Sync status</b><span class="spacer"></span>
      <button class="btn small" data-act="refresh">${icon('refresh')}Check now</button>
      ${app.local ? `<button class="btn small" data-act="sync-local">${icon('refresh')}Re-sync &amp; log</button>` : ''}
      ${repo && !app.local ? `<a class="btn small ghost" href="https://github.com/${attr(repo)}/actions/workflows/sync.yml" target="_blank" rel="noopener">Cloud sync ${icon('ext')}</a>` : ''}</div>
    <div class="small muted">${liveLine}<br>
      Cloud sync last ran <b>${esc(relTime(meta.lastChecked))}</b>, last logged change ${esc(relTime(meta.lastChanged))}${meta.ok === false ? ` · <span style="color:var(--bad)">failed: ${esc(meta.error || 'unknown error')}</span>` : ''}<br>
      ${st.sessions ?? app.model.sessions.length} sessions · ${st.withDates ?? 0} with dates · ${st.withRooms ?? 0} with rooms${st.draftTimes ? ` · ${st.draftTimes} placeholder times ignored` : ''}<br>
      ${flagsLine(app.live?.flags || app.snapshot?.doc?.siteFlags || meta.siteFlags)}</div></div>`);
  if (app.live && !app.live.same) {
    const items = changeItems(app.live.diff).filter(x => !onlyMine || isMine(x));
    parts.push(`<section class="card batch" style="margin-top:14px"><header><b>Live on the Ignite site now</b><span class="muted small">not yet in the history log</span><span class="spacer"></span>
      <span class="small muted">+${app.live.diff.added.length} · −${app.live.diff.removed.length} · ~${app.live.diff.changed.length}</span></header>${changeList(items, isMine)}</section>`);
  }
  parts.push(`<div class="row" style="margin:16px 0 8px"><h2 style="margin:0">History</h2><span class="spacer"></span>
    <label class="toggle" style="padding:0"><input type="checkbox" id="only-mine" ${onlyMine ? 'checked' : ''}> <span>Only my picks</span></label></div>`);
  if (!batches.length) {
    parts.push(`<div class="panel empty"><h3>No changes logged yet</h3><p>The first sync took a baseline snapshot. When Microsoft adds, removes, retimes or moves sessions, the cloud sync logs it here. It also flags the moment dates and rooms are published.</p></div>`);
  }
  const seen = store.get().seenBatch;
  for (const b of batches.slice(0, 40)) {
    const items = changeItems(b).filter(x => !onlyMine || isMine(x));
    if (onlyMine && !items.length && !b.milestones.length) continue;
    const at = new Date(b.at);
    parts.push(`<section class="card batch">
      <header><b>${esc(at.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</b><span class="muted small">${esc(relTime(b.at))}</span>
        <span class="spacer"></span><span class="small muted">+${b.added.length} · −${b.removed.length} · ~${b.changed.length}</span>${!seen || b.at > seen ? '<span class="chip new">New</span>' : ''}</header>
      ${b.milestones.map(m => `<div class="milestone">${esc(m)}</div>`).join('')}
      ${changeList(items, isMine)}</section>`);
  }
  return parts.join('');
}

// ---------------------------------------------------------------- settings

function numField(path, label, value, hint = '', min = 0, max = 120) {
  return `<div class="field"><label for="f-${attr(path)}">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</label>
    <input id="f-${attr(path)}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" data-set="${attr(path)}" value="${attr(value)}"></div>`;
}

function renderSettings() {
  const s = store.settings();
  const ids = ['W', 'S', 'N', 'M', 'C', 'H'];
  const matrix = `<table class="matrix"><thead><tr><th></th>${ids.map(i => `<th title="${attr(BUILDING[i].name)}">${esc(BUILDING[i].short)}</th>`).join('')}</tr></thead><tbody>
    ${ids.map(a => `<tr><th>${esc(BUILDING[a].short)}</th>${ids.map(b => {
      if (a === b) return a === 'H' ? `<td><input type="number" min="0" max="90" data-set="walk.pairs.H|H" value="${attr(s.walk.pairs['H|H'])}" aria-label="Between off-site venues"></td>` : '<td class="na">—</td>';
      const key = [a, b].sort().join('|');
      if (ids.indexOf(b) < ids.indexOf(a)) return '<td class="na">·</td>';
      return `<td><input type="number" min="0" max="90" data-set="walk.pairs.${key}" value="${attr(s.walk.pairs[key] ?? s.walk.unknown)}" aria-label="${attr(BUILDING[a].name)} to ${attr(BUILDING[b].name)}"></td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
  const auto = app.model.locations.map(l => ({ l, auto: parseLocation(l, {}) }));
  const unknown = auto.filter(x => !x.auto.known || s.overrides[x.l]);
  const theme = document.documentElement.dataset.theme || 'auto';
  const ov = list => list.map(({ l, auto: a }) => `<div class="field"><label>${esc(l)}<small>detected: ${esc(BUILDING[a.building]?.name || 'unknown')}</small></label>
      <select data-override="${attr(l)}"><option value="">Auto</option>${[...BUILDINGS].map(b => `<option value="${b.id}" ${s.overrides[l] === b.id ? 'selected' : ''}>${esc(b.short)}</option>`).join('')}</select></div>`).join('');
  return `<h1>Settings</h1><p class="lede">Tune how the planner trades sessions off. Changes apply instantly and stay on this device.</p>
  <div class="settings-grid">
    <section class="panel"><h3>Getting between rooms</h3>
      ${numField('buffer', 'Buffer per move (min)', s.buffer, 'Finding the room, grabbing a seat')}
      ${numField('tolerance', 'OK to miss up to (min)', s.tolerance, 'Leave early or arrive late. Never more than ¼ of a session')}
      ${numField('walk.sameFloor', 'Same building, same floor', s.walk.sameFloor)}
      ${numField('walk.diffFloor', 'Same building, different floor', s.walk.diffFloor)}
      ${numField('walk.unknown', 'Room not known yet', s.walk.unknown)}
      <h3 style="margin-top:12px">Walking minutes between buildings</h3>
      ${matrix}
      <p class="small muted">Moscone North and South connect underground. West is across 4th St. The Marriott Marquis is a block north of West. Chase Center (keynote venue in 2025) is about a mile away, so allow for a shuttle.</p>
    </section>
    <section class="panel"><h3>How to break ties</h3>
      ${numField('weights.3', 'Points for a Must', s.weights[3], '', 0, 1000)}
      ${numField('weights.2', 'Points for a Want', s.weights[2], '', 0, 1000)}
      ${numField('weights.1', 'Points for a Maybe', s.weights[1], '', 0, 1000)}
      ${numField('weights.recordedPenalty', 'Recorded: “watch later” discount', s.weights.recordedPenalty, 'Higher = prefer things you can only see live', 0, 200)}
      ${numField('weights.notRecordedBonus', 'Not recorded: bonus', s.weights.notRecordedBonus, '', 0, 200)}
      ${numField('weights.handsOnBonus', 'Labs & table talks: bonus', s.weights.handsOnBonus, 'In-person only experiences', 0, 200)}
      ${numField('weights.tightPerMin', 'Cost per minute missed', s.weights.tightPerMin, 'For tight transfers', 0, 50)}
      <div class="row" style="margin-top:10px"><button class="btn small" data-act="reset-settings">Restore defaults</button></div>
    </section>
    <section class="panel"><h3>Display</h3>
      <label class="toggle"><input type="checkbox" data-toggle="preview" ${s.preview ? 'checked' : ''}><span>Preview with a simulated schedule<small>Only used until Microsoft publishes real dates and rooms. Clearly marked “Preview”.</small></span></label>
      <label class="toggle"><input type="checkbox" data-toggle="hideOnline" ${s.hideOnline ? 'checked' : ''}><span>Hide online-only sessions</span></label>
      <div class="field"><label for="theme">Theme</label><select id="theme">${['auto', 'light', 'dark'].map(t => `<option ${theme === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    </section>
    <section class="panel"><h3>Your data</h3>
      <p class="small muted">Picks live in this browser. Use a backup file or a share link to move them between laptop and phone.</p>
      <div class="row"><button class="btn small" data-act="export">Download backup</button>
        <label class="btn small">Restore backup<input type="file" accept="application/json,.json" id="import-file" hidden></label>
        <button class="btn small" data-act="share">Copy link to my picks</button></div>
      <div class="field" style="grid-template-columns:1fr auto;margin-top:10px"><label for="import-code">Import picks from a link<small>Paste a link copied on another device (e.g. Safari → Home Screen app)</small></label>
        <span></span></div>
      <div class="row"><input id="import-code" type="text" inputmode="url" autocomplete="off" placeholder="https://…#/import/…" style="flex:1;min-width:0;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--surface)">
        <button class="btn small" data-act="import-code">Import</button></div>
      <h3 style="margin-top:14px">Email alerts for your picks</h3>
      <p class="small muted">The cloud sync posts every catalog change as a GitHub issue comment (GitHub can email you). It stars changes to codes in <code>data/watchlist.json</code>. Copy your Must/Want list, then paste it into that file.</p>
      <div class="row"><button class="btn small" data-act="watchlist">Copy watchlist</button>
        ${s.repo ? `<a class="btn small ghost" target="_blank" rel="noopener" href="https://github.com/${attr(s.repo)}/edit/main/data/watchlist.json">Edit on GitHub ${icon('ext')}</a>` : ''}</div>
      <div class="row" style="margin-top:14px"><button class="btn small danger" data-act="reset-all">Erase all my picks</button></div>
    </section>
    ${app.model.locations.length ? `<section class="panel" style="grid-column:1/-1"><h3>Room → building</h3>
      <p class="small muted">${unknown.length ? `${unknown.length} location(s) couldn't be matched to a building automatically. Set them so walking times are right.` : 'All published locations were matched to a building automatically.'}</p>
      ${ov(unknown)}
      <details><summary class="small">All ${auto.length} locations</summary>${ov(auto.filter(x => !unknown.includes(x)))}</details></section>` : ''}
  </div>
  <p class="small muted" style="margin-top:20px">Unofficial personal tool, not affiliated with Microsoft. Session data comes from the public Ignite catalog feed and is re-checked automatically.</p>`;
}

// ---------------------------------------------------------------- detail dialog

function openDetail(key) {
  const s = app.model.byKey.get(key);
  if (!s) return;
  app.dialogKey = key;
  dialog.innerHTML = renderDetail(s);
  if (!dialog.open) dialog.showModal();
}

function renderDetail(s) {
  const p = prioOf(s);
  const pk = pickOf(s);
  const pid = pickIdFor(s);
  const plan = computePlan();
  const c = ctx();
  const insts = groupOf(s);
  const conflicts = [];
  if (s.day) {
    const me = { key: s.key, id: s.group, day: s.day, startMin: s.startMin, endMin: s.endMin, loc: s.loc };
    for (const x of Object.values(plan.res.plan).flat()) {
      if (x.id === s.group || x.day !== s.day) continue;
      if (!canBoth(me, x, c)) {
        const [a, b] = x.startMin <= me.startMin ? [x, me] : [me, x];
        const t = transition(a, b, c);
        conflicts.push(`${esc(x.code)} ${esc(x.title)} (${overlaps(x, me) ? 'overlaps' : `${t.walk} min walk, ${Math.max(0, t.gap)} min gap`})`);
      }
    }
  }
  const sp = s.speakers || [];
  return `<div class="d-head">
      <button class="btn ghost small d-close" data-act="close" aria-label="Close">${icon('x')}</button>
      <div class="row small muted"><span style="font-family:var(--mono);font-weight:600">${esc(s.code)}</span>·${esc(s.type)}${s.level ? ` · Level ${s.level}` : ''}${s.dur ? ` · ${fmtDuration(s.dur)}` : ''}</div>
      <h2 id="detail-title">${esc(s.title)}</h2>
      <div class="row">${prioControl(pid, p, true)}</div>
    </div>
    <div class="d-body">
      ${s.timeSource === 'preview' ? '<div class="banner warn">' + icon('warn') + '<div><b>Simulated time and room</b><p>Preview mode. The real schedule hasn\'t been published.</p></div></div>' : ''}
      <dl>
        <dt>When</dt><dd>${esc(whenText(s))}</dd>
        <dt>Where</dt><dd>${s.onlineOnly ? 'Online' : `${bldgChip(s.loc)} ${esc(s.roomLabel)}`}</dd>
        <dt>Recording</dt><dd>${s.recorded === true ? 'Will be recorded: you can watch it later' : s.recorded === false ? '<b>Not recorded</b>: in person only' : 'Unknown'}</dd>
        ${s.rsvp ? `<dt>RSVP</dt><dd><b>Required</b>, seats are limited${typeof s.rsvp === 'string' ? `. Opens ${esc(fmtStamp(s.rsvp))} PT on the Ignite site` : ''}</dd>` : ''}
        <dt>Format</dt><dd>${esc((s.delivery || []).join(', ') || '—')}</dd>
        ${s.audience?.length ? `<dt>Audience</dt><dd>${esc(s.audience.join(', '))}</dd>` : ''}
        ${s.topics?.length ? `<dt>Topics</dt><dd>${esc(s.topics.join(', '))}</dd>` : ''}
        ${s.tags?.length ? `<dt>Tags</dt><dd>${esc(s.tags.join(', '))}</dd>` : ''}
      </dl>
      ${conflicts.length ? `<div class="banner bad">${icon('warn')}<div><b>Clashes with your plan</b><p>${conflicts.join('<br>')}</p></div></div>` : ''}
      <p class="desc">${esc(s.desc)}</p>
      ${sp.length ? `<h3>Speakers</h3><div class="speakers">${sp.map(x => `<div class="speaker"><b>${esc(x[0])}</b> <span>${esc([x[2], x[1]].filter(Boolean).join(', '))}</span></div>`).join('')}</div>` : ''}
      ${insts.length > 1 ? `<h3>Runs ${insts.length} times</h3>${insts.map(o => `<div class="inst ${pk?.lock === o.key ? 'locked' : ''}"><b>${esc(o.code)}</b><span>${esc(whenText(o))}</span>${o.day ? bldgChip(o.loc) : ''}<span class="spacer"></span>
        ${pk?.lock === o.key ? `<button class="btn small" data-act="unlock" data-pick="${attr(pid)}">Unlock</button>` : o.day ? `<button class="btn small" data-act="lock" data-pick="${attr(pid)}" data-key="${attr(o.key)}">${icon('lock')}Attend this one</button>` : ''}</div>`).join('')}` : ''}
      ${insts.length === 1 && s.day && p > 0 ? `<div class="row">${pk?.lock === s.key ? `<button class="btn small" data-act="unlock" data-pick="${attr(pid)}">${icon('lock')}Locked, tap to unlock</button>` : `<button class="btn small" data-act="lock" data-pick="${attr(pid)}" data-key="${attr(s.key)}">${icon('lock')}Lock in (always keep in plan)</button>`}</div>` : ''}
      ${s.related?.length ? `<p class="small muted">Related: ${s.related.map(code => app.model.byCode.has(code) ? `<a href="#/session/${encodeURIComponent(code)}" data-act="open-code" data-code="${attr(code)}">${esc(code)}</a>` : esc(code)).join(', ')}</p>` : ''}
      <h3 style="margin-top:14px"><label for="note">My notes</label></h3>
      <textarea id="note" data-note="${attr(pid)}" placeholder="Questions to ask, why it matters…">${esc(pk?.note || '')}</textarea>
      <div class="row" style="margin-top:12px"><a class="btn small" href="${attr(EVENT.sessionUrl(s))}" target="_blank" rel="noopener">View on the Ignite site ${icon('ext')}</a></div>
    </div>`;
}

function refreshDetail() {
  if (dialog.open && app.dialogKey) {
    const s = app.model.byKey.get(app.dialogKey);
    if (!s) { dialog.close(); return; }
    const scroll = dialog.querySelector('.d-body')?.scrollTop || 0;
    const active = document.activeElement?.id === 'note';
    if (active) return; // don't clobber typing
    dialog.innerHTML = renderDetail(s);
    const body = dialog.querySelector('.d-body');
    if (body) body.scrollTop = scroll;
  }
}

// ---------------------------------------------------------------- ics

function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}
function icsDate(iso) { return iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/Z?$/, 'Z'); }

function exportIcs() {
  const plan = computePlan();
  const items = Object.values(plan.res.plan).flat().filter(x => x.s.timeSource === 'official' && x.s.start);
  if (!items.length) {
    toast(app.model.mode === 'preview' ? 'Preview times are simulated. Calendar export unlocks once the real schedule is published.' : 'Nothing with an official time in your plan yet');
    return;
  }
  const stamp = icsDate(new Date().toISOString());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ignite26-planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Ignite 2026 plan'];
  for (const x of items) {
    const s = x.s;
    lines.push('BEGIN:VEVENT', `UID:${s.inst}@ignite26-planner`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(s.start)}`,
      `DTEND:${icsDate(s.end || new Date(new Date(s.start).getTime() + (s.dur || 45) * 60000).toISOString())}`,
      `SUMMARY:${icsEscape(`[${s.code}] ${s.title}`)}`, `LOCATION:${icsEscape(s.room || '')}`,
      `DESCRIPTION:${icsEscape(`${PRIORITY[x.priority]} · ${s.recorded ? 'recorded' : s.recorded === false ? 'not recorded' : ''}\n${EVENT.sessionUrl(s)}\n\n${s.desc}`)}`,
      `URL:${EVENT.sessionUrl(s)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  shareOrDownload('ignite-2026-plan.ics', lines.map(icsFold).join('\r\n') + '\r\n', 'text/calendar')
    .then(r => { if (r !== 'cancelled') toast(`Exported ${items.length} sessions`); });
}

// ---------------------------------------------------------------- routing & render

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [tab, ...rest] = h.split('/');
  return { tab: tab || '', arg: rest.join('/') };
}

function render() {
  if (!app.model) return;
  clearInterval(app.nowTimer);
  const view = { browse: renderBrowse, triage: renderTriage, plan: renderPlan, now: renderNow, changes: renderChanges, settings: renderSettings }[app.tab];
  main.innerHTML = view();
  app.rendered = true;
  for (const a of document.querySelectorAll('#tabs a')) a.setAttribute('aria-current', a.dataset.tab === app.tab ? 'page' : 'false');
  if (app.tab === 'now') app.nowTimer = setInterval(() => { if (app.tab === 'now' && !dialog.open) main.innerHTML = renderNow(); }, 30000);
  if (app.tab === 'changes') markSeen();
  renderBadges();
}

function markSeen() {
  const newest = app.raw.changes?.batches?.[0]?.at;
  if (newest && store.get().seenBatch !== newest) store.setSeenBatch(newest);
}

function onRoute() {
  const r = parseRoute();
  if (r.tab === 'session') {
    const s = app.model.byCode.get(decodeURIComponent(r.arg));
    if (!app.rendered) render();
    if (s) openDetail(s.key);
    return;
  }
  if (r.tab === 'import') {
    importShare(decodeURIComponent(r.arg));
    history.replaceState(null, '', '#/plan');
    app.tab = 'plan';
    render();
    return;
  }
  const tab = TABS.includes(r.tab) ? r.tab : store.get().ui.tab || 'browse';
  if (dialog.open) dialog.close();
  if (tab !== app.tab || !app.rendered) {
    app.tab = tab;
    store.setUI({ tab });
    render();
    window.scrollTo(0, 0);
  }
}

function importShare(str) {
  const parsed = store.parseShare(str, code => app.model.byCode.get(code)?.id, code => app.model.byCode.get(code)?.key);
  const n = Object.keys(parsed).length;
  if (!n) { toast('That link had no picks in it'); return; }
  if (confirm(`Import ${n} picks from the link? Matching sessions you've already rated will be overwritten.`)) {
    store.applyShared(parsed);
    toast(`Imported ${n} picks`);
  }
}

// ---------------------------------------------------------------- events

function setPriorityFromUI(id, p) {
  const cur = store.priority(id);
  store.setPriority(id, cur === p ? null : p);
}

main.addEventListener('click', onClick);
dialog.addEventListener('click', e => {
  if (e.target === dialog) { dialog.close(); return; }
  onClick(e);
});
dialog.addEventListener('close', () => {
  app.dialogKey = null;
  if (location.hash.startsWith('#/session/')) history.replaceState(null, '', `#/${app.tab}`);
});

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const handlers = {
    prio: () => setPriorityFromUI(el.dataset.id, Number(el.dataset.p)),
    open: () => { e.preventDefault(); openDetail(el.dataset.key); },
    'open-code': () => { e.preventDefault(); const s = app.model.byCode.get(el.dataset.code); if (s) openDetail(s.key); else toast('That session is no longer in the catalog'); },
    close: () => dialog.close(),
    quick: () => setFilters({ [el.dataset.k]: !filtersState()[el.dataset.k] }),
    unfacet: () => { const f = filtersState(); setFilters({ [el.dataset.k]: (f[el.dataset.k] || []).filter(v => String(v) !== el.dataset.v) }); },
    clearfilters: () => setFilters({ topics: [], types: [], levels: [], audience: [], days: [], buildings: [], q: '', inPerson: false, notRecorded: false, unrated: false, mine: false, fresh: false }),
    more: () => { app.browseLimit += PAGE; render(); },
    't-rate': () => triageRate(Number(el.dataset.p)),
    't-undo': () => triageUndo(),
    't-later': () => { triageQueue().idx++; render(); },
    day: () => { store.setUI({ day: el.dataset.day }); app.openFill = null; render(); },
    lock: () => { store.setLock(el.dataset.pick, el.dataset.key); toast('Locked in. The rest of the day was re-planned around it'); },
    unlock: () => store.setLock(el.dataset.pick, null),
    'unlock-all': () => { for (const [id, p] of Object.entries(store.get().picks)) if (p.lock) store.setLock(id, null); toast('All locks cleared'); },
    fill: () => { app.openFill = app.openFill === el.dataset.fill ? null : el.dataset.fill; render(); },
    'preview-on': () => { store.updateSettings({ preview: true }); toast('Preview on: days and rooms are simulated'); },
    'preview-off': () => store.updateSettings({ preview: false }),
    ics: () => exportIcs(),
    sim: () => {
      const d = $('#sim-day').value; const [h, m] = ($('#sim-time').value || '10:00').split(':').map(Number);
      store.updateSettings({ simNow: { day: d, min: h * 60 + m } });
    },
    'sim-off': () => store.updateSettings({ simNow: null }),
    ack: () => { store.setKnown({ ...store.get().known, ...app.nextKnown }); app.alerts = []; render(); },
    refresh: () => refreshData(true),
    'sync-local': () => syncLocal(el),
    export: () => shareOrDownload(`ignite-2026-picks-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(store.exportData(), null, 1), 'application/json'),
    'import-code': () => {
      const raw = ($('#import-code')?.value || '').trim();
      const str = raw.includes('#/import/') ? raw.split('#/import/')[1] : raw;
      let decoded = str;
      try { decoded = decodeURIComponent(str); } catch { /* already decoded */ }
      importShare(decoded);
    },
    'install-dismiss': () => { store.setUI({ installDismissed: true }); render(); },
    'forget-missing': () => {
      for (const [id, p] of Object.entries(store.get().picks)) if (p.p > 0 && !app.model.byId.has(id)) store.setPriority(id, null);
      toast('Removed');
    },
    share: async () => {
      const str = store.shareString(id => sessionById(id)?.code);
      const url = `${location.origin}${location.pathname}#/import/${encodeURIComponent(str)}`;
      toast((await copyText(url)) ? 'Link copied. Open it on your other device' : 'Could not copy the link');
    },
    watchlist: async () => {
      const codes = new Set();
      for (const [id, pk] of Object.entries(store.get().picks)) if (pk.p >= 2) for (const s of groupOf(sessionById(id) || { group: '' })) if (s.code) codes.add(s.code);
      const json = JSON.stringify({ codes: [...codes].sort() }, null, 1);
      toast((await copyText(json)) ? `Copied ${codes.size} codes. Paste into data/watchlist.json` : 'Could not copy');
    },
    'reset-settings': () => { store.resetSettings(); toast('Settings restored'); },
    'reset-all': () => { if (confirm('Erase all your ratings, locks and notes on this device?')) { store.resetAll(); toast('Erased'); } },
  };
  if (handlers[act]) handlers[act]();
}

// Inputs (search, filters, settings) use delegated input/change events.
let qTimer = null;
main.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'q') {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const pos = t.selectionStart;
      setFilters({ q: t.value });
      const q = $('#q');
      if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch { /* search inputs in some browsers */ } }
    }, 180);
  }
});
main.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.facet) {
    const k = t.dataset.facet;
    const f = filtersState();
    const set = new Set((f[k] || []).map(String));
    if (t.checked) set.add(t.value); else set.delete(t.value);
    setFilters({ [k]: [...set] });
  } else if (t.id === 'sort') setFilters({ sort: t.value });
  else if (t.dataset.set) {
    if (t.value === '') return;
    const v = Math.max(0, Number(t.value));
    if (!Number.isFinite(v)) return;
    const path = t.dataset.set.split('.');
    const patch = {};
    let o = patch;
    path.forEach((k, i) => { if (i === path.length - 1) o[k] = v; else o = (o[k] = {}); });
    store.updateSettings(patch);
  } else if (t.dataset.toggle) store.updateSettings({ [t.dataset.toggle]: t.checked });
  else if (t.dataset.override !== undefined) {
    store.updateSettings({ overrides: { [t.dataset.override]: t.value } }); // '' = automatic
  } else if (t.id === 'theme') { applyTheme(t.value); store.setUI({ theme: t.value }); }
  else if (t.id === 'only-mine') { store.setUI({ onlyMine: t.checked }); render(); }
  else if (t.id === 'import-file' && t.files?.[0]) {
    t.files[0].text().then(txt => {
      const n = store.importData(JSON.parse(txt), { replace: confirm('Replace your current picks with the backup? (Cancel = merge them)') });
      toast(`Restored ${n} picks`);
    }).catch(err => toast(`Couldn't read that file: ${err.message}`));
  }
});
main.addEventListener('toggle', e => {
  if (e.target.id === 'filters') store.setUI({ filtersOpen: e.target.open });
  if (e.target.dataset?.fill) app.openFill = e.target.open ? e.target.dataset.fill : null;
}, true);
dialog.addEventListener('input', e => {
  if (e.target.dataset.note) store.setNote(e.target.dataset.note, e.target.value);
});

document.addEventListener('keydown', e => {
  if (app.tab !== 'triage' || dialog.open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const map = { 1: 3, 2: 2, 3: 1, 0: 0, x: 0 };
  if (e.key in map) { e.preventDefault(); triageRate(map[e.key]); }
  else if (e.key === 'u' || e.key === 'Backspace') { e.preventDefault(); triageUndo(); }
  else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); triageQueue().idx++; render(); }
});

// Store changes -> keep views and badges in sync.
store.subscribe(what => {
  if (!app.model) return;
  if (what === 'note' || what === 'seen' || what === 'known') { renderBadges(); return; }
  if (what === 'settings') {
    const prev = app.modelKey;
    const key = modelKey();
    if (key !== prev) rebuildModel();
  }
  if (what === 'picks' || what === 'reset') trackNewPicks();
  invalidate();
  if (app.tab === 'browse' && what === 'picks') {
    // Update only the cards that changed, so the list doesn't jump.
    for (const card of main.querySelectorAll('[data-card]')) {
      const s = sessionById(card.dataset.card);
      if (!s) continue;
      const p = prioOf(s);
      card.className = ['card', 's-card', p != null ? `p-${p}` : '', p === 0 ? 'skipped' : ''].join(' ');
      card.querySelectorAll('.prio button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.p) === p)));
    }
    renderBadges();
  } else {
    render();
  }
  refreshDetail();
});

// Remember what each newly picked session looked like, so later changes can be flagged.
function trackNewPicks() {
  const known = store.get().known;
  let added = false;
  for (const [id, pk] of Object.entries(store.get().picks)) {
    if (!(pk.p > 0) || known[id]) continue;
    const s = sessionById(id);
    if (s) { known[id] = snapshot(s); added = true; }
  }
  if (added) store.setKnown(known);
}

// ---------------------------------------------------------------- data lifecycle

function modelKey() {
  const s = store.settings();
  return JSON.stringify([s.preview, s.overrides]);
}

function rsvpConfig() {
  const r = app.live?.flags?.rsvp || app.snapshot?.doc?.siteFlags?.rsvp || app.snapshot?.meta?.siteFlags?.rsvp;
  return r && Object.keys(r).length ? r : EVENT.rsvp;
}

function rebuildModel() {
  app.model = buildModel(app.raw.doc, store.settings(), rsvpConfig());
  app.modelKey = modelKey();
  invalidate();
}

function computeAlerts() {
  const { alerts, next } = diffKnown(app.model, store.get().picks, store.get().known);
  app.alerts = alerts;
  app.nextKnown = next;
  if (!Object.keys(store.get().known).length) { store.setKnown(next); app.alerts = []; }
}

// The model is built from the live Ignite catalog when it differs from the synced
// snapshot, otherwise from the snapshot (which also carries the change history).
function docSig() {
  return app.live && !app.live.same ? `live:${JSON.stringify(app.live.diff)}` : `snap:${app.snapshot.doc.generatedAt}`;
}

function applyData() {
  const sig = docSig();
  if (sig === app.sig) return false;
  app.sig = sig;
  app.raw = { ...app.snapshot, doc: app.live && !app.live.same ? app.live.doc : app.snapshot.doc };
  rebuildModel();
  computeAlerts();
  return true;
}

function countText(d) {
  const parts = [];
  if (d.added.length) parts.push(`${d.added.length} added`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  if (d.changed.length) parts.push(`${d.changed.length} updated`);
  return parts.join(', ');
}

// Toast only for things that happened while the app was open, or that touch your picks.
function announce(initial = false) {
  if (initial && !app.alerts.length) return;
  const d = app.live && !app.live.same ? app.live.diff : app.snapshot.changes?.batches?.[0];
  const counts = d ? countText(d) : '';
  const msg = app.alerts.length ? `${app.alerts.length} of your picks changed`
    : `The Ignite catalog changed${counts ? `: ${counts}` : ''}`;
  toast(msg, { label: 'Review', run: () => { location.hash = '#/changes'; } });
}

async function checkLiveNow() {
  if (CUSTOM_DATA) return;
  try {
    app.live = await checkLive(app.snapshot.doc);
    app.liveError = null;
  } catch (err) {
    app.liveError = err.name === 'AbortError' ? 'timed out' : err.message;
  }
}

async function refreshData(manual = false) {
  let snapErr = null;
  try { app.snapshot = await fetchAll(); } catch (err) { snapErr = err; }
  await checkLiveNow();
  const changed = applyData();
  if (changed) {
    if (!dialog.open) render();
    announce();
  } else if (manual) {
    toast(snapErr && app.liveError ? `Couldn't check: ${app.liveError}` : 'Already up to date');
  }
  renderStatus();
  renderBadges();
}

async function syncLocal(btn) {
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const res = await fetch('api/sync', { method: 'POST' });
    const out = await res.json();
    if (!res.ok || !out.ok) throw new Error(out.output || `HTTP ${res.status}`);
    await refreshData(true);
  } catch (err) {
    toast(`Sync failed: ${err.message.slice(0, 120)}`);
  } finally {
    if (app.tab === 'changes') render();
  }
}

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function boot() {
  store.load();
  applyTheme(store.get().ui.theme);
  try {
    app.snapshot = await fetchAll();
  } catch (err) {
    main.innerHTML = `<div class="panel empty"><h3>Couldn't load the session catalog</h3><p>${esc(err.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div>`;
    $('#sync-status').textContent = 'Offline';
    return;
  }
  applyData();
  trackNewPicks();
  renderStatus();
  window.addEventListener('hashchange', onRoute);
  if (!location.hash) history.replaceState(null, '', `#/${store.get().ui.tab || 'browse'}`);
  onRoute();
  if (app.alerts.length) announce(true);
  checkLiveNow().then(() => {
    if (applyData()) { if (!dialog.open) render(); announce(true); }
    renderStatus();
    renderBadges();
  });
  fetch('api/status').then(r => (r.ok ? r.json() : null)).then(j => { if (j?.local) { app.local = true; if (app.tab === 'changes') render(); } }).catch(() => {});
  setInterval(() => refreshData(false), REFRESH_MS);
  setInterval(renderStatus, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshData(false); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
