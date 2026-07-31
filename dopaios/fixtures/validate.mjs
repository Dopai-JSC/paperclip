#!/usr/bin/env node
// Validator danh mục fixture chuẩn tắc dùng chung (V-09).
// Chạy: node dopaios/fixtures/validate.mjs
// Kiểm: cấu trúc catalog, hash sha256 của mọi thành phần, ràng buộc nội bộ
// (reviewer khác executor, độ phủ AC-FR-24.3, disposition cutover, replay case…).

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
}
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function loadJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}
const HEX64 = /^[0-9a-f]{64}$/;

// 1. Catalog và 5 file nhóm
const catalog = loadJson('catalog.json');
check('catalog: đúng 5 nhóm', catalog.groups.length === 5, `groups=${catalog.groups.length}`);
const groups = {};
for (const g of catalog.groups) {
  const exists = existsSync(join(ROOT, g.file));
  check(`catalog: file nhóm ${g.id} tồn tại`, exists, g.file);
  if (exists) groups[g.id] = loadJson(g.file);
}
check(
  'catalog: pin đủ 6 nguồn chuẩn tắc (FS-001/002/003, PRD, SOP, kế hoạch KC)',
  catalog.source_pins.length === 6 && catalog.source_pins.every((p) => /^[0-9a-f]{40}$/.test(p.git_blob_sha1))
);

// 2. Hash mọi thành phần của mọi nhóm
for (const [gid, g] of Object.entries(groups)) {
  for (const c of g.components ?? []) {
    const p = join(ROOT, c.path);
    if (!existsSync(p)) {
      check(`${gid}: thành phần ${c.path} tồn tại`, false);
      continue;
    }
    check(`${gid}: hash khớp ${c.path}`, HEX64.test(c.sha256) && sha256(p) === c.sha256);
  }
}

// 3. FX-01: template pin khớp seed; 14 ca, ID duy nhất
{
  const g = groups['FX-01'];
  const seedHash = sha256(join(ROOT, 'content/seed-bootstrap-template.json'));
  check('FX-01: base_command pin đúng hash seed template', g.base_command.template_ref.sha256 === seedHash);
  const ids = g.cases.map((c) => c.case_id);
  check('FX-01: 14 ca, case_id duy nhất', ids.length === 14 && new Set(ids).size === 14, `cases=${ids.length}`);
  check(
    'FX-01: có ca khóa cửa PREPARING (SFR-003) và ca REC-001',
    ids.includes('FX-01-C13') && ids.includes('FX-01-C14')
  );
}

// 4. FX-02: reviewer khác executor; review evidence ready + độc lập; đủ thành phần bản sửa
{
  const g = groups['FX-02'];
  for (const rel of ['content/t1-review-evidence-rev1.json', 'content/t1-review-evidence-rev2.json']) {
    const re = loadJson(rel);
    check(`FX-02: ${rel} — reviewer khác executor`, re.reviewer !== g.fixture_package.executor);
    check(
      `FX-02: ${rel} — kết luận ready, độc lập pass`,
      re.conclusion === 'ready' &&
        re.independence_check.result === 'pass' &&
        re.independence_check.created_or_modified_target === false &&
        re.independence_check.conflicting_binding === false
    );
  }
  check('FX-02: gói fixture đủ 4 thành phần bản sửa', g.fixture_package.revision_components.length === 4);
  check('FX-02: chuỗi happy 10 bước', g.happy_chain.length === 10, `steps=${g.happy_chain.length}`);
  check('FX-02: 15 ca âm', g.negative_cases.length === 15, `neg=${g.negative_cases.length}`);
  check('FX-02: khai đủ 7 loại trạng thái cho replay (SQR-003)', g.seven_state_types_for_replay.length === 7);
  const re1 = loadJson('content/t1-review-evidence-rev1.json');
  const out1 = sha256(join(ROOT, 'content/t1-output-rev1.md'));
  check('FX-02: Review Evidence rev1 pin đúng hash đầu ra rev1', re1.targets[0].sha256 === out1);
  const re2 = loadJson('content/t1-review-evidence-rev2.json');
  const out2 = sha256(join(ROOT, 'content/t1-output-rev2.md'));
  check('FX-02: Review Evidence rev2 pin đúng hash đầu ra rev2', re2.targets[0].sha256 === out2);
}

