# KC-02 B9 — spike DBOS Transact coexistence (tùy chọn)

Project scratch độc lập (KHÔNG thuộc pnpm workspace của fork) pin
`@dbos-inc/dbos-sdk@4.24.16` exact. Tiêu chí duy nhất theo kế hoạch kiểm
chứng r4: DBOS không xung đột event store.

Chạy:

```sh
npm ci
DATABASE_URL='postgres://paperclip:paperclip-spike@localhost:5433/dopaios_kc02' node b9.mjs
```

Kỳ vọng: `B9-WORKFLOW-RESULT {"events":<số event hiện có>,"probeRows":…}`,
`APPDB-SCHEMAS=dbos,drizzle,message_store,public`, `B9-DONE`; sau đó chạy
`b7-cli-workitem.ts report` phải in `REPLAY-IDENTICAL=true`. Kết quả thật
31/07/2026 trong hồ sơ KC-02 (log `~/spike/kc02-b9.log`).
