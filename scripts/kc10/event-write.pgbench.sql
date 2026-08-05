SELECT message_store.write_message(
  gen_random_uuid()::text,
  'kc10-benchmark-' || (:client_id)::text,
  'Kc10BenchmarkEvent',
  jsonb_build_object('clientId', :client_id, 'nonce', gen_random_uuid()::text),
  jsonb_build_object('runId', 'KC10-MEASURE-CHROME150-001'),
  NULL::bigint
);
