// background.js — MV3 module service worker for the bouncer POC.
// Two jobs:
//  1. Be the background half of @duckduckgo/autoconsent (same protocol as the package's own
//     reference addon, dist/addon-mv3): answer `init` with config + filtered compact rules, run
//     `eval` snippets in the page's main world, request the self-test after an opt-out.
//  2. Run the round-2 `h-bouncer` pipeline (heuristics → AI gate → AI labels → JS chooser) for
//     banners autoconsent does not know, on behalf of bouncer.js.
// Plus: per-tab timing, the decision log (last 50) and the toolbar badge.
import { filterCompactRules, evalSnippets } from './node_modules/@duckduckgo/autoconsent/dist/autoconsent.esm.js';
import * as ACHeur from './node_modules/@duckduckgo/autoconsent/dist/heuristics.mjs';
import './runner.js';
import './variants.js';
import { installMockModel } from './mock-model.js';
globalThis.ACHeur = ACHeur;
const V = globalThis.Variants, R = globalThis.Runner;
const PIPELINE = V.ALL.find((v) => v.id === 'h-bouncer');

const SW_STARTED = Date.now();
let ctx = null;            // model sessions; live only as long as this service worker
let rulesPromise = null;
const acState = new Map(); // tabId -> { frames: {frameId: report.state}, cmp, popupFound, entryId }

// ---------------------------------------------------------------- settings / helpers
const DEFAULT_SETTINGS = { enabled: true, disabledSites: [] };
async function settings() { return chrome.storage.local.get(DEFAULT_SETTINGS); }
const siteOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
async function enabledFor(url) { const s = await settings(); return s.enabled && !s.disabledSites.includes(siteOf(url)); }

function loadRules() {
  rulesPromise = rulesPromise || fetch('./node_modules/@duckduckgo/autoconsent/rules/compact-rules.json').then((r) => r.json());
  return rulesPromise;
}

// autoconsent config: opt-out, prehide known CMPs immediately, NO heuristic clicking (unknown
// banners are ours), NO cosmetic-only rules (they hide without refusing; those banners fall through
// to the AI path instead).
function acConfig(enabled) {
  return {
    enabled, autoAction: 'optOut', disabledCmps: [], enablePrehide: true, enableCosmeticRules: false,
    enableGeneratedRules: true, detectRetries: 20, isMainWorld: false, prehideTimeout: 2000,
    enableHeuristicDetection: false, heuristicMode: 'off', enablePopupMutationObserver: true, visualTest: false,
    performanceLoggingEnabled: false, heuristicPopupSearchTimeout: 0,
    logs: { lifecycle: false, rulesteps: false, detectionsteps: false, evals: false, errors: true, messages: false, waits: false },
  };
}

async function nav(tabId) { return (await chrome.storage.session.get(`nav-${tabId}`))[`nav-${tabId}`] || null; }
async function sinceNav(tabId, epoch) { const n = await nav(tabId); return n ? Math.round(epoch - n.timeOrigin) : null; }

// ---------------------------------------------------------------- decision log + badge
// storage.local read-modify-write must not interleave (several messages arrive at once)
let logQueue = Promise.resolve();
function serial(fn) { const p = logQueue.then(fn, fn); logQueue = p.catch(() => {}); return p; }
function addEntry(entry) { return serial(() => addEntry_(entry)); }
function updateEntry(id, patch) { return serial(() => updateEntry_(id, patch)); }
async function addEntry_(entry) {
  entry.id = entry.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  entry.at = entry.at || new Date().toISOString();
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift(entry);
  await chrome.storage.local.set({ log: log.slice(0, 50) });
  return entry.id;
}
async function updateEntry_(id, patch) {
  const { log = [] } = await chrome.storage.local.get('log');
  const e = log.find((x) => x.id === id);
  if (!e) return null;
  for (const [k, v] of Object.entries(patch)) e[k] = (v && typeof v === 'object' && !Array.isArray(v) && e[k] && typeof e[k] === 'object') ? Object.assign(e[k], v) : v;
  await chrome.storage.local.set({ log });
  return e;
}
const DEBUG = [];
function dbg(tabId, what) { DEBUG.push(`${Date.now() % 100000} tab${tabId} ${what}`); if (DEBUG.length > 50) DEBUG.shift(); chrome.storage.session.set({ debug: DEBUG }); }
// One badge per page load; a later, lesser outcome (e.g. "left alone" for a second overlay such as
// an age gate) must not overwrite "dismissed"/"failed".
const RANK = { 'left-alone': 1, failed: 2, dismissed: 3 };
const badgeRank = new Map(); // tabId -> rank for the current document (reset on bouncer-hello)
function badge(tabId, outcome, ms) {
  if (tabId == null || !RANK[outcome]) return;
  if ((badgeRank.get(tabId) || 0) > RANK[outcome]) return;
  badgeRank.set(tabId, RANK[outcome]);
  dbg(tabId, `badge ${outcome} ${ms}`);
  const text = outcome === 'dismissed' ? (ms == null ? 'ok' : ms < 10000 ? String(ms) : Math.round(ms / 1000) + 's')
    : outcome === 'left-alone' ? '–' : outcome === 'failed' ? '!' : '';
  const color = outcome === 'dismissed' ? '#137333' : outcome === 'failed' ? '#b00020' : '#777';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

// ---------------------------------------------------------------- messages
const AC_TYPES = new Set(['init', 'eval', 'visualDelay', 'cmpDetected', 'popupFound', 'optOutResult', 'optInResult', 'selfTestResult', 'autoconsentDone', 'autoconsentError', 'report']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && AC_TYPES.has(msg.type)) {
    sendResponse(); // autoconsent awaits sendMessage; its real replies go back via tabs.sendMessage
    handleAutoconsent(msg, sender).catch((e) => console.error('autoconsent handler', msg.type, e));
    return false;
  }
  handleBouncer(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});
