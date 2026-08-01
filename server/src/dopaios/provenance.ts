import { CommandRejectedError } from "./event-store.js";

// KC-04 B1: hợp đồng INPUT "Danh sách nguồn" của lệnh đăng ký artifact theo
// FS-002 (d.629 + EDGE-001): mỗi nguồn pin ID@revision HOẶC hash, KHÔNG nhận
// tham chiếu "latest"; thiếu danh sách → danh sách rỗng hợp lệ. Nguồn khai ở
// cửa đăng ký có thể nằm ngoài sổ (tài liệu gốc chỉ có hash).
//
// PHÂN RANH với validateSourceRefs (lifecycle.ts, KC-15): hàm đó là guard
// HIỆU LỰC lúc phiên bản đầu ra DÙNG nguồn — bắt buộc đủ bộ ba
// artifactId@revision@sha256 và nguồn phải approved/clear trong sổ. Đây là
// hai chặng khác nhau của cùng một hợp đồng pin FS-002, không phải hai cơ
// chế truy vết song song.
// Fail-closed: một entry sai làm cả lệnh bị từ chối, không lọc im lặng.

export type RegisteredSourcePin = {
  artifactId?: string;
  revision?: number;
  sha256?: string;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function parseRegisteredSourcePins(raw: unknown): RegisteredSourcePin[] {
  if (raw === undefined || raw === null) {
    return []; // EDGE-001: artifact gốc không có nguồn — danh sách rỗng hợp lệ.
  }
  if (!Array.isArray(raw)) {
    throw new CommandRejectedError("ERR-SOURCE-PIN", "sourceRefs must be a list of source pins");
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new CommandRejectedError("ERR-SOURCE-PIN", `sourceRefs[${index}] must be a pin object`);
    }
    const e = entry as Record<string, unknown>;
    const artifactId = e["artifactId"];
    const revision = e["revision"];
    const sha256 = e["sha256"];
    const hasId = typeof artifactId === "string" && artifactId.length > 0;
    const hasRevision = typeof revision === "number" && Number.isInteger(revision) && revision >= 1;
    const hasSha = typeof sha256 === "string" && SHA256_HEX.test(sha256);
    // Pin hợp lệ: ID@revision (kèm hash nếu khai) HOẶC hash đứng một mình.
    // Mọi dạng khác — revision không phải số nguyên (kể cả "latest"), ID
    // không kèm revision, hash sai định dạng — đều bị từ chối.
    if (hasId && !hasRevision) {
      throw new CommandRejectedError(
        "ERR-SOURCE-PIN",
        `sourceRefs[${index}] pins an artifact ID without an integer revision — "latest" references are rejected`,
      );
    }
    if (!hasId && hasRevision) {
      throw new CommandRejectedError(
        "ERR-SOURCE-PIN",
        `sourceRefs[${index}] has a revision without an artifact ID`,
      );
    }
    if (sha256 !== undefined && !hasSha) {
      throw new CommandRejectedError(
        "ERR-SOURCE-PIN",
        `sourceRefs[${index}] sha256 must be 64 lowercase hex characters`,
      );
    }
    if (!hasId && !hasSha) {
      throw new CommandRejectedError(
        "ERR-SOURCE-PIN",
        `sourceRefs[${index}] must pin ID@revision or a content hash`,
      );
    }
    const pin: RegisteredSourcePin = {};
    if (hasId) {
      pin.artifactId = artifactId as string;
      pin.revision = revision as number;
    }
    if (hasSha) {
      pin.sha256 = sha256 as string;
    }
    return pin;
  });
}

// KC-04 B1: "nơi lưu" của tiêu chí 2 — tham chiếu bất biến tới nội dung
// artifact (đường dẫn kho, object key…). Tùy chọn khi đăng ký để giữ tương
// thích event cũ; chuỗi truy vết chức năng mẫu yêu cầu nó có mặt (B2/B4).
export function parseStorageRef(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new CommandRejectedError("ERR-STORAGE-REF", "storageRef must be a non-empty string");
  }
  return raw;
}
