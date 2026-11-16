// md-fast driver: the program the harness runs.
//
// Reads every case from /input/cases.json, renders each one with parse
// from parse.js, and writes the HTML strings, in order, to
// /output/html.json. Node 22 standard library only; nothing is read from
// anywhere else, and nothing is kept from one case to the next.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from './parse.js';

const cases = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(html));
