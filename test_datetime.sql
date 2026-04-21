-- Test what happens when you apply datetime() to an ISO string
SELECT 
  '2025-06-01T23:00:00.000Z' as raw_iso,
  datetime('2025-06-01T23:00:00.000Z') as plain_datetime,
  datetime('2025-06-01T23:00:00.000Z', 'localtime') as with_localtime,
  datetime('2025-06-01T23:00:00.000Z', 'localtime', '-6 hours') as with_offset;
