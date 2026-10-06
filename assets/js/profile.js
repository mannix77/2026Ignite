// Preferences that rank and trim a big catalog, so only a short list is left to rate one
// by one. A profile holds the quick-start answers (role, interests, goals, levels,
// formats) and whole-group choices ("Want all" / "Skip all" on a topic, track, format…).
//
// Group skips never rate anything: a skipped session stays unrated and is only hidden
// from Browse and Triage until the choice is cleared. A rating given one by one always
// wins over every group choice.

const TEXT = s => `${s.title || ''}`.toLowerCase();
const DESC = s => `${s.desc || ''}`.toLowerCase();

// Learning goals: matched against the title (strong) and the description (weaker).
export const GOALS = [
  { id: 'architecture', label: 'Architecture & design', re: /architect|reference design|design pattern|landing zone|blueprint|platform engineering|integration pattern|modernization/ },
  { id: 'leadership', label: 'Executive presence & influence', re: /leader|executive|influenc|persua|storytell|communicat|stakeholder|board|c-suite|ceo|change management|culture|negotiat|convinc|business case|presence/ },
  { id: 'strategy', label: 'Strategy & roadmaps', re: /strateg|roadmap|operating model|transformation|value|roi|priorit|investment/ },
  { id: 'ai', label: 'AI & agents', re: /\bai\b|agent|copilot|genai|generative|llm|machine learning/ },
  { id: 'security', label: 'Security & governance', re: /secur|governance|compliance|risk|zero trust|identity/ },
  { id: 'hands-on', label: 'Hands-on depth', re: /deep dive|hands-on|demo|build |lab\b|under the hood|in practice/ },
];

const hasTrack = (s, t) => (s.tags || []).some(tag => tag === t || tag.startsWith(`${t}:`));