// 5. FX-03: đúng danh sách điểm; Gate Record chỉ A/B/C; đủ ca chặn
{
  const g = groups['FX-03'];
  const required = [
    'P0-01', 'P0-05', 'P1-10', 'INPUT-DISPOSITION', 'PILOT-CUTOVER',
    'B0-12', 'B1-08', 'B2-06', 'B3-04', 'R-03', 'ROLLBACK-CONDITIONAL',
    'T-03', 'P3-06', 'P4-03',
  ];
  const ids = g.approval_points.map((p) => p.point_id);
  check(
    'FX-03: phủ đúng danh sách AC-FR-24.3 + P0-01 (14 điểm, không thừa không thiếu)',
    ids.length === required.length && required.every((r) => ids.includes(r)),
    ids.join(',')
  );
  const gates = g.approval_points.filter((p) => p.gate_record === true).map((p) => p.point_id).sort();
  check('FX-03: Gate Record chỉ tại B0-12/B1-08/B2-06', JSON.stringify(gates) === JSON.stringify(['B0-12', 'B1-08', 'B2-06']));
  check('FX-03: P0-01 là hành động trực tiếp (AC-FR-24.2)', g.approval_points.find((p) => p.point_id === 'P0-01').direct_action === true);
  check('FX-03: 12 ca chặn, có ca một-người-nhiều-capability', g.blocking_cases.length === 12 && g.blocking_cases.some((c) => c.case_id === 'FX-03-B03'));
  check('FX-03: đủ 4 outcome chuẩn', g.outcome_contract.standard_outcomes.length === 4);
}

// 6. FX-04: tái dùng đúng thành phần FX-02
{
  const g = groups['FX-04'];
  check('FX-04: khai tái dùng thành phần FX-02', typeof g.reuses_components_of === 'string' && g.reuses_components_of.includes('FX-02'));
  check('FX-04: kịch bản 5 bước + 6 assertion', g.scenario.length === 5 && g.assertions.length === 6);
}

// 7. FX-05: plan pin khớp; disposition hợp lệ; replay case; chuỗi rollback
{
  const g = groups['FX-05'];
  const plan = loadJson('content/cutover-plan.json');
  check('FX-05: plan pin đúng hash feature spec sim', plan.pins.feature_spec.sha256 === sha256(join(ROOT, 'content/cutover-feature-spec-sim.md')));
  check('FX-05: plan pin đúng hash plan sim', plan.pins.plan.sha256 === sha256(join(ROOT, 'content/cutover-plan-doc-sim.md')));
  check('FX-05: plan pin đúng hash tasks sim', plan.pins.tasks.sha256 === sha256(join(ROOT, 'content/cutover-tasks-sim.md')));
  check('FX-05: plan pin đúng hash snapshot', plan.source_inventory_snapshot.sha256 === sha256(join(ROOT, 'content/cutover-source-snapshot-sim.json')));
  const dispositions = plan.open_states.map((s) => s.disposition);
  check(
    'FX-05: mỗi trạng thái mở đúng một disposition imported|closed|deferred (đủ cả ba loại)',
    plan.open_states.length === 3 &&
      dispositions.every((d) => ['imported', 'closed', 'deferred'].includes(d)) &&
      new Set(dispositions).size === 3
  );
  const deferred = plan.open_states.find((s) => s.disposition === 'deferred');
  check('FX-05: deferred có owner–due–guard', Boolean(deferred.owner && deferred.due && deferred.guard));
  check('FX-05: có rollback_condition và rollback_target', Boolean(plan.rollback_condition && plan.rollback_target));
  check('FX-05: approval fixture pin đúng hash plan', g.approval_fixture.target.sha256 === sha256(join(ROOT, 'content/cutover-plan.json')));
  const ids = g.cases.map((c) => c.case_id);
  check('FX-05: 10 ca, gồm replay AC-V1-10 (C06) và ca âm từng tiền điều kiện (C01-C03)', ids.length === 10 && ['FX-05-C01', 'FX-05-C02', 'FX-05-C03', 'FX-05-C06'].every((x) => ids.includes(x)));
  const recon = loadJson('content/cutover-reconciliation-mapping.json');
  check('FX-05: reconciliation pin revision rolled-back, có residual owner–due–guard', recon.pins_cutover_record.state === 'rolled-back' && recon.residuals.every((r) => r.action_owner && r.due && r.guard));
}

// 8. Nhãn test trên mọi nhóm
for (const [gid, g] of Object.entries(groups)) {
  check(`${gid}: nhãn test`, g.label === 'test');
}

// Tổng kết
const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
}
console.log(`\n${failed.length === 0 ? 'FIXTURE CATALOG PASS' : 'FIXTURE CATALOG FAIL'} — ${results.length - failed.length}/${results.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
