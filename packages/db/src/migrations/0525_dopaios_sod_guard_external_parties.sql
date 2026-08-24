-- ADR-031 (vùng migration Dopai 0500+): guard điều kiện tắt của ngoại lệ SoD
-- một-người-vận-hành cần thuộc tính "Project có bên ngoài" trên projection
-- dopaios_projects. Cột nullable CÓ CHỦ ĐÍCH: NULL nghĩa là "không xác định
-- được thuộc tính có-bên-ngoài" — theo spec guard (Approval Record closure
-- wave 2, 20/08/2026), một Project đang active chưa khai thuộc tính này làm
-- ngoại lệ local-board tự vô hiệu (fail-closed). Khai báo đi qua command
-- declareProjectExternalParties (event ProjectExternalPartiesDeclared) —
-- nguồn sự thật là event log, cột dưới đây chỉ là projection đọc.

ALTER TABLE "dopaios_projects" ADD COLUMN "has_external_parties" boolean;
