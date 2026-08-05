import { randomBytes, randomUUID } from "node:crypto";
import { authSessions, createDb, instanceUserRoles } from "@paperclipai/db";
import { inArray, sql } from "drizzle-orm";
import { boardAuthService } from "../services/board-auth.js";
import { buildKc10SessionCookie } from "./kc10-auth.js";
import { buildKc10Dataset } from "./kc10-dataset.js";
import {
  KC10_COMPANY_ID,
  seedKc10ControlPlane,
  seedKc10OperationalProjection,
} from "./kc10-seed.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
if (!betterAuthSecret) throw new Error("BETTER_AUTH_SECRET is required");
const instanceId = process.env.PAPERCLIP_INSTANCE_ID;
if (instanceId !== "kc10") throw new Error("PAPERCLIP_INSTANCE_ID must be kc10");

const dataset = buildKc10Dataset({
  seed: "KC10-20260805-v1",
  anchorTime: "2026-08-05T00:00:00.000Z",
  sourceCommit: "79c42d53aaef0d37532d35aa9565e0aaee346681",
});
const db = createDb(databaseUrl);
const controlPlane = await seedKc10ControlPlane(db, dataset);
const projection = await seedKc10OperationalProjection(db, KC10_COMPANY_ID, dataset);

await db.execute(sql`
  DELETE FROM board_api_keys
  WHERE user_id IN (${sql.join(dataset.users.map((user) => sql`${user.id}`), sql`, `)})
    AND name LIKE 'KC-10 runner %'
`);
const boardAuth = boardAuthService(db);
const now = new Date();
const sessionExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
const browserSessions = dataset.users.map((user) => ({
  id: randomUUID(),
  token: randomBytes(32).toString("hex"),
  userId: user.id,
  createdAt: now,
  updatedAt: now,
  expiresAt: sessionExpiresAt,
  ipAddress: null,
  userAgent: "Dopaios KC-10 official browser harness",
}));
const firstUser = dataset.users[0];
if (!firstUser) throw new Error("KC-10 dataset must contain at least one user");

await db.delete(authSessions).where(inArray(authSessions.userId, dataset.users.map((user) => user.id)));
await db.insert(authSessions).values(browserSessions);
await db.insert(instanceUserRoles).values({
  userId: firstUser.id,
  role: "instance_admin",
}).onConflictDoNothing();

const credentials = [];
for (const [ordinal, user] of dataset.users.entries()) {
  const browserSession = browserSessions[ordinal];
  if (!browserSession) throw new Error(`Missing KC-10 browser session ${ordinal + 1}`);
  const key = await boardAuth.createNamedBoardApiKey({
    userId: user.id,
    name: `KC-10 runner ${String(user.ordinal + 1).padStart(2, "0")}`,
  });
  credentials.push({
    userId: user.id,
    token: key.token,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    sessionExpiresAt: sessionExpiresAt.toISOString(),
    sessionCookie: buildKc10SessionCookie({
      instanceId,
      token: browserSession.token,
      secret: betterAuthSecret,
    }),
  });
}

process.stdout.write(`${JSON.stringify({
  schema: "dopaios.kc10.runtime-seed/v1",
  companyId: KC10_COMPANY_ID,
  dataset: dataset.manifest,
  controlPlane,
  projection,
  credentials,
}, null, 2)}\n`);
process.exit(0);
