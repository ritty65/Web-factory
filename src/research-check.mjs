import {z} from 'zod';
import {open,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {candidateInput,CONTACT_CHANNELS,WEBSITE_STATUSES,LINK_STATUSES,publicUrl,hash,fail,now} from './contracts.mjs';
import {noLinks} from './db.mjs';
import {readIntakeEvidence,assessIntake} from './intake.mjs';
import {assessScreening} from './screening.mjs';
import {assessMaterial} from './acquisition.mjs';

const MAX_BYTES=1024*1024, MAX_CHECKS=2;
export const RESEARCH_CHECK_RULES=`RESEARCH CHECK v1: Before final JSON, call sources.check_research with {output:the complete proposed JSON object}. Contact keys in contacts/contactSources/contactSourceEvidence are ONLY ${CONTACT_CHANNELS.join(', ')}. Never put website there: an actually found official website belongs in websiteCheck.url and status. Website statuses are exactly ${WEBSITE_STATUSES.join(', ')}; link statuses are exactly ${LINK_STATUSES.join(', ')}. Every candidate needs name, area, summary, sourceUrls, inspectionIds, facts and websiteCheck. Unknown optional proof must be omitted, not null. The checker uses the shared strict parser and retained sources, with no web/model calls or import. It reports malformed fields separately from missing-evidence holds. One correction is permitted inside this SAME native request: at most TWO checks including failures, never another native launch, replacement round or reset. Preserve real held businesses and gaps. If a check succeeds, finalize EXACTLY that checked object (including shortfall, order and literal strings); do not append new fields, commentary or unchecked changes. If the last check is invalid and no checks remain, stop: no valid submission exists, even after an earlier success. Do not emit unchecked amended final JSON, claim success, request another slot or retry. A valid data check is NOT qualification, human acceptance or authority to build. The final output and cached stages must match the last successful same-request receipt.`;
const str=max=>z.string().min(1).max(max);
const key=str(96).regex(/^[a-z0-9][a-z0-9-]{1,95}$/);
const url=str(1200).refine(value=>{try{publicUrl(value);return true;}catch{return false;}},'Unsafe public URL');
const ref=z.strictObject({kind:z.literal('image_alt'),sourceId:key,imageId:key,postUrl:url});
const proof=z.strictObject({sourceUrl:url,inspectionId:key,excerpt:str(1000)});
const channels=value=>z.strictObject(Object.fromEntries(CONTACT_CHANNELS.map(k=>[k,value(k).optional()])));
// Strict research output is separate from the conservative legacy import parser.
// Zod 4: https://zod.dev/api#zstrictobject; no coercion, defaults or key stripping.
function schema(limit){
  const candidate=z.strictObject({
    name:str(150),area:str(150),summary:str(1800),identityMatched:z.boolean().optional(),active:z.boolean().optional(),
    sourceUrls:z.array(url).max(20),inspectionIds:z.array(key).max(15),observationJobIds:z.array(key).max(15).optional(),
    facts:z.array(z.strictObject({id:key.optional(),text:str(1000),sourceUrl:url,excerpt:str(1000).optional(),evidenceRef:ref.optional()})).max(30),
    contacts:channels(k=>['instagram','facebook'].includes(k)?url:str(200)).optional(),
    contactSources:channels(()=>z.union([url,proof])).optional(),contactSourceEvidence:channels(()=>proof).optional(),
    websiteCheck:z.strictObject({status:z.enum(WEBSITE_STATUSES),queries:z.array(str(300)).max(10),checkedAt:z.iso.datetime({offset:true}),url:url.optional(),
      linkChecks:z.array(z.strictObject({url,sourceId:key.nullable(),status:z.enum(LINK_STATUSES),reason:str(1000)}).refine(v=>v.status==='unresolved'||v.sourceId!==null,'Inspected links need an actual source ID')).max(25).optional()}),
    pagePurposes:z.array(z.strictObject({purpose:str(300),factIds:z.array(key).max(30)})).length(5).optional(),
    activityEvidence:z.strictObject({sourceId:key,excerpt:str(1000),dateText:str(100),date:str(40),evidenceRef:ref.optional()}).optional(),
    media:z.array(z.strictObject({sourceId:key,imageId:key,account:url,postUrl:url,businessPosted:z.boolean(),alt:str(300),role:str(100).optional(),credit:str(300).optional(),postedAt:str(100).nullable().optional()})).max(6).optional(),
    unknowns:z.array(str(1000)).max(20).optional(),
  });
  return z.strictObject({candidates:z.array(candidate).max(limit),shortfall:z.string().max(3000).optional()});
}
const issueMessages={unrecognized_keys:'Remove unsupported fields; only the documented research fields are allowed.',invalid_value:'Use an exact documented enum value.',invalid_type:'Use the documented field type; omit unknown optional proof instead of null placeholders.',too_big:'The field exceeds its original length or count limit.',too_small:'A required value is missing or too short.'};
export function validateResearchOutput(output,candidateLimit){
  const invalid=issues=>({valid:false,issues});
  if(!Number.isInteger(candidateLimit)||candidateLimit<1||candidateLimit>100)return invalid([{path:'candidates',message:'Invalid host candidate limit.'}]);
  let bytes;try{bytes=Buffer.byteLength(JSON.stringify(output));}catch{return invalid([{path:'output',message:'Research output must be bounded JSON data.'}]);}
  if(bytes>MAX_BYTES)return invalid([{path:'output',message:'Research output exceeds the one MiB limit.'}]);
  const parsed=schema(candidateLimit).safeParse(output);
  if(!parsed.success)return invalid(parsed.error.issues.slice(0,20).map(i=>({path:i.path.join('.'),message:issueMessages[i.code]||'The field fails the documented input contract.'})));
  const candidates=[];
  for(const [i,input] of output.candidates.entries()){
    try{candidates.push(candidateInput(input));}catch{return invalid([{path:`candidates.${i}`,message:'Candidate fails the shared host parser; check public URLs, source bindings and literal text.'}]);}
  }
  return {valid:true,issues:[],candidates};
}
function ordered(value){return Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,ordered(value[k])])):value;}
export const researchDigest=output=>hash(ordered(output));
function receiptPath(directory,requestId,n){
  if(!path.isAbsolute(directory)||!directory.endsWith('/sources')||!/^[a-f0-9]{64}$/.test(requestId))fail('RESEARCH_CHECK_BINDING','Research check needs the host-selected source directory and native request ID.');
  return path.join(directory,`research-check-${requestId}-${n}.json`);
}
export async function checkResearchOutput({directory,requestId,candidateLimit,settings={},output,validateScope}){
  let handle,check;
  for(let n=1;n<=MAX_CHECKS;n++){
    const file=receiptPath(directory,requestId,n);await noLinks(file);
    try{handle=await open(file,'wx',0o600);check=n;break;}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  if(!handle)fail('RESEARCH_CHECK_CAP','Two research checks used. No additional correction, native launch or retry is authorized.');
  try{
     const result=validateResearchOutput(output,candidateLimit),feedback=[];
     const evidence=result.valid?await readIntakeEvidence(directory):null;
     if(result.valid&&validateScope){const issues=validateScope(result.candidates,evidence);if(issues.length){result.valid=false;result.issues=issues;}}
     if(result.valid){
      for(const [index,c] of result.candidates.entries()){
        const intake=assessIntake(c,evidence);
         feedback.push({index,screening:assessScreening(c,evidence,settings),material:assessMaterial(c,evidence),intakeReady:intake.ready,reasons:intake.reasons.slice(0,16)});
      }
    }
    const payloadDigest=result.valid?researchDigest(output):null;
    let boundedOutput;try{if(Buffer.byteLength(JSON.stringify(output))<=MAX_BYTES)boundedOutput=output;}catch{/* Non-JSON/oversized input cannot enlarge the private receipt. */}
    const receipt={version:1,requestId,candidateLimit,check,at:now(),valid:result.valid,payloadDigest,issues:result.issues,...(boundedOutput?{output:boundedOutput}:{inputOmitted:'non_json_or_oversized'})};
    // Own exclusive new receipt only. Failed checks and process deaths consume a
    // slot across MCP restarts; an empty/interrupted receipt cannot authorize output.
    await handle.writeFile(JSON.stringify(receipt));
    const terminal=!result.valid&&check===MAX_CHECKS;
    const nextAction=result.valid?'finalize_exact_checked_output':terminal?'stop_no_valid_submission':'correct_within_remaining_check';
    const note=result.valid?'Data check only. Return exactly this checked output; do not make unchecked changes.':terminal?'No successful current check; no valid submission exists, even after an earlier success. Do not emit unchecked amended final JSON, claim success, request another slot or retry. The host rejects final submission with RESEARCH_CHECK_MISSING.':'Data check only. Correct the reported issues within the one remaining check in this same request; never invent proof.';
    return {valid:result.valid,payloadDigest,check,checksRemaining:MAX_CHECKS-check,nextAction,terminal,issues:result.issues,feedback,fullQualification:false,humanAcceptance:false,
      allowedContactChannels:CONTACT_CHANNELS,websiteStatuses:WEBSITE_STATUSES,linkStatuses:LINK_STATUSES,
      note:note+' Holds remain holds; no import, source request, build or approval occurs here.'};
  }finally{await handle.close();}
}
export async function assertResearchChecked({directory,requestId,candidateLimit,output}){
  const result=validateResearchOutput(output,candidateLimit);
  if(!result.valid)fail('RESEARCH_SCHEMA','Final research output fails the strict shared data contract; no partial import or correction launch.');
  let last;
  for(let n=1;n<=MAX_CHECKS;n++){
    const file=receiptPath(directory,requestId,n);await noLinks(file);
    try{
      const info=await stat(file);if(!info.isFile()||info.size>MAX_BYTES+16000)fail('RESEARCH_CHECK_MISMATCH','Research check receipt is not bounded.');
      last=JSON.parse(await readFile(file,'utf8'));
      if(last?.check!==n)fail('RESEARCH_CHECK_MISMATCH','Research check receipt does not match its original slot.');
    }catch(e){if(e.code==='ENOENT')continue;if(e instanceof SyntaxError){last={valid:false};continue;}throw e;}
  }
  if(!last||last.valid!==true)fail('RESEARCH_CHECK_MISSING','Final research needs its last successful check in this same native request.');
  if(last.version!==1||last.requestId!==requestId||last.candidateLimit!==candidateLimit||last.payloadDigest!==researchDigest(output)||last.payloadDigest!==researchDigest(last.output))fail('RESEARCH_CHECK_MISMATCH','Final research differs from its exact checked payload or host scope.');
  return {requestId,payloadDigest:last.payloadDigest,check:last.check};
}
