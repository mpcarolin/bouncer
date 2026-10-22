// bench.js — side-by-side comparison of variants over the fixtures. ES module.
import * as ACHeur from './node_modules/@duckduckgo/autoconsent/dist/heuristics.mjs';
import './runner.js';
import './variants.js';
globalThis.ACHeur = ACHeur;
const V = globalThis.Variants, R = globalThis.Runner;

const $ = (id) => document.getElementById(id);
const r0 = (x) => (x == null || Number.isNaN(x) ? '–' : Math.round(x));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let fixtures = [], results = null, stopFlag = false, probeInfo = null;

const DEFAULT_OFF = new Set(['g-def-tiny', 'd-baseline']); // d-baseline was measured in round 1 (32–42/55)
// rough per-run seconds for the estimate (round-1: ~1.1 s per JSON decision, gate outputs are ~2 tokens)
const COST = { mechanical: 0, gate: 0.5, decide: 1.2, hybrid: 0.6, 'd-labels': 2.5, 'd-narrow': 0.9 };

function log(s) { $('log').textContent += s + '\n'; $('log').scrollTop = 1e9; }
function quant(xs, q) { xs = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!xs.length) return null; return xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]; }
function median(xs) { xs = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!xs.length) return null; const m = xs.length >> 1; return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2; }
function mode(xs) { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]; }

async function init() {
  const ids = await (await fetch('fixtures/index.json')).json();
  fixtures = await Promise.all(ids.map(async (id) => (await fetch(`fixtures/${id}.json`)).json()));
  const vbox = $('variants');
  for (const kind of ['mechanical', 'gate', 'decide', 'hybrid']) {
    const d = document.createElement('div');
    d.innerHTML = `<b>${kind}</b> `;
    for (const v of V.ALL.filter((x) => x.kind === kind)) {
      const l = document.createElement('label');
      l.title = v.describe || v.label;
      l.innerHTML = `<input type="checkbox" name="v" value="${v.id}" ${DEFAULT_OFF.has(v.id) ? '' : 'checked'}> ${v.id} <span class="dim">(${esc(v.label)})</span> `;
      d.appendChild(l);
    }
    vbox.appendChild(d);
  }
  const fbox = $('fixtures');
  for (const f of fixtures) {
    const l = document.createElement('label');
    l.title = f.note;
    l.innerHTML = `<input type="checkbox" name="fx" value="${f.id}" data-kind="${f.kind}" checked> ${f.kind === 'negative' ? '<span class="dim">−</span>' : '+'}${f.id}`;
    fbox.appendChild(l);
  }
  const setFx = (pred) => { for (const el of document.querySelectorAll('input[name=fx]')) el.checked = pred(el); estimate(); };
  $('fxAll').onclick = () => setFx(() => true);
  $('fxPos').onclick = () => setFx((el) => el.dataset.kind === 'positive');
  $('fxNeg').onclick = () => setFx((el) => el.dataset.kind === 'negative');
  $('fxNone').onclick = () => setFx(() => false);
  document.addEventListener('change', estimate);
  estimate();

  probeInfo = await R.probe();
  $('status').textContent = `LanguageModel: ${probeInfo.hasLanguageModel ? 'present' : 'MISSING'} · availability="${probeInfo.availability}"` +
    `${probeInfo.availabilityError ? ' (' + probeInfo.availabilityError + ' — treat as unavailable)' : ''} · samplingMode ${probeInfo.hasSamplingMode ? 'exposed' : 'not exposed'}` +
    ` · legacy topK ${probeInfo.hasLegacyTopK ? 'exposed' : 'not exposed'} · Chrome ${(navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1]}` +
    (probeInfo.availability === 'available' ? '' : ' · only the mechanical variant can run');
  $('run').disabled = false;
}

function selected() {
  const vs = [...document.querySelectorAll('input[name=v]:checked')].map((x) => V.ALL.find((v) => v.id === x.value));
  const fset = new Set([...document.querySelectorAll('input[name=fx]:checked')].map((x) => x.value));
  return { vs, fxs: fixtures.filter((f) => fset.has(f.id)) };
}

function estimate() {
  const { vs, fxs } = selected();
  const n = Number($('iters').value) || 3;
  let sec = 0;
  for (const v of vs) sec += (COST[v.id] != null ? COST[v.id] : COST[v.kind]) * fxs.filter((f) => V.applies(v, f)).length * n;
  $('estimate').textContent = `≈ ${Math.ceil(sec / 60)} min`;
}

$('stop').onclick = () => { stopFlag = true; };

