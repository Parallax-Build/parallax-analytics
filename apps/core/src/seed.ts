/**
 * Enrolls the projects listed in a tenants file. Idempotent.
 *
 * For each project it creates a website in Umami (once) and a row in
 * `parallax.tenant`. It also replaces Umami's default admin password.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { migrate } from "./store.ts";

interface TenantSpec {
  id: string;
  name: string;
  domains: string[];
  /** Name of the environment variable that holds the OTLP key, if the project has an API. */
  apiKeyEnv?: string;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    console.error(`missing environment variable ${name}`);
    process.exit(1);
  }
  return value;
}

const umamiUrl = env("UMAMI_URL", "http://localhost:3000").replace(/\/$/, "");
const adminPassword = env("UMAMI_ADMIN_PASSWORD");
const tenantsFile = env("PARALLAX_TENANTS_FILE", "deploy/tenants.demo.json");

async function login(password: string): Promise<string | null> {
  const response = await fetch(`${umamiUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  if (!response.ok) return null;
  return ((await response.json()) as { token?: string }).token ?? null;
}

async function umamiToken(): Promise<string> {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const token = await login(adminPassword);
      if (token) return token;
      // First run: Umami ships with a well-known default password. Replace it.
      const initial = await login("umami");
      if (initial) {
        const changed = await fetch(`${umamiUrl}/api/me/password`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${initial}` },
          body: JSON.stringify({ currentPassword: "umami", newPassword: adminPassword }),
        });
        if (!changed.ok) throw new Error(`could not change the default admin password: ${changed.status}`);
        console.log("replaced Umami's default admin password");
        continue;
      }
      throw new Error("admin login failed with both the configured and the default password");
    } catch (error) {
      if (attempt === 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw new Error("Umami did not become ready");
}

async function createWebsite(token: string, spec: TenantSpec): Promise<string> {
  const response = await fetch(`${umamiUrl}/api/websites`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: spec.name, domain: (spec.domains[0] ?? spec.id).split(":")[0] }),
  });
  if (!response.ok) throw new Error(`could not create the Umami website for ${spec.id}: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { id?: string };
  if (!body.id) throw new Error(`Umami returned no website id for ${spec.id}`);
  return body.id;
}

async function main(): Promise<void> {
  const specs = JSON.parse(readFileSync(tenantsFile, "utf8")) as TenantSpec[];
  const pool = new pg.Pool({ connectionString: env("DATABASE_URL"), max: 2 });
  try {
    await migrate(pool);
    const token = await umamiToken();

    for (const spec of specs) {
      const key = spec.apiKeyEnv ? process.env[spec.apiKeyEnv] : undefined;
      if (spec.apiKeyEnv && !key) console.warn(`${spec.id}: ${spec.apiKeyEnv} is not set, the project gets no OTLP key`);
      const keyHash = key ? createHash("sha256").update(key).digest("hex") : null;

      const existing = await pool.query<{ website_id: string }>("select website_id from parallax.tenant where id = $1", [spec.id]);
      const websiteId = existing.rows[0]?.website_id ?? (await createWebsite(token, spec));
      await pool.query(
        `insert into parallax.tenant (id, name, website_id, domains, api_key_hash)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set name = excluded.name, domains = excluded.domains, api_key_hash = excluded.api_key_hash`,
        [spec.id, spec.name, websiteId, spec.domains, keyHash],
      );
      console.log(`enrolled ${spec.id}: website ${websiteId}, domains ${spec.domains.join(", ")}${keyHash ? ", OTLP key set" : ""}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
