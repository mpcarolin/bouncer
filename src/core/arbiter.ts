import type { KV } from "./platform.ts";

export type Owner = "none" | "autoconsent" | "bouncer";

interface ArbState {
  /** The top document this state belongs to; null until one has been recorded. */
  documentId: string | null;
  owner: Owner;
  topCmp: boolean;
}

const key = (tabId: number) => `arb:${tabId}`;

/** The caller names a page (`documentId`) other than the one on record. */
const otherPage = (s: ArbState, documentId: string | undefined) =>
  documentId !== undefined && s.documentId !== null && s.documentId !== documentId;

/**
 * Background-side arbiter (§2b): one owner per tab and page load. Atomicity assumes a single Arbiter instance (one live service worker). Every method is a serialised
 * read-modify-write on `arb:<tabId>`; state lives only in the KV so a restarted service worker
 * (a new Arbiter over the same KV) sees every earlier claim.
 */
export class Arbiter {
  private chains = new Map<number, Promise<unknown>>();

  constructor(private kv: KV) {}

  /** Run `fn` after every earlier call for this tab has settled; a rejection never blocks later calls. */
  private serial<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(tabId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(tabId, tail);
    void tail.then(() => {
      if (this.chains.get(tabId) === tail) this.chains.delete(tabId);
    });
    return run;
  }

  private async load(tabId: number): Promise<ArbState> {
    return (
      (await this.kv.get<ArbState>(key(tabId))) ?? {
        documentId: null,
        owner: "none",
        topCmp: false,
      }
    );
  }

  /**
   * A new top document: fresh state. Idempotent for the same document, so a repeated hello or
   * navigation event never wipes a claim. State created before any document was known (autoconsent
   * spoke first) is kept and attached to this document.
   */
  topDocument(tabId: number, documentId: string): Promise<void> {
    return this.serial(tabId, async () => {
      const s = await this.kv.get<ArbState>(key(tabId));
      if (s && s.documentId === documentId) return;
      if (s && s.documentId === null) {
        await this.kv.set(key(tabId), { ...s, documentId } satisfies ArbState);
        return;
      }
      await this.kv.set(key(tabId), {
        documentId,
        owner: "none",
        topCmp: false,
      } satisfies ArbState);
    });
  }

  /**
   * A top-frame detection gives the page to autoconsent. A child-frame one changes nothing, and
   * so does one for a page (`documentId`, the top document) other than the one on record.
   */
  cmpDetected(tabId: number, frameId: number, documentId?: string): Promise<void> {
    if (frameId !== 0) return Promise.resolve();
    return this.serial(tabId, async () => {
      const s = await this.load(tabId);
      if (otherPage(s, documentId)) return;
      s.topCmp = true;
      if (s.owner === "none") s.owner = "autoconsent";
      await this.kv.set(key(tabId), s);
    });
  }

  claimForBouncer(
    tabId: number,
    documentId: string,
  ): Promise<{ granted: boolean; reason?: "autoconsent" | "already" | "stale" }> {
    return this.serial(tabId, async () => {
      const s = await this.load(tabId);
      // No recorded page, or a different one: stand down. The hello always records the page first.
      if (s.documentId !== documentId) return { granted: false, reason: "stale" as const };
      if (s.owner === "autoconsent") {
        await this.kv.set(key(tabId), s);
        return { granted: false, reason: "autoconsent" as const };
      }
      if (s.owner === "bouncer") {
        await this.kv.set(key(tabId), s);
        return { granted: false, reason: "already" as const };
      }
      s.owner = "bouncer";
      await this.kv.set(key(tabId), s);
      return { granted: true };
    });
  }

  /**
   * From any frame. Claims for autoconsent if nobody owns the page yet. For a page (`documentId`,
   * the top document) other than the one on record it changes nothing and refuses as `stale`.
   */
  popupFound(
    tabId: number,
    _frameId: number,
    documentId?: string,
  ): Promise<{ sendOptOut: boolean; reason?: "stale" }> {
    return this.serial(tabId, async () => {
      const s = await this.load(tabId);
      if (otherPage(s, documentId)) return { sendOptOut: false, reason: "stale" as const };
      if (s.owner === "bouncer") return { sendOptOut: false };
      if (s.owner === "none") {
        s.owner = "autoconsent";
        await this.kv.set(key(tabId), s);
      }
      return { sendOptOut: true };
    });
  }

  owner(tabId: number): Promise<Owner> {
    return this.serial(tabId, async () => (await this.load(tabId)).owner);
  }

  forget(tabId: number): Promise<void> {
    return this.serial(tabId, () => this.kv.remove(key(tabId)));
  }
}