chrome.runtime.onConnect.addListener(() => {}); // autoconsent content opens an `instance-*` port (devtools only)
chrome.tabs.onRemoved.addListener((tabId) => { acState.delete(tabId); chrome.storage.session.remove(`nav-${tabId}`); });

function tabAc(tabId) {
  if (!acState.has(tabId)) acState.set(tabId, { frames: {}, cmp: null, popupFound: false, entryId: null });
  return acState.get(tabId);
}

async function handleAutoconsent(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const frameId = sender.frameId;
  if (tabId == null) return;
  const st = tabAc(tabId);
  switch (msg.type) {
    case 'init': {
      if (frameId === 0) acState.set(tabId, { frames: {}, cmp: null, popupFound: false, entryId: null }); // new top-level document
      const enabled = await enabledFor(sender.tab.url || msg.url);
      const rules = { autoconsent: [], compact: filterCompactRules(await loadRules(), { url: msg.url || sender.url, mainFrame: frameId === 0 }) };
      await chrome.tabs.sendMessage(tabId, { type: 'initResp', rules, config: acConfig(enabled) }, { frameId });
      break;
    }
    case 'eval': {
      let result;
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, world: 'MAIN', func: evalSnippets[msg.snippetId] });
        result = r && r.result;
      } catch (e) { result = false; }
      await chrome.tabs.sendMessage(tabId, { id: msg.id, type: 'evalResp', result }, { frameId });
      break;
    }
    case 'cmpDetected': st.cmp = msg.cmp; st.cmpDetected = true; break;
    case 'popupFound': {
      st.cmp = msg.cmp; st.popupFound = true; st.popupFrame = frameId;
      st.entryId = await addEntry({
        tabId, url: sender.tab.url, site: siteOf(sender.tab.url), path: 'autoconsent', rule: msg.cmp, frame: frameId === 0 ? 'top' : 'iframe',
        gate: 'n/a (known CMP rule)', outcome: 'working', t: { bannerFoundAt: await sinceNav(tabId, Date.now()) },
      });
      break;
    }
    case 'optOutResult': {
      st.optOutResult = msg.result;
      if (msg.result && msg.scheduleSelfTest) st.selfTestFrame = frameId;
      if (st.entryId) {
        const e = await updateEntry(st.entryId, { optOutResult: msg.result, t: { decisionAt: await sinceNav(tabId, Date.now()) }, ...(msg.result ? {} : { outcome: 'failed', detail: 'autoconsent optOut returned false' }) });
        if (!msg.result) badge(tabId, 'failed');
        void e;
      }
      break;
    }
    case 'autoconsentDone': {
      const goneAt = await sinceNav(tabId, Date.now());
      if (st.entryId) {
        await updateEntry(st.entryId, { outcome: st.optOutResult === false ? 'failed' : 'dismissed', clicks: msg.totalClicks, durationMs: msg.duration, isCosmetic: msg.isCosmetic, t: { goneAt } });
      } else {
        st.entryId = await addEntry({ tabId, url: sender.tab.url, site: siteOf(sender.tab.url), path: 'autoconsent', rule: msg.cmp, outcome: 'dismissed', clicks: msg.totalClicks, t: { goneAt } });
      }
      badge(tabId, st.optOutResult === false ? 'failed' : 'dismissed', goneAt);
      if (typeof st.selfTestFrame === 'number') {
        const f = st.selfTestFrame; st.selfTestFrame = null;
        chrome.tabs.sendMessage(tabId, { type: 'selfTest' }, { frameId: f }).catch(() => {});
      }
      chrome.tabs.sendMessage(tabId, { type: 'bouncer-ac-done', cmp: msg.cmp }, { frameId: 0 }).catch(() => {});
      break;
    }
    case 'selfTestResult': if (st.entryId) await updateEntry(st.entryId, { selfTest: msg.result }); break;
    case 'autoconsentError': if (st.entryId) await updateEntry(st.entryId, { error: JSON.stringify(msg.details).slice(0, 300) }); break;
    case 'report': st.frames[frameId] = { lifecycle: msg.state.lifecycle, attempts: msg.state.findCmpAttempts, detectedCmps: msg.state.detectedCmps, detectedPopups: msg.state.detectedPopups, prehideOn: msg.state.prehideOn }; break;
    default: break;
  }
}

