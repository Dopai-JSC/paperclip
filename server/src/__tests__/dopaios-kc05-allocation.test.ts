import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executeCommand, CommandRejectedError } from "../dopaios/event-store.ts";
import {
  provisionWorkspace,
  activateWorkspace,
  beginWorkspaceClose,
  recordWorkspacePurge,
  accessWorkspaceCredential,
  resolveScopedPath,
} from "../dopaios/workspace.ts";
import { requestActivation, claimActivation } from "../dopaios/activation.ts";

// KC-05 B2: cấp phát nguyên tử dưới tương tranh THẬT + ca âm cho từng guard
// hình dạng production (ASM-001). Hai Release song song không nhận trùng
// port/path/credential (tiêu chí "không giẫm"); pool cạn, release lạ, id tái
// sử dụng, path escape, purge sai phạm vi, credential chéo Release đều bị
// chặn kèm vệt audit bất biến (SQR-001).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Dopaios KC-05 B2 tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function seedRun(db: ReturnType<typeof createDb>, runId: string): Promise<void> {
  await executeCommand(db, {
    commandId: `KC05-SEED-${runId}`,
    payload: { runId },
    handler: async (ctx) => {
      await ctx.emit({
        streamName: `dopaiosSopRun-${runId}`,
        type: "TestRunRequested",
        data: {
          runId,
          definitionRef: { id: "SOPDEF-KC05", revision: 1 },
          decider: "ORCH-KC05",
          pod: "POD-KC05",
        },
        expectedVersion: -1,
      });
      return { runId };
    },
  });
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "NO-REJECTION";
  } catch (error) {
    if (error instanceof CommandRejectedError) return error.code;
    throw error;
  }
}

