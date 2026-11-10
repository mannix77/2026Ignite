// Runs the browser's placeholder-room pattern over every BMP character in each template (used by
// tests/test_sync.py to check that scripts/venues.py PLACEHOLDER reads every character the same way).
// Works under macOS JavaScriptCore (jsc -m ... -- ARGS) and Node (node ... ARGS):
//   TEMPLATES.json OUT.json
// TEMPLATES.json is a list of labels with one "{}" marking where the character goes; OUT.json maps
// each template to the code points (0 to 0xFFFF) whose label the pattern calls a placeholder.
import { PLACEHOLDER_ROOM } from '../assets/js/venue.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const fs = isNode ? await import('node:fs') : null;
const args = (isNode ? process.argv.slice(2) : typeof scriptArgs !== 'undefined' ? [...scriptArgs] : [...arguments]).filter(a => a !== '--');
const read = p => (isNode ? fs.readFileSync(p, 'utf8') : readFile(p));
const write = (p, s) => (isNode ? fs.writeFileSync(p, s) : writeFile(p, s));

const [templatesPath, outPath] = args;
const out = {};
for (const t of JSON.parse(read(templatesPath))) {
  const [head, tail] = t.split('{}');
  out[t] = [];
  for (let cp = 0; cp <= 0xffff; cp++) if (PLACEHOLDER_ROOM.test(head + String.fromCharCode(cp) + tail)) out[t].push(cp);
}
write(outPath, JSON.stringify(out));
