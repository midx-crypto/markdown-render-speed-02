// md-fast driver: the program the harness runs.
//
// Reads every case from the input directory, renders each one with parse
// from parse.js, and writes the HTML strings, in order, to html.json in
// the output directory. The harness mounts the directories at /input and
// /output inside its container; outside one (the process driver) it hands
// them over as MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR instead. Node 22
// standard library only; nothing is read from anywhere else, and nothing
// is kept from one case to the next.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(inputDir + '/cases.json', 'utf8'));
const html = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + '/html.json', JSON.stringify(html));
