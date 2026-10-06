// Exits 0 if the argument is a conference id the app knows (a key of CONFERENCES), 1 otherwise.
// The deploy uses it to check instances/<name>/conference before stamping it into a copy:
//   node scripts/conference_id.js gartner2026
import { CONFERENCES } from '../assets/js/conferences.js';

const id = process.argv[2] || '';
if (!Object.hasOwn(CONFERENCES, id)) {
  console.error(`unknown conference '${id}' (known: ${Object.keys(CONFERENCES).join(', ')})`);
  process.exit(1);
}
