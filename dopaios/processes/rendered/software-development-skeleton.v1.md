<!-- BẢN DIỄN GIẢI — SINH TỰ ĐỘNG, KHÔNG SỬA TAY -->

> **BẢN DIỄN GIẢI (ADR-010).** Tài liệu này được sinh tự động từ file
> định nghĩa `software-development-skeleton.v1.json` (sha256 `8e93079265454c9fab5700fc9e335560bb2ab3524d2637887e7ecbdc0313d1a4`).
> File định nghĩa là nguồn chân lý THỰC THI của quy trình; muốn đổi quy
> trình thì sửa file định nghĩa qua review rồi sinh lại bản này — không
> sửa bản diễn giải. CI kiểm đồng bộ: bản này lệch với file định nghĩa
> là build đỏ. Chừng nào ADR-010 còn In review, văn bản SOP hiện hành
> (repo dopaios, docs/sop/) vẫn là nguồn chân lý NGHIỆP VỤ.

# Skeleton SOP Phát triển phần mềm P0–P4

- **ID:** `software-development-skeleton` — revision 1
- **Schema:** `1.0`
- **Nguồn thẩm quyền (sourceAuthority):** `business-text`
- **Trạng thái khởi đầu:** `p0-initiation`

## Các trạng thái

### `p0-initiation`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `project-initiation-request`
  - `team-manifest-bootstrap`
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `approve` → `p0-source-review`
  - `reject` → `terminated`

### `p0-source-review`

- **Loại:** `automatic`
- **Actor:** `ai-spec`
- **Hoạt động:** project-source-review
- **Bằng chứng:**
  - `input-package`
  - `intake-review-record`
- **Khi hoàn tất →** `p0-charter`

### `p0-charter`

- **Loại:** `automatic`
- **Actor:** `ai-lead`
- **Hoạt động:** project-charter-drafting
- **Bằng chứng:**
  - `project-charter`
- **Khi hoàn tất →** `p0-independent-review`

### `p0-independent-review`

- **Loại:** `automatic`
- **Actor:** `ai-reviewer`
- **Hoạt động:** project-opening-review
- **Bằng chứng:**
  - `review-evidence`
  - `decision-package`
- **Khi hoàn tất →** `p0-open-decision`

### `p0-open-decision`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `approve` → `p1-baseline`
  - `reject` → `p0-charter`

### `p1-baseline`

- **Loại:** `automatic`
- **Actor:** `ai-lead`
- **Hoạt động:** product-baseline-preparation
- **Bằng chứng:**
  - `product-baseline`
  - `team-manifest-delivery`
  - `release-roadmap`
- **Khi hoàn tất →** `p1-independent-review`

### `p1-independent-review`

- **Loại:** `automatic`
- **Actor:** `ai-reviewer`
- **Hoạt động:** product-baseline-review
- **Bằng chứng:**
  - `review-evidence`
  - `decision-package`
- **Khi hoàn tất →** `p1-baseline-decision`

### `p1-baseline-decision`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `approve` → `b0-spec-design`
  - `reject` → `p1-baseline`

### `b0-spec-design`

- **Loại:** `automatic`
- **Actor:** `ai-spec`
- **Hoạt động:** release-spec-design
- **Bằng chứng:**
  - `release-spec-baseline`
  - `design-evidence`
- **Khi hoàn tất →** `gate-a`

### `gate-a`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `gate-a-record`
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `approve` → `b1-build`
  - `reject` → `b0-spec-design`

### `b1-build`

- **Loại:** `automatic`
- **Actor:** `ai-build`
- **Hoạt động:** release-build
- **Bằng chứng:**
  - `build-output`
  - `self-check`
  - `independent-review`
- **Khi hoàn tất →** `gate-b`

### `gate-b`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `gate-b-record`
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `approve` → `b2-test`
  - `reject` → `b1-build`

### `b2-test`

- **Loại:** `automatic`
- **Actor:** `ai-test`
- **Hoạt động:** release-verification
- **Bằng chứng:**
  - `test-evidence`
  - `nfr-evidence`
  - `independent-review`
- **Khi hoàn tất →** `gate-c`

### `gate-c`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `gate-c-record`
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `approve` → `b3-acceptance`
  - `reject` → `b2-test`

### `b3-acceptance`

- **Loại:** `human-decision`
- **Actor:** `pod`
- **Bằng chứng:**
  - `uat-evidence`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `accepted` → `go-no-go`
  - `rework` → `b1-build`

### `go-no-go`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `go-no-go-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `go` → `release`
  - `no-go` → `b1-build`

### `release`

- **Loại:** `human-decision`
- **Actor:** `pod`
- **Bằng chứng:**
  - `release-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `released` → `post-release-verification`
  - `failed` → `b1-build`

### `post-release-verification`

- **Loại:** `automatic`
- **Actor:** `ai-test`
- **Hoạt động:** post-release-verification
- **Bằng chứng:**
  - `post-release-evidence`
- **Khi hoàn tất →** `release-review`

### `release-review`

- **Loại:** `automatic`
- **Actor:** `ai-reviewer`
- **Hoạt động:** release-review
- **Bằng chứng:**
  - `release-review-record`
- **Khi hoàn tất →** `release-continuation-decision`

### `release-continuation-decision`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `release-review-record`
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `next-release` → `b0-spec-design`
  - `scope-complete` → `p3-handover`

### `p3-handover`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `handover-record`
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `approve` → `p4-close`
  - `rework` → `release-review`

### `p4-close`

- **Loại:** `human-decision`
- **Actor:** `orchestrator`
- **Bằng chứng:**
  - `project-closure-record`
  - `approval-record`
- **Các quyết định (điểm chờ NGƯỜI — máy không tự vượt):**
  - `close` → `completed`
  - `reopen` → `p3-handover`

### `completed`

- **Loại:** `final`

### `terminated`

- **Loại:** `final`

