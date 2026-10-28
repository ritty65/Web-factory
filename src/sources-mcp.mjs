import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { hash, now, fail } from './contracts.mjs';
import { openStore } from './db.mjs';
import { sourceJobPolicy } from './batch-budget.mjs';
import { createRequire } from 'node:module';
import { safeFetch } from './network.mjs';
import { MEDIA_HOSTS } from './media.mjs';
import { searchPublic } from './search.mjs';
import {checkResearchOutput} from './research-check.mjs';
import {scoutStep,scoutDraftIssues,scoutRegistrationFailure,selectedLinkedRead} from './scout.mjs';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
import { inspectSource, publicObservation, readObservations } from './browser.mjs';
const directory = process.env.FACTORY_SOURCES;
if (!directory || !path.isAbsolute(directory) || !directory.endsWith('/sources')) throw new Error('A host-selected source staging directory is required');
const budgetStore = process.env.FACTORY_SOURCE_JOB ? openStore({ dbPath: process.env.FACTORY_DB, stateRoot: process.env.FACTORY_STATE }) : null;
const policy = budgetStore ? sourceJobPolicy(budgetStore, process.env.FACTORY_SOURCE_JOB, directory) : null;
const requestId=process.env.FACTORY_RESEARCH_REQUEST;
if(requestId&&(!/^[a-f0-9]{64}$/.test(requestId)||!policy||Number(process.env.FACTORY_RESEARCH_LIMIT)!==policy.researchContext().candidateLimit))fail('BATCH_SOURCE_BINDING','Research check must use its exact host request and candidate limit.');
const server = new McpServer({ name: 'factory-public-sources', version: '0.1.0' });
if(requestId&&policy?.researchContext().acquisition?.version===1&&budgetStore.job(process.env.FACTORY_SOURCE_JOB).input.phase==='discovery')server.registerTool('scout',{
  description:'One host-planned acquisition step. Supply output:{candidates:[]} for the next diverse discovery search, or the COMPLETE current candidate draft for an observed evidence question and material feedback. Uses the same original caps/deadline; attempts and interrupted tasks persist across restart. No import, extra model launch, qualification or acceptance. Retain all registered draft identities in final checked output.',
  inputSchema:z.object({output:z.record(z.string(),z.unknown())}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
},async({output})=>{
  try{const data=await scoutStep({store:budgetStore,jobId:process.env.FACTORY_SOURCE_JOB,directory,output});return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}
  catch(e){
    const diagnostic=scoutRegistrationFailure(budgetStore,process.env.FACTORY_SOURCE_JOB,e);
    const note=diagnostic?'Rejected registration commits nothing. Preserve ALL registered anchors and identities. Do not spend a research check on this rejected or an edited draft. These retained identities cannot reconstruct the exact prior payload: restore your own last successfully registered COMPLETE draft. Re-register only under ordinary existing permissions; sources.scout may advance source work. No repeat, reset, partial import, source switch or extra authority is granted.':'Scout stopped. No repeat, partial import, source switch or budget reset is authorized.';
    const data={status:'held',code:e.code||'SOURCE_SCOUT_FAILED',...(diagnostic?{diagnostic}:{}),note};return {isError:true,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
  }
});
let calls = (await readObservations(directory)).length;
let imageCalls = 0;
let searchCalls = 0;
// Existing MCP v1 registerTool/structuredContent contract:
// https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/server.md#tools
if(requestId)server.registerTool('check_research',{
  description:'Check the complete proposed research JSON before finalizing it. Local retained-evidence/schema check only: no web/model calls, import, qualification override, build or approval. Two attempts total in this original request, including failures, across restarts. Return the exact last successful checked payload.',
  inputSchema:z.object({output:z.record(z.string(),z.unknown())}).strict(),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false},
},async({output})=>{
  try{
     const scope=policy.researchContext(),data=await checkResearchOutput({directory,requestId,...scope,output,validateScope:(candidates,evidence)=>scoutDraftIssues(budgetStore,process.env.FACTORY_SOURCE_JOB,candidates,evidence)});policy.researchContext();
    return {isError:!data.valid,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
  }catch(e){
    const data={valid:false,code:e.code||'RESEARCH_CHECK_FAILED',note:'Research check stopped. No new native launch, reset, partial import or fabricated proof is authorized.'};
    return {isError:true,content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
  }
});
server.registerTool('search', { description: 'Bounded public search. Saved batches enforce their selected provider and persisted allowance. intent=discover only finds names; intent=verify documents exact-business website checks. Neither establishes absence from snippets. No credentials or access bypass.', inputSchema: z.object({ query: z.string().min(2).max(300), provider: z.enum(['guest_bing', 'firecrawl']).default(policy?.provider || 'guest_bing'), intent: z.enum(['discover', 'verify']).default('verify') }).strict(), annotations: { readOnlyHint: true, openWorldHint: true } }, async ({ query, provider, intent }) => {
  if (++searchCalls > 6) return { isError: true, content: [{ type: 'text', text: 'Search-query cap reached. Report the shortfall; do not fill it with guesses.' }] };
   try { policy?.reserve('searches', { provider }); const data = await searchPublic(query, { directory, provider, intent }); return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; }
  catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'blocked', code: e.code || 'SEARCH_FAILED', note: 'Public search is unavailable or blocked. Failed queries are not absence evidence. No credential or challenge bypass is permitted.' }) }] }; }
});
server.registerTool('inspect', { description: 'Inspect one public HTTPS page in a fresh guest browser, returning bounded untrusted DOM evidence and observed image IDs. No login, credentials or arbitrary commands. Raw CDN URLs remain private.', inputSchema: z.object({ url: z.string().url().max(1200) }).strict(), annotations: { readOnlyHint: true, openWorldHint: true } }, async ({ url }) => {
  if (++calls > 24) return { isError: true, content: [{ type: 'text', text: 'Source inspection budget reached. Return the documented shortfall.' }] };
    try { const linked=budgetStore?await selectedLinkedRead({store:budgetStore,jobId:process.env.FACTORY_SOURCE_JOB,directory,url}):false;policy?.reserve('inspections', { url }); const data = publicObservation(await inspectSource(url, { directory,linked })); return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; }
  catch (e) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: 'blocked', error: e.code || 'SOURCE_FAILED', ...(e.sourceFailure ? { diagnostic: e.sourceFailure } : {}), note: 'A failed source is unknown evidence, not website absence. Diagnostic categories are process hints, not evidence about the business. Do not bypass access restrictions.' }) }] }; }
});
server.registerTool('image', { description: 'View ONE actually observed public social image by source/image ID. Returns normalized pixels for visual inspection, not the signed media URL. Reject AI-labelled/reposted/irrelevant/watermarked material; uploader identity does not prove a licence.', inputSchema: z.object({ sourceId: z.string().regex(/^source-[a-f0-9]+$/), imageId: z.string().regex(/^image-[a-f0-9]+$/) }).strict(), annotations: { readOnlyHint: true, openWorldHint: true } }, async ({ sourceId, imageId }) => {
  if (++imageCalls > 8) return { isError: true, content: [{ type: 'text', text: 'Image review budget reached; report the honest remaining gap.' }] };
  try {
    policy?.reserve('imageViews');
    const source = (await readObservations(directory)).find(v => v.id === sourceId);
    const image = source?.images.find(v => v.id === imageId);
    if (!image || !/(^|\.)(instagram\.com|facebook\.com)$/.test(new URL(source.url).hostname)) throw new Error('Not an observed social image');
    const response = await safeFetch(image.mediaUrl, { signed: true, allowedHosts: MEDIA_HOSTS, redirects: 0, maxBytes: 8 * 1024 * 1024 });
    if (response.status !== 200 || !response.contentType.startsWith('image/')) throw new Error('Image inaccessible');
    const pixels = await sharp(response.bytes, { limitInputPixels: 24000000 }).rotate().resize({ width: 1100, height: 1100, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    await writeFile(path.join(directory, `image-view-${hash({ sourceId, imageId }).slice(0, 24)}.json`), JSON.stringify({ sourceId, imageId, at: now(), pixelsSha256: hash(pixels), status: 'pixels_returned_to_AI_not_human_acceptance' }), { mode: 0o600 });
    return { content: [{ type: 'image', mimeType: 'image/webp', data: pixels.toString('base64') }, { type: 'text', text: JSON.stringify({ sourceId, imageId, sourceUrl: source.url, note: 'Actual observed image pixels. Visual review is AI evidence, not human acceptance, copyright ownership or proof of documentary authenticity.' }) }] };
  } catch { return { isError: true, content: [{ type: 'text', text: 'Observed image could not be safely viewed; do not invent its subject or claim it was reviewed.' }] }; }
});
await server.connect(new StdioServerTransport());
