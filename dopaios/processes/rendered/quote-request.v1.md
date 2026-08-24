<!-- BẢN DIỄN GIẢI — SINH TỰ ĐỘNG, KHÔNG SỬA TAY -->

> **BẢN DIỄN GIẢI (ADR-010).** Tài liệu này được sinh tự động từ file
> định nghĩa `quote-request.v1.json` (sha256 `6770e09423675f520313e9cc12ba900e485fb5fa202479f683ff14dc85238fdd`).
> File định nghĩa là nguồn chân lý THỰC THI của quy trình; muốn đổi quy
> trình thì sửa file định nghĩa qua review rồi sinh lại bản này — không
> sửa bản diễn giải. CI kiểm đồng bộ: bản này lệch với file định nghĩa
> là build đỏ. Chừng nào ADR-010 còn In review, văn bản SOP hiện hành
> (repo dopaios, docs/sop/) vẫn là nguồn chân lý NGHIỆP VỤ.

# SOP Báo giá tham chiếu

- **ID:** `quote-request` — revision 1
- **Schema:** `1.0`
- **Nguồn thẩm quyền (sourceAuthority):** `business-text`
- **Trạng thái khởi đầu:** `prepare-quote`
- **Input:**
  - `requester`
  - `scope`
  - `source`
  - `assumptions`
  - `due-date`
- **Output:**
  - `scope`
  - `exclusions`
  - `price-or-estimate`
  - `assumptions`
  - `validity`
  - `source-trace`
- **Runtime contract:**
  - `versioned-definition`
  - `work-item`
  - `decision-request`
  - `output-version`
  - `approval-record`
  - `audit`
  - `invalidation`

## Các trạng thái

### `prepare-quote`

- **Loại:** `automatic`
- **Actor:** `ai-staff`
- **Hoạt động:** prepare-quote
- **Guard kích hoạt:**
  - `input.requester.present`
  - `input.scope.present`
  - `input.source.present`
  - `input.assumptions.present`
  - `input.due-date.present`
- **Input:**
  - `quote-request`
  - `quality-contract`
- **Output:**
  - `quote-draft`
- **Bằng chứng:**
  - `quote-draft`
  - `source-trace`
  - `quality-contract`
- **Khi hoàn tất →** `independent-review`

### `independent-review`

- **Loại:** `automatic`
- **Actor:** `ai-reviewer`
- **Hoạt động:** independent-review
- **Guard kích hoạt:**
  - `quote-draft.submitted`
- **Input:**
  - `quote-draft`
  - `quality-contract`
- **Output:**
  - `review-evidence`
- **Bằng chứng:**
  - `review-evidence`
- **Khi hoàn tất →** `orchestrator-decision`

### `orchestrator-decision`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Guard kích hoạt:**
  - `independent-review.passed`
- **Input:**
  - `quote-draft`
  - `review-evidence`
  - `decision-package`
- **Bằng chứng:**
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `approve` → `completed`
  - `reject` → `rejected`
  - `request-rework` → `prepare-quote`
- **Hiệu ứng quyết định:** `{"approve":["output.approve"],"reject":["output.reject"],"request-rework":["output.create-successor-revision"]}`

### `completed`

- **Loại:** `final`

### `rejected`

- **Loại:** `final`

