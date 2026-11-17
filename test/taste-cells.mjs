/**
 * The taste cells are real, labelled gustatory receptor neurons, and sweet and bitter never overlap.
 *   node test/taste-cells.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadNeuronsNode } from '../site/fly/load.js';
import { findTasteCells } from '../src/taste.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'site', 'fly');
const names = await loadNeuronsNode(DIR);
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.log('  FAIL', m); } };

for (const mode of ['paper', 'bilateral']) {
  const t = findTasteCells(names, { mode });
  console.log(`${mode}: sweet ${t.sweet.length} ${JSON.stringify(t.meta.sweetTypes)} | bitter ${t.bitter.length} ${JSON.stringify(t.meta.bitterTypes)}`);
  ok(t.sweet.length > 0 && t.bitter.length > 0, 'empty set');
  const s = new Set(t.sweet);
  ok(t.bitter.every((i) => !s.has(i)), 'sweet and bitter overlap');
  ok(new Set(t.sweet).size === t.sweet.length && new Set(t.bitter).size === t.bitter.length, 'duplicates in a set');
  const all = [...t.sweet, ...t.bitter];
  ok(all.every((i) => Number.isInteger(i) && i >= 0 && i < names.length), 'index out of range');
  // every one is a FlyWire gustatory sensory neuron (TSV cell_class "gustatory", super_class "sensory")
  ok(all.every((i) => names[i].cls === 'sensory'), 'non-sensory cell in a taste set');
  ok(t.sweet.every((i) => names[i].type === 'LB3'), 'sweet cell not LB3');
  ok(t.bitter.every((i) => ['LB1a,LB1d', 'LB1b', 'LB1c'].includes(names[i].type)), 'bitter cell not LB1a-d');
  ok(t.meta.sweetIds.length === t.sweet.length && t.meta.sweetIds.every((id, k) => names[t.sweet[k]].id === id), 'ids do not match indices');
  ok(t.meta.source.includes('Shiu'), 'source missing');
}
const p = findTasteCells(names);
ok(p.sweet.length === 29 && p.bitter.length === 20, `paper sets are ${p.sweet.length}/${p.bitter.length}, expected 29/20`);
ok(p.meta.missing.sugarR.length === 1 && p.meta.missing.sugarL.length === 1 && p.meta.missing.bitter.length === 1, 'missing counts changed');
console.log(`not in v783 (dropped, never guessed): ${JSON.stringify(p.meta.missing)}`);
// deterministic
ok(JSON.stringify(findTasteCells(names)) === JSON.stringify(p), 'not deterministic');
console.log(`\ntaste-cells: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