async function handleBouncer(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case 'bouncer-hello': {
      await chrome.storage.session.set({ [`nav-${tabId}`]: { timeOrigin: msg.timeOrigin, url: msg.url } });
      chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      badgeRank.delete(tabId);
      dbg(tabId, 'hello-clear ' + msg.url);
      return { enabled: await enabledFor(sender.tab.url || msg.url) };
    }
    case 'bouncer-status': { // has autoconsent claimed this tab?
      const st = tabAc(tabId);
      const top = st.frames[0] || {};
      const anyDetected = Object.values(st.frames).some((f) => (f.detectedCmps || []).length);
      return { claimed: !!(st.popupFound || st.cmpDetected || anyDetected), cmp: st.cmp, topLifecycle: top.lifecycle || null, topAttempts: top.attempts || 0 };
    }
    case 'bouncer-decide': {
      const t = performance.now();
      const { debugMockModel } = await chrome.storage.local.get('debugMockModel');
      if (debugMockModel && !globalThis.__mockInstalled) { installMockModel(); globalThis.__mockInstalled = true; ctx = null; }
      ctx = ctx || new R.Ctx({});
      const before = new Set(ctx.bases.keys());
      const r = { stage: msg.fx.stage2 ? 2 : 1, swAgeMs: Date.now() - SW_STARTED, sessionsWarmBefore: before.size > 0 };
      ctx.begin(false);
      try {
        const out = await PIPELINE.run(ctx, msg.fx.banner, msg.fx);
        Object.assign(r, { decision: out.decision, output: V.fmtDecision(out.decision), gate: out.gate, steps: out.steps, labels: out.labels });
      } catch (e) { r.error = String(e && e.message || e); }
      const m = ctx.end();
      r.modelCalls = m.modelCalls;
      r.calls = m.calls.map((c) => ({ kind: c.kind, ms: Math.round(c.ms), ttftMs: c.ttftMs == null ? undefined : Math.round(c.ttftMs) }));
      r.basesCreated = Object.fromEntries([...ctx.bases.keys()].filter((k) => !before.has(k)).map((k) => [k, Math.round(ctx.baseInfo[k].createMs)]));
      r.coldStart = Object.values(r.basesCreated).some((ms) => ms > 2000); // round 2: cold create ≈ 9.5 s, warm ≈ 0.1–0.45 s
      if (ctx.availabilityMs != null && !r.sessionsWarmBefore) r.availabilityMs = Math.round(ctx.availabilityMs);
      r.workMs = Math.round(performance.now() - t);
      if (globalThis.__mockInstalled) r.MOCK_MODEL = true;
      return r;
    }
    case 'bouncer-ac-scroll': { // bouncer.js unlocked page scroll after an autoconsent opt-out
      const st = tabAc(tabId);
      if (st.entryId) await updateEntry(st.entryId, { scrollUnlocked: msg.unlocked });
      return { ok: true };
    }
    case 'bouncer-log': {
      const e = Object.assign({ tabId, url: sender.tab.url, site: siteOf(sender.tab.url) }, msg.entry);
      await addEntry(e);
      if (e.outcome !== 'deferred') badge(tabId, e.outcome, e.t && e.t.goneAt); // deferred: autoconsent owns the badge
      return { ok: true };
    }
    default: return { error: 'unknown message ' + msg.type };
  }
}
