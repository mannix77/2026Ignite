// Runs the browser normalizer on a raw catalog file (used by tests/test_sync.py).
// Works under macOS JavaScriptCore (jsc -m ... -- ARGS) and Node (node ... ARGS):
//   RAW.json SPEAKERS.json|- OUT.json FIRST_DAY LAST_DAY
import { normalize } from '../assets/js/live.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const fs = isNode ? await import('node:fs') : null;
const args = (isNode ? process.argv.slice(2) : typeof scriptArgs !== 'undefined' ? [...scriptArgs] : [...arguments]).filter(a => a !== '--');
const read = p => (isNode ? fs.readFileSync(p, 'utf8') : readFile(p));
const write = (p, s) => (isNode ? fs.writeFileSync(p, s) : writeFile(p, s));

const [rawPath, spkPath, outPath, first, last] = args;
const raw = JSON.parse(read(rawPath));
const spk = spkPath && spkPath !== '-' ? JSON.parse(read(spkPath)) : null;
write(outPath, JSON.stringify(normalize(raw, spk, [first, last])));
