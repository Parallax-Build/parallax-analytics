/**
 * Hard-coded path normalization rules.
 *
 * One rule set, two consumers: the OpenTelemetry Collector (Go RE2 regular
 * expressions, through the OTTL `replace_pattern` function) and the Astrolabe
 * writer (JavaScript). Every pattern must therefore be valid in both engines:
 * no lookaround, no backreferences. `\b` is the only boundary used.
 *
 * Rules run in order. Each one replaces a whole path segment that matches a
 * high-cardinality identifier with a fixed placeholder, so the stored route is
 * the shape of the URL and never the identifier itself.
 */

export interface PathRule {
  /** Stable name, used in docs and tests. */
  readonly name: string;
  /** Regular expression source, valid in RE2 and in JavaScript. */
  readonly pattern: string;
  /** Replacement text. Never contains `$`, so it is literal in both engines. */
  readonly placeholder: string;
}

const BASE32 = "[A-Z2-7]";
const HEX = "[0-9a-fA-F]";

export const PATH_RULES: readonly PathRule[] = [
  // Stellar muxed account (M...), 69 characters.
  { name: "muxed-account", pattern: `/M${BASE32}{68}\\b`, placeholder: "/{muxed}" },
  // Classic asset written as CODE-ISSUER or CODE:ISSUER.
  { name: "asset", pattern: `/[A-Za-z0-9]{1,12}[-:]G${BASE32}{55}\\b`, placeholder: "/{asset}" },
  // Stellar account (G...), 56 characters.
  { name: "account", pattern: `/G${BASE32}{55}\\b`, placeholder: "/{account}" },
  // Soroban contract (C...), 56 characters.
  { name: "contract", pattern: `/C${BASE32}{55}\\b`, placeholder: "/{contract}" },
  { name: "uuid", pattern: `/${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}\\b`, placeholder: "/{uuid}" },
  // Transaction, ledger or contract hash: 64 hexadecimal characters.
  { name: "hash", pattern: `/${HEX}{64}\\b`, placeholder: "/{hash}" },
  { name: "long-hex", pattern: `/${HEX}{16,}\\b`, placeholder: "/{hex}" },
  { name: "numeric-id", pattern: "/[0-9]+\\b", placeholder: "/{id}" },
  // Anything else that is too long to be a route name.
  { name: "long-segment", pattern: "/[^/]{65,}", placeholder: "/{other}" },
];

/** Placeholder used when a tenant goes over its cap of distinct routes. */
export const OVERFLOW_ROUTE = "/{other}";
/** Route used when a span carries no path information at all. */
export const UNKNOWN_ROUTE = "/{unknown}";

const MAX_ROUTE_LENGTH = 256;

const COMPILED = PATH_RULES.map((rule) => ({
  rule,
  regex: new RegExp(rule.pattern, "g"),
}));

/**
 * Normalizes a URL path (or request target) to a low-cardinality route.
 *
 * @param raw A path such as `/accounts/GA5Z.../payments?limit=10`.
 * @returns The route shape, for example `/accounts/{account}/payments`.
 */
export function normalizePath(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return UNKNOWN_ROUTE;
  let path = raw.trim();
  if (path === "") return UNKNOWN_ROUTE;

  // Drop scheme and host if a full URL was sent.
  const schemeEnd = path.indexOf("://");
  if (schemeEnd !== -1) {
    const pathStart = path.indexOf("/", schemeEnd + 3);
    path = pathStart === -1 ? "/" : path.slice(pathStart);
  }

  // Drop query string and fragment: they never belong in a route.
  const cut = path.search(/[?#]/);
  if (cut !== -1) path = path.slice(0, cut);

  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");

  for (const { regex, rule } of COMPILED) {
    path = path.replace(regex, rule.placeholder);
  }

  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path.length > MAX_ROUTE_LENGTH) return OVERFLOW_ROUTE;
  return path;
}

/**
 * Renders the rule set as OTTL statements for the Collector's transform
 * processor. `attribute` is the span attribute that holds the route.
 */
export function toOttlStatements(attribute: string): string[] {
  const target = `attributes["${attribute}"]`;
  return [
    `replace_pattern(${target}, "[?#].*", "")`,
    ...PATH_RULES.map((rule) => {
      const pattern = rule.pattern.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
      return `replace_pattern(${target}, "${pattern}", "${rule.placeholder}")`;
    }),
  ];
}
