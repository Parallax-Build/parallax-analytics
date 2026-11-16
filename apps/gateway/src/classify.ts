/**
 * Traffic classification.
 *
 * Every accepted event gets one of three classes. Nothing is silently dropped:
 * all three are counted per tenant, so an operator can see the ratio.
 *
 * - `confident`: nothing suspicious.
 * - `low_confidence`: kept, but treated with skepticism.
 * - `automated`: declared or detected automation.
 */

export type TrafficClass = "confident" | "low_confidence" | "automated";

export interface Classification {
  class: TrafficClass;
  /** Machine-readable reason, `ok` for confident traffic. */
  reason: string;
}

export interface EventSignals {
  userAgent: string | undefined;
  /** `navigator.webdriver`, as reported by the tracker. */
  webdriver: boolean;
  /** True when the browser sent a `Sec-Fetch-Site` header. */
  hasFetchMetadata: boolean;
  /** Website id. */
  website: string;
  /** Truncated client address (see `truncateIp`). */
  network: string | null;
  now: number;
}

const AUTOMATION_UA =
  /bot\b|crawl|spider|slurp|headless|phantomjs|selenium|puppeteer|playwright|python-requests|python-urllib|aiohttp|httpx|curl\/|wget\/|node-fetch|undici|axios\/|go-http-client|okhttp|java\/|libwww|scrapy|lighthouse|pingdom|uptimerobot/i;

export interface RateLimits {
  /** Events per minute from one network to one website before skepticism. */
  eventsPerMinute: number;
  /** Distinct user agents from one network to one website, per ten minutes. */
  agentsPerTenMinutes: number;
}

export const DEFAULT_LIMITS: RateLimits = { eventsPerMinute: 60, agentsPerTenMinutes: 8 };

interface Window {
  minute: number;
  events: number;
  tenMinute: number;
  agents: Set<string>;
}

/**
 * Stateful classifier. Rate state lives in memory and is keyed by website and
 * truncated network, never by full address. With several gateway nodes each
 * node keeps its own windows, which makes the limits per node.
 */
export class Classifier {
  private readonly windows = new Map<string, Window>();
  private readonly limits: RateLimits;

  constructor(limits: RateLimits = DEFAULT_LIMITS) {
    this.limits = limits;
  }

  classify(signals: EventSignals): Classification {
    const ua = signals.userAgent?.trim() ?? "";
    if (ua === "") return { class: "automated", reason: "no-user-agent" };
    if (AUTOMATION_UA.test(ua)) return { class: "automated", reason: "automation-user-agent" };
    if (signals.webdriver) return { class: "automated", reason: "webdriver" };

    const rate = this.observe(signals, ua);
    if (rate) return { class: "low_confidence", reason: rate };
    if (!signals.hasFetchMetadata) return { class: "low_confidence", reason: "no-fetch-metadata" };
    return { class: "confident", reason: "ok" };
  }

  private observe(signals: EventSignals, ua: string): string | null {
    if (signals.network === null) return "unknown-network";
    const key = `${signals.website}|${signals.network}`;
    const minute = Math.floor(signals.now / 60);
    const tenMinute = Math.floor(signals.now / 600);
    let window = this.windows.get(key);
    if (!window) {
      window = { minute, events: 0, tenMinute, agents: new Set() };
      this.windows.set(key, window);
    }
    if (window.minute !== minute) {
      window.minute = minute;
      window.events = 0;
    }
    if (window.tenMinute !== tenMinute) {
      window.tenMinute = tenMinute;
      window.agents.clear();
    }
    window.events += 1;
    if (window.agents.size <= this.limits.agentsPerTenMinutes) window.agents.add(ua);

    if (window.events > this.limits.eventsPerMinute) return "rate";
    if (window.agents.size > this.limits.agentsPerTenMinutes) return "many-agents-one-network";
    return null;
  }

  /** Drops windows that have not been touched for ten minutes. */
  prune(now: number): void {
    const tenMinute = Math.floor(now / 600);
    for (const [key, window] of this.windows) {
      if (window.tenMinute < tenMinute - 1) this.windows.delete(key);
    }
  }
}
