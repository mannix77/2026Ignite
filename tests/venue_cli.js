// Runs the browser venue parser over a list of rooms (used by tests/test_venues.py to check that
// scripts/venues.py places rooms in the same buildings as assets/js/venue.js).
//   node tests/venue_cli.js CONFERENCE_ID ROOMS.json OUT.json
// ROOMS.json is a JSON list of room labels; OUT.json maps each label to {building, floor, known}.
import { readFileSync, writeFileSync } from 'node:fs';
import './shim.js';
import { CONFERENCES } from '../assets/js/conferences.js';
import { createVenue } from '../assets/js/venue.js';

const [conf, roomsPath, outPath] = process.argv.slice(2);
if (!Object.hasOwn(CONFERENCES, conf)) {
  console.error(`unknown conference '${conf}'`);
  process.exit(1);
}
const venue = createVenue(CONFERENCES[conf].venue);
const rooms = JSON.parse(readFileSync(roomsPath, 'utf8'));
const out = {};
for (const room of rooms) {
  const loc = venue.parseLocation(room);
  out[room] = { building: loc.building, floor: loc.floor, known: loc.known };
}
writeFileSync(outPath, JSON.stringify(out));
