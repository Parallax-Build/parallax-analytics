import { describe, expect, it } from "vitest";
import { Classifier } from "./classify.ts";
import { clientIp, truncateIp } from "./ip.ts";
import { checkWork, issueChallenge, issueToken, leadingZeroBits, solveWork, verifyChallenge, verifyToken } from "./tokens.ts";

describe("truncateIp", () => {
  it.each([
    ["203.0.113.77", "203.0.113.0"],
    ["::ffff:198.51.100.9", "198.51.100.0"],
    ["2001:db8:abcd:1234:5678:9abc:def0:1", "2001:db8:abcd::"],
    ["2001:db8::1", "2001:db8:0::"],
    ["::1", "0:0:0::"],
  ])("%s -> %s", (input, expected) => {
    expect(truncateIp(input)).toBe(expected);
  });

  it("returns null for anything that is not an address", () => {
    expect(truncateIp("not-an-ip")).toBeNull();
    expect(truncateIp(undefined)).toBeNull();
  });
});

describe("clientIp", () => {
  it("ignores forwarding headers unless the proxy is trusted", () => {
    const headers = { "x-forwarded-for": "203.0.113.77, 10.0.0.1" };
    expect(clientIp(headers, "10.0.0.9", false)).toBe("10.0.0.9");
    expect(clientIp(headers, "10.0.0.9", true)).toBe("203.0.113.77");
  });
});

describe("tokens", () => {
  const secret = "s".repeat(40);

  it("counts leading zero bits", () => {
    expect(leadingZeroBits(Buffer.from([0x00, 0x0f, 0xff]))).toBe(12);
    expect(leadingZeroBits(Buffer.from([0x80]))).toBe(0);
    expect(leadingZeroBits(Buffer.from([0x00, 0x00]))).toBe(16);
  });

  it("issues a challenge that can be solved and verified", () => {
    const challenge = issueChallenge(secret, "w", "https://a.example", 1000, 10);
    const verified = verifyChallenge(secret, challenge, 1001);
    expect(verified.ok).toBe(true);
    const counter = solveWork(challenge, 10);
    expect(checkWork(challenge, counter, 10)).toBe(true);
    expect(checkWork(challenge, -1, 10)).toBe(false);
    expect(checkWork(challenge, 1.5, 10)).toBe(false);
  });

  it("does not accept a challenge as a token, or a token signed with another secret", () => {
    const challenge = issueChallenge(secret, "w", "https://a.example", 1000, 10);
    expect(verifyToken(secret, challenge, 1001)).toEqual({ ok: false, reason: "malformed" });
    const token = issueToken("x".repeat(40), "w", "https://a.example", 1000);
    expect(verifyToken(secret, token, 1001)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("expires", () => {
    const token = issueToken(secret, "w", "https://a.example", 1000, 60);
    expect(verifyToken(secret, token, 1060).ok).toBe(true);
    expect(verifyToken(secret, token, 1061)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("Classifier", () => {
  const ua = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
  const signals = { userAgent: ua, webdriver: false, hasFetchMetadata: true, website: "w", network: "203.0.113.0", now: 6000 };

  it("is confident about an ordinary browser", () => {
    expect(new Classifier().classify(signals)).toEqual({ class: "confident", reason: "ok" });
  });

  it.each(["curl/8.5.0", "python-requests/2.32", "Mozilla/5.0 (compatible; Googlebot/2.1)", "Playwright/1.48", ""])(
    "treats %j as automated",
    (userAgent) => {
      expect(new Classifier().classify({ ...signals, userAgent }).class).toBe("automated");
    },
  );

  it("is skeptical about many user agents from one network", () => {
    const classifier = new Classifier({ eventsPerMinute: 1000, agentsPerTenMinutes: 3 });
    let last = classifier.classify(signals);
    for (let i = 0; i < 4; i++) last = classifier.classify({ ...signals, userAgent: `${ua} v${i}` });
    expect(last).toEqual({ class: "low_confidence", reason: "many-agents-one-network" });
  });

  it("resets the rate window each minute", () => {
    const classifier = new Classifier({ eventsPerMinute: 2, agentsPerTenMinutes: 8 });
    classifier.classify(signals);
    classifier.classify(signals);
    expect(classifier.classify(signals).reason).toBe("rate");
    expect(classifier.classify({ ...signals, now: 6060 }).class).toBe("confident");
  });

  it("is skeptical when a browser sends no fetch metadata", () => {
    expect(new Classifier().classify({ ...signals, hasFetchMetadata: false })).toEqual({
      class: "low_confidence",
      reason: "no-fetch-metadata",
    });
  });
});
