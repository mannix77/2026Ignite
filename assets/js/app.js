// Conference Planner — views, routing and event handling.

import * as store from './store.js';
import { fetchAll, buildModel, diffKnown, snapshot, CUSTOM_DATA, DATA_OVERRIDE } from './data.js';
import { checkLive, diff as liveDiff } from './live.js';
import { optimize, decisionGroups, transitions, fillers, nowNext, weigh, canBoth, overlaps, transition, whatIf, lunchConfig, PRIORITY } from './planner.js';
import { fmtTime, fmtDay, fmtDuration, relTime, nowLocal } from './time.js';
import { createVenue, setVenue, walkMinutes } from './venue.js';
import { CONFERENCES, currentConferenceId, rememberConference, conferenceList } from './conferences.js';
import { buildSuggester } from './suggest.js';
import { esc, attr, icon, bldgChip, recChip, rsvpChip, prioPill, scoreChip, whenText, prioControl, sessionCard, cardClass, toast, shareOrDownload, copyText, speakersLine } from './ui.js';

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const dialog = $('#detail');
const TABS = ['browse', 'triage', 'plan', 'now', 'changes', 'settings'];
const PAGE = 60;
const REFRESH_MS = 10 * 60 * 1000;
const MIN_REFRESH_GAP = 4 * 60 * 1000;
const LIVE_GAP = 12 * 60 * 1000;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

const app = {
  conf: null,       // the conference being shown (conferences.js)
  venue: null,      // its venue model (venue.js)
  raw: null,        // { doc, meta, changes } the model is built from
  snapshot: null,   // last synced copy from data/<conf>/
  live: null,       // latest live check against the conference site (Ignite only)
  liveError: null,
  sig: null,
  model: null,
  picks: null,      // { byGroup: Map(group -> records), orphans: [...] }
  plan: null,
  suggester: null,
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
  pendingRender: false,
  lastRefresh: 0,
  lastLiveCheck: 0,
  lastBatchAt: null,
  announcedLive: null,
  favoritesOffer: null,
  simNow: null,     // rehearsal clock: this tab only, never saved
};

// ---------------------------------------------------------------- helpers

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const hhmm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const fromHHMM = v => { const [h, m] = String(v || '').split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };
const B = id => app.venue.BUILDING[id] || app.venue.BUILDING.U;

// Your walking-time edits sit on top of the conference's matrix (a backup may hold only some keys).
function walkCfg() {
  const w = store.settings().walk;
  if (!w) return app.venue.walk;
  return { ...app.venue.walk, ...w, pairs: { ...app.venue.walk.pairs, ...(w.pairs || {}) } };
}

function ctx() {
  const s = store.settings();
  return { walk: walkCfg(), buffer: num(s.buffer, 2), tolerance: num(s.tolerance, 5), keynoteExtra: num(s.keynoteExtra, 15), weights: s.weights };
}
const lunch = () => lunchConfig(store.settings().lunch);

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}

function groupOf(s) { return app.model.byGroup.get(s.group) || [s]; }
function sessionById(id) { return app.model.byId.get(id)?.[0] || null; }

function isNew(s) {
  if (!s.firstSeen) return false;
  return Date.now() - new Date(s.firstSeen).getTime() < 7 * 86400000;
}

// ---------------------------------------------------------------- picks (per repeat group)
//
// Ratings live on sessionId records, but a session can have several runs (repeat
// records or shared ids) and a run can be cancelled. Every record is resolved to its
// repeat group; reads and writes always act on the whole group.

function resolveGroup(id, pk) {
  const s = sessionById(id);
  if (s) return s.group;
  if (pk.g && app.model.byGroup.has(pk.g)) return pk.g;
  if (pk.code) {
    const byCode = app.model.byCode.get(pk.code);
    if (byCode) return byCode.group;
    const base = pk.code.replace(/-R\d+$/i, '');
    if (app.model.byGroup.has(base)) return base;
  }
  return null;
}

function indexPicks() {
  const byGroup = new Map();
  const orphans = [];
  for (const [id, pk] of Object.entries(store.get().picks)) {
    const g = resolveGroup(id, pk);
    if (!g) { orphans.push({ id, ...pk }); continue; }
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push({ id, ...pk });
  }
  app.picks = { byGroup, orphans };
  app.suggester = null;
}

// The group's effective pick: the most recent rating wins; the lock and reservation
// come from whichever record holds them. A reserved seat pins that run unless you lock
// another on purpose. Locks made in preview don't count once the real schedule is out.
function groupPick(g) {
  const recs = app.picks.byGroup.get(g);
  if (!recs?.length) return null;
  const byAt = recs.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const latest = byAt[0];
  const official = app.model.mode === 'official';
  const keys = new Set((app.model.byGroup.get(g) || []).map(s => s.key));
  const lockRec = byAt.find(r => r.lock && !(official && r.lockMode === 'preview'));
  const reserved = byAt.map(r => r.reserved).find(k => k && keys.has(k)) || null;
  const scored = byAt.find(r => Number.isFinite(r.score));
  return {
    p: latest.p ?? null,
    lock: (lockRec && keys.has(lockRec.lock) ? lockRec.lock : null) || reserved,
    reserved,
    score: scored ? scored.score : null,
    mode: latest.mode === 'watch' ? 'watch' : null,
    note: recs.map(r => r.note).filter(Boolean).join('\n\n'),
    ids: recs.map(r => r.id),
    holder: (lockRec || latest).id,
  };
}
const prioOf = s => groupPick(s.group)?.p ?? null;

function groupMeta(s) {
  const first = groupOf(s)[0];
  return { g: s.group, code: first.code };
}

function groupIds(s) {
  const gp = groupPick(s.group);
  return gp?.ids.length ? gp.ids : [groupOf(s)[0].id];
}

function setGroupPriority(s, p) {
  const meta = groupMeta(s);
  store.mutatePicks(picks => {
    for (const id of groupIds(s)) {
      const cur = picks[id] || { note: '' };
      picks[id] = { ...cur, ...meta, p, at: Date.now() };
      if (!(p > 0)) { picks[id].lock = null; delete picks[id].lockMode; }
    }
  });
}

// Score / watch-later live on every record of the group. Setting them on an unrated
// session rates it too (a score means you care about it).
function setGroupField(s, patch) {
  const meta = groupMeta(s);
  store.mutatePicks(picks => {
    for (const id of groupIds(s)) {
      const cur = picks[id] || { note: '', p: null, lock: null };
      const next = { ...cur, ...meta, at: Date.now() };
      if ('score' in patch) { if (patch.score == null) delete next.score; else next.score = patch.score; }
      if ('mode' in patch) { if (patch.mode) next.mode = patch.mode; else delete next.mode; }
      if (next.p == null && (next.score != null || next.mode)) next.p = next.mode ? 1 : 2;
      picks[id] = next;
    }
  });
}

function clearGroupLocks(picks, g) {
  for (const id of groupPick(g)?.ids || []) if (picks[id]) { picks[id].lock = null; delete picks[id].lockMode; }
}

// Lock a run (or unlock with instKey = null). `release` lists groups whose locks this
// choice replaces (the other options of a clash).
function setGroupLock(s, instKey, release = [], { dropReservation = false } = {}) {
  const gp = groupPick(s.group);
  const meta = groupMeta(s);
  store.mutatePicks(picks => {
    for (const g of release) if (g !== s.group) clearGroupLocks(picks, g);
    clearGroupLocks(picks, s.group);
    if (dropReservation) for (const id of gp?.ids || []) if (picks[id]) delete picks[id].reserved;
    if (!instKey) return;
    const holder = gp?.holder || groupOf(s)[0].id;
    const cur = picks[holder] || { note: '' };
    picks[holder] = { ...cur, ...meta, p: cur.p > 0 ? cur.p : gp?.p > 0 ? gp.p : 3, lock: instKey, at: Date.now() };
    if (app.model.mode === 'preview') picks[holder].lockMode = 'preview';
    else delete picks[holder].lockMode;
  });
}

// "I reserved a seat for this run": attend that run, and stop nagging about the RSVP.
function setReserved(s, instKey) {
  const gp = groupPick(s.group);
  const meta = groupMeta(s);
  store.mutatePicks(picks => {
    for (const id of gp?.ids || []) if (picks[id]) delete picks[id].reserved;
    clearGroupLocks(picks, s.group);
    if (!instKey) return;
    const holder = gp?.holder || groupOf(s)[0].id;
    const cur = picks[holder] || { note: '' };
    picks[holder] = { ...cur, ...meta, p: cur.p > 0 ? cur.p : gp?.p > 0 ? gp.p : 3, lock: instKey, reserved: instKey, at: Date.now() };
    delete picks[holder].lockMode;
  });
}

function pickedGroups() {
  const set = new Set();
  for (const g of app.picks.byGroup.keys()) if (groupPick(g).p > 0) set.add(g);
  for (const o of app.picks.orphans) if (o.p > 0 && o.g) set.add(o.g);
  return set;
}

function invalidate() { app.plan = null; }

// ---------------------------------------------------------------- suggestions

function suggester() {
  if (app.suggester) return app.suggester;
  const picks = [];
  for (const g of app.picks.byGroup.keys()) {
    const gp = groupPick(g);
    if (!(gp.p > 0)) continue;
    const s = app.model.byGroup.get(g)?.[0];
    if (s) picks.push({ s, w: Number.isFinite(gp.score) ? Math.max(0.5, gp.score / 4) : gp.p });
  }
  app.suggester = buildSuggester(app.model.sessions, picks);
  return app.suggester;
}

// Unrated sessions ranked by how much they resemble your picks (one row per repeat group).
function suggestions(limit = 12, min = 25) {
  const sg = suggester();
  if (!sg.ready) return [];
  const seen = new Set();
  const out = [];
  for (const s of app.model.sessions) {
    if (seen.has(s.group) || prioOf(s) != null || s.dur === 0) continue;
    seen.add(s.group);
    const r = sg.score(s);
    if (r.score >= min) out.push({ s, ...r });
  }
  out.sort((a, b) => b.score - a.score || a.s.code.localeCompare(b.s.code));
  return out.slice(0, limit);
}

// Does any run of this session fit around the current plan? Returns the run that fits.
function fitsPlan(s) {
  const plan = computePlan();
  const c = ctx();
  for (const run of groupOf(s)) {
    if (!run.day || !(run.endMin > run.startMin)) continue;
    const chain = plan.res.plan[run.day] || [];
    const cand = { key: run.key, id: run.group, code: run.code, type: run.type, day: run.day, startMin: run.startMin, endMin: run.endMin, loc: run.loc };
    if (fillers(chain, [cand], c).length) return run;
  }
  return null;
}

function suggestExtra(x) {
  const fit = app.model.mode !== 'unscheduled' ? fitsPlan(x.s) : null;
  return `<div class="reason ok">${icon('check')}<span><span class="chip sugg">Suggested ${x.score}%</span> ${esc(x.reasons.join(' · '))}${fit ? ` · <b>fits your plan ${esc(fmtDay(fit.day))} ${fmtTime(fit.startMin)}</b>` : app.model.mode !== 'unscheduled' ? ' · clashes with your plan' : ''}</span></div>`;
}

// ---------------------------------------------------------------- plan model

function blockItems() {
  const out = [];
  for (const b of store.settings().blocks || []) {
    const building = b.building && app.venue.BUILDING[b.building] ? b.building : app.venue.startFrom;
    const loc = { label: B(building).name, building, floor: null, known: true };
    // Blocked time is a hard constraint: it outranks even sessions you've locked.
    out.push({ key: `block:${b.id}`, id: `block:${b.id}`, code: b.label, title: b.label, pseudo: 'block', weight: 1e7, locked: true, priority: 0, day: b.day, startMin: b.start, endMin: b.end, loc });
  }
  return out;
}

function computePlan() {
  if (app.plan) return app.plan;
  const items = [], online = [], tba = [], watch = [];
  let groupCount = 0;
  for (const g of app.picks.byGroup.keys()) {
    const gp = groupPick(g);
    if (!(gp.p > 0)) continue;
    groupCount++;
    const runs = app.model.byGroup.get(g) || [];
    if (gp.mode === 'watch') { if (runs[0]) watch.push({ id: g, s: runs[0], priority: gp.p, score: gp.score }); continue; }
    for (const s of runs) {
      const it = {
        key: s.key, id: g, code: s.code, title: s.title, type: s.type, day: s.day, startMin: s.startMin, endMin: s.endMin,
        loc: s.loc, recorded: s.recorded, priority: gp.p, score: Number.isFinite(gp.score) ? gp.score : undefined,
        locked: gp.lock === s.key, reserved: gp.reserved === s.key, s,
      };
      if (s.onlineOnly) online.push(it);
      else if (!s.day || !(s.endMin > s.startMin)) tba.push(it);
      else items.push(it);
    }
  }
  const c = ctx();
  const L = lunch();
  const blocks = blockItems();
  const res = optimize([...items, ...blocks], c, L);
  const all = Object.values(res.plan).flat();
  const chosen = new Set(all.map(x => x.key));
  const chosenGroups = new Set(all.map(x => x.id));
  // Picks that collide with blocked time aren't decisions: the block wins.
  const blockedKeys = new Set(items.filter(x => blocks.some(b => b.day === x.day && !canBoth(b, x, c))).map(x => x.key));
  // A run whose repeat is already in the plan isn't a real decision either.
  const contested = items.filter(x => !blockedKeys.has(x.key) && (chosen.has(x.key) || !chosenGroups.has(x.id)));
  const decisions = decisionGroups(contested, c);
  const oneEach = list => [...new Map(list.map(x => [x.id, x])).values()];
  app.plan = {
    items, blocks, res, chosen, chosenGroups, decisions, contested, blockedKeys, lunch: L, watch,
    online: oneEach(online).filter(x => !chosenGroups.has(x.id)),
    tba: oneEach(tba).filter(x => !chosenGroups.has(x.id) && !items.some(i => i.id === x.id)),
    groupCount,
  };
  return app.plan;
}

// ---------------------------------------------------------------- header / badges

function renderStatus() {
  if (!app.model) return;
  const meta = app.raw?.meta || {};
  const el = $('#sync-status');
  const sched = app.model.hasOfficial ? `${app.model.officialCount} timed` : 'dates & rooms not published yet';
  let src, ok = true;
  if (CUSTOM_DATA) src = 'Test data';
  else if (!app.conf.live) src = `From your export · ${relTime(app.raw.doc.generatedAt)}`;
  else if (app.live) src = `${app.live.stale ? 'Live copy' : `Live from ${app.conf.siteName}`} · ${relTime(app.live.at)}`;
  else { src = `${app.liveError ? 'Offline copy' : 'Synced'} · ${relTime(meta.lastChecked || app.raw.doc.generatedAt)}`; ok = meta.ok !== false && !app.liveError; }
  if (app.live?.stale) ok = false;
  el.innerHTML = `<span class="dot${ok ? '' : ' err'}"></span>${esc(src)} · ${Number(app.model.sessions.length)} sessions · ${esc(sched)}`;
  el.title = [app.live ? `Live check ${app.live.at}${app.live.same ? ' (matches the last sync)' : ' (newer than the last sync)'}${app.live.stale ? ' — the latest check failed' : ''}` : '',
    app.liveError ? `Live check failed: ${app.liveError}` : '',
    `Sync ${meta.lastChecked || '?'}${meta.error ? ` (${meta.error})` : ''}`].filter(Boolean).join(' · ');
}

