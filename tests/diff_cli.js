// Runs the browser's catalog diff on two normalized session lists (used by tests/test_sync.py).
// Works under macOS JavaScriptCore (jsc -m ... -- ARGS) and Node (node ... ARGS):
//   PREV.json CUR.json OUT.json
import { diff } from '../assets/js/live.js';

const isNode = typeof process !== 'undefined' && !!process.versions?.node;
const fs = isNode ? await import('node:fs') : null;
const args = (isNode ? process.argv.slice(2) : typeof scriptArgs !== 'undefined' ? [...scriptArgs] : [...arguments]).filter(a => a !== '--');
const read = p => (isNode ? fs.readFileSync(p, 'utf8') : readFile(p));
const write = (p, s) => (isNode ? fs.writeFileSync(p, s) : writeFile(p, s));

const [prevPath, curPath, outPath] = args;
write(outPath, JSON.stringify(diff(JSON.parse(read(prevPath)), JSON.parse(read(curPath)))));
