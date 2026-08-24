// Lint ranh giới import core/–drills/ của tầng Dopaios (mẫu hiện thực số 13):
//   - core/** không import drills/** và không import routes/;
//   - routes/**, index.ts, app.ts chỉ import core/** trong vùng dopaios;
//   - drills/** được import core/** (không cần rule).
// Cấu hình tối thiểu có chủ đích: chỉ rule no-restricted-imports, không bật
// bộ rule style nào — kiểm tra kiểu đã có tsc, format giữ nguyên hiện trạng.
import tseslint from "typescript-eslint";

// Đăng ký plugin (không bật rule nào) để các directive eslint-disable
// `@typescript-eslint/*` sẵn có trong code upstream không thành lỗi
// "rule not found"; tắt báo directive thừa để không phải sửa code upstream.
const shared = {
  plugins: { "@typescript-eslint": tseslint.plugin },
  linterOptions: { reportUnusedDisableDirectives: "off" },
};

export default [
  {
    ...shared,
    files: ["server/src/dopaios/core/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/drills/**"],
              message:
                "core/ không được import drills/ — mã diễn tập KC không phải nền production (mẫu 13).",
            },
            {
              group: ["**/routes/**"],
              message: "core/ không được import routes/ — chiều phụ thuộc là routes → core (mẫu 13).",
            },
          ],
        },
      ],
    },
  },
  {
    ...shared,
    files: ["server/src/routes/**/*.ts", "server/src/index.ts", "server/src/app.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/dopaios/drills/**", "**/dopaios/*.js", "**/dopaios/*.ts"],
              message:
                "routes/index/app chỉ được import dopaios/core/** — không drills/, không file rời ngoài core (mẫu 13).",
            },
          ],
        },
      ],
    },
  },
];
