/**
 * The claim wait's safety net (§2b). The wait ends at autoconsent's look at the page; this, from
 * the start of the candidate's run, ends it only if autoconsent never looks.
 */
export const CLAIM_WAIT_MS = 1500;
export const PANEL_WAIT_MS = 3000;
export const VERIFY_GONE_MS = 3000;
export const VERIFY_STAY_MS = 2000;
export const DETECT_WATCH_MS = 20000;
export const DETECT_THROTTLE_MS = 250;
export const MAX_MODEL_CALLS_PER_PAGE = 8;
export const LINK_THRESHOLD = 10;
export const GATE_TEXT_CHARS = 150;
/** Banner text budget for labelling and corroboration (the spike's hybrid pipeline used 300). */
export const LABEL_TEXT_CHARS = 300;
export const AVAILABILITY_TIMEOUT_MS = 1500;
export const CREATE_TIMEOUT_MS = 30000;
export const PROMPT_TIMEOUT_MS = 8000;
export const AC_OPTOUT_TIMEOUT_MS = 15000;
export const LOG_RETENTION_MS = 86_400_000;
/**
 * How long after Bouncer clicks a submit control its `navigate` backstop stays armed (§0's submit
 * guard). The form's navigation begins in a task queued by the click, so it has to outlast that.
 */
export const SUBMIT_GUARD_MS = 500;
/**
 * The prerendered documents whose autoconsent `init` is held per tab, the oldest dropped. Chrome
 * renders a prerendered page's cross-origin iframes only once it is shown, so the holds are its
 * top frame's and its same-origin frames'.
 */
export const PRERENDER_HOLDS_PER_TAB = 8;