$('run').onclick = async () => {
  stopFlag = false;
  $('run').disabled = true; $('stop').disabled = false; $('log').textContent = '';
  const { vs, fxs } = selected();
  const n = Math.max(1, Number($('iters').value) || 3);
  const greedy = $('greedy').checked;
  const measure = $('measure').checked;
  if (!probeInfo || probeInfo.availability !== 'available') { $('progress').textContent = 're-checking model…'; probeInfo = await R.probe(); }
  const modelOk = probeInfo.availability === 'available';
  results = {
    kind: 'prompt-variants-bench', startedAt: new Date().toISOString(),
    env: { userAgent: navigator.userAgent, chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1], hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory },
    probe: probeInfo, config: { iterations: n, greedy, measure, variants: vs.map((v) => v.id), fixtures: fxs.map((f) => f.id) },
    summary: {}, perFixture: {}, sessions: {}, raw: {}, coldStarts: (results && results.coldStarts) || [],
  };
  try { results.env.uaData = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture']); } catch {}

  for (const v of vs) {
    if (stopFlag) break;
    if (v.kind !== 'mechanical' && !modelOk) { log(`skip ${v.id}: model not available`); continue; }
    const ctx = new R.Ctx({ greedy });
    const applicable = fxs.filter((f) => V.applies(v, f));
    if (!applicable.length) continue;
    const runs = [];
    // warm-up run (discarded): creates the primed base session(s) for this variant
    if (v.kind !== 'mechanical') {
      try { ctx.begin(false); await v.run(ctx, applicable[0].banner, applicable[0]); ctx.end(); } catch (e) { log(`${v.id} warm-up error: ${e}`); }
    }
    const iters = v.kind === 'mechanical' ? 1 : n; // deterministic, no model
    for (let it = 0; it < iters && !stopFlag; it++) {
      for (const f of applicable) {
        if (stopFlag) break;
        $('progress').textContent = `${v.id} · iteration ${it + 1}/${iters} · ${f.id}`;
        ctx.begin(measure && it === 0);
        let out, err = null;
        try { out = await v.run(ctx, f.banner, f); } catch (e) { err = (e && e.name ? e.name + ': ' : '') + (e && e.message || e); out = { decision: null }; }
        const m = ctx.end();
        const ev = V.evaluate(v, f, out.decision);
        const run = {
          fixture: f.id, iteration: it, output: v.kind === 'gate' ? (out.decision ? 'gate:' + out.decision.gate : 'unparseable') : V.fmtDecision(out.decision),
          correct: ev.correct, why: ev.why, ms: m.ms, firstTtftMs: m.firstTtftMs, modelCalls: m.modelCalls, inputTokens: m.inputTokens,
          raw: out.raw, steps: out.steps, error: err,
        };
        runs.push(run);
        if (!ev.correct || err) log(`${v.id} ${f.id} #${it}: ${run.output} ${err || ''} ${ev.why || ''}`);
      }
      summarise(v, runs, applicable);
      render();
    }
    results.sessions[v.id] = ctx.baseInfo;
    results.raw[v.id] = runs;
    ctx.destroyAll();
  }
  results.finishedAt = new Date().toISOString();
  $('progress').textContent = stopFlag ? 'stopped' : 'done';
  $('run').disabled = false; $('stop').disabled = true; $('copy').disabled = false; $('save').disabled = false;
};

function summarise(v, runs, applicable) {
  const byFx = {};
  for (const r of runs) (byFx[r.fixture] = byFx[r.fixture] || []).push(r);
  const fxById = Object.fromEntries(applicable.map((f) => [f.id, f]));
  let fp = 0, fn = 0, negRuns = 0, posRuns = 0, consistent = 0;
  const per = {};
  for (const [id, rs] of Object.entries(byFx)) {
    const f = fxById[id];
    const outs = rs.map((r) => r.output);
    const same = outs.every((o) => o === outs[0]);
    if (same) consistent++;
    for (const r of rs) {
      const actedOnNegative = f.kind === 'negative' && (v.kind === 'gate' ? r.output === 'gate:consent' : r.output !== 'not_consent');
      const missedPositive = f.kind === 'positive' && (v.kind === 'gate' ? r.output !== 'gate:consent' : r.output === 'not_consent');
      if (f.kind === 'negative') { negRuns++; if (actedOnNegative) fp++; } else { posRuns++; if (missedPositive) fn++; }
    }
    per[id] = {
      expected: v.kind === 'gate' ? 'gate:' + f.gate.expected : f.expected.map(V.fmtDecision).join(' | '),
      correct: `${rs.filter((r) => r.correct).length}/${rs.length}`, consistent: same, outputs: outs, medianMs: r0(median(rs.map((r) => r.ms))),
    };
  }
  const cor = runs.filter((r) => r.correct).length;
  results.summary[v.id] = {
    kind: v.kind, label: v.label,
    correct: `${cor}/${runs.length}`, accuracy: runs.length ? +(cor / runs.length).toFixed(3) : null,
    fp: v.kind === 'decide' ? null : `${fp}/${negRuns}`, fn: v.kind === 'decide' ? null : `${fn}/${posRuns}`,
    medianMs: r0(median(runs.map((r) => r.ms))), p90Ms: r0(quant(runs.map((r) => r.ms), 0.9)),
    medianTtftMs: r0(median(runs.map((r) => r.firstTtftMs))),
    medianInputTokens: r0(median(runs.map((r) => r.inputTokens))),
    avgModelCalls: runs.length ? +(runs.reduce((a, r) => a + r.modelCalls, 0) / runs.length).toFixed(2) : 0,
    consistent: `${consistent}/${Object.keys(byFx).length}`, errors: runs.filter((r) => r.error).length,
  };
  results.perFixture[v.id] = per;
}

