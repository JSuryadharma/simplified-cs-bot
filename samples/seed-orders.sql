SELECT bot_api.upsert_order(
  'DEMO-1001',
  '628111111111',
  'Budi Demo',
  'diproses',
  '[{"name":"Kopi Arabika 250g","qty":2,"price":85000}]'::jsonb,
  170000,
  15000,
  'Jakarta',
  NULL,
  'Kirim sore hari',
  now()
);

SELECT bot_api.upsert_order(
  'DEMO-1002',
  '628222222222',
  'Siti Demo',
  'dikirim',
  '[{"name":"Teh Melati 100g","qty":1,"price":45000}]'::jsonb,
  45000,
  12000,
  'Bandung',
  'JX123456789',
  NULL,
  now() - interval '1 hour'
);

