import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb } from "@paperclipai/db";

export async function startKc08VectorTestDatabase(baseConnectionString: string): Promise<{
  connectionString: string;
  cleanup: () => Promise<void>;
}> {
  const databaseName = `dopaios_kc08_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  if (!/^dopaios_kc08_[a-z0-9_]+$/u.test(databaseName)) {
    throw new Error("Unsafe KC-08 temporary database identifier");
  }
  const adminUrl = new URL(baseConnectionString);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${databaseName}`;
  const cleanup = async (): Promise<void> => {
    const cleanupDb = createDb(adminUrl.toString());
    try {
      await cleanupDb.execute(sql.raw(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`));
    } finally {
      await cleanupDb.$client.end();
    }
  };
  const adminDb = createDb(adminUrl.toString());
  try {
    await adminDb.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
  } finally {
    await adminDb.$client.end();
  }
  try {
    await applyPendingMigrations(testUrl.toString());
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    connectionString: testUrl.toString(),
    cleanup,
  };
}
