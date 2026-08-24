// ADR-032 — hai đường DB cho contract test:
//   - vòng nhanh (mặc định): embedded-postgres như trước;
//   - đường PostgreSQL 16 thật: đặt DOPAIOS_TEST_DATABASE_URL trỏ tới một
//     server Postgres (job CI dùng image pgvector/pgvector pin digest theo
//     PROVENANCE — PostgreSQL 16 + pgvector 0.8.6, cùng digest KC-16), mỗi
//     suite nhận một database mới toanh trên server đó với trọn chuỗi
//     migration, xong thì drop. Không đổi ngữ nghĩa test nào — chỉ đổi nơi
//     provision database.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  createDb,
  getEmbeddedPostgresTestSupport as getEmbeddedSupportUpstream,
  startEmbeddedPostgresTestDatabase as startEmbeddedUpstream,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db";

export type { EmbeddedPostgresTestDatabase, EmbeddedPostgresTestSupport };

function externalBaseUrl(): string | undefined {
  const value = process.env.DOPAIOS_TEST_DATABASE_URL;
  return value && value.length > 0 ? value : undefined;
}

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  if (externalBaseUrl()) return { supported: true };
  return getEmbeddedSupportUpstream();
}

export async function startEmbeddedPostgresTestDatabase(
  tempDirPrefix: string,
): Promise<EmbeddedPostgresTestDatabase> {
  const baseUrl = externalBaseUrl();
  if (!baseUrl) return startEmbeddedUpstream(tempDirPrefix);

  // Postgres giới hạn identifier 63 byte: đuôi pid + 12 hex đủ duy nhất cho
  // một lần chạy CI; prefix (tên suite) bị cắt để tổng luôn nằm trong giới hạn.
  const suffix = `${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const safePrefix = tempDirPrefix
    .toLowerCase()
    .replaceAll(/[^a-z0-9_]/g, "_")
    .slice(0, 63 - "dopaios_test_".length - suffix.length);
  const databaseName = `dopaios_test_${safePrefix}${suffix}`;
  if (!/^[a-z0-9_]+$/u.test(databaseName) || databaseName.length > 63) {
    throw new Error(`Unsafe external test database identifier: ${databaseName}`);
  }
  const adminUrl = new URL(baseUrl);
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
  return { connectionString: testUrl.toString(), cleanup };
}