const CONFIG = {
  ignite2026: {
    roles: [
      { id: 'Enterprise architect', audience: ['Technical Decision Maker'] },
      { id: 'Developer / engineer', audience: ['Technical Practitioner'] },
      { id: 'IT / business leader', audience: ['Business Decision Maker'] },
      { id: 'Partner', audience: ['Partner Business'] },
    ],
    levels: true,
    defaultOffTypes: ['Pre-recorded'],
    groups: [
      { key: 'topic', label: 'Topics', get: s => s.topics },
      { key: 'tag', label: 'Products & themes', get: s => s.tags, top: 30, exclude: ['MVP'] },
      { key: 'type', label: 'Formats', get: s => [s.type] },
      { key: 'level', label: 'Levels', get: s => (s.level ? [String(s.level)] : []), sort: 'name' },
      { key: 'aud', label: 'Audience', get: s => s.audience },
    ],
    signals(s) {
      const out = [];
      if (s.type === 'Keynote') out.push([4, 'Keynote']);
      const exec = (s.speakers || []).find(p => /vice president|\bcvp\b|chief|\bevp\b/i.test(p?.[2] || ''));
      if (exec) out.push([1, `Exec speaker: ${exec[0]}`]);
      const cust = (s.speakers || []).find(p => p?.[1] && !/microsoft/i.test(p[1]));
      if (cust) out.push([0.5, `Speaker from ${cust[1]}`]);
      if (s.type === 'Lab' || s.type === 'Table Talk') out.push([0.5, 'In-person only format']);
      return out;
    },
  },
  gartner2026: {
    // Gartner publishes no role agendas: each role maps to the tracks that fit it (our call).
    roles: [
      { id: 'Enterprise architect', tracks: ['D', 'Spotlight: Enterprise Architecture'], topics: ['Enterprise Architecture and Applications'] },
      { id: 'CIO / IT leader', tracks: ['B', 'C', 'F', 'G'] },
      { id: 'AI leader', tracks: ['A', 'Spotlight: AI Leaders'] },
      { id: 'Infrastructure & cloud', tracks: ['I'] },
      { id: 'Security', tracks: ['D'] },
      { id: 'Data & analytics', tracks: ['H'] },
      { id: 'Talent & change', tracks: ['C', 'E'] },
    ],
    levels: false,
    defaultOffTypes: ['Meals', 'Operating Hours', 'Receptions and Special Event', 'Conference Orientation'],
    groups: [
      { key: 'track', label: 'Tracks', get: s => (s.tags || []).filter(t => /^[A-Z]: |^Spotlight:/.test(t)), sort: 'name' },
      { key: 'topic', label: 'Topics', get: s => s.topics },
      { key: 'type', label: 'Session types', get: s => [s.type] },
      { key: 'aud', label: 'Industries & programs', get: s => s.audience },
      { key: 'vendor', label: 'Solution providers', get: s => s.vendors, top: 20 },
    ],
    signals(s) {
      const out = [];
      if (s.type === 'Signature Series' || s.type === 'Keynote') out.push([4, s.type]);
      if (s.speakerType === 'Gartner Speaker') out.push([0.75, 'Gartner analyst']);
      if (s.speakerType === 'Exhibitor Speaker') out.push([-0.5, 'Vendor-led']);
      return out;
    },
  },
  reinvent2026: {
    roles: [
      { id: 'Enterprise architect', audience: ['Solution / Systems Architect', 'IT Executive'] },
      { id: 'Developer / engineer', audience: ['Developer / Engineer', 'DevOps Engineer'] },
      { id: 'IT / business leader', audience: ['IT Executive', 'IT Professional / Technical Manager', 'Business Executive'] },
      { id: 'Security', audience: ['Cloud Security Specialist'] },
      { id: 'Data & analytics', audience: ['Data Engineer', 'Data Scientist'] },
    ],
    levels: true,
    defaultOffTypes: ['Exam prep'],
    groups: [
      { key: 'topic', label: 'Topics', get: s => s.topics },
      { key: 'tag', label: 'Services & themes', get: s => s.tags, top: 30 },
      { key: 'type', label: 'Formats', get: s => [s.type] },
      { key: 'level', label: 'Levels', get: s => (s.level ? [String(s.level)] : []), sort: 'name' },
      { key: 'aud', label: 'Audience', get: s => s.audience, top: 20 },
    ],
    signals(s) {
      const out = [];
      if (s.type === 'Keynote') out.push([4, 'Keynote']);
      const cust = (s.speakers || []).find(p => p?.[1] && !/\baws\b|amazon/i.test(p[1]));
      if (cust) out.push([0.5, `Speaker from ${cust[1]}`]);
      if (s.sponsored) out.push([-0.5, 'Sponsored']);
      if (['Workshop', "Builders' session", 'Code talk', 'Lab', 'Chalk talk'].includes(s.type)) out.push([0.5, 'Interactive, in person only']);
      return out;
    },
  },
};

// A conference without its own entry gets roles from its audience values and plain groups.
const FALLBACK = {
  roles: [],
  levels: true,
  defaultOffTypes: [],
  groups: [
    { key: 'topic', label: 'Topics', get: s => s.topics },
    { key: 'type', label: 'Formats', get: s => [s.type] },
    { key: 'aud', label: 'Audience', get: s => s.audience },
  ],
  signals: () => [],
};

export function profileConfig(confId) { return CONFIG[confId] || FALLBACK; }

export function blankProfile() {
  return { roles: [], interests: [], goals: [], levels: [], offTypes: null, groups: {}, size: 100 };
}

// Saved and imported profiles are untrusted input.
const str = v => typeof v === 'string' && v.length > 0 && v.length <= 200;
const strs = v => (Array.isArray(v) ? [...new Set(v.filter(str))].slice(0, 100) : []);
export function sanitizeProfile(p) {
  const out = blankProfile();
  if (!p || typeof p !== 'object') return out;
  out.roles = strs(p.roles);
  out.interests = strs(p.interests);
  out.goals = strs(p.goals).filter(g => GOALS.some(x => x.id === g));
  out.levels = Array.isArray(p.levels) ? [...new Set(p.levels.filter(l => Number.isInteger(l) && l > 0 && l < 1000))] : [];
  out.offTypes = Array.isArray(p.offTypes) ? strs(p.offTypes) : null;
  if (p.groups && typeof p.groups === 'object') {
    for (const [k, v] of Object.entries(p.groups).slice(0, 500)) if (str(k) && (v === 1 || v === -1)) out.groups[k] = v;
  }
  if (Number.isInteger(p.size) && p.size >= 25 && p.size <= 2000) out.size = p.size;
  return out;
}

