import { describe, expect, it } from "vitest";
import { normalizePath, PATH_RULES, toOttlStatements, UNKNOWN_ROUTE } from "./index.ts";

const G = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const G2 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const C = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const M = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK";
const HASH = "3389e9f0f1a65f19736cacf544c2e825313e8447f569233bb8db39aa607c8889";

describe("normalizePath", () => {
  it.each([
    [`/accounts/${G}`, "/accounts/{account}"],
    [`/accounts/${G}/payments?limit=10&order=desc`, "/accounts/{account}/payments"],
    [`/accounts/${G}/trades/${G2}`, "/accounts/{account}/trades/{account}"],
    [`/contracts/${C}/events`, "/contracts/{contract}/events"],
    [`/accounts/${M}`, "/accounts/{muxed}"],
    [`/transactions/${HASH}`, "/transactions/{hash}"],
    [`/transactions/${HASH.toUpperCase()}/operations`, "/transactions/{hash}/operations"],
    [`/assets/USDC-${G}`, "/assets/{asset}"],
    [`/assets/yXLM:${G}/holders`, "/assets/{asset}/holders"],
    ["/ledgers/52871340", "/ledgers/{id}"],
    ["/ledgers/52871340/transactions/7", "/ledgers/{id}/transactions/{id}"],
    ["/orders/550e8400-e29b-41d4-a716-446655440000", "/orders/{uuid}"],
    ["/blobs/deadbeefdeadbeefdeadbeef", "/blobs/{hex}"],
    ["/health", "/health"],
    ["/", "/"],
    ["/v1/accounts", "/v1/accounts"],
    ["/api/v2/quotes/", "/api/v2/quotes"],
    ["//double//slash", "/double/slash"],
    ["accounts", "/accounts"],
    [`https://api.example.org/accounts/${G}#frag`, "/accounts/{account}"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePath(input)).toBe(expected);
  });

  it("keeps version prefixes and short words that contain digits", () => {
    expect(normalizePath("/v1/pools/usdc2")).toBe("/v1/pools/usdc2");
  });

  it("collapses very long unknown segments", () => {
    expect(normalizePath(`/files/${"x".repeat(80)}`)).toBe("/files/{other}");
  });

  it("returns the unknown route for missing input", () => {
    expect(normalizePath(undefined)).toBe(UNKNOWN_ROUTE);
    expect(normalizePath("  ")).toBe(UNKNOWN_ROUTE);
  });

  it("never lets a Stellar address through, wherever it sits in the path", () => {
    for (const path of [`/${G}`, `/a/${G}/b/${C}/c`, `/x/${M}?who=${G}`]) {
      const out = normalizePath(path);
      expect(out).not.toMatch(/[GCM][A-Z2-7]{55}/);
    }
  });

  it("is idempotent", () => {
    const once = normalizePath(`/accounts/${G}/offers/123`);
    expect(normalizePath(once)).toBe(once);
  });
});

describe("rule set", () => {
  it("uses only syntax shared by RE2 and JavaScript", () => {
    for (const rule of PATH_RULES) {
      expect(rule.pattern, rule.name).not.toMatch(/\(\?[=!<]/); // no lookaround
      expect(rule.pattern, rule.name).not.toMatch(/\\[1-9]/); // no backreferences
      expect(rule.placeholder, rule.name).not.toContain("$");
    }
  });

  it("renders one OTTL statement per rule plus the query-string strip", () => {
    const statements = toOttlStatements("parallax.route");
    expect(statements).toHaveLength(PATH_RULES.length + 1);
    expect(statements[1]).toContain('attributes["parallax.route"]');
    expect(statements.join("\n")).toContain("\\\\b");
  });
});