function render() {
  const S = results.summary;
  const cols = ['variant', 'kind', 'correct', 'acc', 'FP', 'FN', 'ms med', 'ms p90', 'TTFT med', 'in tok', 'calls/run', 'consistent', 'errors'];
  $('summary').innerHTML = `<table><thead><tr>${cols.map((c, i) => `<th class="${i < 2 ? 'l' : ''}">${c}</th>`).join('')}</tr></thead><tbody>` +
    Object.entries(S).map(([id, s]) => `<tr><td class="l" title="${esc(s.label)}">${id}</td><td class="l">${s.kind}</td><td>${s.correct}</td><td>${s.accuracy == null ? '–' : (s.accuracy * 100).toFixed(0) + '%'}</td>` +
      `<td>${s.fp || '–'}</td><td>${s.fn || '–'}</td><td>${s.medianMs}</td><td>${s.p90Ms}</td><td>${s.medianTtftMs}</td><td>${s.medianInputTokens}</td><td>${s.avgModelCalls}</td><td>${s.consistent}</td><td>${s.errors}</td></tr>`).join('') +
    '</tbody></table>';
  const vids = Object.keys(results.perFixture);
  const fids = fixtures.map((f) => f.id).filter((id) => vids.some((v) => results.perFixture[v][id]));
  $('matrix').innerHTML = `<table class="matrix"><thead><tr><th class="l">fixture</th><th class="l">expected</th>${vids.map((v) => `<th>${v}</th>`).join('')}</tr></thead><tbody>` +
    fids.map((fid) => {
      const f = fixtures.find((x) => x.id === fid);
      return `<tr><td class="l">${f.kind === 'negative' ? '−' : '+'}${fid}</td><td class="l dim">${esc(f.expected.map(V.fmtDecision).join(' | '))}</td>` +
        vids.map((v) => {
          const p = results.perFixture[v][fid];
          if (!p) return '<td class="dim">·</td>';
          const [k, n] = p.correct.split('/').map(Number);
          return `<td class="${k === n ? 'good' : 'bad'}" title="${esc(p.outputs.join(' ; '))}">${p.correct} ${esc(mode(p.outputs))}${p.consistent ? '' : '*'}</td>`;
        }).join('') + '</tr>';
    }).join('') + '</tbody></table><div class="dim">* = iterations disagreed (hover for all outputs)</div>';
}

$('copy').onclick = async () => {
  const json = JSON.stringify(results, null, 1);
  try { await navigator.clipboard.writeText(json); $('progress').textContent = `copied ${json.length} chars`; }
  catch (e) { $('progress').textContent = 'clipboard failed — copy from the box'; }
  $('out').hidden = false; $('out').value = json;
};
$('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(results, null, 1)], { type: 'application/json' }));
  a.download = `prompt-variants-${results.startedAt.replace(/[:.]/g, '-')}.json`;
  a.click();
};

// ---- cold start ----
$('cold').onclick = async () => {
  const wait = Math.max(0, Number($('coldWait').value) || 0);
  const where = $('coldWhere').value;
  const banner = fixtures.find((f) => f.id === 'nvidia').banner;
  $('cold').disabled = true; $('coldOut').hidden = false;
  const out = { kind: 'cold-start', where, waitS: wait, at: new Date().toISOString(), userAgent: navigator.userAgent };
  try {
    // Make sure this extension holds no sessions anywhere, so the browser may unload the model.
    try { out.swReset = await chrome.runtime.sendMessage({ type: 'reset' }); } catch (e) { out.swReset = String(e); }
    for (let s = wait; s > 0; s--) { $('coldStatus').textContent = `waiting ${s}s (don't use the model elsewhere)…`; await new Promise((r) => setTimeout(r, 1000)); }
    $('coldStatus').textContent = 'measuring…';
    if (where === 'page') out.result = await R.coldProbe(banner);
    else { const t = performance.now(); out.result = await chrome.runtime.sendMessage({ type: 'cold-probe', banner }); out.roundTripMs = performance.now() - t; }
    $('coldStatus').textContent = `cold total ${r0(out.result && out.result.coldTotalMs)} ms (create ${r0(out.result && out.result.cold && out.result.cold.createMs)}, warm create ${r0(out.result && out.result.warm && out.result.warm.createMs)})`;
  } catch (e) { out.error = String(e); $('coldStatus').textContent = 'error: ' + e; }
  $('coldOut').textContent = JSON.stringify(out, null, 1);
  (results = results || { kind: 'prompt-variants-bench', coldStarts: [] }).coldStarts = (results.coldStarts || []).concat([out]);
  $('copy').disabled = false; $('save').disabled = false;
  if (!results.startedAt) results.startedAt = out.at;
  $('cold').disabled = false;
};

init();