describeEmbeddedPostgres("dopaios KC-05 B2 — cấp phát nguyên tử + guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("dopaios-kc05-b2-");
    db = createDb(tempDb.connectionString);
    for (const run of [
      "RUN-REL-C",
      "RUN-REL-D",
      "RUN-REL-E",
      "RUN-REL-F",
      "RUN-REL-G",
      "RUN-REL-H",
      "RUN-REL-I",
    ]) {
      await seedRun(db, run);
    }
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("hai provision SONG SONG trên cùng pool không nhận trùng port/path/credential", async () => {
    const pool = [15601, 15602];
    const [left, right] = await Promise.all([
      provisionWorkspace(db, "KC05-B2-PROV-C", {
        workspaceId: "WS-REL-C",
        releaseId: "RUN-REL-C",
        portPool: pool,
        baseRef: "kc05-base",
      }),
      provisionWorkspace(db, "KC05-B2-PROV-D", {
        workspaceId: "WS-REL-D",
        releaseId: "RUN-REL-D",
        portPool: pool,
        baseRef: "kc05-base",
      }),
    ]);
    expect(new Set([left["port"], right["port"]])).toEqual(new Set(pool));
    expect(left["relPath"]).not.toBe(right["relPath"]);
    const credLeft = left["credentialRef"] as { id: string };
    const credRight = right["credentialRef"] as { id: string };
    expect(credLeft.id).not.toBe(credRight.id);

    const reserved = (await db.execute(
      sql`SELECT resource_type, value, workspace_id FROM dopaios_workspace_resources
          WHERE state = 'reserved' ORDER BY resource_type, value`,
    )) as unknown as Array<{ resource_type: string; value: string; workspace_id: string }>;
    // 2 workspace × 3 loại tài nguyên, không giá trị nào hai chủ.
    expect(reserved).toHaveLength(6);
    expect(new Set(reserved.map((r) => `${r.resource_type}:${r.value}`)).size).toBe(6);
  });

  it("bốn provision song song trên pool 3 port: ba bên thắng khác giá trị, một bên bị chặn ERR-WS-PORT-POOL", async () => {
    const pool = [15611, 15612, 15613];
    const results = await Promise.allSettled([
      provisionWorkspace(db, "KC05-B2-PROV-E", {
        workspaceId: "WS-REL-E",
        releaseId: "RUN-REL-E",
        portPool: pool,
        baseRef: "kc05-base",
      }),
      provisionWorkspace(db, "KC05-B2-PROV-F", {
        workspaceId: "WS-REL-F",
        releaseId: "RUN-REL-F",
        portPool: pool,
        baseRef: "kc05-base",
      }),
      provisionWorkspace(db, "KC05-B2-PROV-G", {
        workspaceId: "WS-REL-G",
        releaseId: "RUN-REL-G",
        portPool: pool,
        baseRef: "kc05-base",
      }),
      provisionWorkspace(db, "KC05-B2-PROV-H", {
        workspaceId: "WS-REL-H",
        releaseId: "RUN-REL-H",
        portPool: pool,
        baseRef: "kc05-base",
      }),
    ]);
    const won = results.filter((r): r is PromiseFulfilledResult<Record<string, unknown>> => r.status === "fulfilled");
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(won).toHaveLength(3);
    expect(lost).toHaveLength(1);
    expect(new Set(won.map((r) => r.value["port"]))).toEqual(new Set(pool));
    expect(lost[0].reason).toBeInstanceOf(CommandRejectedError);
    expect((lost[0].reason as CommandRejectedError).code).toBe("ERR-WS-PORT-POOL");
  });

  it("một Release một workspace sống; sau PURGED mới cấp lại được (tái dùng port đã trả)", async () => {
    expect(
      await rejectionCode(
        provisionWorkspace(db, "KC05-B2-DUP-C", {
          workspaceId: "WS-REL-C-2",
          releaseId: "RUN-REL-C",
          portPool: [15699],
          baseRef: "kc05-base",
        }),
      ),
    ).toBe("ERR-WS-DUP-RELEASE");

    // Đóng trọn WS-REL-C rồi cấp lại: workspace id MỚI, port cũ tái dùng được.
    await activateWorkspace(db, "KC05-B2-ACT-C", {
      workspaceId: "WS-REL-C",
      materialized: { worktreeHead: "c".repeat(40), boundPort: 15601 },
    });
    await beginWorkspaceClose(db, "KC05-B2-CLOSE-C", { workspaceId: "WS-REL-C", reason: "test-reuse" });
    await recordWorkspacePurge(db, "KC05-B2-PURGE-C", {
      workspaceId: "WS-REL-C",
      outcome: "purged",
      report: {
        actor: "dopaios-runner",
        purgedScope: ["releases/RUN-REL-C/ws", "releases/RUN-REL-C/cache"],
        // B7: evidence ràng với phạm vi — mỗi mục khai xóa một checksum.
        checksums: {
          "releases/RUN-REL-C/ws": "1".repeat(64),
          "releases/RUN-REL-C/cache": "2".repeat(64),
        },
        residue: [],
      },
    });
    const again = await provisionWorkspace(db, "KC05-B2-PROV-C2", {
      workspaceId: "WS-REL-C-2",
      releaseId: "RUN-REL-C",
      portPool: [15601],
      baseRef: "kc05-base",
    });
    expect(again["port"]).toBe(15601);
    expect(again["state"]).toBe("PROVISIONED");
  });

  it("guard provision: release lạ, release terminal, id tái sử dụng, pool rỗng", async () => {
    expect(
      await rejectionCode(
        provisionWorkspace(db, "KC05-B2-NEG-1", {
          workspaceId: "WS-NEG-1",
          releaseId: "RUN-KHONG-TON-TAI",
          portPool: [15701],
          baseRef: "kc05-base",
        }),
      ),
    ).toBe("ERR-WS-RELEASE");

    await executeCommand(db, {
      commandId: "KC05-B2-SEED-DONE-RUN",
      payload: { runId: "RUN-REL-DONE" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosSopRun-RUN-REL-DONE",
          type: "TestRunRequested",
          data: {
            runId: "RUN-REL-DONE",
            definitionRef: { id: "SOPDEF-KC05", revision: 1 },
            decider: "ORCH-KC05",
            pod: "POD-KC05",
          },
          expectedVersion: -1,
        });
        await ctx.emit({
          streamName: "dopaiosSopRun-RUN-REL-DONE",
          type: "SopRunStateChanged",
          data: { runId: "RUN-REL-DONE", state: "COMPLETED" },
        });
        return { runId: "RUN-REL-DONE" };
      },
    });
    expect(
      await rejectionCode(
        provisionWorkspace(db, "KC05-B2-NEG-2", {
          workspaceId: "WS-NEG-2",
          releaseId: "RUN-REL-DONE",
          portPool: [15702],
          baseRef: "kc05-base",
        }),
      ),
    ).toBe("ERR-WS-RELEASE-TERMINAL");

    expect(
      await rejectionCode(
        provisionWorkspace(db, "KC05-B2-NEG-3", {
          workspaceId: "WS-REL-D",
          releaseId: "RUN-REL-E",
          portPool: [15703],
          baseRef: "kc05-base",
        }),
      ),
    ).toBe("ERR-WS-ID");

    expect(
      await rejectionCode(
        provisionWorkspace(db, "KC05-B2-NEG-4", {
          workspaceId: "WS-NEG-4",
          releaseId: "RUN-REL-E",
          portPool: [],
          baseRef: "kc05-base",
        }),
      ),
    ).toBe("ERR-WS-PORT-POOL");
  });

  it("guard activate/close/purge theo trạng thái + hồ sơ purge đúng phạm vi", async () => {
    // activate thiếu bằng chứng vật chất hóa / sai port / sai trạng thái.
    expect(
      await rejectionCode(
        activateWorkspace(db, "KC05-B2-NEG-5", {
          workspaceId: "WS-REL-D",
          materialized: { worktreeHead: "", boundPort: 0 },
        }),
      ),
    ).toBe("ERR-WS-MATERIALIZE");
    expect(
      await rejectionCode(
        activateWorkspace(db, "KC05-B2-NEG-6", {
          workspaceId: "WS-REL-D",
          materialized: { worktreeHead: "d".repeat(40), boundPort: 19999 },
        }),
      ),
    ).toBe("ERR-WS-PORT-MISMATCH");
    expect(
      await rejectionCode(
        beginWorkspaceClose(db, "KC05-B2-NEG-7", { workspaceId: "WS-REL-D", reason: "x" }),
      ),
    ).toBe("ERR-WS-STATE");
    expect(
      await rejectionCode(
        recordWorkspacePurge(db, "KC05-B2-NEG-8", {
          workspaceId: "WS-REL-D",
          outcome: "purged",
          report: { actor: "x", purgedScope: [], checksums: {}, residue: [] },
        }),
      ),
    ).toBe("ERR-WS-STATE");

    // Đưa WS-REL-D tới CLOSING để kiểm hồ sơ purge.
    const port = (await db.execute(
      sql`SELECT port FROM dopaios_workspaces WHERE id = 'WS-REL-D'`,
    )) as unknown as Array<{ port: number }>;
    await activateWorkspace(db, "KC05-B2-ACT-D", {
      workspaceId: "WS-REL-D",
      materialized: { worktreeHead: "d".repeat(40), boundPort: port[0].port },
    });
    await beginWorkspaceClose(db, "KC05-B2-CLOSE-D", { workspaceId: "WS-REL-D", reason: "test-guards" });

    // Purge chạm ngoài phạm vi Release → chặn (tiêu chí "purge đúng phạm vi").
    expect(
      await rejectionCode(
        recordWorkspacePurge(db, "KC05-B2-NEG-9", {
          workspaceId: "WS-REL-D",
          outcome: "purged",
          report: {
            actor: "dopaios-runner",
            purgedScope: ["releases/RUN-REL-D/ws", "releases/RUN-REL-E/ws"],
            checksums: {},
            residue: [],
          },
        }),
      ),
    ).toBe("ERR-WS-PURGE-SCOPE");

    // Post-check còn sót → không được ghi purged (ADR-012).
    expect(
      await rejectionCode(
        recordWorkspacePurge(db, "KC05-B2-NEG-10", {
          workspaceId: "WS-REL-D",
          outcome: "purged",
          report: {
            actor: "dopaios-runner",
            purgedScope: ["releases/RUN-REL-D/ws"],
            checksums: { "releases/RUN-REL-D/ws": "3".repeat(64) },
            residue: ["releases/RUN-REL-D/cache/left.tmp"],
          },
        }),
      ),
    ).toBe("ERR-WS-RESIDUE");

    // Hồ sơ thất bại thiếu hành động khắc phục → chặn (FR-17).
    expect(
      await rejectionCode(
        recordWorkspacePurge(db, "KC05-B2-NEG-11", {
          workspaceId: "WS-REL-D",
          outcome: "failed",
          failure: {
            reason: "efs-error",
            leftoverScope: ["releases/RUN-REL-D/cache"],
            correctiveAction: { owner: "", dueMs: 0, scope: [] },
          },
        }),
      ),
    ).toBe("ERR-WS-PURGE-FAILURE");
  });

  it("credential: đúng scope + đúng claimer đọc được; chéo Release, actor không giữ claim và sau thu hồi bị chặn cả đọc kèm audit", async () => {
    // Fixture riêng: không phụ thuộc Release nào thắng cuộc đua 4 bên / 3 port ở ca trước.
    const workspace = await provisionWorkspace(db, "KC05-B2-PROV-I", {
      workspaceId: "WS-REL-I",
      releaseId: "RUN-REL-I",
      portPool: [15621],
      baseRef: "kc05-base",
    });
    await activateWorkspace(db, "KC05-B2-ACT-I", {
      workspaceId: "WS-REL-I",
      materialized: { worktreeHead: "i".repeat(40), boundPort: workspace["port"] as number },
    });
    // B7: actor phải là claimer đang giữ Release — dựng work-item + claim thật.
    await executeCommand(db, {
      commandId: "KC05-B2-SEED-WI-I",
      payload: { workItemId: "WI-RUN-REL-I" },
      handler: async (ctx) => {
        await ctx.emit({
          streamName: "dopaiosWorkItem-WI-RUN-REL-I",
          type: "WorkItemCreated",
          data: { workItemId: "WI-RUN-REL-I", runId: "RUN-REL-I", state: "ACCEPTED" },
          expectedVersion: -1,
        });
        return { seeded: true };
      },
    });
    await requestActivation(db, "KC05-B2-REQ-I", {
      activationId: "ACT-RUN-REL-I",
      workItemId: "WI-RUN-REL-I",
      agentId: "AI-STAFF-BUILD-I",
      engine: "fake-acp-shape",
    });
    // Chưa claim → actor khai đúng tên mình vẫn bị chặn (không giữ claim).
    expect(
      await rejectionCode(
        accessWorkspaceCredential(db, "KC05-B2-CRED-NOCLAIM", {
          workspaceId: "WS-REL-I",
          forReleaseId: "RUN-REL-I",
          actor: "AI-STAFF-BUILD-I",
        }),
      ),
    ).toBe("ERR-WS-CRED-ACTOR");
    await claimActivation(db, "KC05-B2-CLAIM-I", {
      activationId: "ACT-RUN-REL-I",
      claimedBy: "AI-STAFF-BUILD-I",
    });
    const ok = await accessWorkspaceCredential(db, "KC05-B2-CRED-I", {
      workspaceId: "WS-REL-I",
      forReleaseId: "RUN-REL-I",
      actor: "AI-STAFF-BUILD-I",
    });
    expect((ok["credentialRef"] as { id: string }).id).toBe("CRED-RUN-REL-I");

    expect(
      await rejectionCode(
        accessWorkspaceCredential(db, "KC05-B2-CRED-XSCOPE", {
          workspaceId: "WS-REL-I",
          forReleaseId: "RUN-REL-F",
          actor: "AI-STAFF-BUILD-F",
        }),
      ),
    ).toBe("ERR-WS-CRED-SCOPE");

    // WS-REL-D đang CLOSING (ca trước) — credential coi như đã thu hồi.
    expect(
      await rejectionCode(
        accessWorkspaceCredential(db, "KC05-B2-CRED-REVOKED", {
          workspaceId: "WS-REL-D",
          forReleaseId: "RUN-REL-D",
          actor: "AI-STAFF-BUILD-D",
        }),
      ),
    ).toBe("ERR-WS-CRED-REVOKED");

    // Vệt audit bất biến của lần chặn (SQR-001 qua executeAuditedCommand).
    const audit = (await db.execute(
      sql`SELECT type, data ->> 'code' AS code FROM message_store.messages
          WHERE stream_name = 'dopaiosAudit-KC05-B2-CRED-XSCOPE'`,
    )) as unknown as Array<{ type: string; code: string }>;
    expect(audit).toEqual([{ type: "CommandRejected", code: "ERR-WS-CRED-SCOPE" }]);
  });

  it("resolveScopedPath: đường hợp lệ đi qua, tuyệt đối và .. thoát scope bị chặn", () => {
    const base = "/spike-root/releases/RUN-REL-C/ws";
    expect(resolveScopedPath(base, "src/output.txt")).toBe(
      "/spike-root/releases/RUN-REL-C/ws/src/output.txt",
    );
    expect(resolveScopedPath(base, ".")).toBe("/spike-root/releases/RUN-REL-C/ws");
    for (const escape of ["../RUN-REL-D/ws/x.txt", "/etc/passwd", "a/../../../../etc", "../../creds"]) {
      let code = "NO-REJECTION";
      try {
        resolveScopedPath(base, escape);
      } catch (error) {
        if (error instanceof CommandRejectedError) code = error.code;
        else throw error;
      }
      expect(code, `escape ${escape} phải bị chặn`).toBe("ERR-WS-PATH-ESCAPE");
    }
  });
});