function renderBadges() {
  const plan = app.model ? computePlan() : null;
  const open = plan ? plan.decisions.filter(d => !d.resolved).length : 0;
  const bp = $('#badge-plan');
  bp.hidden = !open; bp.textContent = open;
  bp.title = `${open} clash(es) to decide`;
  const batches = app.raw?.changes?.batches || [];
  const seen = store.get().seenBatch;
  const unseen = batches.filter(b => !seen || b.at > seen).length;
  const n = app.alerts.length || unseen;
  const bc = $('#badge-changes');
  bc.hidden = !n; bc.textContent = n > 99 ? '99+' : n;
  bc.title = app.alerts.length ? `${app.alerts.length} change(s) to your picks` : `${unseen} new catalog update(s)`;
}

// ---------------------------------------------------------------- browse

function filtersState() {
  const f = store.get().ui.filters || {};
  return { q: '', topics: [], types: [], levels: [], audience: [], days: [], buildings: [], inPerson: false, notRecorded: false, unrated: false, mine: false, fresh: false, suggested: false, sort: 'smart', ...f };
}

function applyFilters(f, { forTriage = false } = {}) {
  const toks = (f.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const set = a => (a && a.length ? new Set(a.map(String)) : null);
  const topics = set(f.topics), types = set(f.types), levels = set(f.levels), aud = set(f.audience), days = set(f.days), blds = set(f.buildings);
  const hideOnline = store.settings().hideOnline;
  const sg = f.suggested || forTriage ? suggester() : null;
  const sugg = new Map();
  const out = [];
  for (const s of app.model.sessions) {
    const p = prioOf(s);
    if (forTriage && p != null) continue;
    if (f.inPerson && !s.inPerson) continue;
    if (hideOnline && s.onlineOnly) continue;
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
    if (sg?.ready) sugg.set(s.key, sg.score(s));
    if (f.suggested && (p != null || !(sugg.get(s.key)?.score > 0))) continue;
    out.push(s);
  }
  const byTime = (a, b) => (a.day || '9') < (b.day || '9') ? -1 : (a.day || '9') > (b.day || '9') ? 1 : (a.startMin ?? 1e9) - (b.startMin ?? 1e9) || a.code.localeCompare(b.code);
  const bySugg = (a, b) => (sugg.get(b.key)?.score || 0) - (sugg.get(a.key)?.score || 0) || byTime(a, b);
  let sort = f.sort;
  if (f.suggested || (forTriage && sg?.ready)) sort = 'suggested';
  else if (sort === 'smart') sort = toks.length ? 'relevance' : app.model.mode !== 'unscheduled' ? 'time' : 'code';
  if (sort === 'suggested') out.sort(bySugg);
  else if (sort === 'relevance') {
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
  out.sugg = sugg;
  return out;
}

function facetBox(name, label, entries, selected, fmt = v => v) {
  const sel = new Set((selected || []).map(String));
  return `<fieldset><legend>${esc(label)}</legend><div class="scroll" data-scroll="${attr(name)}">${entries.map(([v, n]) =>
    `<label><input type="checkbox" data-facet="${attr(name)}" value="${attr(v)}" ${sel.has(String(v)) ? 'checked' : ''}> ${esc(fmt(v))}<span class="n">${Number(n)}</span></label>`).join('')}</div></fieldset>`;
}

function card(s, opts = {}) {
  const gp = groupPick(s.group);
  return sessionCard(s, { p: gp?.p ?? null, reserved: gp?.reserved === s.key, score: gp?.score ?? null, watch: gp?.mode === 'watch', isNew: isNew(s), ...opts });
}

function favoritesBanner() {
  const f = app.favoritesOffer;
  if (!f) return '';
  const n = Object.keys(f.picks || {}).length;
  return `<div class="banner install">${icon('cards')}<div><b>Your workbook favorites are available (${n} sessions)</b>
    <p>Ratings, scores and watch-later marks from your spreadsheet. Importing keeps the notes you've written here.</p>
    <button class="btn small primary" data-act="favorites-import">Import ${n} favorites</button></div>
    <button class="btn ghost small x" data-act="favorites-dismiss" aria-label="Dismiss">${icon('x')}</button></div>`;
}

function renderBrowse() {
  const f = filtersState();
  const results = applyFilters(f);
  const fc = app.model.facets;
  const sortDesc = m => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const levelName = { 100: '100 Foundational', 200: '200 Intermediate', 300: '300 Advanced', 400: '400 Expert' };
  const activeCount = ['topics', 'types', 'levels', 'audience', 'days', 'buildings'].reduce((a, k) => a + (f[k]?.length || 0), 0);
  const quick = [['suggested', 'Suggested for you'], ['inPerson', 'In person'], ['notRecorded', 'Not recorded'], ['unrated', 'Not rated yet'], ['mine', 'My picks'], ['fresh', 'New this week']];
  const dayEntries = app.model.days.map(d => [d, app.model.sessions.filter(s => s.day === d).length]);
  const bldEntries = [...app.venue.buildings, app.venue.BUILDING.U].map(b => [b.id, app.model.sessions.filter(s => s.loc.building === b.id).length]).filter(e => e[1]);
  const chips = [];
  for (const k of ['topics', 'types', 'levels', 'audience', 'days', 'buildings']) for (const v of f[k] || []) {
    const label = k === 'levels' ? levelName[v] || v : k === 'days' ? (v === 'tba' ? 'Date TBA' : fmtDay(v)) : k === 'buildings' ? (B(v).name) : v;
    chips.push(`<button type="button" class="chip removable" data-act="unfacet" data-k="${attr(k)}" data-v="${attr(v)}">${esc(label)} ${icon('x')}</button>`);
  }
  const shown = results.slice(0, app.browseLimit);
  const started = Object.keys(store.get().picks).length > 0 || store.get().ui.introDismissed;
  const intro = started ? '' : `<div class="banner install">${icon('cards')}<div><b>How this works</b>
    <p>1. Rate sessions <b>Must / Want / Maybe / Skip</b> here or in <a href="#/triage">Triage</a>.<br>
    2. <b>My plan</b> builds your days around walking time between buildings and flags clashes. For Ignite, the app watches the catalog until dates and rooms are published.<br>
    3. Settle the clashes it flags. At the venue, <b>Now</b> tells you where to go next.</p></div>
    <button class="btn ghost small x" data-act="intro-dismiss" aria-label="Dismiss">${icon('x')}</button></div>`;
  const sg = results.sugg;
  const extraFor = s => (f.suggested && sg?.get(s.key)?.score > 0 ? suggestExtra({ s, ...sg.get(s.key) }) : '');
  return `${installBanner()}${favoritesBanner()}${intro}
  <div class="searchbar">
    <label class="search">${icon('search')}<span class="sr-only">Search sessions</span>
      <input id="q" type="search" placeholder="Search titles, speakers, tags, codes…" value="${attr(f.q)}" autocomplete="off" enterkeyhint="search"></label>
  </div>
  <div class="quick" role="group" aria-label="Quick filters">
    ${quick.map(([k, l]) => `<button type="button" class="chip btn-chip" data-act="quick" data-k="${k}" aria-pressed="${!!f[k]}">${l}</button>`).join('')}
  </div>
  ${f.suggested && !suggester().ready ? `<p class="small muted">Rate at least two sessions first, then suggestions appear here ranked by how much they resemble your picks.</p>` : ''}
  <details class="filters" ${store.get().ui.filtersOpen ? 'open' : ''} id="filters">
    <summary>${icon('search')} More filters${activeCount ? ` (${activeCount})` : ''}</summary>
    <div class="filter-grid">
      ${facetBox('topics', 'Topic', sortDesc(fc.topics), f.topics)}
      ${facetBox('types', 'Session type', sortDesc(fc.types), f.types)}
      ${fc.levels.size ? facetBox('levels', 'Level', [...fc.levels.entries()].sort((a, b) => a[0] - b[0]), f.levels, v => levelName[v] || v) : ''}
      ${facetBox('audience', app.conf.id === 'gartner2026' ? 'Program / industry' : 'Audience', sortDesc(fc.audience), f.audience)}
      ${dayEntries.length ? facetBox('days', 'Day', [...dayEntries, ['tba', app.model.sessions.filter(s => !s.day).length]].filter(e => e[1]), f.days, v => (v === 'tba' ? 'Date TBA' : fmtDay(v))) : ''}
      ${app.model.mode !== 'unscheduled' ? facetBox('buildings', 'Building', bldEntries, f.buildings, v => B(v).name) : ''}
    </div>
  </details>
  ${chips.length ? `<div class="row" style="margin-bottom:8px">${chips.join('')}<button type="button" class="btn ghost small" data-act="clearfilters">Clear all</button></div>` : ''}
  <div class="result-meta">
    <span><b>${results.length}</b> of ${app.model.sessions.length} sessions</span>
    <span class="spacer"></span>
    <label>Sort <select id="sort" ${f.suggested ? 'disabled' : ''}>
      ${[['smart', 'Best match'], ['time', 'Time'], ['code', 'Code'], ['title', 'Title'], ['priority', 'My priority']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    ${results.length ? `<a class="btn small" href="#/triage">${icon('cards')}Triage these</a>` : ''}
  </div>
  <div class="list" id="results">
    ${shown.map(s => card(s, { extra: extraFor(s) })).join('') || `<div class="empty"><h3>No sessions match</h3><p>Try fewer filters or a different search.</p></div>`}
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

// Unrated sessions, most-like-your-picks first once you've rated a few.
function triageQueue() {
  if (app.triage) return app.triage;
  const seenGroups = new Set();
  const queue = [];
  const results = applyFilters(filtersState(), { forTriage: true });
  for (const s of results) {
    if (seenGroups.has(s.group)) continue;
    seenGroups.add(s.group);
    queue.push(s.key);
  }
  app.triage = { queue, idx: 0, history: [], sugg: results.sugg };
  return app.triage;
}

// Skip entries that vanished from the catalog or were rated elsewhere since queuing.
function triageCurrent() {
  const t = triageQueue();
  while (t.idx < t.queue.length) {
    const s = app.model.byKey.get(t.queue[t.idx]);
    if (s && prioOf(s) == null) return s;
    t.idx++;
  }
  return null;
}

function renderTriage() {
  const t = triageQueue();
  const s = triageCurrent();
  const f = filtersState();
  const rated = [...app.picks.byGroup.keys()].filter(g => groupPick(g).p != null).length;
  const activeFilters = ['topics', 'types', 'levels', 'audience', 'days', 'buildings'].some(k => f[k]?.length) || f.q || f.inPerson || f.notRecorded || f.fresh;
  const ordered = suggester().ready;
  const head = `<h1>Triage</h1>
    <p class="lede">Rate sessions one at a time to get through the catalog quickly. ${ordered ? 'The ones most like your picks come first. ' : ''}${activeFilters ? `Using your Browse filters (<a href="#/browse">change</a>).` : `Tip: narrow it first in <a href="#/browse">Browse</a> (e.g. by topic), then come back.`}</p>`;
  if (!s) {
    return `${head}<div class="panel empty"><h3 tabindex="-1" id="t-focus">All caught up</h3><p>${t.queue.length ? `You rated ${t.history.length} session(s) this round.` : 'Nothing unrated matches your filters.'} You've rated ${rated} sessions in total.</p>
      <div class="row" style="justify-content:center">${t.history.length ? `<button class="btn" data-act="t-undo">Undo last</button>` : ''}<a class="btn primary" href="#/plan">See my plan</a></div></div>`;
  }
  const pct = Math.round((t.idx / Math.max(1, t.queue.length)) * 100);
  const sp = speakersLine(s, 8);
  const sg = t.sugg?.get(s.key);
  return `${head}
  <div class="triage">
    <div class="row small muted"><span>${t.idx + 1} of ${t.queue.length}</span><span class="spacer"></span><span>${rated} rated overall</span></div>
    <div class="progress" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <article class="card t-card">
      <div class="row small muted"><span class="code" style="font-family:var(--mono);font-weight:600">${esc(s.code)}</span>·${esc(s.type)}${s.level ? ` · ${esc(s.level)}` : ''}${s.dur ? ` · ${fmtDuration(s.dur)}` : ''} ${isNew(s) ? '<span class="chip new">New</span>' : ''}</div>
      <h2 tabindex="-1" id="t-focus">${esc(s.title)}</h2>
      <div class="row">${s.timeSource === 'preview' ? '<span class="chip preview">Preview</span>' : ''}<span class="small">${esc(whenText(s))}</span>${!s.onlineOnly && s.day ? bldgChip(s.loc) : ''}${recChip(s)}${rsvpChip(s)}</div>
      ${sg?.score > 0 ? suggestExtra({ s, ...sg }) : ''}
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

function snapshotGroup(g) {
  const out = {};
  for (const id of groupPick(g)?.ids || []) out[id] = { ...store.pick(id) };
  return out;
}

function triageRate(p) {
  const t = triageQueue();
  const s = triageCurrent();
  if (!s) return;
  t.history.push({ g: s.group, ids: groupOf(s).map(x => x.id), prev: snapshotGroup(s.group), idx: t.idx });
  t.idx++;
  app.triageFocus = true;
  const keep = t; // rating invalidates the suggester; keep this round's order stable
  setGroupPriority(s, p);
  app.triage = keep;
  const next = triageCurrent();
  announceSR(`Rated ${PRIORITY[p]}. ${next ? `Next: ${next.title}` : 'All caught up.'}`);
}

function triageUndo() {
  const t = triageQueue();
  const h = t.history.pop();
  if (!h) return;
  t.idx = h.idx;
  app.triageFocus = true;
  const keep = t;
  store.mutatePicks(picks => {
    for (const id of new Set([...h.ids, ...(groupPick(h.g)?.ids || [])])) {
      if (h.prev[id]) picks[id] = h.prev[id]; else delete picks[id];
    }
  });
  app.triage = keep;
}

function announceSR(msg) {
  const el = $('#sr-live');
  if (el) { el.textContent = ''; setTimeout(() => { el.textContent = msg; }, 30); }
}

// ---------------------------------------------------------------- plan

function renderPlan() {
  const plan = computePlan();
  const m = app.model;
  if (!plan.groupCount) {
    return `<h1>My plan</h1>${installBanner()}${favoritesBanner()}${missingPicksBanner()}
    <div class="panel empty"><h3>No picks yet</h3><p>Rate sessions as <b>Must</b>, <b>Want</b> or <b>Maybe</b> in Browse or Triage. Your plan builds itself from those ratings, using real walking times between buildings.</p>
    <div class="row" style="justify-content:center"><a class="btn primary" href="#/triage">${icon('cards')}Start triage</a><a class="btn" href="#/browse">Browse sessions</a></div></div>`;
  }
  if (m.mode === 'unscheduled') return renderShortlist(plan);
  return renderSchedule(plan);
}

function previewBanner() {
  return app.model.mode === 'preview'
    ? `<div class="banner warn">${icon('warn')}<div><b>Preview: days and rooms are simulated</b>
      <p>Rehearse with this until the real schedule is published. Your ratings carry over; choices you lock here are dropped when the real schedule arrives.</p>
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
  const gone = app.picks.orphans.filter(o => o.p > 0);
  if (!gone.length) return '';
  const names = gone.map(o => o.code).filter(Boolean);
  return `<div class="banner bad">${icon('warn')}<div><b>${gone.length} of your picks ${gone.length === 1 ? 'is' : 'are'} no longer in the catalog</b>
    <p>${names.length ? esc(names.slice(0, 8).join(', ')) + (names.length > 8 ? ` +${names.length - 8} more` : '') : 'They were removed or renamed.'}. Check <a href="#/changes">Changes</a> or search for a replacement.</p>
    <button class="btn small" data-act="forget-missing">Remove them from my picks</button></div></div>`;
}

function watchSection(plan) {
  if (!plan.watch.length) return '';
  const list = plan.watch.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.priority - a.priority);
  return `<section><h2>Watch later (${list.length})</h2><p class="lede small">Kept out of the live plan; catch the recordings. Tap <b>Attend live</b> to put one back.</p>
    <div class="list">${list.map(x => card(x.s, { compact: true, extra: `<div class="row" style="margin-top:8px"><button class="btn small ghost" data-act="attend-live" data-key="${attr(x.s.key)}">Attend live instead</button>
      <a class="btn small ghost" href="${attr(app.conf.sessionUrl(x.s))}" target="_blank" rel="noopener">On ${esc(app.conf.siteName)} ${icon('ext')}</a></div>` })).join('')}</div></section>`;
}

function suggestedSection(limit = 8) {
  const list = suggestions(limit);
  if (!list.length) return '';
  return `<section><h2>Suggested for you</h2><p class="lede small">Unrated sessions most like your picks. Rate them to add them to the plan.</p>
    <div class="list">${list.map(x => card(x.s, { compact: true, extra: suggestExtra(x) })).join('')}</div>
    <p class="small"><a href="#/browse" data-act="browse-suggested">See all suggestions</a></p></section>`;
}

function renderShortlist(plan) {
  const meta = app.raw.meta || {};
  const groups = [3, 2, 1].map(p => {
    const list = plan.tba.filter(x => x.priority === p).map(x => x.s)
      .sort((a, b) => (groupPick(b.group)?.score ?? -1) - (groupPick(a.group)?.score ?? -1) || (a.recorded === false ? 0 : 1) - (b.recorded === false ? 0 : 1) || a.code.localeCompare(b.code));
    return { p, list };
  });
  const minutes = plan.tba.reduce((a, x) => a + (x.s.dur || 0), 0);
  const notRec = plan.tba.filter(x => x.s.recorded === false && x.priority >= 2).length;
  const rec = plan.tba.filter(x => x.s.recorded === true).length;
  return `<h1>My plan</h1>${installBanner()}${favoritesBanner()}${missingPicksBanner()}${rsvpBanner(plan)}
  <div class="banner">${icon('clock')}<div><b>Waiting for dates and rooms to be published.</b>
    <p>The catalog is checked automatically (last checked ${esc(relTime(app.live?.at || meta.lastChecked || app.raw.doc.generatedAt))}). Once times appear, your plan builds itself. It flags sessions you can't reach in time and suggests what to give up. Want to try it now?</p>
    <button class="btn small" data-act="preview-on">Rehearse with a simulated schedule</button></div></div>
  <div class="stats">
    <div class="stat"><b>${plan.groupCount}</b><span>sessions picked</span></div>
    <div class="stat"><b>${fmtDuration(minutes) || '0 min'}</b><span>of content picked (about ${Math.round(minutes / 60 / 7 * 10) / 10} days)</span></div>
    <div class="stat"><b>${notRec}</b><span>Must/Want <b>not recorded</b> (in person only)</span></div>
    <div class="stat"><b>${rec + plan.watch.length}</b><span>picks you could watch later</span></div>
  </div>
  ${groups.map(g => g.list.length ? `<section class="prio-group"><h2>${prioPill(g.p)} ${g.list.length} session${g.list.length > 1 ? 's' : ''}</h2>
    <div class="list">${g.list.map(s => card(s, { compact: true })).join('')}</div></section>` : '').join('')}
  ${watchSection(plan)}
  ${suggestedSection()}
  ${plan.online.length ? `<section><h2>Online / on demand</h2><div class="list">${plan.online.map(x => card(x.s, { compact: true })).join('')}</div></section>` : ''}`;
}

function dayCounts(plan) {
  const out = {};
  for (const d of app.model.days) {
    const chosen = (plan.res.plan[d] || []).filter(x => !x.pseudo).length;
    const open = plan.decisions.filter(x => x.day === d && !x.resolved).length;
    out[d] = { chosen, open };
  }
  return out;
}

function lunchRow(slot) {
  return `<div class="t-lunch"><div class="t-time">${fmtTime(slot.start)}<small>${fmtTime(slot.end)}</small></div><div class="line">🍽 <b>Lunch break</b> <span class="muted">(protected; change it in Settings)</span></div></div>`;
}

function renderSchedule(plan) {
  const m = app.model;
  const ui = store.get().ui;
  const counts = dayCounts(plan);
  let day = ui.day && m.days.includes(ui.day) ? ui.day : null;
  if (!day) day = m.days.find(d => counts[d].chosen || counts[d].open) || m.days[0];
  const c = ctx();
  const chain = plan.res.plan[day] || [];
  const lunchSlot = plan.res.lunch?.[day] || null;
  const trans = transitions(chain, c);
  const decisions = plan.decisions.filter(d => d.day === day);
  const real = d => !d.item.pseudo;
  const dropped = plan.res.dropped.filter(d => real(d) && d.item.day === day && d.reason.kind !== 'repeat');
  const totalChosen = Object.values(plan.res.plan).flat().filter(x => !x.pseudo).length;
  const tight = Object.values(plan.res.plan).reduce((a, dp) => a + transitions(dp, c).filter(t => t.status === 'tight').length, 0);
  const openDecisions = plan.decisions.filter(d => !d.resolved).length;
  const sacrificed = new Set(plan.res.dropped.filter(d => real(d) && !plan.chosenGroups.has(d.item.id)).map(d => d.item.id)).size;

  const parts = [];
  parts.push(`<h1>My plan</h1>${installBanner()}${favoritesBanner()}${previewBanner()}${missingPicksBanner()}${rsvpBanner(plan)}`);
  const lockedConflicts = plan.res.lockedConflicts.filter(x => !x.pseudo);
  if (lockedConflicts.length) {
    parts.push(`<div class="banner bad">${icon('warn')}<div><b>Some sessions you locked can't all happen.</b><p>${lockedConflicts.map(x => esc(x.code)).join(', ')} clash with other locked sessions or blocked time. Unlock one of them.</p></div></div>`);
  }
  parts.push(`<div class="stats">
    <div class="stat"><b>${totalChosen}</b><span>sessions in your plan</span></div>
    <div class="stat ${openDecisions ? 'warn' : ''}"><b>${openDecisions}</b><span>clashes to decide</span></div>
    <div class="stat ${tight ? 'warn' : ''}"><b>${tight}</b><span>tight transfers</span></div>
    <div class="stat"><b>${sacrificed}</b><span>picks you'll miss</span></div>
  </div>
  <div class="daytabs" role="group" aria-label="Day">${m.days.map(d => `<button type="button" data-act="day" data-day="${attr(d)}" aria-pressed="${d === day}">${esc(fmtDay(d))}<span class="n">${counts[d].chosen}</span>${counts[d].open ? `<span class="w" aria-label="clashes to decide">●</span>` : ''}</button>`).join('')}</div>`);

  if (decisions.length) {
    parts.push(`<h2>Clashes on ${esc(fmtDay(day, true))}</h2>`);
    for (const d of decisions) parts.push(renderDecision(d, plan, c));
  }

  parts.push(`<h2>Your day</h2>`);
  if (!chain.some(x => !x.pseudo)) {
    parts.push(`<div class="panel empty"><h3>Nothing planned on ${esc(fmtDay(day))}</h3><p>Here's what fits best given your interests.</p></div>`);
    if (lunchSlot) parts.push(`<div class="timeline">${lunchRow(lunchSlot)}</div>`);
    parts.push(renderFillers(day, chain, c));
  } else {
    const rows = [];
    const first = chain[0], last = chain[chain.length - 1];
    if (lunchSlot && lunchSlot.end <= first.startMin) rows.push(lunchRow(lunchSlot));
    chain.forEach((x, i) => {
      if (i > 0) {
        const t = trans[i - 1];
        rows.push(renderMove(t, c));
        const lunchHere = lunchSlot && lunchSlot.start >= t.from.endMin && lunchSlot.end <= t.to.startMin;
        if (lunchHere) rows.push(lunchRow(lunchSlot));
        const free = t.gap - t.need - (lunchHere ? plan.lunch.length : 0);
        if (free >= 25) rows.push(renderFree(day, t.from, t.to, c));
      }
      rows.push(`<div class="t-item"><div class="t-time">${fmtTime(x.startMin)}<small>${fmtTime(x.endMin)}</small></div>
        ${x.pseudo ? pseudoRow(x) : card(x.s, { compact: true, extra: lockRow(x) })}</div>`);
    });
    if (lunchSlot && lunchSlot.start >= last.endMin) rows.push(lunchRow(lunchSlot));
    parts.push(`<div class="timeline">${rows.join('')}</div>`);
    parts.push(`<details class="panel" style="margin-top:14px" ${app.openFill === day + ':all' ? 'open' : ''} data-fill="${attr(day)}:all"><summary><b>More sessions that fit around this day</b></summary>${renderFillers(day, chain, c)}</details>`);
  }

  const all = Object.values(plan.res.plan).flat();
  const moved = plan.res.dropped.filter(d => real(d) && d.item.day === day && d.reason.kind === 'repeat');
  if (moved.length) {
    parts.push(`<div class="panel small" style="margin-top:14px"><b>Other runs:</b> ${moved.map(d => {
      const to = all.find(x => x.id === d.item.id);
      if (!to) return esc(d.item.code);
      const link = `<a href="#/plan" data-act="day" data-day="${attr(to.day)}">${esc(to.code)} on ${esc(fmtDay(to.day))} at ${fmtTime(to.startMin)}</a>${to.reserved ? ' (your reserved seat)' : ''}`;
      const here = d.item.reserved ? ` <b style="color:var(--bad)">You reserved a seat for this run.</b>` : '';
      return d.reason.clash ? `${esc(d.item.code)} clashes with ${esc(d.reason.other.code)} here, so you'll catch ${link}${here}` : `${esc(d.item.code)} also runs here; you're attending ${link}${here}`;
    }).join(' · ')}</div>`);
  }
  if (dropped.length) {
    parts.push(`<h2>What you'll miss on ${esc(fmtDay(day))}</h2><p class="lede small">These picks don't fit. Recorded ones can be watched later. Tap <b>Go to this instead</b> to swap one in and the plan will reshuffle.</p>
    <div class="list sacrifices">${dropped.sort((a, b) => (b.item.score ?? b.item.priority * 10) - (a.item.score ?? a.item.priority * 10) || a.item.startMin - b.item.startMin).map(d => {
      const release = chain.filter(p => p.locked && !p.pseudo && !canBoth(p, d.item, c)).map(p => p.id);
      const note = d.item.reserved ? ' · <b>you reserved a seat here</b>' : d.item.recorded ? ' · <b>recorded: watch later</b>' : d.item.recorded === false ? ' · not recorded' : '';
      const action = d.reason.kind === 'block'
        ? `<a class="btn small" href="#/settings">Edit blocked time</a>`
        : `<button class="btn small" data-act="lock" data-key="${attr(d.item.key)}" data-release="${attr(release.join(' '))}">${icon('lock')}Go to this instead</button>`;
      const watch = d.item.recorded !== false && d.reason.kind !== 'block' ? `<button class="btn small ghost" data-act="watch-later" data-key="${attr(d.item.key)}">Watch later</button>` : '';
      return card(d.item.s, { compact: true, extra: `<div class="reason">${icon('x')}<span>${esc(d.reason.text)}${note}</span></div><div class="row" style="margin-top:8px">${action}${watch}</div>` });
    }).join('')}</div>`);
  }
  if (plan.tba.length) {
    parts.push(`<h2>Picks without a time yet</h2><div class="list">${plan.tba.map(x => card(x.s, { compact: true })).join('')}</div>`);
  }
  parts.push(watchSection(plan));
  parts.push(suggestedSection());
  if (plan.online.length) {
    parts.push(`<h2>Online / on demand</h2><div class="list">${plan.online.map(x => card(x.s, { compact: true })).join('')}</div>`);
  }
  parts.push(`<div class="row" style="margin-top:18px">
    <button class="btn" data-act="ics">${icon('plan')}Add plan to calendar (.ics)</button>
    <button class="btn ghost" data-act="unlock-all">Clear all locks</button>
    <a class="btn ghost" href="#/settings">Lunch &amp; blocked time</a></div>
    <p class="legend" style="margin-top:12px">Walking estimates use your Settings (buffer ${c.buffer} min, keynote entry ${c.keynoteExtra} min, accept missing up to ${c.tolerance} min).
    ${app.venue.buildings.filter(b => b.id !== 'O').map(b => `<span>${bldgChip({ building: b.id })} ${esc(b.name)}</span>`).join('')}</p>`);
  return parts.join('');
}

function pseudoRow(x) {
  return `<div class="panel small" style="margin:4px 0">⛔ <b>${esc(x.title)}</b> ${bldgChip(x.loc)} <span class="muted">(blocked time)</span></div>`;
}

function lockRow(x) {
  return `<div class="row" style="margin-top:8px">${x.locked
    ? `<button class="btn small" data-act="unlock" data-key="${attr(x.key)}">${icon('lock')}${x.reserved ? 'Reserved seat' : 'Locked'}, tap to unlock</button>`
    : `<button class="btn small ghost" data-act="lock" data-key="${attr(x.key)}">${icon('lock')}Lock in</button>`}</div>`;
}

function renderMove(t, c) {
  const to = B(t.to.loc.building).short;
  const extra = t.need - t.walk - c.buffer;
  let text;
  if (t.status === 'ok') {
    text = t.stay ? `Same room · ${t.gap} min break` : `${t.walk} min walk to ${esc(to)}${extra > 0 ? ` + ${extra} min to get in` : ''} · ${Math.max(0, t.slack)} min to spare`;
  } else if (t.status === 'tight') {
    text = `<b>Tight:</b> ${t.walk} min walk + ${t.need - t.walk} min buffer, ${t.gap} min gap. Leave ${t.miss} min early or arrive late`;
  } else {
    text = `<b>Can't make it:</b> ${t.walk} min walk, ${t.gap} min gap`;
  }
  return `<div class="t-move ${t.status}"><div></div><div class="line">${icon(t.status === 'ok' ? 'walk' : 'warn')}<span>${text}</span></div></div>`;
}

function renderFree(day, from, to, c) {
  const id = `${day}:${from.key}`;
  const open = app.openFill === id;
  return `<div class="t-free"><div></div><div class="line">Free ${fmtTime(from.endMin)}–${fmtTime(to.startMin)}
    <button class="btn small ghost" data-act="fill" data-fill="${attr(id)}">${open ? 'Hide' : 'What fits?'}</button>
    ${open ? renderFillers(day, [from, to], c, true) : ''}</div></div>`;
}

function renderFillers(day, around, c, between = false) {
  const sg = suggester();
  const cands = app.model.sessions
    .filter(s => s.day === day && s.inPerson && Number.isFinite(s.startMin) && s.endMin > s.startMin)
    .filter(s => { const p = prioOf(s); return p == null || (p > 0 && !app.plan.chosenGroups.has(s.group)); })
    .map(s => ({ key: s.key, id: s.group, code: s.code, type: s.type, day: s.day, startMin: s.startMin, endMin: s.endMin, loc: s.loc, s }));
  let fit = fillers(around, cands, c);
  if (between) fit = fit.filter(x => x.startMin >= around[0].endMin && x.endMin <= around[1].startMin);
  const rank = x => (prioOf(x.s) > 0 ? 1000 + prioOf(x.s) : 0) + (sg.ready ? sg.score(x.s).score : 0);
  fit.sort((a, b) => rank(b) - rank(a) || a.startMin - b.startMin);
  const top = fit.slice(0, 8);
  if (!top.length) return `<p class="small muted" style="margin:8px 0">Nothing else fits${around.length ? ' without breaking your plan' : ''}.</p>`;
  return `<div class="list" style="margin:8px 0">${top.map(x => { const r = sg.ready ? sg.score(x.s) : null; return card(x.s, { compact: true, extra: r?.score >= 25 ? suggestExtra({ s: x.s, ...r }) : '' }); }).join('')}</div>
    ${fit.length > top.length ? `<p class="small muted">${fit.length - top.length} more fit. Filter Browse by this day to see them.</p>` : ''}`;
}

// Why y can't fit around the chosen chain: grouped by the session that blocks it.
function missSummary(missed, chain, c) {
  const overlapBy = new Map(), walks = [], other = [];
  for (const y of missed) {
    const z = chain.find(z => z.day === y.day && !canBoth(z, y, c));
    if (!z) other.push(y.code);
    else if (overlaps(z, y)) { if (!overlapBy.has(z.code)) overlapBy.set(z.code, []); overlapBy.get(z.code).push(y.code); }
    else {
      const [a, b] = z.startMin <= y.startMin ? [z, y] : [y, z];
      const t = transition(a, b, c);
      walks.push(`${y.code} (${t.walk} min walk ${B(a.loc.building).short} → ${B(b.loc.building).short}, ${Math.max(0, t.gap)} min gap)`);
    }
  }
  const parts = [...[...overlapBy].map(([by, codes]) => `${codes.join(', ')} (same time as ${by})`), ...walks];
  if (other.length) parts.push(`${other.join(', ')} (lower value)`);
  return parts.join(' · ');
}

function renderDecision(d, plan, c) {
  const allItems = [...plan.items, ...plan.blocks];
  const releaseFor = x => new Set([x.key, ...d.items.filter(o => !o.locked).map(o => o.key), ...d.items.filter(o => o.locked && o.id !== x.id && !canBoth(o, x, c)).map(o => o.key)]);
  const outcome = new Map(d.items.map(x => [x.key, whatIf(allItems, x.key, releaseFor(x), c, plan.lunch)]));
  const feasibleVals = d.items.map(x => outcome.get(x.key)).filter(o => o.feasible).map(o => o.value);
  const best = feasibleVals.length ? Math.max(...feasibleVals) : 0;
  const isBest = x => outcome.get(x.key).feasible && outcome.get(x.key).value >= best - 0.5;
  const ties = d.items.filter(isBest).length;
  const decided = d.resolved ? d.items.find(x => x.locked) : null;
  const lockedOthers = x => d.items.filter(o => o.locked && o.id !== x.id && !canBoth(o, x, c)).map(o => o.id);
  // Best outcome first so the decision can be made at a glance.
  const opts = d.items.slice().sort((a, b) => (b.locked - a.locked) || (outcome.get(b.key).value - outcome.get(a.key).value) || a.startMin - b.startMin);
  const preview = app.model.mode === 'preview';
  const row = x => {
    const o = outcome.get(x.key);
    const keysX = new Set(o.chosen.map(y => y.key));
    const groupsX = new Set(o.chosen.map(y => y.id));
    const also = d.items.filter(y => y !== x && keysX.has(y.key));
    const moved = d.items.filter(y => y !== x && !keysX.has(y.key) && groupsX.has(y.id)).map(y => ({ y, to: o.chosen.find(z => z.id === y.id) }));
    const miss = d.items.filter(y => y !== x && !groupsX.has(y.id));
    const top = isBest(x);
    const label = x.locked ? (x.reserved ? 'Reserved seat' : 'Your choice') : decided ? '' : top ? (ties > 1 ? 'Toss-up: your call' : 'Best for your plan') : '';
    const w = weigh(x, c);
    const repeat = (app.model.byGroup.get(x.s.group) || []).filter(r => r.key !== x.key && r.day);
    const diff = Math.round(best - o.value);
    return `<div class="option ${(x.locked || (!decided && top)) ? 'rec' : ''}">
      <div>
        ${label ? `<div class="tag-rec">${esc(label)}</div>` : ''}
        <div class="row small"><b>${fmtTime(x.startMin)}–${fmtTime(x.endMin)}</b>${prioPill(x.priority)}${scoreChip(x.score)}${bldgChip(x.loc)}${recChip(x)}</div>
        <a class="title" href="#/session/${encodeURIComponent(x.code)}" data-act="open" data-key="${attr(x.key)}" style="font-weight:700;display:block;margin:4px 0;color:var(--text);text-decoration:none">${esc(x.code)} · ${esc(x.title)}</a>
        <div class="why">${w.why.map(esc).join(' · ')}</div>
        ${!o.feasible ? `<div class="lose">Not possible with the sessions or blocked time you've locked</div>` : `
        ${also.length ? `<div class="why">${icon('check')} Then you also make ${esc(also.map(y => y.code).join(', '))}</div>` : ''}
        ${moved.length ? `<div class="why">${icon('check')} ${moved.map(m => `${esc(m.y.code)} moves to ${esc(m.to.code)} ${esc(fmtDay(m.to.day))} ${fmtTime(m.to.startMin)}`).join(' · ')}</div>` : ''}
        ${miss.length ? `<div class="lose">You'd miss ${esc(missSummary(miss, o.chosen, c))}</div>` : ''}
        <div class="why">Plan value ${Math.round(o.value)}${diff > 0 ? ` (${diff} less than the best option)` : ''}</div>`}
        ${repeat.length ? `<div class="why">Also runs ${repeat.map(r => `${r.code} ${fmtDay(r.day)} ${fmtTime(r.startMin)}`).map(esc).join(', ')}</div>` : ''}
      </div>
      <div class="btns">
        ${x.locked ? `<button class="btn small" data-act="unlock" data-key="${attr(x.key)}">Undo choice</button>`
          : `<button class="btn small ${!decided && top && ties === 1 ? 'primary' : ''}" data-act="lock" data-key="${attr(x.key)}" data-release="${attr(lockedOthers(x).join(' '))}" ${o.feasible ? '' : 'disabled'}>${icon('check')}Go to this</button>`}
        ${x.recorded !== false ? `<button class="btn small ghost" data-act="watch-later" data-key="${attr(x.key)}" title="Keep it on the watch-later list instead">Watch later</button>` : ''}
        <button class="btn small ghost" data-act="not-going" data-key="${attr(x.key)}" ${preview ? 'data-preview="1"' : ''} title="Mark as Skip">Not going</button>
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
  const t = nowLocal(app.simNow, app.conf.tz);
  const plan = computePlan();
  const c = ctx();
  const m = app.model;
  const days = m.days.length ? m.days : app.conf.days;
  const sim = `<div class="panel sim-panel" style="margin-top:14px"><h3>Rehearse a moment</h3>
    <p class="small muted">Pick a day and time to see what this screen will tell you at the conference. Only for this visit; the real clock comes back next time.</p>
    <div class="sim"><select id="sim-day" aria-label="Day">${days.map(d => `<option value="${attr(d)}" ${app.simNow?.day === d ? 'selected' : ''}>${esc(fmtDay(d))}</option>`).join('')}</select>
    <input id="sim-time" type="time" aria-label="Time" value="${app.simNow ? hhmm(app.simNow.min) : '10:00'}">
    <button class="btn small" data-act="sim">Simulate</button>${app.simNow ? `<button class="btn small ghost" data-act="sim-off">Use real time</button>` : ''}</div></div>`;
  const simBanner = app.simNow ? `<div class="banner warn">${icon('clock')}<div><b>Simulated time: not the real clock</b><button class="btn small" data-act="sim-off">Use real time</button></div></div>` : '';
  const tzName = app.conf.tz === 'America/New_York' ? 'Eastern time' : app.conf.tz === 'America/Los_Angeles' ? 'Pacific time' : app.conf.tz;
  const clock = `<div class="row"><div class="big-time">${fmtTime(t.min)}</div><div class="muted">${esc(fmtDay(t.day, true))}${app.simNow ? ' · <span class="chip preview">Simulated</span>' : ` · ${esc(tzName)}`}</div></div>`;
  if (m.mode === 'unscheduled') {
    return `<h1>Now</h1>${simBanner}${clock}<div class="panel empty"><h3>Available once the schedule is out</h3><p>At the conference this screen shows where you should be, when to leave, and what's starting nearby if a room is full. You can rehearse it with the simulated preview schedule.</p>
      <button class="btn primary" data-act="preview-on">Turn on preview</button></div>`;
  }
  const dayPlan = plan.res.plan[t.day] || [];
  const startFrom = s.startFrom && app.venue.BUILDING[s.startFrom] ? s.startFrom : app.venue.startFrom;
  const origin = { label: '', building: startFrom, floor: null, known: true };
  const nn = nowNext(dayPlan, t.min, c, origin, plan.res.lunch?.[t.day] || null);
  const parts = [`<h1>Now</h1>${simBanner}${previewBanner()}${clock}`];
  if (!m.days.includes(t.day)) {
    parts.push(`<div class="panel empty"><h3>No sessions today</h3><p>The conference runs ${esc(fmtDay(m.days[0]))} to ${esc(fmtDay(m.days[m.days.length - 1]))}.</p></div>`);
    parts.push(sim);
    return parts.join('');
  }
  const cards = [];
  const show = x => (x.pseudo === 'lunch' ? `<div class="panel small">🍽 <b>Lunch break</b> ${fmtTime(x.startMin)}–${fmtTime(x.endMin)}</div>` : x.pseudo ? pseudoRow(x) : card(x.s, { compact: true, noActions: true }));
  if (nn.current) {
    cards.push(`<div class="card now-card"><div class="label">Now · until ${fmtTime(nn.current.endMin)}</div>${show(nn.current)}</div>`);
  }
  if (nn.next) {
    cards.push(`<div class="card now-card"><div class="label">Next · ${fmtTime(nn.next.startMin)} (in ${fmtDuration(nn.next.startMin - t.min)})</div>${show(nn.next)}`);
    if (!nn.next.pseudo) {
      const left = nn.leaveBy - t.min;
      const cls = left < 0 ? 'late' : left <= 5 ? 'soon' : '';
      const fromText = nn.from?.key === 'origin' ? ` from ${B(origin.building).short}` : '';
      const walkText = nn.walk != null ? ` · ${nn.walk} min walk${fromText}${nn.extra ? ` + ${nn.extra} min to get in` : ''}` : '';
      const msg = left < 0 ? `You should have left ${fmtDuration(-left)} ago${walkText}` : `Leave by ${fmtTime(nn.leaveBy)}, ${left ? `in ${fmtDuration(left)}` : 'now'}${walkText}`;
      cards.push(`<div class="leave ${cls}">${icon('walk')}<span>${esc(msg)}</span></div>`);
    }
    cards.push('</div>');
  } else if (!nn.current) {
    cards.push(`<div class="panel"><h3>Nothing else planned today</h3><p class="muted">See what's starting soon, or check tomorrow's plan.</p></div>`);
  }
  // Starting soon, ranked by priority, likeness to your picks, then distance from where you are.
  const sg = suggester();
  const here = nn.from;
  const soon = m.sessions
    .filter(x => x.day === t.day && x.inPerson && x.startMin >= t.min - 5 && x.startMin <= t.min + 45 && prioOf(x) !== 0)
    .map(x => ({ s: x, walk: here ? walkMinutes(here.loc, x.loc, c.walk) : null, p: prioOf(x) ?? 0, i: sg.ready ? sg.score(x).score : 0 }))
    .sort((a, b) => b.p - a.p || b.i - a.i || (a.walk ?? 99) - (b.walk ?? 99))
    .slice(0, 10);
  const soonHtml = `<div><h2 style="margin-top:0">Starting soon nearby</h2><p class="small muted">Backups if a room is full, ranked by your priorities and interests, then distance.</p>
    <div class="list">${soon.map(x => card(x.s, { compact: true, extra: x.walk != null ? `<div class="reason ok">${icon('walk')}<span>${x.walk} min walk · starts ${fmtTime(x.s.startMin)}${x.i >= 25 ? ` · ${x.i}% like your picks` : ''}</span></div>` : '' })).join('') || '<p class="muted">Nothing starting in the next 45 minutes.</p>'}</div></div>`;
  parts.push(`<div class="now-grid"><div class="stack">${cards.join('')}${sim}</div>${soonHtml}</div>`);
  return parts.join('');
}

// ---------------------------------------------------------------- changes

function fmtStamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : new Intl.DateTimeFormat('en-US', { timeZone: app.conf.tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

function rsvpBanner(plan) {
  const all = Object.values(plan.res.plan).flat();
  const firstOf = new Map();
  for (const x of [...plan.items, ...plan.tba]) if (x.priority >= 2 && x.s.rsvp && !firstOf.has(x.id)) firstOf.set(x.id, x);
  const need = [], mismatch = [];
  for (const [g, x] of firstOf) {
    const gp = groupPick(g);
    if (gp?.reserved) {
      if (plan.chosen.has(gp.reserved)) continue;
      const attending = all.find(y => y.id === g);
      if (attending) mismatch.push({ reserved: app.model.byKey.get(gp.reserved), attending });
    } else if (plan.chosen.has(x.key) || !plan.chosenGroups.has(g)) need.push(x);
  }
  const parts = [];
  if (mismatch.length) {
    parts.push(`<div class="banner bad">${icon('warn')}<div><b>Your plan skips a seat you reserved</b>
      <p>${mismatch.map(m => `You reserved <b>${esc(m.reserved?.code || '?')}</b> (${esc(m.reserved ? whenText(m.reserved) : '')}) but the plan attends <b>${esc(m.attending.code)}</b> (${esc(whenText(m.attending.s))}).
        <button class="btn small" data-act="lock" data-key="${attr(m.reserved?.key || '')}">Attend the reserved run</button>`).join('<br>')}</p></div></div>`);
  }
  if (need.length) {
    const opens = need.map(x => x.s.rsvp).find(v => typeof v === 'string');
    const open = !opens || new Date(opens).getTime() <= Date.now();
    const list = need.map(x => `<a href="${attr(app.conf.sessionUrl(x.s))}" target="_blank" rel="noopener">${esc(x.code)}</a>`).join(', ');
    parts.push(`<div class="banner ${open ? 'warn' : ''}">${icon(open ? 'warn' : 'bell')}<div><b>${need.length} of your Must/Want picks need a seat reservation</b>
      <p>${open ? `Seats are limited: reserve on ${esc(app.conf.siteName)}, then tap <b>I reserved a seat</b> on the session.` : opens ? `Reservations open ${esc(fmtStamp(opens))}. Seats are limited.` : 'Seats are limited.'}</p>
      <details><summary class="small">Show which</summary><p class="small">${list}</p></details></div></div>`);
  }
  return parts.join('');
}

function fieldLabel(k) {
  return { start: 'Start', end: 'End', slot: 'Time slot', dur: 'Length', room: 'Room', title: 'Title', code: 'Code', type: 'Type', speakers: 'Speakers', level: 'Level', delivery: 'Format', recorded: 'Recorded', desc: 'Description' }[k] || k;
}
function fmtVal(k, v) {
  if (v == null || v === '') return '—';
  if ((k === 'start' || k === 'end') && typeof v === 'string') return fmtStamp(v);
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}
function diffHtml(fields) {
  return Object.entries(fields).map(([k, v]) => v === true
    ? `${esc(fieldLabel(k))} updated`
    : `${esc(fieldLabel(k))}: <del>${esc(fmtVal(k, v?.[0]))}</del> → <ins>${esc(fmtVal(k, v?.[1]))}</ins>`).join('<br>');
}

function changeItems(b) {
  return [
    ...(b.added || []).map(x => ({ ...x, k: 'Added' })),
    ...(b.removed || []).map(x => ({ ...x, k: 'Removed' })),
    ...(b.changed || []).map(x => ({ ...x, k: 'Changed' })),
  ];
}

function changeList(items, isMine) {
  return `<ul>${items.slice(0, 60).map(x => `<li class="${isMine(x) ? 'mine' : ''}"><span class="chip">${esc(x.k)}</span> <a href="#/session/${encodeURIComponent(x.code)}" data-act="open-code" data-code="${attr(x.code)}"><b>${esc(x.code)}</b></a> ${esc(x.title)}
    ${x.f ? `<div class="diff">${diffHtml(x.f)}</div>` : ''}</li>`).join('')}
    ${items.length > 60 ? `<li class="muted">…and ${items.length - 60} more</li>` : ''}</ul>`;
}

function flagsLine(flags) {
  if (!flags) return '';
  const on = (k, yes, no) => (flags[k] ? `<b style="color:var(--ok)">${yes}</b>` : no);
  return `Ignite site: ${on('showSessionTimeSlots', 'times shown', 'times hidden')} · ${on('showLocations', 'locations shown', 'locations hidden')} · ${on('enableMySchedule', 'schedule builder open', 'schedule builder off')}`;
}

function alertHtml(a) {
  const planned = app.plan?.chosen?.has(a.inst);
  const tag = planned ? ' <span class="chip new">in your plan</span>' : '';
  if (a.kind === 'removed') return `<b>${esc(a.code)}</b> ${esc(a.title)} <b style="color:var(--bad)">was removed from the catalog</b>`;
  if (a.kind === 'run-removed') return `<b>${esc(a.code)}</b> ${esc(a.title)}: <b style="color:var(--bad)">this run was cancelled</b>. Still runs as ${esc(a.remaining.join(', '))}`;
  if (a.kind === 'run-added') return `<b>${esc(a.code)}</b> ${esc(a.title)}: <b style="color:var(--ok)">new run added</b>, another chance to fit it in${tag}`;
  return `<b>${esc(a.code)}</b> ${esc(a.title)}${tag}<div class="diff">${diffHtml(a.fields)}</div>`;
}

function isMineFn() {
  const mine = pickedGroups();
  const picks = store.get().picks;
  return x => {
    const s = app.model.byId.get(x.id)?.[0] || app.model.byCode.get(x.code);
    if (s) return mine.has(s.group);
    const pk = picks[x.id];
    return !!(pk && pk.p > 0) || mine.has(x.code) || mine.has(String(x.code || '').replace(/-R\d+$/i, ''));
  };
}

function renderChanges() {
  const meta = app.raw.meta || {};
  const batches = app.raw.changes?.batches || [];
  const onlyMine = !!store.get().ui.onlyMine;
  const isMine = isMineFn();
  const st = app.raw.doc.stats || meta.stats || {};
  const repo = store.settings().repo;
  const n = v => Number(v) || 0;
  const parts = [`<h1>Changes</h1>`];
  if (app.conf.live) {
    parts.push(`<p class="lede">The app checks ${esc(app.conf.siteName)} directly whenever you open it. A scheduled cloud sync also logs every difference here and posts it to GitHub, which can email you. Changes to your picks are highlighted.</p>`);
  } else {
    parts.push(`<p class="lede">This catalog comes from your ${esc(app.conf.siteName)} export (${esc(fmtStamp(app.raw.doc.generatedAt))}). Re-run <code>scripts/import_gartner.py</code> with a new export to update it; differences are logged here and changes to your picks are highlighted.</p>`);
  }
  if (app.alerts.length) {
    parts.push(`<section class="card batch"><header><b>${icon('warn')} ${app.alerts.length} change${app.alerts.length > 1 ? 's' : ''} to your picks since you last looked</b><span class="spacer"></span><button class="btn small primary" data-act="ack">Got it</button></header><ul>
      ${app.alerts.map(a => `<li class="mine">${alertHtml(a)}</li>`).join('')}</ul></section>`);
  }
  if (app.conf.live) {
    const liveLine = CUSTOM_DATA ? 'Live check is off while viewing test data.'
      : app.live ? `Live check ${esc(relTime(app.live.at))}${app.live.stale ? ` (the latest check failed: ${esc(app.liveError || 'offline')})` : ''}: ${app.live.same ? 'matches the last sync' : `<b>${esc(app.conf.siteName)} has changes newer than the last sync</b> (shown below)`}`
      : app.liveError ? `<span style="color:var(--bad)">Live check failed: ${esc(app.liveError)}</span>. Showing the synced copy.` : 'Live check running…';
    parts.push(`<div class="panel stack"><div class="row"><b>Sync status</b><span class="spacer"></span>
        <button class="btn small" data-act="refresh">${icon('refresh')}Check now</button>
        ${app.local ? `<button class="btn small" data-act="sync-local">${icon('refresh')}Re-sync &amp; log</button>` : ''}
        ${repo && !app.local ? `<a class="btn small ghost" href="https://github.com/${attr(repo)}/actions/workflows/sync.yml" target="_blank" rel="noopener">Cloud sync ${icon('ext')}</a>` : ''}</div>
      <div class="small muted">${liveLine}<br>
        Cloud sync last ran <b>${esc(relTime(meta.lastChecked))}</b>, catalog last changed ${esc(relTime(meta.lastChanged))}${meta.ok === false ? ` · <span style="color:var(--bad)">failed: ${esc(meta.error || 'unknown error')}</span>` : ''}<br>
        ${n(st.sessions) || app.model.sessions.length} sessions · ${n(st.withDates)} with dates · ${n(st.withRooms)} with rooms${n(st.draftTimes) ? ` · ${n(st.draftTimes)} placeholder times ignored` : ''}<br>
        ${flagsLine(app.live?.flags || app.snapshot?.doc?.siteFlags || meta.siteFlags)}</div></div>`);
    if (app.live && !app.live.same) {
      const items = changeItems(app.live.diff).filter(x => !onlyMine || isMine(x));
      parts.push(`<section class="card batch" style="margin-top:14px"><header><b>Live on ${esc(app.conf.siteName)} now</b><span class="muted small">not yet in the history log</span><span class="spacer"></span>
        <span class="small muted">+${app.live.diff.added.length} · −${app.live.diff.removed.length} · ~${app.live.diff.changed.length}</span></header>${changeList(items, isMine)}</section>`);
    }
  }
  parts.push(`<div class="row" style="margin:16px 0 8px"><h2 style="margin:0">History</h2><span class="spacer"></span>
    <label class="toggle" style="padding:0"><input type="checkbox" id="only-mine" ${onlyMine ? 'checked' : ''}> <span>Only my picks</span></label></div>`);
  if (!batches.length) {
    parts.push(`<div class="panel empty"><h3>No changes logged yet</h3><p>The first import took a baseline snapshot. When sessions are added, removed, retimed or moved, it shows up here.</p></div>`);
  }
  const seen = store.get().seenBatch;
  for (const b of batches.slice(0, 40)) {
    const items = changeItems(b).filter(x => !onlyMine || isMine(x));
    if (onlyMine && !items.length && !b.milestones?.length) continue;
    parts.push(`<section class="card batch">
      <header><b>${esc(fmtStamp(b.at))}</b><span class="muted small">${esc(relTime(b.at))}</span>
        <span class="spacer"></span><span class="small muted">+${n(b.added?.length)} · −${n(b.removed?.length)} · ~${n(b.changed?.length)}</span>${!seen || b.at > seen ? '<span class="chip new">New</span>' : ''}</header>
      ${(b.milestones || []).map(m => `<div class="milestone">${esc(m)}</div>`).join('')}
      ${changeList(items, isMine)}</section>`);
  }
  return parts.join('');
}

// ---------------------------------------------------------------- settings

function numField(path, label, value, hint = '', min = 0, max = 120) {
  return `<div class="field"><label for="f-${attr(path)}">${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</label>
    <input id="f-${attr(path)}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" data-set="${attr(path)}" value="${attr(value)}"></div>`;
}

function buildingOptions(selected) {
  return app.venue.buildings.filter(b => b.id !== 'O').map(b => `<option value="${attr(b.id)}" ${selected === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
}

function renderSettings() {
  const s = store.settings();
  const walk = walkCfg();
  const ids = app.venue.ids.filter(id => id !== 'O');
  const matrix = `<div class="matrix-wrap"><table class="matrix"><thead><tr><th></th>${ids.map(i => `<th title="${attr(B(i).name)}">${esc(B(i).short)}</th>`).join('')}</tr></thead><tbody>
    ${ids.map(a => `<tr><th>${esc(B(a).short)}</th>${ids.map(b => {
      const key = [a, b].sort().join('|');
      if (a === b) return app.venue.walk.pairs[key] != null ? `<td><input type="number" min="0" max="240" data-set="walk.pairs.${attr(key)}" value="${attr(walk.pairs[key])}" aria-label="Between ${attr(B(a).name)} venues"></td>` : '<td class="na">—</td>';
      if (ids.indexOf(b) < ids.indexOf(a)) return '<td class="na">·</td>';
      return `<td><input type="number" min="0" max="240" data-set="walk.pairs.${attr(key)}" value="${attr(walk.pairs[key] ?? walk.unknown)}" aria-label="${attr(B(a).name)} to ${attr(B(b).name)}"></td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>`;
  const auto = app.model.locations.map(l => ({ l, auto: app.venue.parseLocation(l, {}) }));
  const unknown = auto.filter(x => !x.auto.known || s.overrides[x.l]);
  const theme = document.documentElement.dataset.theme || 'auto';
  const ov = list => list.map(({ l, auto: a }) => `<div class="field"><label>${esc(l)}<small>detected: ${esc(B(a.building).name)}</small></label>
      <select data-override="${attr(l)}"><option value="">Auto</option>${app.venue.buildings.map(b => `<option value="${attr(b.id)}" ${s.overrides[l] === b.id ? 'selected' : ''}>${esc(b.short)}</option>`).join('')}</select></div>`).join('');
  const days = app.model.days.length ? app.model.days : app.conf.days;
  const l = s.lunch;
  const blocks = (s.blocks || []).slice().sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.start - b.start));
  const fav = app.snapshot?.favorites;
  const favN = fav ? Object.keys(fav.picks || {}).length : 0;
  const startFrom = s.startFrom && app.venue.BUILDING[s.startFrom] ? s.startFrom : app.venue.startFrom;
  return `<h1>Settings</h1><p class="lede">Tune how the planner trades sessions off. Changes apply instantly and stay on this device, per conference.</p>
  <div class="settings-grid">
    <section class="panel"><h3>Conference</h3>
      <div class="field"><label for="conf-select">Showing<small>${esc(app.conf.place)} · ${esc(fmtDay(app.conf.days[0]))} – ${esc(fmtDay(app.conf.days[app.conf.days.length - 1]))}</small></label>
        <select id="conf-select">${conferenceList().map(cf => `<option value="${attr(cf.id)}" ${cf.id === app.conf.id ? 'selected' : ''}>${esc(cf.name)}</option>`).join('')}</select></div>
      <p class="small muted">${esc(app.conf.hint)} Picks, settings and notes are kept separately for each conference.</p>
      ${favN ? `<div class="row"><button class="btn small" data-act="favorites-import">Import my workbook favorites (${favN})</button></div><p class="small muted">Ratings, scores and watch-later marks from your spreadsheet. Importing replaces ratings for those sessions and keeps your notes.</p>` : ''}
    </section>
    <section class="panel"><h3>Getting between rooms</h3>
      ${numField('buffer', 'Buffer per move (min)', s.buffer, 'Finding the room, grabbing a seat')}
      ${numField('tolerance', 'OK to miss up to (min)', s.tolerance, 'Leave early or arrive late. Never more than ¼ of a session')}
      ${numField('keynoteExtra', 'Getting into a keynote (min)', s.keynoteExtra, 'Security, seating, shuttle lines', 0, 120)}
      ${numField('walk.sameFloor', 'Same building, same floor', walk.sameFloor)}
      ${numField('walk.diffFloor', 'Same building, different floor', walk.diffFloor)}
      ${numField('walk.unknown', 'Room not known yet', walk.unknown)}
      <div class="field"><label for="start-from">Each day starts from<small>Used for “leave by” before your first session</small></label>
        <select id="start-from" data-pref="startFrom">${buildingOptions(startFrom)}</select></div>
      <h3 style="margin-top:12px">Walking minutes between buildings</h3>
      ${matrix}
      <p class="small muted">${esc(app.venue.notes)}</p>
    </section>
    <section class="panel"><h3>Lunch &amp; blocked time</h3>
      <label class="toggle"><input type="checkbox" id="lunch-on" ${l.on ? 'checked' : ''}><span>Protect a lunch break<small>The planner keeps a ${l.length}-minute gap somewhere in this window, allowing for the walk, on days you have sessions</small></span></label>
      <div class="field"><label for="lunch-from">Window starts</label><input id="lunch-from" type="time" value="${hhmm(l.from)}" data-lunch="from"></div>
      <div class="field"><label for="lunch-to">Window ends</label><input id="lunch-to" type="time" value="${hhmm(l.to)}" data-lunch="to"></div>
      <div class="field"><label for="lunch-length">Length (min)</label><input id="lunch-length" type="number" min="10" max="120" value="${attr(l.length)}" data-lunch="length"></div>
      <div class="field"><label for="lunch-weight">How much it matters<small>Lunch gives way to anything worth more: a Maybe scores 20, a Want 50, a Must 100</small></label><input id="lunch-weight" type="number" min="0" max="1000" value="${attr(l.weight)}" data-lunch="weight"></div>
      <h3 style="margin-top:14px">Blocked time</h3>
      <p class="small muted">Meetings, booth duty, a flight. The plan works around these, including the walk to and from them.</p>
      ${blocks.map(b => `<div class="inst"><b>${esc(fmtDay(b.day))} ${fmtTime(b.start)}–${fmtTime(b.end)}</b><span>${esc(b.label)}</span>${bldgChip({ building: b.building })}<span class="spacer"></span><button class="btn small ghost" data-act="block-del" data-id="${attr(b.id)}">Remove</button></div>`).join('') || '<p class="small muted">Nothing blocked yet.</p>'}
      <div class="stack" style="margin-top:8px">
        <div class="row"><select id="blk-day" aria-label="Day">${days.map(d => `<option value="${attr(d)}">${esc(fmtDay(d))}</option>`).join('')}</select>
          <input id="blk-start" type="time" value="14:00" aria-label="From"> <input id="blk-end" type="time" value="15:00" aria-label="To"></div>
        <input id="blk-label" type="text" maxlength="80" placeholder="What is it? (e.g. Customer meeting)" aria-label="What is it?" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--surface)">
        <div class="row"><select id="blk-bldg" aria-label="Where" style="flex:1;min-width:0">${buildingOptions(app.venue.startFrom)}</select>
          <button class="btn small" data-act="block-add">Add block</button></div>
      </div>
    </section>
    <section class="panel"><h3>How to break ties</h3>
      ${numField('weights.3', 'Points for a Must', s.weights[3], '', 0, 1000)}
      ${numField('weights.2', 'Points for a Want', s.weights[2], '', 0, 1000)}
      ${numField('weights.1', 'Points for a Maybe', s.weights[1], '', 0, 1000)}
      ${numField('weights.scoreScale', 'Points per point of your score', s.weights.scoreScale, 'A workbook score of 9 = 90 points; it replaces the Must/Want weighting', 0, 100)}
      ${numField('weights.recordedPenalty', 'Recorded: “watch later” discount', s.weights.recordedPenalty, 'Higher = prefer things you can only see live', 0, 200)}
      ${numField('weights.notRecordedBonus', 'Not recorded: bonus', s.weights.notRecordedBonus, '', 0, 200)}
      ${numField('weights.handsOnBonus', 'Labs & table talks: bonus', s.weights.handsOnBonus, 'In-person only experiences', 0, 200)}
      ${numField('weights.tightPerMin', 'Cost per minute missed', s.weights.tightPerMin, 'For tight transfers', 0, 50)}
      <div class="row" style="margin-top:10px"><button class="btn small" data-act="reset-settings">Restore defaults</button></div>
    </section>
    <section class="panel"><h3>Display</h3>
      ${app.conf.live ? `<label class="toggle"><input type="checkbox" data-toggle="preview" ${s.preview ? 'checked' : ''}><span>Preview with a simulated schedule<small>Only works until the real times are published, then switches itself off. Clearly marked “Preview”.</small></span></label>` : ''}
      <label class="toggle"><input type="checkbox" data-toggle="hideOnline" ${s.hideOnline ? 'checked' : ''}><span>Hide online-only sessions</span></label>
      <div class="field"><label for="theme">Theme</label><select id="theme">${['auto', 'light', 'dark'].map(t => `<option ${theme === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    </section>
    <section class="panel"><h3>Your data</h3>
      <p class="small muted">Picks live on this device${STANDALONE ? ' (in this Home Screen app)' : ''}. Use a backup file or a share link to move them between devices.</p>
      <div class="row"><button class="btn small" data-act="export">Save a backup</button>
        <label class="btn small">Restore backup<input type="file" accept="application/json,.json" id="import-file" hidden></label>
        <button class="btn small" data-act="share">Copy link to my picks</button></div>
      <div class="field" style="grid-template-columns:1fr;margin-top:10px"><label for="import-code">Import picks from a link<small>Paste a link copied on another device (e.g. Safari → Home Screen app)</small></label></div>
      <div class="row"><input id="import-code" type="text" inputmode="url" autocomplete="off" placeholder="https://…#/import/…" style="flex:1;min-width:0;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:var(--surface)">
        <button class="btn small" data-act="import-code">Import</button></div>
      ${app.conf.live ? `<h3 style="margin-top:14px">Email alerts for your picks</h3>
      <p class="small muted">The cloud sync posts every catalog change as a GitHub issue comment (GitHub can email you). It stars changes to codes in <code>${esc(app.conf.dataDir)}/watchlist.json</code>. Copy your Must/Want list, then paste it into that file.</p>
      <div class="row"><button class="btn small" data-act="watchlist">Copy watchlist</button>
        ${s.repo ? `<a class="btn small ghost" target="_blank" rel="noopener" href="https://github.com/${attr(s.repo)}/edit/main/${attr(app.conf.dataDir)}/watchlist.json">Edit on GitHub ${icon('ext')}</a>` : ''}</div>` : ''}
      <div class="row" style="margin-top:14px"><button class="btn small danger" data-act="reset-all">Erase my ratings, locks &amp; notes</button></div>
    </section>
    ${app.model.locations.length ? `<section class="panel" style="grid-column:1/-1"><h3>Room → building</h3>
      <p class="small muted">${unknown.length ? `${unknown.length} location(s) couldn't be matched to a building automatically. Set them so walking times are right.` : 'All locations were matched to a building automatically.'}</p>
      ${ov(unknown)}
      <details><summary class="small">All ${auto.length} locations</summary>${ov(auto.filter(x => !unknown.includes(x)))}</details></section>` : ''}
  </div>
  <p class="small muted" style="margin-top:20px">Unofficial personal tool, not affiliated with Microsoft or Gartner. Session data comes from each conference's catalog.</p>`;
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
  const gp = groupPick(s.group);
  const p = gp?.p ?? null;
  const plan = computePlan();
  const c = ctx();
  const insts = groupOf(s);
  const conflicts = [];
  if (s.day && Number.isFinite(s.startMin)) {
    const me = { key: s.key, id: s.group, day: s.day, startMin: s.startMin, endMin: s.endMin, loc: s.loc, type: s.type };
    for (const x of Object.values(plan.res.plan).flat()) {
      if (x.id === s.group || x.day !== s.day) continue;
      if (!canBoth(me, x, c)) {
        const [a, b] = x.startMin <= me.startMin ? [x, me] : [me, x];
        const t = transition(a, b, c);
        conflicts.push(`${esc(x.code)} ${esc(x.title)} (${overlaps(x, me) ? 'overlaps' : `${t.walk} min walk, ${Math.max(0, t.gap)} min gap`})`);
      }
    }
  }
  const sg = suggester();
  const sugg = p == null && sg.ready ? sg.score(s) : null;
  const sp = s.speakers || [];
  const runRow = o => {
    const locked = gp?.lock === o.key, reserved = gp?.reserved === o.key;
    const btns = [];
    if (o.day) btns.push(locked ? `<button class="btn small" data-act="unlock" data-key="${attr(o.key)}">${reserved ? 'Undo reservation' : 'Unlock'}</button>` : `<button class="btn small" data-act="lock" data-key="${attr(o.key)}">${icon('lock')}${insts.length > 1 ? 'Attend this run' : 'Lock in'}</button>`);
    if (o.rsvp) btns.push(reserved ? `<span class="chip new">Reserved ✓</span>` : `<button class="btn small ghost" data-act="reserve" data-key="${attr(o.key)}">I reserved a seat</button>`);
    return `<div class="inst ${locked ? 'locked' : ''}"><b>${esc(o.code)}</b><span>${esc(whenText(o))}</span>${o.day ? bldgChip(o.loc) : ''}<span class="spacer"></span>${btns.join('')}</div>`;
  };
  return `<div class="d-head">
      <button class="btn ghost small d-close" data-act="close" aria-label="Close">${icon('x')}</button>
      <div class="row small muted"><span style="font-family:var(--mono);font-weight:600">${esc(s.code)}</span>·${esc(s.type)}${s.level ? ` · Level ${esc(s.level)}` : ''}${s.dur ? ` · ${fmtDuration(s.dur)}` : ''}</div>
      <h2 id="detail-title">${esc(s.title)}</h2>
      <div class="row">${prioControl(s.key, p, true)}</div>
    </div>
    <div class="d-body">
      ${s.timeSource === 'preview' ? `<div class="banner warn">${icon('warn')}<div><b>Simulated time and room</b><p>Preview mode. The real schedule hasn't been published.</p></div></div>` : ''}
      ${sugg?.score >= 25 ? suggestExtra({ s, ...sugg }) : ''}
      <dl>
        <dt>When</dt><dd>${esc(whenText(s))}</dd>
        <dt>Where</dt><dd>${s.onlineOnly ? 'Online' : `${bldgChip(s.loc)} ${esc(s.roomLabel)}`}</dd>
        <dt>Recording</dt><dd>${s.recorded === true ? 'Will be recorded: you can watch it later' : s.recorded === false ? '<b>Not recorded</b>: in person only' : 'Unknown'}</dd>
        ${s.rsvp ? `<dt>Reservation</dt><dd><b>Required</b>, seats are limited${typeof s.rsvp === 'string' ? `. Opens ${esc(fmtStamp(s.rsvp))} on ${esc(app.conf.siteName)}` : ''}${gp?.reserved ? '. <b>You reserved a seat.</b>' : ''}</dd>` : ''}
        <dt>Format</dt><dd>${esc((s.delivery || []).join(', ') || '—')}${s.remote ? ' · remote viewing rooms available' : ''}</dd>
        ${s.audience?.length ? `<dt>${app.conf.id === 'gartner2026' ? 'Program' : 'Audience'}</dt><dd>${esc(s.audience.join(', '))}</dd>` : ''}
        ${s.topics?.length ? `<dt>Topics</dt><dd>${esc(s.topics.join(', '))}</dd>` : ''}
        ${s.tags?.length ? `<dt>${app.conf.id === 'gartner2026' ? 'Track / vendor' : 'Tags'}</dt><dd>${esc(s.tags.join(', '))}</dd>` : ''}
      </dl>
      ${conflicts.length ? `<div class="banner bad">${icon('warn')}<div><b>Clashes with your plan</b><p>${conflicts.join('<br>')}</p></div></div>` : ''}
      <p class="desc">${esc(s.desc)}</p>
      ${sp.length ? `<h3>Speakers</h3><div class="speakers">${sp.map(x => `<div class="speaker"><b>${esc(x[0])}</b> <span>${esc([x[2], x[1]].filter(Boolean).join(', '))}</span></div>`).join('')}</div>` : ''}
      ${insts.length > 1 ? `<h3>Runs ${insts.length} times</h3>` : ''}
      ${insts.length > 1 || (s.day && p > 0) || s.rsvp ? insts.map(runRow).join('') : ''}
      ${s.related?.length ? `<p class="small muted">Related: ${s.related.map(code => app.model.byCode.has(code) ? `<a href="#/session/${encodeURIComponent(code)}" data-act="open-code" data-code="${attr(code)}">${esc(code)}</a>` : esc(code)).join(', ')}</p>` : ''}
      <div class="field" style="margin-top:12px"><label for="score">My score<small>Your own ranking (e.g. the workbook score). Overrides Must/Want weighting in clashes</small></label>
        <input id="score" type="number" inputmode="decimal" min="0" max="100" step="0.5" data-score-key="${attr(s.key)}" value="${attr(gp?.score ?? '')}" placeholder="—"></div>
      <label class="toggle"><input type="checkbox" data-watch-key="${attr(s.key)}" ${gp?.mode === 'watch' ? 'checked' : ''}><span>Watch the recording instead of attending<small>${s.recorded === false ? 'Careful: this session is not recorded.' : 'Kept out of the live plan and listed under Watch later.'}</small></span></label>
      <h3 style="margin-top:14px"><label for="note">My notes</label></h3>
      <textarea id="note" data-note-key="${attr(s.key)}" placeholder="Questions to ask, why it matters…">${esc(gp?.note || '')}</textarea>
      <div class="row" style="margin-top:12px"><a class="btn small" href="${attr(app.conf.sessionUrl(s))}" target="_blank" rel="noopener">View on ${esc(app.conf.siteName)} ${icon('ext')}</a></div>
    </div>`;
}

// Cleanup runs synchronously; the dialog's own 'close' event (Esc key) calls it too, and
// it's safe to run twice.
function closeDetail() {
  if (dialog.open) dialog.close();
  afterDetailClosed();
}

function afterDetailClosed() {
  app.dialogKey = null;
  if (location.hash.startsWith('#/session/')) history.replaceState(null, '', `#/${app.tab}`);
  if (app.pendingRender) render();
}

function refreshDetail() {
  if (!dialog.open || !app.dialogKey) return;
  const s = app.model.byKey.get(app.dialogKey);
  if (!s) { closeDetail(); return; }
  if (['note', 'score'].includes(document.activeElement?.id)) return; // don't clobber typing
  const scroll = dialog.querySelector('.d-body')?.scrollTop || 0;
  dialog.innerHTML = renderDetail(s);
  const body = dialog.querySelector('.d-body');
  if (body) body.scrollTop = scroll;
}

// ---------------------------------------------------------------- ics

function icsEscape(s) { return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) {
  const out = [];
  let cur = '';
  const enc = new TextEncoder();
  for (const ch of line) {
    if (enc.encode(cur + ch).length > 74) { out.push(cur); cur = ' ' + ch; } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n');
}
function icsDate(iso) { return iso.replace(/[-:]/g, '').replace(/\.\d+/, '').replace(/Z?$/, 'Z'); }

function exportIcs() {
  const plan = computePlan();
  const items = Object.values(plan.res.plan).flat().filter(x => !x.pseudo && x.s.timeSource === 'official' && x.s.start);
  if (!items.length) {
    toast(app.model.mode === 'preview' ? 'Preview times are simulated. Calendar export unlocks once the real schedule is published.' : 'Nothing with an official time in your plan yet');
    return;
  }
  const stamp = icsDate(new Date().toISOString());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ignite26-planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(app.conf.short)} plan`];
  for (const x of items) {
    const s = x.s;
    lines.push('BEGIN:VEVENT', `UID:${s.inst}@${app.conf.id}.ignite26-planner`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(s.start)}`,
      `DTEND:${icsDate(s.end || new Date(new Date(s.start).getTime() + (s.dur || 45) * 60000).toISOString())}`,
      `SUMMARY:${icsEscape(`[${s.code}] ${s.title}`)}`, `LOCATION:${icsEscape(s.room || '')}`,
      `DESCRIPTION:${icsEscape(`${PRIORITY[x.priority]} · ${s.recorded ? 'recorded' : s.recorded === false ? 'not recorded' : ''}\n${app.conf.sessionUrl(s)}\n\n${s.desc}`)}`,
      `URL:${app.conf.sessionUrl(s)}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  shareOrDownload(`${app.conf.id}-plan.ics`, lines.map(icsFold).join('\r\n') + '\r\n', 'text/calendar')
    .then(r => { if (r !== 'cancelled') toast(`Exported ${items.length} sessions`); });
}

// ---------------------------------------------------------------- routing & render

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [tab, ...rest] = h.split('/');
  return { tab: tab || '', arg: rest.join('/') };
}

// Re-rendering replaces main's HTML; keep the focused control and scrolled lists in place.
function focusKey(el) {
  if (!el || !main.contains(el)) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  for (const a of ['data-set', 'data-lunch', 'data-override']) if (el.hasAttribute(a)) return `[${a}="${CSS.escape(el.getAttribute(a))}"]`;
  if (el.dataset.facet) return `[data-facet="${CSS.escape(el.dataset.facet)}"][value="${CSS.escape(el.value)}"]`;
  return null;
}

function render() {
  if (!app.model) return;
  clearInterval(app.nowTimer);
  const fk = focusKey(document.activeElement);
  const scrolls = [...main.querySelectorAll('[data-scroll]')].map(e => [e.dataset.scroll, e.scrollTop]);
  const view = { browse: renderBrowse, triage: renderTriage, plan: renderPlan, now: renderNow, changes: renderChanges, settings: renderSettings }[app.tab];
  main.innerHTML = view();
  app.rendered = true;
  app.pendingRender = false;
  for (const [k, top] of scrolls) { const e = main.querySelector(`[data-scroll="${CSS.escape(k)}"]`); if (e) e.scrollTop = top; }
  if (fk) main.querySelector(fk)?.focus({ preventScroll: true });
  if (app.tab === 'triage' && app.triageFocus) { app.triageFocus = false; $('#t-focus')?.focus({ preventScroll: true }); }
  for (const a of document.querySelectorAll('#tabs a')) a.setAttribute('aria-current', a.dataset.tab === app.tab ? 'page' : 'false');
  if (app.tab === 'now' && !app.simNow) {
    app.nowTimer = setInterval(() => {
      if (app.tab !== 'now' || dialog.open || document.activeElement?.closest?.('.sim')) return;
      main.innerHTML = renderNow();
    }, 30000);
  }
  if (app.tab === 'changes') markSeen();
  renderBadges();
}

function renderOrDefer() {
  if (dialog.open) app.pendingRender = true;
  else render();
}

function markSeen() {
  const newest = app.raw.changes?.batches?.[0]?.at;
  if (newest && store.get().seenBatch !== newest) store.setSeenBatch(newest);
}

function onRoute() {
  const r = parseRoute();
  if (r.tab === 'session') {
    const s = app.model.byCode.get(safeDecode(r.arg));
    if (!app.rendered) { app.tab = store.get().ui.tab || 'browse'; render(); }
    if (s) openDetail(s.key); else toast('That session is not in the catalog');
    return;
  }
  if (r.tab === 'import') {
    history.replaceState(null, '', '#/plan');
    app.tab = 'plan';
    render();
    importShare(safeDecode(r.arg));
    return;
  }
  const tab = TABS.includes(r.tab) ? r.tab : store.get().ui.tab || 'browse';
  if (dialog.open) closeDetail();
  if (tab !== app.tab || !app.rendered) {
    app.tab = tab;
    store.setUI({ tab });
    render();
    window.scrollTo(0, 0);
  }
}

function importShare(str) {
  const parsed = store.parseShare(str, code => app.model.byCode.get(code)?.id || app.model.byGroup.get(code.replace(/-R\d+$/i, ''))?.[0]?.id, code => app.model.byCode.get(code)?.key);
  if (app.model.mode === 'official') for (const p of Object.values(parsed)) if (p.lockMode === 'preview') { p.lock = null; delete p.lockMode; }
  const n = Object.keys(parsed).length;
  if (!n) { toast('That link had no picks in it'); return; }
  if (confirm(`Import ${n} picks from the link? Ratings and locks for sessions you've already rated will be replaced; notes and reserved seats are kept.`)) {
    store.applyShared(parsed);
    toast(`Imported ${n} picks`);
  }
}

function importFavorites() {
  const f = app.snapshot?.favorites;
  if (!f) return;
  const n = store.importData(f, { replace: false });
  store.setUI({ favoritesVersion: f.version });
  app.favoritesOffer = null;
  toast(`Imported ${n} favorites from your workbook`);
}

// Offer (or, on a fresh device, apply) the committed workbook favorites.
function offerFavorites() {
  const f = app.snapshot?.favorites;
  app.favoritesOffer = null;
  if (!f || !f.picks || CUSTOM_DATA) return;
  if (store.get().ui.favoritesVersion === f.version) return;
  if (!Object.keys(store.get().picks).length) importFavorites();
  else app.favoritesOffer = f;
}

// ---------------------------------------------------------------- events

function sessionFor(el) { return app.model.byKey.get(el.dataset.key) || null; }

main.addEventListener('click', onClick);
dialog.addEventListener('click', e => {
  if (e.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDetail();
    return;
  }
  onClick(e);
});
dialog.addEventListener('close', afterDetailClosed);

function lockRun(s, el) {
  const gp = groupPick(s.group);
  let dropReservation = false;
  if (gp?.reserved && gp.reserved !== s.key) {
    const r = app.model.byKey.get(gp.reserved);
    if (!confirm(`You reserved a seat for ${r?.code || 'another run'} (${r ? whenText(r) : ''}). Attend ${s.code} instead and drop that reservation?`)) return;
    dropReservation = true;
  }
  setGroupLock(s, s.key, (el.dataset.release || '').split(' ').filter(Boolean), { dropReservation });
  toast(app.model.mode === 'preview' ? 'Locked for this preview. The plan was rebuilt around it' : 'Locked in. The rest of the plan was rebuilt around it');
}

function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const s = el.dataset.key ? sessionFor(el) : null;
  const handlers = {
    prio: () => { if (s) { const p = Number(el.dataset.p); setGroupPriority(s, prioOf(s) === p ? null : p); } },
    'not-going': () => {
      if (!s) return;
      if (el.dataset.preview && !confirm(`Mark ${s.code} as Skip? This changes your rating everywhere, not just in the preview.`)) return;
      setGroupPriority(s, 0);
    },
    'watch-later': () => { if (s) { setGroupField(s, { mode: 'watch' }); toast(`${s.code} moved to your watch-later list`); } },
    'attend-live': () => { if (s) setGroupField(s, { mode: null }); },
    open: () => { e.preventDefault(); if (el.dataset.key) openDetail(el.dataset.key); },
    'open-code': () => { e.preventDefault(); const x = app.model.byCode.get(el.dataset.code); if (x) openDetail(x.key); else toast('That session is no longer in the catalog'); },
    close: () => closeDetail(),
    quick: () => setFilters({ [el.dataset.k]: !filtersState()[el.dataset.k] }),
    'browse-suggested': () => { e.preventDefault(); setFilters({ suggested: true, mine: false, unrated: false }, false); location.hash = '#/browse'; if (app.tab === 'browse') render(); },
    unfacet: () => { const f = filtersState(); setFilters({ [el.dataset.k]: (f[el.dataset.k] || []).filter(v => String(v) !== el.dataset.v) }); },
    clearfilters: () => setFilters({ topics: [], types: [], levels: [], audience: [], days: [], buildings: [], q: '', inPerson: false, notRecorded: false, unrated: false, mine: false, fresh: false, suggested: false }),
    more: () => { app.browseLimit += PAGE; render(); },
    't-rate': () => triageRate(Number(el.dataset.p)),
    't-undo': () => triageUndo(),
    't-later': () => { triageQueue().idx++; app.triageFocus = true; render(); },
    day: () => { e.preventDefault(); store.setUI({ day: el.dataset.day }); app.openFill = null; render(); },
    lock: () => { if (s) lockRun(s, el); },
    unlock: () => {
      if (!s) return;
      const gp = groupPick(s.group);
      if (gp?.reserved === s.key) { if (confirm(`Undo the reservation note for ${s.code}? (It doesn't cancel the seat on ${app.conf.siteName}.)`)) setReserved(s, null); return; }
      setGroupLock(s, null);
    },
    reserve: () => { if (s) { setReserved(s, s.key); toast('Noted: seat reserved. This run is pinned in your plan'); } },
    unreserve: () => { if (s) setReserved(s, null); },
    'unlock-all': () => {
      store.mutatePicks(picks => { for (const p of Object.values(picks)) if (p.lock && !p.reserved) { p.lock = null; delete p.lockMode; } });
      toast('Locks cleared (reserved seats stay)');
    },
    fill: () => { app.openFill = app.openFill === el.dataset.fill ? null : el.dataset.fill; render(); },
    'preview-on': () => { store.updateSettings({ preview: true }); toast('Preview on: days and rooms are simulated'); },
    'preview-off': () => store.updateSettings({ preview: false }),
    ics: () => exportIcs(),
    sim: () => {
      const d = $('#sim-day').value;
      const min = fromHHMM($('#sim-time').value) ?? 600;
      app.simNow = { day: d, min };
      try { sessionStorage.setItem('ignite26.simNow', JSON.stringify(app.simNow)); } catch { /* private mode */ }
      render();
    },
    'sim-off': () => {
      app.simNow = null;
      try { sessionStorage.removeItem('ignite26.simNow'); } catch { /* private mode */ }
      render();
    },
    ack: () => { store.setKnown(app.nextKnown); app.alerts = []; render(); },
    refresh: () => refreshData(true),
    'sync-local': () => syncLocal(el),
    export: () => shareOrDownload(`${app.conf.id}-picks-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(store.exportData(), null, 1), 'application/json'),
    'import-code': () => {
      const raw = ($('#import-code')?.value || '').trim();
      importShare(safeDecode(raw.includes('#/import/') ? raw.split('#/import/')[1] : raw));
    },
    'favorites-import': () => { if (confirm('Import your workbook favorites? Ratings, scores and watch-later marks for those sessions will be set from the spreadsheet; your notes are kept.')) importFavorites(); },
    'favorites-dismiss': () => { store.setUI({ favoritesVersion: app.snapshot?.favorites?.version }); app.favoritesOffer = null; render(); },
    'install-dismiss': () => { store.setUI({ installDismissed: true }); render(); },
    'intro-dismiss': () => { store.setUI({ introDismissed: true }); render(); },
    'forget-missing': () => {
      const gone = new Set(app.picks.orphans.map(o => o.id));
      store.mutatePicks(picks => { for (const id of gone) delete picks[id]; });
      toast('Removed');
    },
    share: async () => {
      const str = store.shareString(id => sessionById(id)?.code || store.pick(id)?.code, inst => app.model.byKey.get(inst)?.code);
      const url = `${location.origin}${location.pathname}?conf=${encodeURIComponent(app.conf.id)}#/import/${encodeURIComponent(str)}`;
      toast((await copyText(url)) ? 'Link copied. Open or paste it on your other device' : 'Could not copy the link');
    },
    watchlist: async () => {
      const codes = new Set();
      for (const g of pickedGroups()) if (groupPick(g)?.p >= 2) for (const x of app.model.byGroup.get(g) || []) codes.add(x.code);
      const json = JSON.stringify({ codes: [...codes].sort() }, null, 1);
      toast((await copyText(json)) ? `Copied ${codes.size} codes. Paste into ${app.conf.dataDir}/watchlist.json` : 'Could not copy');
    },
    'block-add': () => {
      const day = $('#blk-day').value, start = fromHHMM($('#blk-start').value), end = fromHHMM($('#blk-end').value);
      if (start == null || end == null || end <= start) { toast('Pick a start and end time'); return; }
      const label = ($('#blk-label').value || 'Busy').trim().slice(0, 80) || 'Busy';
      const blocks = [...(store.settings().blocks || []), { id: `b${Date.now().toString(36)}`, day, start, end, label, building: $('#blk-bldg').value }];
      store.setSetting('blocks', blocks);
      toast('Blocked. Your plan now works around it');
    },
    'block-del': () => store.setSetting('blocks', (store.settings().blocks || []).filter(b => b.id !== el.dataset.id)),
    'reset-settings': () => { store.resetSettings(); toast('Settings restored'); },
    'reset-all': () => { if (confirm(`Erase all your ${app.conf.short} ratings, locks and notes on this device? Settings are kept.`)) { store.resetAll(); toast('Erased'); } },
  };
  if (handlers[act]) handlers[act]();
}

function switchConference(id) {
  if (!CONFERENCES[id] || id === app.conf.id) return;
  rememberConference(id);
  const u = new URL(location.href);
  u.searchParams.set('conf', id);
  u.searchParams.delete('data');
  u.hash = location.hash.startsWith('#/session/') || location.hash.startsWith('#/import/') ? '#/plan' : location.hash;
  location.href = u.toString();
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
  else if (t.id === 'conf-select') switchConference(t.value);
  else if (t.dataset.set) {
    if (t.value === '') return;
    const v = Math.max(0, Number(t.value));
    if (!Number.isFinite(v)) return;
    const path = t.dataset.set.split('.');
    const patch = {};
    let o = patch;
    path.forEach((k, i) => { if (i === path.length - 1) o[k] = v; else o = (o[k] = {}); });
    if (path[0] === 'walk') patch.walk = { ...walkCfg(), ...patch.walk, pairs: { ...walkCfg().pairs, ...(patch.walk.pairs || {}) } };
    store.updateSettings(patch);
  } else if (t.dataset.lunch) {
    const k = t.dataset.lunch;
    const v = k === 'from' || k === 'to' ? fromHHMM(t.value) : Number(t.value);
    if (v == null || !Number.isFinite(v)) return;
    store.updateSettings({ lunch: { [k]: v } });
  } else if (t.id === 'lunch-on') store.updateSettings({ lunch: { on: t.checked } });
  else if (t.dataset.pref) store.updateSettings({ [t.dataset.pref]: t.value });
  else if (t.dataset.toggle) store.updateSettings({ [t.dataset.toggle]: t.checked });
  else if (t.dataset.override !== undefined) {
    store.updateSettings({ overrides: { [t.dataset.override]: t.value } }); // '' = automatic
  } else if (t.id === 'theme') { applyTheme(t.value); store.setUI({ theme: t.value }); }
  else if (t.id === 'only-mine') { store.setUI({ onlyMine: t.checked }); render(); }
  else if (t.id === 'import-file' && t.files?.[0]) {
    t.files[0].text().then(txt => {
      const obj = JSON.parse(txt);
      if (obj.conference && obj.conference !== app.conf.id && !confirm(`This backup is for ${CONFERENCES[obj.conference]?.name || obj.conference}, but you're viewing ${app.conf.name}. Import anyway?`)) return;
      const n = store.importData(obj, { replace: confirm('Replace your current picks and settings with the backup? (Cancel = merge the picks in)') });
      toast(`Restored ${n} picks`);
    }).catch(err => toast(`Couldn't read that file: ${err.message}`));
  }
});
main.addEventListener('toggle', e => {
  if (e.target.id === 'filters') store.setUI({ filtersOpen: e.target.open });
  if (e.target.dataset?.fill) app.openFill = e.target.open ? e.target.dataset.fill : null;
}, true);
dialog.addEventListener('input', e => {
  const key = e.target.dataset.noteKey;
  if (!key) return;
  const s = app.model.byKey.get(key);
  if (!s) return;
  const gp = groupPick(s.group);
  const ids = gp?.ids || [groupOf(s)[0].id];
  store.setGroupNote(ids, gp?.holder || ids[0], e.target.value, groupMeta(s));
});
dialog.addEventListener('change', e => {
  const t = e.target;
  const s = app.model.byKey.get(t.dataset.scoreKey || t.dataset.watchKey || '');
  if (!s) return;
  if (t.dataset.scoreKey) {
    const v = t.value === '' ? null : Number(t.value);
    if (v !== null && !(Number.isFinite(v) && v >= 0 && v <= 100)) return;
    setGroupField(s, { score: v });
  } else if (t.dataset.watchKey) setGroupField(s, { mode: t.checked ? 'watch' : null });
});

document.addEventListener('keydown', e => {
  if (app.tab !== 'triage' || dialog.open || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const t = e.target;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return;
  if ((e.key === ' ' || e.key === 'Enter') && t.closest?.('button, a, summary, [role="button"]')) return; // let controls work
  const map = { 1: 3, 2: 2, 3: 1, 0: 0, x: 0 };
  if (e.key in map) { e.preventDefault(); triageRate(map[e.key]); }
  else if (e.key === 'u' || e.key === 'Backspace') { e.preventDefault(); triageUndo(); }
  else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); triageQueue().idx++; app.triageFocus = true; render(); }
});

// Store changes -> keep views and badges in sync.
store.subscribe(what => {
  if (!app.model) return;
  if (what === 'seen' || what === 'known') { renderBadges(); return; }
  if (what === 'note') { indexPicks(); renderBadges(); return; }
  if (what === 'settings' || what === 'reset') {
    if (modelKey() !== app.modelKey) rebuildModel();
    if (what === 'reset') { applyTheme(store.get().ui.theme); app.triage = null; }
  }
  indexPicks();
  if (what === 'picks' || what === 'reset') { trackNewPicks(); computeAlerts(); }
  invalidate();
  if (app.tab === 'browse' && what === 'picks') {
    // Update only the cards that changed, so the list doesn't jump.
    for (const el of main.querySelectorAll('[data-card]')) {
      const x = app.model.byKey.get(el.dataset.card);
      if (!x) continue;
      const p = prioOf(x);
      el.className = cardClass(p);
      el.querySelectorAll('.prio button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.p) === p)));
    }
    renderBadges();
  } else {
    renderOrDefer();
  }
  refreshDetail();
});

// ---------------------------------------------------------------- change alerts

// Snapshot every run of newly picked sessions, so later moves can be flagged. A group
// already tracked by any of its runs isn't touched (a new run shows up as an alert).
function trackNewPicks() {
  const known = { ...store.get().known };
  const tracked = new Set(Object.values(known).map(k => k.g));
  let added = false;
  for (const g of pickedGroups()) {
    const runs = app.model.byGroup.get(g) || [];
    if (tracked.has(g) || runs.some(s => known[s.key])) continue;
    for (const s of runs) { known[s.key] = snapshot(s); added = true; }
  }
  if (added) store.setKnown(known);
}

function computeAlerts() {
  const { alerts, next } = diffKnown(app.model, pickedGroups(), store.get().known);
  app.alerts = alerts;
  app.nextKnown = next;
}

// ---------------------------------------------------------------- data lifecycle

function modelKey() {
  const s = store.settings();
  return JSON.stringify([s.preview, s.overrides]);
}

function rsvpConfig() {
  const r = app.live?.flags?.rsvp || app.snapshot?.doc?.siteFlags?.rsvp || app.snapshot?.meta?.siteFlags?.rsvp;
  return r && Object.keys(r).length ? r : app.conf.rsvp;
}

function rebuildModel() {
  app.model = buildModel(app.raw.doc, store.settings(), rsvpConfig(), app.conf, app.venue);
  app.modelKey = modelKey();
  app.triage = null;
  indexPicks();
  invalidate();
}

// The model is built from the live conference catalog when it differs from the synced
// snapshot, otherwise from the snapshot (which also carries the change history).
const liveDiffers = () => !!(app.live && !app.live.same);
function docSig() {
  return liveDiffers() ? `live:${app.snapshot.doc.generatedAt}:${app.live.at}` : `snap:${app.snapshot.doc.generatedAt}`;
}

// Returns true when the catalog itself changed (and the model was rebuilt).
function applyData() {
  const sig = docSig();
  app.raw = { ...app.snapshot, doc: liveDiffers() ? app.live.doc : app.snapshot.doc }; // meta/history always fresh
  if (sig === app.sig) return false;
  app.sig = sig;
  rebuildModel();
  afterModelChange();
  computeAlerts();
  return true;
}

// Once the real schedule exists: preview switches itself off and choices made against
// simulated times are dropped, so a fake clash can't decide a real one.
function afterModelChange() {
  if (!app.model.hasOfficial) return;
  if (store.settings().preview) {
    store.updateSettings({ preview: false });
    toast('The real schedule is out, so preview mode was switched off');
  }
  const stale = Object.values(store.get().picks).filter(p => p.lockMode === 'preview').length;
  if (stale) {
    store.mutatePicks(picks => { for (const p of Object.values(picks)) if (p.lockMode === 'preview') { p.lock = null; delete p.lockMode; } });
    toast(`${stale} choice${stale > 1 ? 's' : ''} you made in preview ${stale > 1 ? 'were' : 'was'} reset now that the real schedule is out`);
  }
}

function countText(d) {
  const parts = [];
  if (d.added?.length) parts.push(`${d.added.length} added`);
  if (d.removed?.length) parts.push(`${d.removed.length} removed`);
  if (d.changed?.length) parts.push(`${d.changed.length} updated`);
  return parts.join(', ');
}

// Toast only for things that happened while the app was open, or that touch your picks.
function announce(initial = false) {
  const newest = app.snapshot.changes?.batches?.[0]?.at || null;
  const newBatch = !!newest && newest !== app.lastBatchAt;
  app.lastBatchAt = newest;
  const review = { label: 'Review', run: () => { location.hash = '#/changes'; } };
  if (app.alerts.length) toast(`${app.alerts.length} change${app.alerts.length > 1 ? 's' : ''} to your picks`, review);
  else if (liveDiffers() && app.announcedLive !== app.live.at) toast(`${app.conf.siteName} has updates: ${countText(app.live.diff)}`, review);
  else if (newBatch && !initial) toast(`The catalog changed: ${countText(app.snapshot.changes.batches[0])}`, review);
  if (liveDiffers()) app.announcedLive = app.live.at;
}

const LIVE_KEY = () => `ignite26.planner.live:${app.conf.id}`;

async function persistLive(r) {
  try {
    const c = await caches.open('planner-live');
    if (r.same) await c.delete(LIVE_KEY());
    else await c.put(LIVE_KEY(), new Response(JSON.stringify({ at: r.at, base: r.base, doc: r.doc, flags: r.flags }), { headers: { 'Content-Type': 'application/json' } }));
  } catch { /* no cache storage */ }
}

// A live result newer than the synced snapshot is kept across launches, so a cold start
// (or a failed check) never shows older rooms and times than you already saw.
async function restoreLive() {
  try {
    const c = await caches.open('planner-live');
    const res = await c.match(LIVE_KEY());
    if (!res) return;
    const saved = await res.json();
    if (saved.base !== app.snapshot.doc.generatedAt) { await c.delete(LIVE_KEY()); return; }
    const d = liveDiff(app.snapshot.doc.sessions || [], saved.doc.sessions || []);
    app.live = { ...saved, same: !(d.added.length || d.removed.length || d.changed.length), diff: d, stale: true };
  } catch { /* ignore */ }
}

async function checkLiveNow(force = false) {
  if (CUSTOM_DATA || !app.conf.live) return;
  if (!force && Date.now() - app.lastLiveCheck < LIVE_GAP) return;
  try {
    const r = await checkLive(app.snapshot.doc, app.conf);
    r.base = app.snapshot.doc.generatedAt;
    app.live = r;
    app.liveError = null;
    app.lastLiveCheck = Date.now();
    try { localStorage.setItem(`ignite26.planner.liveAt:${app.conf.id}`, String(app.lastLiveCheck)); } catch { /* ignore */ }
    persistLive(r);
  } catch (err) {
    app.liveError = err.name === 'AbortError' ? 'timed out' : err.message;
    // Keep a result that is still newer than the snapshot; drop one the snapshot has caught up with.
    if (app.live && app.live.base === app.snapshot.doc.generatedAt) app.live.stale = true;
    else app.live = null;
  }
}

async function refreshData(manual = false) {
  if (!manual && Date.now() - app.lastRefresh < MIN_REFRESH_GAP) return;
  app.lastRefresh = Date.now();
  let snapErr = null;
  try {
    const fresh = await fetchAll(app.conf.dataDir);
    if (fresh.doc?.generatedAt && fresh.doc.generatedAt < app.snapshot.doc.generatedAt) fresh.doc = app.snapshot.doc; // never go backwards
    app.snapshot = fresh;
  } catch (err) { snapErr = err; }
  await checkLiveNow(manual);
  const changed = applyData();
  if (changed) {
    renderOrDefer();
    announce();
  } else if (app.tab === 'changes') renderOrDefer(); // refresh the sync status shown there
  if (!changed && manual) {
    toast(app.liveError ? `Couldn't check ${app.conf.siteName}: ${app.liveError}`
      : snapErr ? `Couldn't load the synced copy: ${snapErr.message}`
      : 'Already up to date');
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
    toast(`Sync failed: ${String(err.message).slice(0, 120)}`);
  } finally {
    if (app.tab === 'changes') render();
  }
}

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:') return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) toast('A new version of the app is ready', { label: 'Reload', run: () => location.reload() });
  });
  let t = null;
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type !== 'data-updated') return;
    clearTimeout(t);
    t = setTimeout(() => { app.lastRefresh = 0; refreshData(false); }, 1000);
  });
}

