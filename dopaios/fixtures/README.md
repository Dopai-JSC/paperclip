# Danh mục fixture chuẩn tắc dùng chung — đợt 1 Pha kiểm chứng kiến trúc Dopaios (V-09)

Thư mục này do Dopai sở hữu (không thuộc upstream paperclip). Nó chứa danh mục fixture
chuẩn tắc dùng chung một lần cho các KC của đợt 1 theo kế hoạch kiểm chứng revision 4
(hồ sơ V-09 tại `docs/architecture/verification/evidence/fixtures/` của repo dopaios).

## Bố cục

- `catalog.json` — danh mục 5 nhóm fixture, pin nguồn chuẩn tắc bằng git-sha1 blob.
- `fx-01-none-preparing.json` — transition `NONE → PREPARING` và bất biến `PREPARING`
  (FS-001) — phục vụ KC-01, KC-13.
- `fx-02-run-test-chain.json` — chuỗi run test chuẩn tắc của FS-003 (walking skeleton)
  — phục vụ KC-01, KC-03, KC-13, KC-14.
- `fx-03-ac-fr-24-3.json` — danh sách điểm phê duyệt đúng AC-FR-24.3 (+ P0-01 theo
  AC-FR-24.2) và hợp đồng outcome — phục vụ KC-03, KC-17.
- `fx-04-fail-then-fix.json` — ca "một bản nộp không đạt → bản sửa đạt" (AC-V1-03) —
  phục vụ KC-14, KC-01, KC-03.
- `fx-05-cutover-sim.json` — fixture cutover bootstrap→runtime giả lập (AC-V1-10) —
  phục vụ KC-17, KC-03.
- `content/` — các file nội dung được pin hash (đầu ra test, self-check, Review
  Evidence, phiên review, định nghĩa SOP test, hồ sơ cutover giả lập…).
- `validate.mjs` — validator của danh mục.

## Quy ước hash

- Thành phần fixture pin **sha256 hex trên đúng byte** của file trong repo.
- `.gitattributes` của thư mục đặt `* -text` để git không đổi line ending — byte ổn
  định trên cả Windows và WSL2, hash tái hiện được ở mọi môi trường.
- Nguồn chuẩn tắc (FS-001/002/003, PRD, SOP, kế hoạch kiểm chứng) pin bằng git-sha1
  blob đúng quy ước repo dopaios; các blob này kiểm lại được bằng `git hash-object`
  trong repo dopaios.

## Chạy validator

```bash
node dopaios/fixtures/validate.mjs
```

Exit code 0 và dòng cuối `FIXTURE CATALOG PASS` nghĩa là danh mục nhất quán: mọi
thành phần đúng hash, reviewer khác executor, đủ danh sách AC-FR-24.3, disposition
cutover hợp lệ và có ca replay AC-V1-10.

## Luật sử dụng

1. Đây là danh mục **chuẩn tắc dùng chung**: các KC không tự chế fixture thay thế cho
   các ca đã có ở đây; thiếu ca thì bổ sung vào danh mục (sửa file + chạy lại
   validator + cập nhật hồ sơ V-09 trong repo dopaios), không tạo bản sao lệch.
2. Mọi record sinh từ fixture mang nhãn `test` không thể gỡ và không được tính vào
   sản lượng hay evidence production (FS-003 US2-AC6). Fixture và kết quả KC không
   phải bằng chứng chạy SOP.
3. Deviation register DEV-001…017 của FS-003 chỉ áp cho record nhãn `test`; ngoài
   bảng đó, record phải thỏa nguyên trạng hợp đồng đã pin.
4. `content/seed-bootstrap-template.json` là bản mô phỏng seed theo PRD Mục 6.1
   (d.316) cho môi trường spike; blob chuẩn tắc của seed do FS-001 pin khi implement.
