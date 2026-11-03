// Seat display helpers shared by the room views. Pure functions, so tests can load them without a page.

const up = (s) => s.toUpperCase();

/**
 * Avatar letters for the seats at one table. A seat gets its first letter when no other seat starts
 * with it; otherwise the first letter plus the first later letter that no rival has at the same
 * position (grok and gemini become GR and GE, seat1 and seat2 become S1 and S2). Anything still
 * equal falls back to the first letter and a counter.
 */
export function chipLabels(names) {
  const out = {};
  for (const n of names) {
    const rivals = names.filter((o) => o !== n && up(o.slice(0, 1)) === up(n.slice(0, 1)));
    let label = up(n.slice(0, 1));
    if (rivals.length) {
      for (let i = 1; i < n.length; i++) {
        if (rivals.every((o) => up(o[i] ?? '') !== up(n[i]))) { label += up(n[i]); break; }
      }
    }
    out[n] = label;
  }
  const used = new Set();
  for (const n of names) {
    let label = out[n];
    for (let k = 2; used.has(label); k++) label = up(n.slice(0, 1)) + k;
    used.add(label);
    out[n] = label;
  }
  return out;
}

/** What runs a seat: the model chosen on the page, otherwise the bot name the agent gave when it joined. */
export const seatDetail = (s) => s.model ?? s.bot ?? null;
