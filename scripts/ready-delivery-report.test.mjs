import Database from 'better-sqlite3';
import { it, expect } from 'vitest';
import { readyDeliveryReport } from './ready-delivery-report.mjs';

it('counts an answer once across a lost acknowledgement and resend, and preserves unknown delivery', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`
      CREATE TABLE operation_trace_operations(scope_key,operation_id,created_at);
      CREATE TABLE operation_trace_attempt_inputs(scope_key,operation_id,attempt_id);
      CREATE TABLE operation_trace_spans(scope_key,operation_id,attempt_id,stage,status,started_at,finished_at,details_json);
      INSERT INTO operation_trace_operations VALUES ('a','m1',100),('b','m2',100);
      INSERT INTO operation_trace_attempt_inputs VALUES ('a','m1','attempt');
      INSERT INTO operation_trace_spans VALUES
        ('a',NULL,'attempt','delivery','succeeded',110,120,'{"reason":"api_acknowledged"}'),
        ('a','m1',NULL,'final_ready','succeeded',130,130,'{}'),
        ('a','m1',NULL,'saved_final_retry','succeeded',160,160,'{}'),
        ('a','m1',NULL,'saved_final_ack','succeeded',170,170,'{}'),
        ('b','m2',NULL,'final_ready','succeeded',150,150,'{}');
    `);
    const summary=readyDeliveryReport(db,100,200);
    expect(summary.readyTasks).toBe(2);
    expect(summary.firstAcknowledgement).toEqual({ measured:1,medianMs:20,p95Ms:20 });
    expect(summary.answerReady).toEqual({ measured:2,medianMs:30,p95Ms:50 });
    expect(summary.finalAcknowledgement.medianMs).toBe(70);
    expect(summary.withoutFinalAcknowledgement).toBe(1);
    expect(summary.retryAttempts).toBe(1);
    expect(readyDeliveryReport(db,100,155).retryAttempts).toBe(0);
  } finally { db.close(); }
});
