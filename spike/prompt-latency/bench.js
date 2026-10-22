// bench.js — reproducible benchmark over canned fixtures.
const $ = (id) => document.getElementById(id);
const r0 = (x) => (x == null || Number.isNaN(x) ? '–' : Math.round(x));
let fixtures = [];
let results = null;

function log(...a) {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  $('log').textContent += s + '\n';
  $('log').scrollTop = 1e9;
}

function stats(xs) {
  xs = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  const median = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  return { n: xs.length, min: xs[0], median, max: xs[xs.length - 1] };
}
const fmt = (s) => (s ? `${r0(s.min)} / ${r0(s.median)} / ${r0(s.max)}` : '–');

// Route an engine call to this page or to the service worker.
async function call(where, fn, ...args) {
  if (where === 'page') {
    if (fn === 'probe') return CookieEngine.probe();
    if (fn === 'createTimings') return CookieEngine.createTimings(args[0], args[1]);
    if (fn === 'decide') return CookieEngine.decide(args[0], args[1]);
    if (fn === 'reset') return CookieEngine.reset();
  }
  const msg = { type: 'bench-' + fn };
  if (fn === 'createTimings') Object.assign(msg, { n: args[0], opts: args[1] });
  if (fn === 'decide') Object.assign(msg, { banner: args[0], opts: args[1] });
  const t = performance.now();
  const r = await chrome.runtime.sendMessage(msg);
  if (r && typeof r === 'object') r.roundTripMs = performance.now() - t;
  return r;
}

async function env() {
  const e = { userAgent: navigator.userAgent, chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1], hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory };
  try {
    e.uaData = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platform', 'platformVersion', 'architecture', 'model', 'bitness']);
  } catch {}
  return e;
}

async function loadFixtures() {
  const ids = await (await fetch('fixtures/index.json')).json();
  fixtures = await Promise.all(ids.map(async (id) => (await fetch(`fixtures/${id}.json`)).json()));
  const box = $('fixtures');
  for (const f of fixtures) {
    const l = document.createElement('label');
    l.title = f.note;
    l.innerHTML = `<input type="checkbox" name="fx" value="${f.id}" checked> ${f.id}${f.stage === 2 ? ' (stage 2)' : ''}`;
    box.appendChild(l);
  }
}

async function refreshStatus() {
  const [page, sw] = await Promise.all([
    CookieEngine.probe(),
    call('sw', 'probe').catch((e) => ({ error: String(e) })),
  ]);
  $('status').textContent = `this page: LanguageModel ${page.hasLanguageModel ? 'present' : 'MISSING'}, availability="${page.availability}" (${r0(page.availabilityMs)} ms)${page.availabilityError ? ' — ' + page.availabilityError + ' (treat as unavailable; see README step 1)' : ''}` +
    ` | service worker: LanguageModel ${sw.hasLanguageModel ? 'present' : 'MISSING'}, availability="${sw.availability}"` +
    ` | Chrome ${(navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1]}`;
  $('dl').hidden = !(page.availability === 'downloadable' || page.availability === 'downloading');
  $('run').disabled = page.availability !== 'available' && sw.availability !== 'available';
  return { page, sw };
}

$('download').onclick = async () => {
  // Must run inside the click handler: model download requires user activation.
  $('dltext').textContent = 'starting…';
  try {
    const r = await CookieEngine.download((p) => { $('dlprog').value = p; $('dltext').textContent = (p * 100).toFixed(1) + '%'; });
    $('dltext').textContent = `done in ${r0(r.ms)} ms`;
    window.__download = r;
    log('download', r);
  } catch (e) {
    $('dltext').textContent = 'failed: ' + e;
  }
  await refreshStatus();
};

$('run').onclick = async () => {
  $('run').disabled = true; $('copy').disabled = true; $('log').textContent = '';
  const where = $('where').value;
  const n = Math.max(1, Number($('iters').value) || 5);
  const maxText = Number($('maxText').value);
  const greedy = $('greedy').checked;
  const strategies = [...document.querySelectorAll('input[name=strategy]:checked')].map((x) => x.value);
  const constraints = [...document.querySelectorAll('input[name=constraint]:checked')].map((x) => x.value);
  const fxIds = new Set([...document.querySelectorAll('input[name=fx]:checked')].map((x) => x.value));
  const fxs = fixtures.filter((f) => fxIds.has(f.id));
  results = {
    kind: 'bench', startedAt: new Date().toISOString(), env: await env(),
    config: { where, iterations: n, maxText, greedy, strategies, constraints, fixtures: fxs.map((f) => f.id) },
    probe: await refreshStatus(), download: window.__download || null,
    prompt: { system: CookieEngine.SYSTEM, schema: CookieEngine.SCHEMA, sampleUser: fxs[0] && CookieEngine.bannerToPrompt(fxs[0].banner, maxText) },
  };
  try {
    await call(where, 'reset');
    log(`session timings in ${where}…`);
    results.sessions = await call(where, 'createTimings', n, { greedy });
    renderSessions(results.sessions);
    // fresh: page/SW base is now warm (createTimings primed it); clone runs reuse it.
    const cases = new Map();
    const total = n * fxs.length * strategies.length * constraints.length;
    let k = 0;
    for (let it = 0; it < n; it++) {
      for (const f of fxs) for (const strategy of strategies) for (const constraint of constraints) {
        k++;
        $('progress').textContent = `${k}/${total}`;
        const r = await call(where, 'decide', f.banner, { strategy, constraint, maxText, greedy, measureTokens: true });
        r.iteration = it;
        Object.assign(r, CookieEngine.score(r.decision, f.expected, f.banner));
        const key = `${f.id}|${strategy}|${constraint}`;
        if (!cases.has(key)) cases.set(key, { fixture: f.id, strategy, constraint, runs: [] });
        cases.get(key).runs.push(r);
        log(`${key} #${it}: setup ${r0(r.setupMs)} ttft ${r0(r.ttftMs)} prompt ${r0(r.promptMs)} tokens ${r.inputTokens} -> ${r.error || r.output} ${r.correct ? 'OK' : 'WRONG ' + (r.why || '')}`);
      }
      results.cases = [...cases.values()].map(summarise);
      renderSummary(results.cases);
    }
    results.overall = overall(results.cases);
    renderOverall(results.overall);
  } catch (e) {
    log('ERROR', String(e && e.stack || e));
    results.error = String(e);
  }
  results.finishedAt = new Date().toISOString();
  $('progress').textContent = 'done';
  $('run').disabled = false; $('copy').disabled = false; $('save').disabled = false;
};

