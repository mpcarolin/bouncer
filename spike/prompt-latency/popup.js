const KEYS = { liveEnabled: true, liveEngine: 'sw', constraint: 'schema', maxText: 400 };
const $ = (id) => document.getElementById(id);
const r0 = (x) => (x == null ? '–' : Math.round(x));

async function init() {
  const cfg = await chrome.storage.local.get(KEYS);
  $('liveEnabled').checked = cfg.liveEnabled;
  $('liveEngine').value = cfg.liveEngine;
  $('constraint').value = cfg.constraint;
  $('maxText').value = cfg.maxText;
  for (const k of Object.keys(KEYS)) {
    $(k).addEventListener('change', () => {
      const el = $(k);
      const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
      chrome.storage.local.set({ [k]: v });
    });
  }
  $('bench').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('bench.html') });
  $('clear').onclick = async () => { await chrome.storage.local.set({ liveResults: [] }); render([]); };
  $('copy').onclick = async () => {
    const { liveResults = [] } = await chrome.storage.local.get('liveResults');
    const out = { kind: 'live', userAgent: navigator.userAgent, chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1], results: liveResults };
    try {
      await navigator.clipboard.writeText(JSON.stringify(out, null, 1));
      $('msg').textContent = `copied ${liveResults.length} results`;
    } catch (e) {
      $('msg').textContent = 'clipboard failed: ' + e.message;
    }
  };
  const { liveResults = [] } = await chrome.storage.local.get('liveResults');
  render(liveResults);
}

function render(list) {
  const tb = $('rows');
  tb.textContent = '';
  for (const r of list) {
    const tr = document.createElement('tr');
    const host = (() => { try { return new URL(r.url).host + (r.isTop ? '' : ' (iframe)'); } catch { return r.url; } })();
    const t = r.t || {};
    const m = r.model || {};
    const d = m.decision;
    const cells = [
      host,
      r.found ? r.banner.vendor : 'no banner',
      r0(t.bannerFoundAt),
      r0(t.aiAddedAfterBannerFoundMs),
      r.found ? `${r0(m.setupMs)}/${r0(m.ttftMs)}/${r0(m.promptMs)}${m.firstDecisionInThisSw ? ' (1st in SW)' : ''}` : '',
      r.error ? r.error : d ? `${d.action} [${d.index}] ${r.chosenLabel || ''} (${d.confidence})` : (r.found ? 'unparsed: ' + (m.output || '') : ''),
    ];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    if (r.error) tr.className = 'err';
    tb.appendChild(tr);
  }
}

init();