function fillConferenceSwitch() {
  const sel = $('#conf-switch');
  sel.innerHTML = conferenceList().map(cf => `<option value="${attr(cf.id)}" ${cf.id === app.conf.id ? 'selected' : ''}>${esc(cf.name)}</option>`).join('');
  sel.onchange = () => switchConference(sel.value);
  document.title = `${app.conf.short} Planner`;
}

async function boot() {
  app.conf = CONFERENCES[currentConferenceId()];
  app.venue = createVenue(app.conf.venue);
  setVenue(app.venue);
  store.configure({ defaults: { startFrom: app.venue.startFrom, lunch: app.conf.lunch }, buildingIds: app.venue.ids });
  store.load(CUSTOM_DATA ? `test:${DATA_OVERRIDE}` : app.conf.namespace);
  fillConferenceSwitch();
  applyTheme(store.get().ui.theme);
  try { app.simNow = JSON.parse(sessionStorage.getItem('ignite26.simNow') || 'null'); } catch { app.simNow = null; }
  try { app.lastLiveCheck = Number(localStorage.getItem(`ignite26.planner.liveAt:${app.conf.id}`)) || 0; } catch { app.lastLiveCheck = 0; }
  try {
    app.snapshot = await fetchAll(app.conf.dataDir);
  } catch (err) {
    main.innerHTML = `<div class="panel empty"><h3>Couldn't load the session catalog</h3><p>${esc(err.message)}</p><button class="btn primary" data-act="reload">Try again</button></div>`;
    main.querySelector('[data-act="reload"]').onclick = () => location.reload();
    $('#sync-status').textContent = 'Offline';
    return;
  }
  app.lastRefresh = Date.now();
  app.lastBatchAt = app.snapshot.changes?.batches?.[0]?.at || null;
  await restoreLive();
  applyData();
  trackNewPicks();
  computeAlerts();
  offerFavorites();
  renderStatus();
  window.addEventListener('hashchange', onRoute);
  if (!location.hash) history.replaceState(null, '', `#/${store.get().ui.tab || 'browse'}`);
  onRoute();
  // Alerts are announced once, after the live check, so a cold start never reports
  // changes the live copy has already superseded.
  checkLiveNow().then(() => {
    if (applyData()) renderOrDefer();
    announce(true);
    renderStatus();
    renderBadges();
  });
  if (app.snapshot.stale) setTimeout(() => { app.lastRefresh = 0; refreshData(false); }, 5000);
  if (LOCAL_HOST) fetch('api/status').then(r => (r.ok ? r.json() : null)).then(j => { if (j?.local) { app.local = true; if (app.tab === 'changes') render(); } }).catch(() => {});
  setInterval(() => refreshData(false), REFRESH_MS);
  setInterval(renderStatus, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshData(false); });
  registerServiceWorker();
}

boot();