function summarise(c) {
  const R = c.runs;
  return Object.assign(c, {
    stats: {
      setupMs: stats(R.map((r) => r.setupMs)),
      ttftMs: stats(R.map((r) => r.ttftMs)),
      promptMs: stats(R.map((r) => r.promptMs)),
      decisionMs: stats(R.map((r) => r.decisionMs)),
      inputTokens: stats(R.map((r) => r.inputTokens)),
      promptChars: R[0] && R[0].promptChars,
      correct: R.filter((r) => r.correct).length,
      parsed: R.filter((r) => r.parseOk).length,
      errors: R.filter((r) => r.error).length,
      n: R.length,
    },
  });
}

function overall(cases) {
  const groups = new Map();
  for (const c of cases) {
    const key = `${c.strategy}|${c.constraint}`;
    if (!groups.has(key)) groups.set(key, { strategy: c.strategy, constraint: c.constraint, runs: [] });
    groups.get(key).runs.push(...c.runs);
  }
  return [...groups.values()].map((g) => ({
    strategy: g.strategy, constraint: g.constraint,
    setupMs: stats(g.runs.map((r) => r.setupMs)), ttftMs: stats(g.runs.map((r) => r.ttftMs)),
    promptMs: stats(g.runs.map((r) => r.promptMs)), decisionMs: stats(g.runs.map((r) => r.decisionMs)),
    correct: g.runs.filter((r) => r.correct).length, n: g.runs.length,
  }));
}

function table(headers, rows) {
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i === 0 ? '' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderSessions(s) {
  $('sessions').innerHTML = table(['measure', 'value (min / median / max)'], [
    ['first create() in this context (no system prompt)', r0(s.firstCreateMs)],
    ['create() no system prompt', fmt(stats(s.bareCreateMs))],
    ['create() with system prompt (initialPrompts)', fmt(stats(s.systemCreateMs))],
    ['primed base create (for clone)', r0(s.baseCreateMs)],
    ['clone() from primed base', fmt(stats(s.cloneMs))],
    ['contextWindow / system prompt usage', `${s.contextWindow} / ${s.systemPromptUsage}`],
  ]);
}

function renderSummary(cases) {
  $('summary').innerHTML = table(
    ['fixture | strategy | output', 'setup med', 'TTFT min/med/max', 'prompt med', 'decision min/med/max', 'input tokens', 'chars', 'correct', 'last output'],
    cases.map((c) => {
      const s = c.stats;
      const last = c.runs[c.runs.length - 1];
      const ok = s.correct === s.n ? 'good' : 'bad';
      return [`${c.fixture} | ${c.strategy} | ${c.constraint}`, r0(s.setupMs && s.setupMs.median), fmt(s.ttftMs), r0(s.promptMs && s.promptMs.median), fmt(s.decisionMs),
        s.inputTokens ? r0(s.inputTokens.median) : '–', s.promptChars, `<span class="${ok}">${s.correct}/${s.n}</span>`,
        `<span class="l">${escapeHtml(last.error || last.output || '')}</span>`];
    }));
}

function renderOverall(rows) {
  $('overall').innerHTML = table(['strategy | output', 'setup', 'TTFT', 'prompt', 'decision', 'correct'],
    rows.map((g) => [`${g.strategy} | ${g.constraint}`, fmt(g.setupMs), fmt(g.ttftMs), fmt(g.promptMs), fmt(g.decisionMs), `${g.correct}/${g.n}`]));
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

$('copy').onclick = async () => {
  const json = JSON.stringify(results, null, 1);
  try {
    await navigator.clipboard.writeText(json);
    $('progress').textContent = `copied ${json.length} chars to clipboard`;
  } catch (e) {
    $('progress').textContent = 'clipboard failed (' + e.message + ') — select the text box below and copy manually';
  }
  $('out').hidden = false;
  $('out').value = json;
};
$('save').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(results, null, 1)], { type: 'application/json' }));
  a.download = `prompt-latency-${results.startedAt.replace(/[:.]/g, '-')}.json`;
  a.click();
};

(async () => {
  $('sys').textContent = CookieEngine.SYSTEM + '\n\nSchema: ' + JSON.stringify(CookieEngine.SCHEMA);
  await loadFixtures();
  await refreshStatus();
})();
