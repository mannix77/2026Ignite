// "Sessions like the ones you picked": a small recommender over the catalog.
//
// It builds an interest profile from your picks (tracks, topics, audience programs,
// session types, speakers, vendors and the words in titles/descriptions, weighted by
// how much you rated each pick) and scores every other session against it. Each score
// comes with the reasons, so the suggestion can be judged at a glance.

const STOP = new Set(('a an and are as at be by for from how in into is it its of on or that the this to with your you we our ' +
  'will can what why when who which not more new most using use used how-to session learn join discover explore see get make ' +
  'their they them than then there these those have has had do does did but if so no yes also just about over under up out ' +
  'one two three key top best next now today future way ways world business enterprise organization organizations leaders ' +
  'leader cio cios it technology technologies gartner microsoft ignite symposium xpo attend attendees').split(/\s+/));

function tokens(text) {
  return (text || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9+#]+/)
    .map(w => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

const FEATURE_WEIGHT = { track: 1.4, topic: 1.0, program: 0.6, type: 0.5, speaker: 2.0, vendor: 1.5, text: 1.6 };

export function buildSuggester(sessions, picks) {
  // picks: [{ s: session, w: 1..3 (how much you want it) }]
  const n = Math.max(1, sessions.length);
  const df = new Map();
  const docs = new Map();
  for (const s of sessions) {
    const t = new Set(tokens(`${s.title} ${s.title} ${s.desc}`));
    docs.set(s.key, t);
    for (const w of t) df.set(w, (df.get(w) || 0) + 1);
  }
  const idf = w => Math.log(n / (1 + (df.get(w) || 0)));
  const profile = { track: new Map(), topic: new Map(), program: new Map(), type: new Map(), speaker: new Map(), vendor: new Map(), text: new Map() };
  const picked = new Set();
  let totalW = 0;
  const add = (m, k, w) => k && m.set(k, (m.get(k) || 0) + w);
  for (const { s, w } of picks) {
    picked.add(s.group);
    totalW += w;
    for (const t of s.tags || []) add(profile.track, t, w);
    for (const t of s.topics || []) add(profile.topic, t, w);
    for (const t of s.audience || []) add(profile.program, t, w);
    add(profile.type, s.type, w);
    for (const p of s.speakers || []) add(profile.speaker, p[0], w);
    for (const v of s.vendors || []) add(profile.vendor, v, w);
    for (const t of docs.get(s.key) || []) add(profile.text, t, w * idf(t));
  }
  const textNorm = Math.sqrt([...profile.text.values()].reduce((a, v) => a + v * v, 0)) || 1;
  const ready = picks.length >= 2;

  function score(s) {
    if (!ready) return { score: 0, reasons: [], fit: false };
    const reasons = [];
    let total = 0;
    const share = (m, keys, feat, label) => {
      let best = null;
      for (const k of keys || []) {
        const w = m.get(k);
        if (!w) continue;
        const v = Math.min(1, w / totalW) * FEATURE_WEIGHT[feat];
        total += v;
        if (!best || w > best.w) best = { k, w };
      }
      if (best) reasons.push({ feat, text: `${label} ${best.k} (${Math.round((best.w / totalW) * 100)}% of your picks)`, v: best.w / totalW });
    };
    share(profile.track, s.tags, 'track', 'Track you favor:');
    share(profile.topic, s.topics, 'topic', 'Topic you favor:');
    share(profile.program, s.audience, 'program', 'Program:');
    share(profile.type, [s.type], 'type', 'Format you favor:');
    const sp = (s.speakers || []).map(p => p[0]).filter(name => profile.speaker.has(name));
    if (sp.length) { total += FEATURE_WEIGHT.speaker * Math.min(1, profile.speaker.get(sp[0]) / totalW + 0.5); reasons.push({ feat: 'speaker', text: `Speaker you picked elsewhere: ${sp[0]}`, v: 1 }); }
    const vd = (s.vendors || []).filter(v => profile.vendor.has(v));
    if (vd.length) { total += FEATURE_WEIGHT.vendor * Math.min(1, profile.vendor.get(vd[0]) / totalW + 0.5); reasons.push({ feat: 'vendor', text: `Vendor in your picks: ${vd[0]}`, v: 1 }); }
    // Cosine similarity of the session's words to the interest profile.
    const t = docs.get(s.key) || new Set();
    let dot = 0, norm = 0;
    const hits = [];
    for (const w of t) {
      const i = idf(w);
      norm += i * i;
      const pw = profile.text.get(w);
      if (pw) { dot += pw * i; hits.push([w, pw * i]); }
    }
    const cos = norm ? dot / (Math.sqrt(norm) * textNorm) : 0;
    if (cos > 0.08) {
      total += FEATURE_WEIGHT.text * Math.min(1, cos * 3);
      hits.sort((a, b) => b[1] - a[1]);
      reasons.push({ feat: 'text', text: `Wording like your picks: ${hits.slice(0, 3).map(h => h[0]).join(', ')}`, v: cos });
    }
    const max = Object.values(FEATURE_WEIGHT).reduce((a, b) => a + b, 0);
    reasons.sort((a, b) => b.v - a.v);
    return { score: Math.round((total / max) * 100), reasons: reasons.slice(0, 3).map(r => r.text) };
  }

  return { ready, score, picked: g => picked.has(g) };
}
