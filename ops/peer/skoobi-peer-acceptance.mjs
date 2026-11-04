import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateRead, privateDirectory, atomicWrite, sha256 } from './skoobi-peer-core.mjs';
import { canonicalJson, contentHash, validatePeerContract, validOutputName } from './skoobi-peer-contract.mjs';

const MAX_TEXT = 1024 * 1024;

/** The host checks exact transferred bytes. A worker's prose is never a proof. */
export function peerResultDigest(remote, artifacts) {
  return contentHash({
    state: remote.state,
    result: remote.result || null,
    deliveries: (remote.deliveries || []).map(({kind, text}) => ({kind, text})),
    artifacts: artifacts.map(({name, displayName, sha256, bytes, kind}) =>
      ({name, displayName: displayName || name, sha256, bytes, kind})),
  });
}

function verifiedArtifacts(artifacts, limit) {
  if (!Array.isArray(artifacts) || artifacts.length > 20) throw Error('artifact_count');
  const outputs = new Map();
  let total = 0;
  for (const a of artifacts) {
    const name = a.displayName || a.name;
    if (!validOutputName(name) || outputs.has(name) || !/^[a-f0-9]{64}$/.test(a.sha256 || '') ||
        !Number.isSafeInteger(a.bytes) || a.bytes < 0 || a.bytes > limit ||
        !path.isAbsolute(a.localPath || '')) throw Error('artifact_manifest_invalid');
    const bytes = privateRead(a.localPath, limit);
    if (bytes.length !== a.bytes || sha256(bytes) !== a.sha256) throw Error('artifact_changed');
    total += bytes.length;
    if (total > limit) throw Error('artifact_total_limit');
    outputs.set(name, {artifact: a, bytes});
  }
  return outputs;
}

function decodeText(bytes) {
  if (bytes.length > MAX_TEXT) throw Error('text_limit');
  const decoded = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  if (decoded.includes('\0')) throw Error('text_binary');
  return decoded;
}

/** A fixed isolated copy + existing checker, not an attestation of remote authorship. */
export async function recheckPeerArtifact(c, artifact, scenario, payload, jobDirectory) {
  if (!scenario || typeof scenario !== 'object') return {status:'inconclusive', code:'scenario_missing'};
  let result;
  try {
    const { runIsolatedArtifactJob } = await import(pathToFileURL(path.join(c.projectRoot, 'packages/core/dist/orchestrator/artifact-job.js')));
    const { defaultArtifactAcceptanceHost, validateArtifactAcceptanceRequirements } =
      await import(pathToFileURL(path.join(c.projectRoot, 'packages/core/dist/orchestrator/artifact-acceptance.js')));
    let requirements = structuredClone(scenario);
    const inputs = [{sourcePath: artifact.localPath, relativePath: 'result' + path.extname(artifact.displayName || artifact.name)}];
    // Calculation sources refer only to task input names, never arbitrary host paths.
    if (requirements.kind === 'calculation-v1') {
      if (!Array.isArray(requirements.sources) || requirements.sources.length < 1 || requirements.sources.length > 8)
        return {status:'inconclusive', code:'source_contract_invalid'};
      const directory = privateDirectory(path.join(jobDirectory, 'check-inputs'), true);
      requirements.sources = requirements.sources.map(source => {
        if (!source || !validOutputName(source.name) || Object.keys(source).some(k=>!['name','sha256'].includes(k)))
          throw Error('source_contract_invalid');
        const input = payload.inputs.find(x => x.name === source.name && x.sha256 === source.sha256);
        if (!input) throw Error('source_contract_invalid');
        const bytes = Buffer.from(input.data, 'base64');
        if (bytes.toString('base64') !== input.data || sha256(bytes) !== input.sha256) throw Error('source_changed');
        const file = path.join(directory, input.sha256 + path.extname(input.name));
        if (!fs.existsSync(file)) atomicWrite(file, bytes, true);
        if (sha256(privateRead(file, 8*1024*1024)) !== input.sha256) throw Error('source_changed');
        return {path:file, sha256:input.sha256};
      });
    }
    if (!validateArtifactAcceptanceRequirements(requirements)) return {status:'inconclusive',code:'scenario_invalid'};
    const relative = inputs[0].relativePath;
    // Literal fixed code; filenames are arguments, never interpolated shell/code.
    result = await runIsolatedArtifactJob({
      host: defaultArtifactAcceptanceHost(c.projectRoot), requirements,
      producer:{executable:process.execPath,args:['-e','require("node:fs").copyFileSync(process.argv[1],process.argv[2])','inputs/'+relative,'output/'+relative]},
      inputs, artifactRelativePath:'output/'+relative, timeoutMs:30000,
    });
    const receipt = result.receipt;
    return {
      status:result.status, code:result.code,
      ...(receipt ? {evidence:{kind:'local_recheck',receiptId:receipt.payload.id,
        artifactSha256:receipt.payload.artifact.sha256,requirementsSha256:receipt.payload.requirementsSha256,
        validator:receipt.payload.validator,checks:receipt.payload.result.checks,
        originalProducerIsolation:'not_attested_by_this_check',humanAcceptance:'not_recorded'}} : {}),
    };
  } catch {
    return {status:'inconclusive',code:'checker_unavailable'};
  } finally { result?.cleanup?.(); }
}

