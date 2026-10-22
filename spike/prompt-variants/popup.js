const $ = (id) => document.getElementById(id);
const r0 = (x) => (x == null ? '–' : Math.round(x));
const VARIANTS = ['h-safe', 'h-fast', 'm-autoconsent', 'd-rubric', 'd-fewshot', 'd-labels', 'd-narrow', 'd-baseline'];

async function init() {
  const cfg = await chrome.storage.local.get({ liveEnabled: true, liveVariant: 'h-safe' });
  $('liveEnabled').checked = cfg.liveEnabled;
  for (const v of VARIANTS) { const o = document.createElement('option'); o.value = o.textContent = v; $('liveVariant').appendChild(o); }
  $('liveVariant').value = cfg.liveVariant;
  $('liveEnabled').onchange = () => chrome.storage.local.set({ liveEnabled: $('liveEnabled').checked });
  $('liveVariant').onchange = () => chrome.storage.local.set({ liveVariant: $('liveVariant').value });
  $('bench').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('bench.html') });
  $('clear').onclick = async () => { await chrome.storage.local.set({ liveResults: [] }); render([]); };
  $('copy').onclick = async () => {
    const { liveResults = [] } = await chrome.storage.local.get('liveResults');
    const out = { kind: 'live', userAgent: navigator.userAgent, results: liveResults };
    try { await navigator.clipboard.writeText(JSON.stringify(out, null, 1)); $('msg').textContent = `copied ${liveResults.length}`; }
    catch (e) { $('msg').textContent = 'clipboard failed: ' + e.message; }
  };
  const { liveResults = [] } = await chrome.storage.local.get('liveResults');
  render(liveResults);
}

function render(list) {
  const tb = $('rows');
  tb.textContent = '';
  for (const r of list) {
    const m = r.model || {};
    const t = r.t || {};
    const host = (() => { try { return new URL(r.url).host + (r.isTop ? '' : ' (iframe)'); } catch { return r.url; } })();
    const warm = `${m.firstDecisionInThisSw ? '1st decision in this SW' : 'SW reused'} (SW age ${r0((m.swAgeMs || 0) / 1000)} s), sessions ${m.sessionsWarm ? 'warm' : 'new'}`;
    const cells = [host, r.found ? r.banner.vendor : 'no banner', r0(t.bannerFoundAt), r0(t.aiAddedAfterBannerFoundMs),
      r.found ? `${warm}; calls ${m.modelCalls ?? '–'}; new bases ${JSON.stringify(Object.fromEntries(Object.entries(m.basesCreatedNow || {}).map(([k, v]) => [k, Math.round(v)])))}` : '',
      r.error || (m.output ? `${m.output} ${r.chosenLabel || ''} [${(m.steps || []).join(',')}]` : '')];
    const tr = document.createElement('tr');
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    tb.appendChild(tr);
  }
}
init();
