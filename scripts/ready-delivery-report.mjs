// Local, read-only operator report. One prepared answer is anchored to the
// first admitted message of its batch. Resends retain that same operation.
import Database from 'better-sqlite3';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function readyDeliveryReport(db, since, until) {
  const tasks = db.prepare(`
    WITH ready AS (
      SELECT scope_key, operation_id, min(finished_at) AS ready_at
      FROM operation_trace_spans
      WHERE stage='final_ready' AND status='succeeded' AND operation_id IS NOT NULL
      GROUP BY scope_key, operation_id
    )
    SELECT o.created_at, r.ready_at,
      (SELECT min(d.finished_at) FROM operation_trace_attempt_inputs i
       JOIN operation_trace_spans d ON d.scope_key=i.scope_key AND d.attempt_id=i.attempt_id
       WHERE i.scope_key=o.scope_key AND i.operation_id=o.operation_id AND d.stage='delivery'
         AND d.status='succeeded' AND json_extract(d.details_json,'$.reason')='api_acknowledged'
         AND d.finished_at BETWEEN o.created_at AND ?) AS early_ack,
      (SELECT min(s.finished_at) FROM operation_trace_spans s
       WHERE s.scope_key=o.scope_key AND s.operation_id=o.operation_id
         AND s.stage='saved_final_ack' AND s.status='succeeded' AND s.finished_at<=?) AS final_ack,
      (SELECT count(*) FROM operation_trace_spans s
       WHERE s.scope_key=o.scope_key AND s.operation_id=o.operation_id
         AND s.stage='saved_final_retry' AND s.started_at<=?) AS retries
    FROM ready r JOIN operation_trace_operations o USING(scope_key,operation_id)
    WHERE o.created_at BETWEEN ? AND ? AND r.ready_at<=?
  `).all(until, until, until, since, until, until);
  const timing = key => {
    const values = tasks.flatMap(task => {
      const stamps = key === 'first_ack' ? [task.early_ack, task.final_ack] : [task[key]];
      const observed = stamps.filter(value => value != null);
      return observed.length ? [Math.min(...observed) - task.created_at] : [];
    }).sort((a,b) => a-b);
    const percentile = q => values.length ? values[Math.ceil(values.length*q)-1] : null;
    return { measured: values.length, medianMs: percentile(0.5), p95Ms: percentile(0.95) };
  };
  return { readyTasks: tasks.length, firstAcknowledgement: timing('first_ack'),
    answerReady: timing('ready_at'), finalAcknowledgement: timing('final_ack'),
    withoutFinalAcknowledgement: tasks.filter(t => t.final_ack == null).length,
    retryAttempts: tasks.reduce((sum,t) => sum+t.retries,0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('node scripts/ready-delivery-report.mjs [database] [since-ISO] [until-ISO]. Defaults to the last seven days. Measures saved owner finals with observed readiness, from first input to first observed channel acknowledgement, readiness and final acknowledgement.');
  } else {
    const until = process.argv[4] ? Date.parse(process.argv[4]) : Date.now();
    const since = process.argv[3] ? Date.parse(process.argv[3]) : until-7*86400_000;
    if (!Number.isFinite(since) || !Number.isFinite(until) || since>until) throw Error('Invalid time window');
    const db = new Database(process.argv[2] ?? 'store/messages.db',{readonly:true,fileMustExist:true});
    try { console.log(JSON.stringify(readyDeliveryReport(db,since,until),null,2)); }
    finally { db.close(); }
  }
}