export async function verifyPeerResult(c, payload, remote, artifacts, {
  contextCurrent = true, cancelled = false, recheck = recheckPeerArtifact, jobDirectory,
} = {}) {
  const contract = validatePeerContract(payload.contract);
  const checks = [];
  const check = (id,status,code,evidence) => checks.push({id,status,code,...(evidence?{evidence}:{} )});
  const digest = peerResultDigest(remote, artifacts);
  if (remote.result?.revision !== contract.revision) check('revision','failed','result_revision_mismatch');
  if (remote.result?.contextSha256 !== payload.context.sha256) check('result_context','failed','result_context_binding_mismatch');
  const runtime=remote.result?.runtime;
  if(!runtime||runtime.requestedModel!==contract.runtime.model||runtime.requestedEffort!==contract.runtime.reasoningEffort)
    check('runtime_profile','failed','requested_runtime_mismatch');
  else if((runtime.reportedModel!=null&&runtime.reportedModel!==contract.runtime.model)||
      (runtime.reportedEffort!=null&&runtime.reportedEffort!==contract.runtime.reasoningEffort))
    check('runtime_profile','failed','reported_runtime_mismatch');
  else check('runtime_profile','passed','requested_runtime_bound',{
    requestedModel:runtime.requestedModel,requestedEffort:runtime.requestedEffort,
    reportedModel:runtime.reportedModel??null,reportedEffort:runtime.reportedEffort??null,
    assurance:runtime.reportedModel!=null&&runtime.reportedEffort!=null?'provider_reported_profile':'explicit_requested_configuration_only',
  });
  if (!contextCurrent) check('context','inconclusive','context_stale');
  if (cancelled) check('cancellation','inconclusive','cancellation_requested');
  if (remote.state !== 'succeeded') check('execution','failed','execution_'+remote.state);
  let outputs;
  try { outputs = verifiedArtifacts(artifacts, contract.execution.maxOutputBytes); }
  catch { check('manifest','failed','artifact_manifest_or_bytes_invalid'); outputs = new Map(); }
  for (const expected of contract.expectedOutputs) {
    if (expected.kind !== 'text') check('output_'+expected.name, outputs.has(expected.name)?'passed':'failed',outputs.has(expected.name)?'output_present':'output_missing');
  }
  const text = (remote.deliveries || []).map(d=>typeof d.text==='string'?d.text:'').join('\n');
  for (const criterion of contract.acceptance) {
    const output = criterion.outputName ? outputs.get(criterion.outputName) : null;
    if (criterion.kind === 'manual') {check(criterion.id,'inconclusive','coordinator_review_required');continue;}
    if (criterion.outputName && !output) {check(criterion.id,'failed','output_missing');continue;}
    try {
      let passed;
      switch (criterion.kind) {
        case 'text_contains': passed = Buffer.byteLength(text)<=MAX_TEXT && text.includes(criterion.expected); break;
        case 'file_present': passed = Boolean(output); break;
        case 'file_contains': passed = decodeText(output.bytes).includes(criterion.expected); break;
        case 'file_sha256': passed = output.artifact.sha256 === criterion.expected; break;
        case 'json_parse': JSON.parse(decodeText(output.bytes)); passed = true; break;
        case 'artifact': {
          const answer = await recheck(c, output.artifact, criterion.scenario, payload, jobDirectory);
          if(!answer||!['passed','failed','inconclusive'].includes(answer.status)||typeof answer.code!=='string'){
            check(criterion.id,'inconclusive','invalid_checker_result');continue;
          }
          check(criterion.id, answer.status, answer.code, answer.evidence); continue;
        }
        default: check(criterion.id,'inconclusive','unsupported_criterion'); continue;
      }
      check(criterion.id,passed?'passed':'failed',passed?'criterion_passed':'criterion_failed');
    } catch { check(criterion.id,'failed','criterion_failed'); }
  }
  // Re-read after all asynchronous checkers to bind the decision to exact bytes.
  try { verifiedArtifacts(artifacts, contract.execution.maxOutputBytes); }
  catch { check('final_bytes','failed','artifact_changed_during_check'); }
  const status = checks.some(x=>x.status==='failed') ? 'failed' : checks.some(x=>x.status==='inconclusive') ? 'inconclusive' : 'passed';
  return {schema:1,jobId:remote.id,revision:contract.revision,checkedAt:new Date().toISOString(),
    contractHash:contentHash(contract),resultHash:digest,contextHash:payload.context.sha256,
    status,checks,assurance:'declared_criteria_only',humanAcceptance:'not_recorded',
    summary:status==='passed'?'Проверки по заданным критериям пройдены.':status==='failed'?'Обнаружены невыполненные требования.':'Для части требований нужна дополнительная проверка.'};
}

export function validatePeerReview({assessment,payload,remote,artifacts,decision,resultHash,revision,note,contextCurrent}) {
  if (!['accept','request_changes'].includes(decision) || typeof note!=='string' || note.trim().length<10 || Buffer.byteLength(note)>8000)
    throw Error('Explicit bounded review required');
  if (assessment.resultHash!==resultHash || peerResultDigest(remote,artifacts)!==resultHash || revision!==payload.contract.revision || assessment.revision!==revision)
    throw Error('Review is stale');
  verifiedArtifacts(artifacts,payload.contract.execution.maxOutputBytes);
  if (!contextCurrent) throw Error('Task memory changed; review cannot override it');
  if (decision==='accept' && (remote.state!=='succeeded' || assessment.checks.some(c=>c.status==='failed') ||
      assessment.checks.some(c=>c.status==='inconclusive' && c.code!=='coordinator_review_required')))
    throw Error('A review cannot override failed or unavailable mechanical checks');
  return {schema:1,decision,resultHash,revision,note,at:new Date().toISOString(),
    assurance:'coordinator_judgment',humanAcceptance:'not_recorded',mechanicalStatus:assessment.status};
}
