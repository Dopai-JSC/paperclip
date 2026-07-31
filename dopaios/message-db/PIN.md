# Blueprint message-db — bản chép có pin

Thư mục này chép nguyên trạng `database/` (schema, tables, types, functions,
indexes, views, privileges, roles, script cài đặt và update) cùng
`MIT-License.txt` và `VERSION.txt` từ upstream, phục vụ KC-01 theo Phụ lục A
của kế hoạch kiểm chứng (vai Tham khảo, phương án B: chép schema/function vào
repo và tự sở hữu migration vì upstream ngủ đông).

| Trường | Giá trị |
|---|---|
| Upstream | <https://github.com/message-db/message-db> |
| Commit pin | `25da82b044f94416202ac3daa1866791b385badc` (HEAD nhánh mặc định lúc chép) |
| Tag gần nhất | `v1.3.0` = `e6999a6bd95ace6e8d70ec62a00c66b27ce8bf3b` (VERSION.txt ghi 1.3.0) |
| Ngày chép | 31/07/2026 |
| Cách chép | `git clone` rồi copy nguyên `database/` — không sửa nội dung |
| License | MIT (`MIT-License.txt`) |

Quy ước sở hữu: từ thời điểm chép, mọi thay đổi schema/function của event store
Dopaios được thực hiện bằng migration do Dopai viết trong khu vực migration
Dopai (vùng 0500+, xem hồ sơ 09 Bước nền), không sửa trực tiếp các file trong
thư mục này; thư mục này giữ vai bản đối chiếu với upstream.
