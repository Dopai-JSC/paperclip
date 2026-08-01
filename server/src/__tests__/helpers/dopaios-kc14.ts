import type { Db } from "../../dopaios/event-store.ts";
import { registerApprovedArtifact } from "../../dopaios/commands.ts";
import {
  registerQualityContract,
  qualityContractContentSha256,
  type QualityContractRef,
} from "../../dopaios/lifecycle.ts";

// KC-14: seed một Hợp đồng chất lượng ĐÃ DUYỆT theo đúng đường QD-2 — hàng
// đăng ký bootstrap của sổ artifact FS-002 (loại quality-contract, approved,
// sha256 = hash nội dung canonical) + projection nội dung. Suites cũ
// (KC-01/KC-03/KC-13) dùng helper này khi chuỗi đầu ra phân rã của KC-14 đòi
// pin hợp đồng — chỉ thêm seed, không đổi hành vi được kiểm.
export async function seedApprovedQualityContract(
  db: Db,
  opts: {
    id: string;
    revision?: number;
    outputType: string;
    requiredChecks: string[];
    cmdPrefix: string;
    registeredBy?: string;
  },
): Promise<QualityContractRef> {
  const revision = opts.revision ?? 1;
  const sha256 = qualityContractContentSha256({
    outputType: opts.outputType,
    requiredChecks: opts.requiredChecks,
  });
  await registerApprovedArtifact(db, `${opts.cmdPrefix}-QC-LEDGER-${opts.id}-r${revision}`, {
    artifactId: opts.id,
    revision,
    sha256,
    artifactType: "quality-contract",
  });
  await registerQualityContract(db, `${opts.cmdPrefix}-QC-CONTENT-${opts.id}-r${revision}`, {
    contractId: opts.id,
    revision,
    outputType: opts.outputType,
    requiredChecks: opts.requiredChecks,
    registeredBy: opts.registeredBy ?? "ORCH-1",
  });
  return { id: opts.id, revision, sha256 };
}
