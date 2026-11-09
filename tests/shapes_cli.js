// Runs the browser's feed-shape check on a raw catalog file (used by tests/test_sync.py to
// keep live.js and sync.py in agreement). Node or JavaScriptCore:
//   RAW.json OUT.json
import { fieldShapes, shapeProblem } from '../assets/js/live.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const fs = isNode ? await import('node:fs') : null;
const args = (isNode ? process.argv.slice(2) : typeof scriptArgs !== 'undefined' ? [...scriptArgs] : [...arguments]).filter(a => a !== '--');
const read = p => (isNode ? fs.readFileSync(p, 'utf8') : readFile(p));
const write = (p, s) => (isNode ? fs.writeFileSync(p, s) : writeFile(p, s));

const [rawPath, outPath] = args;
const shapes = fieldShapes(JSON.parse(read(rawPath)));
write(outPath, JSON.stringify({ shapes, problem: shapeProblem(shapes) }));
