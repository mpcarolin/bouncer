// mock-model.js — TEST HOOK ONLY. When chrome.storage.local.debugMockModel === true, the service
// worker replaces LanguageModel with this deterministic fake so the AI path's page mechanics
// (hide → click → settings panel → toggles → save → unhide on failure) can be exercised in a
// browser without Gemini Nano. Off by default; the popup does not expose it.
export function installMockModel() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  class MockLanguageModel {
    constructor(o) { this.o = o; this.contextUsage = 100; this.contextWindow = 9216; }
    static async availability() { return 'available'; }
    static async create(o) { await sleep(50); return new MockLanguageModel(o); }
    async clone() { return new MockLanguageModel(this.o); }
    destroy() {}
    async measureContextUsage(input) { return Math.round(input.length / 4); }
    promptStreaming(input, opts) {
      const c = opts && opts.responseConstraint;
      const lines = input.split('\n').filter((l) => /^\[\d+\]/.test(l));
      let out;
      if (c && c.type === 'string' && c.enum && c.enum.includes('yes')) out = JSON.stringify(/cookie|consent/i.test(input) ? 'yes' : 'no');
      else if (c && c.properties && c.properties.labels) {
        out = JSON.stringify({ labels: lines.map((l) => /toggle/.test(l) ? (/necessary/i.test(l) ? 'toggle-necessary' : 'toggle-optional')
          : /reject|decline|deny/i.test(l) ? 'reject' : /settings|preferences|manage/i.test(l) ? 'settings' : /save|confirm/i.test(l) ? 'save'
          : /accept|agree/i.test(l) ? 'accept' : / link /.test(l) ? 'link' : 'other') });
      } else out = '"no"';
      return (async function* () { await sleep(200); yield out; })();
    }
  }
  globalThis.LanguageModel = MockLanguageModel;
}
