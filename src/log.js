/**
 * One place everything is said: stdout (Railway logs) and a ring the API reads.
 */
const ring = [];

export function say(msg, extra = {}) {
  const row = { at: new Date().toISOString(), msg: String(msg), ...extra };
  if (!say.quiet) console.log(`[${row.at.slice(11, 19)}] ${row.kind ? `${row.kind}: ` : ''}${row.msg}`);
  ring.push(row);
  if (ring.length > 300) ring.shift();
  return row;
}
say.quiet = process.env.GTAFLY_QUIET === '1';

export const recent = (n = 80) => ring.slice(-n);
