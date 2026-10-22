// baseline.mjs — mechanical baseline (no model) over every fixture, in Node.
//   node baseline.mjs            → prints a table and writes baseline-results.json
// Also runs the hybrid pipelines with the model stubbed out to show how often they would
// need the model at all (fast path / regex gate / unknown controls).
import fs from 'node:fs';
import * as H from '@duckduckgo/autoconsent/heuristics';
globalThis.ACHeur = H;
await import('./variants.js');
const V = globalThis.Variants;

const dir = new URL('./fixtures/', import.meta.url);
const ids = JSON.parse(fs.readFileSync(new URL('index.json', dir)));
const fixtures = ids.map((id) => JSON.parse(fs.readFileSync(new URL(id + '.json', dir))));

const mech = V.MECH_VARIANTS[0];
const rows = [];
const noModel = { open() { throw new Error('model needed'); }, ask() { throw new Error('model needed'); } };
for (const fx of fixtures) {
  const r = await mech.run(noModel, fx.banner, fx);
  const ev = V.evaluate(mech, fx, r.decision);
  const g = V.mechGate(fx);
  const labels = V.regexLabels(fx.banner);
  const unknown = fx.banner.controls.filter((c) => labels[c.i] === 'unknown').map((c) => `${c.i}:"${c.label}"`);
  const hasReject = fx.banner.controls.some((c) => labels[c.i] === 'reject');
  rows.push({
    id: fx.id, kind: fx.kind, category: fx.category, gateExpected: fx.gate.expected, borderline: !!fx.gate.borderline,
    mechGate: g.consent ? 'consent' : 'other', gatePatterns: g.patterns, gateExcluded: g.excluded,
    detectorPicked: fx.detectorPicked,
    expected: fx.expected.map(V.fmtDecision).join(' | '), mechDecision: V.fmtDecision(r.decision), correct: ev.correct, why: ev.why || '',
    autoconsentPopupClass: H.classifyPopup(fx.banner.controls.filter((c) => c.role !== 'toggle').map((c) => ({ text: c.label, regexClassification: H.classifyButtonTextRegex(c.label) }))),
    hybridPath: g.consent && hasReject ? 'fast-path (0 model calls)' : `model: ${g.consent ? 'h-fast skips gate' : 'gate'} + ${unknown.length ? 'label ' + unknown.length + ' unknown' : 'no labelling'}`,
    unknownControls: unknown,
    regexLabels: fx.banner.controls.map((c) => `${c.i}=${labels[c.i]}`).join(' '),
  });
}

const pos = rows.filter((r) => r.kind === 'positive'), neg = rows.filter((r) => r.kind === 'negative');
const summary = {
  fixtures: rows.length, positives: pos.length, negatives: neg.length,
  decisionCorrectAll: `${rows.filter((r) => r.correct).length}/${rows.length}`,
  decisionCorrectPositives: `${pos.filter((r) => r.correct).length}/${pos.length}`,
  negativesLeftAlone: `${neg.filter((r) => r.correct).length}/${neg.length}`,
  gate: {
    truePositive: pos.filter((r) => r.mechGate === 'consent').length,
    falseNegative: pos.filter((r) => r.mechGate !== 'consent').map((r) => r.id),
    trueNegative: neg.filter((r) => r.mechGate === 'other').length,
    falsePositive: neg.filter((r) => r.mechGate === 'consent').map((r) => r.id),
  },
  hybridFastPath: rows.filter((r) => r.hybridPath.startsWith('fast')).map((r) => r.id),
  genericDetectorPickedNegatives: neg.filter((r) => r.detectorPicked).map((r) => r.id),
  autoconsentVersion: JSON.parse(fs.readFileSync(new URL('./node_modules/@duckduckgo/autoconsent/package.json', import.meta.url))).version,
};

fs.writeFileSync(new URL('./baseline-results.json', import.meta.url), JSON.stringify({ summary, rows }, null, 1) + '\n');
for (const r of rows) {
  console.log(`${r.correct ? 'OK  ' : 'MISS'} ${r.id.padEnd(28)} gate=${r.mechGate.padEnd(7)} (exp ${r.gateExpected}${r.borderline ? ', borderline' : ''}) decision=${r.mechDecision.padEnd(20)} expected=${r.expected.padEnd(22)} | ${r.hybridPath}`);
  if (r.unknownControls.length) console.log(`      unknown: ${r.unknownControls.join(', ')}`);
}
console.log(JSON.stringify(summary, null, 1));
