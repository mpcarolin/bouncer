const $ = (id) => document.getElementById(id);
const v = (x) => (x == null ? '–' : x);

async function init() {
  const s = await chrome.storage.local.get({ enabled: true, disabledSites: [] });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try { host = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
  $('host').textContent = host || 'this site';
  $('enabled').checked = s.enabled;
  $('site').checked = s.disabledSites.includes(host);
  $('site').disabled = !host;
  $('enabled').onchange = () => chrome.storage.local.set({ enabled: $('enabled').checked });
  $('site').onchange = async () => {
    const cur = (await chrome.storage.local.get({ disabledSites: [] })).disabledSites.filter((h) => h !== host);
    if ($('site').checked) cur.push(host);
    await chrome.storage.local.set({ disabledSites: cur });
  };
  $('clear').onclick = async () => { await chrome.storage.local.set({ log: [] }); render(); };
  $('showDeferred').onchange = render;
  $('copy').onclick = async () => {
    const { log = [] } = await chrome.storage.local.get('log');
    const out = { kind: 'bouncer-log', userAgent: navigator.userAgent, exportedAt: new Date().toISOString(), log };
    try { await navigator.clipboard.writeText(JSON.stringify(out, null, 1)); $('msg').textContent = `copied ${log.length}`; }
    catch (e) { $('msg').textContent = 'clipboard failed: ' + e.message; }
  };
  render();
}

async function render() {
  const { log = [] } = await chrome.storage.local.get('log');
  const tb = $('rows');
  tb.textContent = '';
  for (const e of log) {
    if (e.outcome === 'deferred' && !$('showDeferred').checked) continue;
    const t = e.t || {};
    const model = e.path === 'autoconsent' ? `${v(e.clicks)} clicks${e.selfTest != null ? ', self-test ' + e.selfTest : ''}`
      : e.modelCalls ? `${e.modelCalls} call(s), ${e.coldStart ? 'COLD start' : 'warm'}` : (e.path === 'heuristic' ? 'no model' : '–');
    const path = e.path === 'autoconsent' ? `autoconsent: ${e.rule}` : e.path + (e.stage2 ? ' (+settings panel)' : '');
    const cells = [e.site, path, v(e.gate), (e.clicked || []).join(' → ') + ((e.toggled || []).length ? ` [${e.toggled.length} toggles]` : ''),
      `${v(t.bannerFoundAt)} / ${v(t.decisionAt)} / ${v(t.goneAt)}`, model, e.outcome + (e.detail ? ': ' + e.detail : '') + (e.scrollUnlocked ? ' (scroll unlocked)' : '')];
    const tr = document.createElement('tr');
    tr.className = e.outcome;
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    tb.appendChild(tr);
  }
}
init();
