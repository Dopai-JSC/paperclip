# SOP nghiệp vụ test — SOP-TEST-001

Tài liệu nghiệp vụ của SOP test tối thiểu dùng cho fixture chuỗi run test (FS-003 US1).
Tài liệu này được đăng ký và duyệt trong sổ cái FS-002 như một artifact được kiểm soát
trước khi tạo định nghĩa SOP runtime.

Ba bước:

1. **T1 — Tạo đầu ra test** (bước sản xuất): executor tạo một đầu ra loại `test-output`
   theo Hợp đồng chất lượng TEST-QC-001; nộp kèm bằng chứng self-check; review độc lập
   bắt buộc, reviewer khác executor.
2. **T2 — Điểm phê duyệt**: người quyết định của run quyết định trên phiên bản đầu ra
   hiện hành của T1. Kết quả nghiệp vụ được phép: đạt; yêu cầu sửa (tái nhập T1);
   từ chối; chấp nhận ngoại lệ. Yêu cầu bổ sung thông tin luôn khả dụng. T2 không phải
   Cổng A/B/C — không có Gate Record.
3. **T3 — Đóng run** (bước máy-kiểm được): chỉ mở khi T2 có Approval Record còn hiệu
   lực; run hoàn tất khi mọi bước, điểm quyết định và nghĩa vụ bắt buộc có terminal
   disposition.

Điều kiện tự động bắt đầu: một yêu cầu chạy thử hợp lệ theo Hợp đồng đầu vào của lệnh
`request-test-run` (FS-003).

Hợp đồng chất lượng TEST-QC-001 cho loại đầu ra `test-output`: nội dung đúng hash đã
pin trong gói fixture; có self-check của executor; có Review Evidence độc lập kết luận
`ready` với reviewer khác executor; đủ hai mục nội dung bắt buộc "Mục A" và "Mục B".
