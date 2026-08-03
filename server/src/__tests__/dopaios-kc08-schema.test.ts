import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../packages/db/src/migrations/0521_dopaios_kc08_context_connector.sql", import.meta.url),
  "utf8",
);
const drizzleSchema = readFileSync(
  new URL("../../../packages/db/src/schema/dopaios_kc01.ts", import.meta.url),
  "utf8",
);

describe("dopaios KC-08 schema contract", () => {
  it("pins pgvector 0.8.6 and creates the context, connector, retrieval, and audit projections", () => {
    expect(migration).toMatch(/extversion[\s\S]*<> '0\.8\.6'|vector_version <> '0\.8\.6'/);
    expect(migration).toContain('"dopaios_context_packages"');
    expect(migration).toContain('"dopaios_connector_policies"');
    expect(migration).toContain('"dopaios_dkp_chunks"');
    expect(migration).toContain('"dopaios_retrieval_queries"');
    expect(migration).toContain('"dopaios_connector_audit_events"');
    for (const requiredPolicyField of [
      '"policy_revision"',
      '"configuration"',
      '"scope_level"',
      '"precedence"',
      '"approver_capability"',
      '"effective_at"',
      '"invalidation"',
    ]) {
      expect(migration).toContain(requiredPolicyField);
    }
    expect(migration).toContain('CONSTRAINT "dopaios_connector_policies_pk" PRIMARY KEY("policy_id", "policy_revision")');
    expect(migration).toContain('"actor_id" text NOT NULL');
    expect(migration).toContain('"session_id" text NOT NULL');
    expect(migration).toContain('"policy_sha256" text');
    expect(migration).toMatch(/"dopaios_dkp_chunks_pk"[\s\S]*"index_version"/);
    expect(migration).toContain("USING gin");
    expect(migration).not.toMatch(/hnsw|ivfflat/i);
  });

  it("requires context package pins to be either absent or complete", () => {
    for (const constraint of [
      "dopaios_execution_contracts_context_package_complete",
      "dopaios_activations_context_package_complete",
      "dopaios_ai_sessions_context_package_complete",
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
    expect(migration.match(/num_nonnulls\("context_package_id", "context_package_revision", "context_package_sha256"\) IN \(0, 3\)/g)).toHaveLength(3);
  });

  it("keeps the generated lexical vector and GIN index in Drizzle schema parity", () => {
    expect(drizzleSchema).toMatch(/searchVector:\s*tsvector\("search_vector"\)[\s\S]*generatedAlwaysAs/);
    expect(drizzleSchema).toContain('index("dopaios_dkp_chunks_search_idx").using("gin", table.searchVector)');
  });

  it("stores the exact Context Package hash and relational provenance for every hit", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "dopaios_retrieval_hits"[\s\S]*"context_package_sha256" text NOT NULL/);
    for (const constraint of [
      "dopaios_context_package_sources_package_fk",
      "dopaios_dkp_chunks_source_fk",
      "dopaios_retrieval_queries_package_fk",
      "dopaios_retrieval_hits_query_fk",
      "dopaios_retrieval_hits_package_fk",
      "dopaios_retrieval_hits_source_fk",
      "dopaios_retrieval_hits_chunk_fk",
    ]) {
      expect(migration).toContain(`CONSTRAINT "${constraint}"`);
    }
    expect(drizzleSchema).toContain('contextPackageSha256: text("context_package_sha256").notNull()');
  });
});
