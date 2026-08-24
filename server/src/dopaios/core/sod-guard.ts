import { sql } from "drizzle-orm";
import { executeCommand, type Db } from "./event-store.js";

// ADR-031 — guard điều kiện tắt của ngoại lệ SoD một-người-vận-hành
// (sentinel `local-board` trong `local_trusted`). Spec được CTO chấp nhận
// tường minh tại Approval Record closure wave 2 (20/08/2026): miễn trừ TỰ VÔ
// HIỆU (fail-closed) khi bất kỳ điều nào sau đây đúng:
//   (1) số Staff người đang active khác đúng một (0 hoặc nhiều hơn một);
//   (2) tồn tại ít nhất một Project đang active được đánh dấu có bên ngoài,
//       hoặc không xác định được trạng thái lifecycle của một Project, hoặc
//       không xác định được thuộc tính có-bên-ngoài của một Project đang
//       active — xét trên toàn tổ chức, bất kể approval thuộc Project nào;
//   (3) chế độ chạy không phải `local_trusted`;
//   (4) không xác định được số Staff người đang active.
// Cách đọc hẹp "đang active" là quyết định tường minh của CTO: Staff người
// đã kết thúc quan hệ làm việc và Project đã đóng không vô hiệu miễn trừ.
// Mọi lần dùng ngoại lệ ghi event audit kèm actor và target (hàm dưới).

export type SodExemptionGuardResult = {
  allowed: boolean;
  reasons: string[];
};

// Trạng thái Project "đang active" theo registry P0 hiện hành (KC-13):
// PREPARING chưa mở phiên AI nhưng vẫn là Project đang sống trong tổ chức —
// đọc rộng có chủ đích ở phía an toàn; Project đã đóng/hủy (terminal) không
// tính. Registry hiện chỉ có PREPARING và P0_ACTIVE; trạng thái lạ đọc là
// "không xác định lifecycle" → vô hiệu miễn trừ.
const KNOWN_PROJECT_STATES = new Set(["PREPARING", "P0_ACTIVE"]);
const CLOSED_PROJECT_STATES = new Set<string>([]);

export async function evaluateSodExemptionGuard(
  db: Db,
  input: { deploymentMode: string },
): Promise<SodExemptionGuardResult> {
  const reasons: string[] = [];

  if (input.deploymentMode !== "local_trusted") {
    reasons.push(`chế độ chạy ${input.deploymentMode} không phải local_trusted`);
  }

  try {
    const humans = (await db.execute(sql`
      SELECT count(*)::int AS n FROM dopaios_actors WHERE kind = 'human' AND active = true
    `)) as unknown as Array<{ n: number }>;
    const activeHumans = humans[0]?.n;
    if (typeof activeHumans !== "number") {
      reasons.push("không xác định được số Staff người đang active");
    } else if (activeHumans !== 1) {
      reasons.push(`số Staff người đang active là ${activeHumans}, khác đúng một`);
    }
  } catch {
    reasons.push("không xác định được số Staff người đang active (lỗi truy vấn)");
  }

  try {
    const projects = (await db.execute(sql`
      SELECT id, state, has_external_parties FROM dopaios_projects
    `)) as unknown as Array<{ id: string; state: string | null; has_external_parties: boolean | null }>;
    for (const project of projects) {
      if (project.state === null || !KNOWN_PROJECT_STATES.has(project.state)) {
        if (project.state !== null && CLOSED_PROJECT_STATES.has(project.state)) continue;
        reasons.push(`không xác định được lifecycle của Project ${project.id} (state ${project.state ?? "null"})`);
        continue;
      }
      if (project.has_external_parties === true) {
        reasons.push(`Project ${project.id} đang active và có bên ngoài`);
      } else if (project.has_external_parties === null) {
        reasons.push(`không xác định được thuộc tính có-bên-ngoài của Project ${project.id} đang active`);
      }
    }
  } catch {
    reasons.push("không xác định được danh sách Project (lỗi truy vấn)");
  }

  return { allowed: reasons.length === 0, reasons };
}

// Audit bắt buộc của ADR-031: mỗi lần miễn trừ được DÙNG ghi một event kèm
// actor và target vào event store — không đi đường log thường.
export async function recordSodExemptionUse(
  db: Db,
  commandId: string,
  payload: { actorId: string; targetKind: string; targetId: string },
): Promise<void> {
  await executeCommand(db, {
    commandId,
    payload: payload as unknown as Record<string, unknown>,
    handler: async (ctx, p) => {
      await ctx.emit({
        streamName: `dopaiosSodExemption-${p["targetId"]}`,
        type: "SodExemptionUsed",
        data: {
          actorId: p["actorId"],
          targetKind: p["targetKind"],
          targetId: p["targetId"],
        },
        metadata: { commandId, audit: true },
      });
      return { recorded: true };
    },
  });
}