// The facets a conference offers for whole-group choices, with how many sessions each has.
export function profileGroups(cfg, sessions) {
  return cfg.groups.map(g => {
    const counts = new Map();
    const seen = new Set();
    for (const s of sessions) {
      if (seen.has(s.group)) continue;
      seen.add(s.group);
      for (const v of g.get(s) || []) if (v != null && v !== '') counts.set(v, (counts.get(v) || 0) + 1);
    }
    let items = [...counts].filter(([v]) => !(g.exclude || []).includes(v));
    items.sort(g.sort === 'name' ? (a, b) => String(a[0]).localeCompare(String(b[0])) : (a, b) => b[1] - a[1]);
    if (g.top) items = items.slice(0, g.top);
    return { key: g.key, label: g.label, items };
  }).filter(g => g.items.length);
}

// evaluate(s) -> { score, why: [text], hidden: null | 'group' | 'format' | 'level' }
export function createRanker(profileIn, confId) {
  const p = sanitizeProfile(profileIn);
  const cfg = profileConfig(confId);
  const roles = cfg.roles.filter(r => p.roles.includes(r.id));
  const goals = GOALS.filter(g => p.goals.includes(g.id));
  const offTypes = new Set(p.offTypes ?? cfg.defaultOffTypes);
  const levels = new Set(p.levels);
  const interests = new Set(p.interests);
  const groupKeys = Object.keys(p.groups).length ? cfg.groups : [];

  function evaluate(s) {
    const why = [];
    let score = 0, wants = 0, skips = 0;
    for (const g of groupKeys) for (const v of g.get(s) || []) {
      const r = p.groups[`${g.key}:${v}`];
      if (r === 1) { wants++; why.push(`You want ${v}`); }
      else if (r === -1) skips++;
    }
    score += Math.min(wants, 2) * 3;
    if (wants && skips) score -= 1;
    const role = roles.find(r => (r.audience || []).some(a => (s.audience || []).includes(a)) || (r.tracks || []).some(t => hasTrack(s, t)) || (r.topics || []).some(t => (s.topics || []).includes(t)));
    if (role) { score += 1.5; why.push(`Role: ${role.id}`); }
    const ints = (s.topics || []).filter(t => interests.has(t));
    if (ints.length) { score += 2 + (ints.length - 1) * 0.5; why.push(`Interest: ${ints[0]}`); }
    let goalPts = 0;
    for (const g of goals) {
      if (g.re.test(TEXT(s))) { goalPts += 2; why.push(`Goal: ${g.label}`); }
      else if (g.re.test(DESC(s))) { goalPts += 1; why.push(`Goal: ${g.label}`); }
    }
    score += Math.min(goalPts, 4);
    for (const [pts, label] of cfg.signals(s)) { score += pts; if (pts > 0) why.push(label); }
    let hidden = null;
    if (offTypes.has(s.type)) hidden = 'format';
    else if (cfg.levels && levels.size && s.level && !levels.has(Number(s.level))) hidden = 'level';
    else if (skips && !wants) hidden = 'group';
    return { score: Math.round(score * 10) / 10, why, hidden };
  }
  return { profile: p, evaluate };
}

// One entry per repeat group, split into what you rated, what your choices hide, the
// shortlist left to rate (best first) and what's parked below the cut.
// `bonus(s)` adds to the rank (e.g. similarity to your picks).
export function partition(sessions, ranker, { isRated, size = 100, bonus = () => 0 }) {
  const seen = new Set();
  const rated = [], hidden = [], open = [];
  for (const s of sessions) {
    if (seen.has(s.group)) continue;
    seen.add(s.group);
    const ev = ranker.evaluate(s);
    const entry = { s, ...ev, rank: ev.score + bonus(s) };
    if (isRated(s)) rated.push(entry);
    else if (ev.hidden) hidden.push(entry);
    else open.push(entry);
  }
  open.sort((a, b) => b.rank - a.rank || String(a.s.code).localeCompare(String(b.s.code)));
  return { rated, hidden, shortlist: open.slice(0, size), parked: open.slice(size) };
}
