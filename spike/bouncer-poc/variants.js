// variants.js — every prompt variant, the mechanical (autoconsent) baseline, the hybrid
// pipelines, and the scorer. Side-effect script: sets globalThis.Variants.
// Used by bench.js and background.js (as ES-module side-effect imports) and by baseline.mjs (Node).
// Model access goes through a `ctx` object supplied by runner.js (or a mock), so this file
// never touches LanguageModel directly. Mechanical code needs globalThis.ACHeur =
// @duckduckgo/autoconsent/heuristics, set by the importer.
(function () {
  'use strict';

  // ---------------------------------------------------------------- input formatting
  function trunc(t, n) { t = t || ''; return t.length > n ? t.slice(0, n) + '…' : t; }

  function fmtControl(c) {
    let s = `[${c.i}] ${c.role} "${c.label}"`;
    if (c.on !== undefined) s += c.on ? ' on' : ' off';
    if (c.disabled) s += ' disabled';
    return s;
  }

  // mode: 'full' (text + controls) | 'text' (text only) ; maxText chars of banner text
  function fmtInput(banner, maxText, mode, controls) {
    controls = controls || banner.controls;
    const t = maxText > 0 ? `Text: ${trunc(banner.text, maxText)}\n` : '';
    if (mode === 'text') return t.trim() || '(no text)';
    return t + `Controls:\n${controls.map(fmtControl).join('\n')}`;
  }

  const sys = (content) => ({ role: 'system', content });
  const user = (content) => ({ role: 'user', content });
  const asst = (content) => ({ role: 'assistant', content });

  // ---------------------------------------------------------------- shared decision helpers
  const NECESSARY_RE = /necessar|required|essential|strictly|always active|nødvendig|notwendig/i;
  const OPTOUT_RE = /do not sell|don.?t sell|do not share|opt.?out|limit the use/i;
  const ACCEPTISH_RE = /accept|agree|allow|^ok$|okay|got it|continue|understand|consent|acept|accepter|akzept|godkend|tillad/i;
  const SAVE_RE = /save|confirm|submit|apply|allow selection|update|gem|speichern|bestätig/i;
  const CLOSE_RE = /^(×|x|✕|close|close banner|close dialog|dismiss|skip|lukk|luk|schließen)$/i;

  function toggleKind(c) {
    if (c.disabled || NECESSARY_RE.test(c.label)) return 'toggle-necessary';
    if (OPTOUT_RE.test(c.label)) return 'toggle-optout';
    return 'toggle-optional';
  }

  // Deterministic choice from per-control labels. labels: {index: label}
  // Priority: reject > save (toggles to change) > settings > no_option (accept/close only) > unsure.
  function chooseFromLabels(banner, labels) {
    const C = banner.controls;
    const idx = (lab) => C.filter((c) => labels[c.i] === lab).map((c) => c.i);
    const preferButton = (ids) => ids.sort((a, b) => (C[a].role === 'link') - (C[b].role === 'link'))[0];
    const rej = idx('reject');
    if (rej.length) return { action: 'reject', index: preferButton(rej), off: [] };
    const off = C.filter((c) => labels[c.i] === 'toggle-optional' && c.on === true && !c.disabled).map((c) => c.i);
    const on = C.filter((c) => labels[c.i] === 'toggle-optout' && c.on === false && !c.disabled).map((c) => c.i);
    const save = idx('save');
    if ((off.length || on.length) && save.length) return { action: 'save', index: preferButton(save), off, on };
    const set = idx('settings');
    if (set.length) return { action: 'settings', index: preferButton(set), off: [] };
    if (save.length && C.some((c) => c.role === 'toggle')) return { action: 'save', index: preferButton(save), off, on };
    if (idx('accept').length || idx('close').length) return { action: 'no_option', index: -1, off: [] };
    return { action: 'unsure', index: -1, off: [] };
  }

  // Round-1 output used 'none'; round 2 distinguishes no_option (no way to refuse) from unsure.
  function normDecision(d) {
    if (!d || typeof d !== 'object') return null;
    const out = { action: d.action === 'none' ? 'no_option' : d.action, index: typeof d.index === 'number' ? d.index : -1 };
    if (Array.isArray(d.off)) out.off = d.off;
    if (Array.isArray(d.on)) out.on = d.on;
    return out;
  }

  function parseJSON(text) {
    if (!text) return null;
    const s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(s); } catch {}
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
    return null;
  }

  // ---------------------------------------------------------------- scoring
  // expected: array of acceptable answers [{action, index?, off?, on?}]
  function score(decision, expected, banner) {
    if (!decision) return { correct: false, why: 'unparseable' };
    for (const e of expected) {
      if (decision.action !== e.action) continue;
      if (['no_option', 'not_consent', 'unsure'].includes(e.action)) return { correct: true };
      if (decision.index !== e.index) continue;
      if (e.action === 'save') {
        const off = decision.off || [], on = decision.on || [];
        const missing = (e.off || []).filter((i) => !off.includes(i));
        const missingOn = (e.on || []).filter((i) => !on.includes(i));
        const bad = off.filter((i) => { const c = banner.controls[i]; return !c || c.role !== 'toggle' || c.disabled || NECESSARY_RE.test(c.label); });
        if (missing.length || missingOn.length || bad.length) return { correct: false, why: `toggles missingOff=${missing} missingOn=${missingOn} bad=${bad}` };
      }
      return { correct: true };
    }
    const c = banner.controls[decision.index];
    return { correct: false, why: `${fmtDecision(decision)}${c ? ' "' + c.label + '"' : ''}` };
  }

  function fmtDecision(d) {
    if (!d) return 'unparseable';
    if (d.gate) return 'gate:' + d.gate;
    let s = d.action;
    if (d.index != null && d.index >= 0) s += ':' + d.index;
    if (d.action === 'save') {
      if (d.off && d.off.length) s += ' off=' + d.off.join(',');
      if (d.on && d.on.length) s += ' on=' + d.on.join(',');
    }
    return s;
  }

  // ================================================================= GATEKEEPER variants
  const GATE_SCHEMA = { type: 'string', enum: ['yes', 'no'] };

  const GATE_BARE = 'Is this page element a cookie or tracking consent dialog? Answer yes or no.';

  const GATE_DEF = `Decide if a page element is a cookie/tracking CONSENT dialog.
YES: it asks the visitor to accept, reject or configure cookies, tracking, or use/sale/sharing of personal data (GDPR/CCPA banners, cookie preference centres, "Do not sell or share" choices). A dialog asking to agree to terms AND data collection also counts.
NO: login or sign-up walls, newsletter/email/SMS signups, discount or promo popups, chat widgets, paywalls and subscription offers, age gates, app-install or notification prompts, surveys, announcement bars, site headers and menus — even when they link to a Privacy Policy, Terms or Cookie Policy.
Answer yes or no.`;

  const GATE_FEWSHOT = [
    user('Text: Get 15% off your first order! Join our list for news and offers. By signing up you agree to our Privacy Policy.\nControls:\n[0] button "Close"\n[1] button "Sign up"\n[2] link "Privacy Policy"'), asst('"no"'),
    user('Text: We use cookies to improve your experience and for advertising. You can accept all, reject non-essential cookies or choose your settings.\nControls:\n[0] button "Accept all"\n[1] button "Reject non-essential"\n[2] button "Settings"'), asst('"yes"'),
    user('Text: Log in to continue. By continuing you agree to our Terms of Service and acknowledge our Privacy Policy.\nControls:\n[0] button "Continue with Google"\n[1] button "Log in"\n[2] link "Terms"\n[3] link "Privacy Policy"'), asst('"no"'),
    user('Text: Privacy preferences. Strictly necessary: always active. Analytics. Advertising.\nControls:\n[0] toggle "Analytics" on\n[1] toggle "Advertising" on\n[2] button "Save preferences"'), asst('"yes"'),
    user('Text: Hi there! Questions? Our team is online.\nControls:\n[0] button "Chat with us"\n[1] button "Minimize"'), asst('"no"'),
  ];

  function gateVariant(id, label, system, fewshot, mode, maxText) {
    return {
      id, kind: 'gate', label,
      initialPrompts: [sys(system)].concat(fewshot || []),
      describe: `${label}; input=${mode}, text ${maxText} chars`,
      async run(ctx, banner) {
        const s = await ctx.open(id, this.initialPrompts);
        const input = fmtInput(banner, maxText, mode);
        const r = await ctx.ask(s, input, GATE_SCHEMA);
        const v = parseJSON(r.text);
        const gate = v === 'yes' ? 'consent' : v === 'no' ? 'other' : null;
        return { decision: gate ? { gate } : null, raw: r.text };
      },
    };
  }

  const GATE_VARIANTS = [
    gateVariant('g-bare', 'bare yes/no', GATE_BARE, null, 'full', 400),
    gateVariant('g-def', 'definition + counterexamples', GATE_DEF, null, 'full', 400),
    gateVariant('g-fewshot', 'definition + 5 few-shot', GATE_DEF, GATE_FEWSHOT, 'full', 400),
    gateVariant('g-def-text', 'definition, text only', GATE_DEF, null, 'text', 400),
    gateVariant('g-def-short', 'definition, text 150 + controls', GATE_DEF, null, 'full', 150),
    gateVariant('g-def-tiny', 'definition, text 60 + controls', GATE_DEF, null, 'full', 60),
  ];

  // ================================================================= DECIDER variants
  // (1) round-1 prompt verbatim, for baseline comparison
  const D_BASELINE_SYSTEM = `You answer cookie consent dialogs so the website gets the LEAST data.
Input: dialog text, then numbered controls "[n] role label" (toggles show on/off).
Pick ONE action:
- reject: click control n that rejects/declines optional cookies (e.g. "Reject all", "Deny", "Necessary only").
- settings: no reject control exists; click control n that opens cookie settings/preferences.
- save: a settings panel with category toggles and no reject control; off = indices of optional toggles that are on; n = the save/confirm control.
- none: none of the above applies.
Never pick accept/agree/allow. Never switch off necessary toggles.
Reply only JSON: {"action":"reject|settings|save|none","index":n,"off":[n],"confidence":"high|medium|low"}. index -1 for none.`;
  const D_BASELINE_SCHEMA = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['reject', 'settings', 'save', 'none'] },
      index: { type: 'integer' }, off: { type: 'array', items: { type: 'integer' } },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['action', 'index', 'off', 'confidence'], additionalProperties: false,
  };

  // (2) detailed rubric
  const D_RUBRIC_SYSTEM = `You decide how to answer a cookie consent dialog so the website gets the LEAST personal data.
Input: the dialog text, then its controls as [n] role "label". Toggles show their state: on = currently enabled, off = currently disabled, disabled = cannot be changed.
Use the FIRST rule that applies:
1. reject — a control refuses optional cookies: "Reject all", "Decline", "Deny", "Necessary/Required/Essential only", "Use necessary cookies only". index = that control.
2. save — no reject control, but there are optional cookie toggles that are on: off = every toggle that is on, not disabled, and not necessary/required; index = the control that saves or confirms ("Save", "Confirm my choices", "Allow selection").
3. settings — no reject control and no toggles: index = the control that opens cookie settings/preferences/choices ("Manage", "Customize", "Preferences", "Your privacy choices").
4. no_option — it is a consent dialog but the only choices are accept/agree/OK/continue or close.
5. unsure — you cannot tell what the controls do.
Never choose accept, agree, allow all, OK, continue or close. Buttons that only name a cookie category (e.g. "Performance Cookies") just expand a description: ignore them. Links open other pages: ignore them.
Reply JSON: {"action":"reject|save|settings|no_option|unsure","index":n,"off":[n]} with index -1 when there is no control.`;
  const D_SCHEMA = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['reject', 'save', 'settings', 'no_option', 'unsure'] },
      index: { type: 'integer' }, off: { type: 'array', items: { type: 'integer' } },
    },
    required: ['action', 'index', 'off'], additionalProperties: false,
  };

  // (3) few-shot: compact rubric + 4 synthetic worked examples (NOT the test fixtures)
  const D_FEW_SYSTEM = `You decide how to answer a cookie consent dialog so the website gets the LEAST personal data.
Priority: reject (a control refusing optional cookies) > save (switch off optional toggles that are on, then the save/confirm control) > settings (open cookie preferences) > no_option (only accept/agree/close exist) > unsure.
Never choose accept/agree/OK/close. Ignore category-name buttons and links.
Reply JSON: {"action":"reject|save|settings|no_option|unsure","index":n,"off":[n]} (index -1 if none).`;
  const D_FEW_SHOTS = [
    user('Text: We value your privacy. We and our partners use cookies to personalise ads and measure traffic.\nControls:\n[0] link "Privacy notice"\n[1] button "Customize"\n[2] button "Accept all"\n[3] button "Only essential"\n[4] button "×"'),
    asst('{"action":"reject","index":3,"off":[]}'),
    user('Text: Privacy preference centre. Strictly necessary cookies are always active. Analytics cookies help us measure traffic. Marketing cookies personalise ads.\nControls:\n[0] button "Strictly necessary"\n[1] toggle "Strictly necessary" on disabled\n[2] button "Analytics"\n[3] toggle "Analytics" on\n[4] button "Marketing"\n[5] toggle "Marketing" on\n[6] link "Cookie list"\n[7] button "Save my preferences"'),
    asst('{"action":"save","index":7,"off":[3,5]}'),
    user('Text: This site uses cookies to improve your experience.\nControls:\n[0] link "Learn more"\n[1] button "Cookie settings"\n[2] button "Got it"'),
    asst('{"action":"settings","index":1,"off":[]}'),
    user('Text: By clicking Continue you agree to our Terms and to the collection of your data as described in our Privacy Policy.\nControls:\n[0] link "Terms"\n[1] link "Privacy Policy"\n[2] button "Continue"'),
    asst('{"action":"no_option","index":-1,"off":[]}'),
  ];

  // (4) per-control labelling; JS chooses
  const LABELS = ['accept', 'reject', 'settings', 'save', 'close', 'link', 'toggle-optional', 'toggle-necessary', 'toggle-optout', 'other'];
  const D_LABELS_SYSTEM = `Label every control of a cookie consent dialog. Input: dialog text, then controls [n] role "label" (toggles show on/off/disabled).
Labels:
accept = accepts/agrees/allows all, OK, Got it, Continue
reject = refuses optional cookies: Reject all, Decline, Deny, Necessary/Required/Essential only
settings = opens cookie settings/preferences/choices
save = saves or confirms the current choices
close = closes the dialog (×, Close) without choosing
link = opens another page (policy, terms, vendor list)
toggle-optional = switch for an optional cookie category or purpose
toggle-necessary = switch for necessary/required cookies
toggle-optout = switch whose ON state refuses tracking (e.g. "Do not sell or share my data")
other = anything else (category headings, tabs)
Reply JSON {"labels":[...]} with exactly one label per control, in the order given.`;
  function labelsSchema(n, minMax) {
    const arr = { type: 'array', items: { type: 'string', enum: LABELS } };
    if (minMax) { arr.minItems = n; arr.maxItems = n; }
    return { type: 'object', properties: { labels: arr }, required: ['labels'], additionalProperties: false };
  }

  async function aiLabel(ctx, sessionKey, banner, controls, maxText) {
    const s = await ctx.open(sessionKey, [sys(D_LABELS_SYSTEM)]);
    const input = fmtInput(banner, maxText, 'full', controls);
    let r;
    try { r = await ctx.ask(s, input, labelsSchema(controls.length, true)); }
    catch (e) {
      if (!/NotSupported/i.test(String(e && e.name || e))) throw e;
      r = await ctx.ask(s, input, labelsSchema(controls.length, false)); // minItems/maxItems unsupported
      r.minMaxUnsupported = true;
    }
    const v = parseJSON(r.text);
    const labels = {};
    if (v && Array.isArray(v.labels)) controls.forEach((c, k) => { if (v.labels[k]) labels[c.i] = v.labels[k]; });
    return { labels, raw: r.text, ok: !!(v && Array.isArray(v.labels)), lengthOk: !!(v && v.labels && v.labels.length === controls.length) };
  }

  // (5) narrow questions with index enums; toggles handled deterministically
  const D_NARROW_SYSTEM = 'You answer questions about the controls of a cookie consent dialog. Reply with only the control number, or "none".';
  function idxEnum(ids) { return { type: 'string', enum: ids.map(String).concat(['none']) }; }

  function decider(id, label, system, shots, schema, maxText) {
    return {
      id, kind: 'decide', label, initialPrompts: [sys(system)].concat(shots || []),
      describe: `${label}; text ${maxText} chars + controls`,
      async run(ctx, banner) {
        const s = await ctx.open(id, this.initialPrompts);
        const r = await ctx.ask(s, fmtInput(banner, maxText, 'full'), schema);
        return { decision: normDecision(parseJSON(r.text)), raw: r.text };
      },
    };
  }

  const DECIDE_VARIANTS = [
    decider('d-baseline', 'round-1 prompt (baseline)', D_BASELINE_SYSTEM, null, D_BASELINE_SCHEMA, 400),
    decider('d-rubric', 'detailed rubric', D_RUBRIC_SYSTEM, null, D_SCHEMA, 400),
    decider('d-fewshot', 'compact rubric + 4 worked examples', D_FEW_SYSTEM, D_FEW_SHOTS, D_SCHEMA, 400),
    {
      id: 'd-labels', kind: 'decide', label: 'per-control labels → JS chooses', describe: 'model labels every control (enum), deterministic JS picks the action',
      initialPrompts: [sys(D_LABELS_SYSTEM)],
      async run(ctx, banner) {
        const l = await aiLabel(ctx, 'd-labels', banner, banner.controls, 400);
        return { decision: l.ok ? chooseFromLabels(banner, l.labels) : null, raw: l.raw, labels: l.labels, lengthOk: l.lengthOk };
      },
    },
    {
      id: 'd-narrow', kind: 'decide', label: 'narrow questions (index enum) + JS toggles',
      describe: 'Q1 which control refuses? → Q2 which saves? (only if toggles to change) → Q3 which opens settings? Each answer is an index enum; toggles decided by regex',
      initialPrompts: [sys(D_NARROW_SYSTEM)],
      async run(ctx, banner) {
        const s = await ctx.open('d-narrow', this.initialPrompts);
        const C = banner.controls;
        const clickable = C.filter((c) => c.role !== 'toggle' && c.role !== 'select').map((c) => c.i);
        const raws = [];
        const q = async (question, first) => {
          const r = await ctx.ask(s, (first ? fmtInput(banner, 300, 'full') + '\n\n' : '') + question, idxEnum(clickable));
          raws.push(r.text);
          const v = parseJSON(r.text);
          return v === 'none' || v == null ? null : Number(v);
        };
        const rej = await q('Which control refuses optional cookies (Reject all, Decline, Deny, Necessary/Required/Essential only)?', true);
        if (rej != null) return { decision: { action: 'reject', index: rej, off: [] }, raw: raws.join(' | ') };
        const off = C.filter((c) => c.role === 'toggle' && c.on === true && !c.disabled && toggleKind(c) === 'toggle-optional').map((c) => c.i);
        const on = C.filter((c) => c.role === 'toggle' && c.on === false && !c.disabled && toggleKind(c) === 'toggle-optout').map((c) => c.i);
        if (off.length || on.length) {
          const save = await q('Which control saves or confirms the current choices?');
          if (save != null) return { decision: { action: 'save', index: save, off, on }, raw: raws.join(' | ') };
        }
        const set = await q('Which control opens cookie settings or preferences?');
        if (set != null) return { decision: { action: 'settings', index: set, off: [] }, raw: raws.join(' | ') };
        const anyAccept = C.some((c) => ACCEPTISH_RE.test(c.label) || CLOSE_RE.test(c.label));
        return { decision: { action: anyAccept ? 'no_option' : 'unsure', index: -1, off: [] }, raw: raws.join(' | ') };
      },
    },
  ];

  // ================================================================= MECHANICAL (autoconsent heuristics)
  function H() {
    const h = globalThis.ACHeur;
    if (!h) throw new Error('autoconsent heuristics not loaded (globalThis.ACHeur)');
    return h;
  }

  // autoconsent-style popup detection: text matches a DETECT pattern and no age-gate exclusion
  function mechGate(fx) {
    const text = fx.fullText || fx.banner.text || '';
    const { patterns } = H().checkHeuristicPatterns(text);
    const excluded = H().isExcludedPopup(text);
    return { consent: patterns.length > 0 && !excluded, patterns: patterns.length, excluded };
  }

  // Regex label per control (autoconsent button classifier + our toggle rules). 'unknown' = needs AI.
  function regexLabels(banner) {
    const labels = {};
    const hasToggles = banner.controls.some((c) => c.role === 'toggle');
    for (const c of banner.controls) {
      if (c.role === 'toggle') { labels[c.i] = toggleKind(c); continue; }
      const k = H().classifyButtonTextRegex(c.label);
      // Our addition: with toggles present, "Confirm"/"Save…" is a save, not an accept.
      if (hasToggles && /^(confirm|save|submit)\b/i.test(H().cleanButtonText(c.label)) && k !== 'reject') { labels[c.i] = 'save'; continue; }
      if (k === 'reject') labels[c.i] = 'reject';
      else if (k === 'settings') labels[c.i] = SAVE_RE.test(c.label) ? 'save' : 'settings';
      else if (k === 'accept' || k === 'acknowledge') labels[c.i] = 'accept';
      else if (CLOSE_RE.test(H().cleanButtonText(c.label))) labels[c.i] = 'close';
      else if (c.role === 'link' || c.role === 'select' || c.role === 'tab') labels[c.i] = 'link';
      else if (SAVE_RE.test(c.label)) labels[c.i] = 'save';
      else labels[c.i] = 'unknown';
    }
    return labels;
  }

  const MECH_VARIANTS = [{
    id: 'm-autoconsent', kind: 'mechanical', label: 'autoconsent heuristics only (no model)',
    describe: 'gate = checkHeuristicPatterns && !isExcludedPopup; decision = classifyButtonTextRegex labels + toggle regex → same JS chooser; unknown buttons ignored',
    async run(ctx, banner, fx) {
      const g = mechGate(fx);
      if (!g.consent) return { decision: { action: 'not_consent', index: -1 }, gate: 'other', raw: JSON.stringify(g) };
      const labels = regexLabels(banner);
      return { decision: chooseFromLabels(banner, labels), gate: 'consent', labels, raw: JSON.stringify(g) };
    },
  }];

  // ================================================================= HYBRID pipelines
  // 1. regex-label controls; 2. fast path: mech gate + a regex 'reject' → reject, no model;
  // 3. gate: h-fast trusts a positive mech gate, otherwise asks the AI gate; h-safe always asks the AI gate;
  // 4. AI labels only the controls regex could not classify; 5. same deterministic chooser.
  function hybrid(id, label, alwaysAiGate, gateId) {
    return {
      id, kind: 'hybrid', label,
      describe: `${label}: regex → ${alwaysAiGate ? 'AI gate always (unless fast path)' : 'AI gate only if regex gate says no'} (${gateId}) → AI labels unknown controls only`,
      async run(ctx, banner, fx) {
        const steps = [];
        const g = mechGate(fx);
        const labels = regexLabels(banner);
        const hasReject = banner.controls.some((c) => labels[c.i] === 'reject');
        if (g.consent && hasReject) { steps.push('fast-path'); return { decision: chooseFromLabels(banner, labels), gate: 'consent', steps, labels }; }
        let gate = 'consent';
        if (fx.stage2) steps.push('stage2-no-gate'); // consent already established on stage 1
        else if (alwaysAiGate || !g.consent) {
          const gv = GATE_VARIANTS.find((v) => v.id === gateId);
          const r = await gv.run(ctx, banner, fx);
          gate = r.decision ? r.decision.gate : 'other';
          steps.push('ai-gate:' + gate);
        } else steps.push('regex-gate');
        if (gate !== 'consent') return { decision: { action: 'not_consent', index: -1 }, gate, steps };
        const unknown = banner.controls.filter((c) => labels[c.i] === 'unknown');
        if (unknown.length) {
          const l = await aiLabel(ctx, 'd-labels', banner, unknown, 300);
          steps.push(`ai-labels:${unknown.length}`);
          for (const c of unknown) labels[c.i] = l.labels[c.i] || 'other';
        }
        return { decision: chooseFromLabels(banner, labels), gate, steps, labels };
      },
    };
  }

  const HYBRID_VARIANTS = [
    hybrid('h-fast', 'hybrid fast', false, 'g-def'),
    hybrid('h-safe', 'hybrid safe', true, 'g-def'),
    // round 3 (bouncer): h-safe with the g-def-short gate (81/81, 0 FP, ~0.44 s median in round 2)
    hybrid('h-bouncer', 'bouncer pipeline', true, 'g-def-short'),
  ];

  const ALL = [].concat(MECH_VARIANTS, GATE_VARIANTS, DECIDE_VARIANTS, HYBRID_VARIANTS);

  // Which fixtures a variant runs on: deciders only see positives.
  function applies(variant, fx) { return variant.kind !== 'decide' || fx.kind === 'positive'; }

  // Expected outcome for a fixture under a variant kind.
  function evaluate(variant, fx, decision) {
    if (variant.kind === 'gate') {
      const got = decision && decision.gate;
      return { correct: got === fx.gate.expected, got: got || 'unparseable' };
    }
    const sc = score(decision, fx.expected, fx.banner);
    return { correct: sc.correct, why: sc.why };
  }

  globalThis.Variants = {
    ALL, GATE_VARIANTS, DECIDE_VARIANTS, MECH_VARIANTS, HYBRID_VARIANTS, LABELS,
    fmtInput, fmtDecision, score, evaluate, applies, chooseFromLabels, regexLabels, mechGate, parseJSON, normDecision,
  };
})();
