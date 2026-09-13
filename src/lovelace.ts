import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { BridgeError } from './errors.js';
import type { Operation } from './operation.js';
import { redact } from './redaction.js';
import { requestWebSocket } from './websocket.js';

const segment=z.union([z.string().min(1).max(128),z.number().int().min(0).max(100_000)]);
const path=z.array(segment).min(1).max(32);
const operation=z.discriminatedUnion('op',[
  z.object({op:z.literal('add'),path,value:z.unknown()}).strict(),
  z.object({op:z.literal('replace'),path,value:z.unknown()}).strict(),
  z.object({op:z.literal('remove'),path}).strict(),
]);
export const lovelacePreviewSchema=z.object({
  dashboard:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/).nullable(),
  cardPath:path,
  operations:z.array(operation).min(1).max(16),
}).strict();
export const lovelaceApplySchema=lovelacePreviewSchema.extend({
  expectedVersion:z.string().regex(/^[a-f0-9]{64}$/),
  expectedPreviewHash:z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgeNonAtomicSave:z.literal(true),
}).strict();
export type PreviewInput=z.infer<typeof lovelacePreviewSchema>;
export type ApplyInput=z.infer<typeof lovelaceApplySchema>;
type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
type ObjectJson={[key:string]:Json};
const forbidden=new Set(['__proto__','prototype','constructor']);
// A card may fit on its own but exceed the full review after JSON escaping and
// duplication into MCP text/structuredContent. MAX_REVIEW is always checked too.
const MAX_INPUT=32_000,MAX_CARD=65_536,MAX_REVIEW=160_000;

function fail(code:string):never {throw new BridgeError(code);}
function serialized(value:unknown):string {
  try {const s=JSON.stringify(value);if(s===undefined)fail('INVALID_JSON');return s;}catch{fail('INVALID_JSON');}
}
function json(value:unknown):asserts value is Json {
  const stack:Array<[unknown,number]>=[[value,0]];let nodes=0;
  while(stack.length){
    const [v,depth]=stack.pop()!;
    if(++nodes>150_000||depth>64)fail('JSON_TOO_COMPLEX');
    if(v===null||typeof v==='string'||typeof v==='boolean')continue;
    if(typeof v==='number'&&Number.isFinite(v))continue;
    if(typeof v!=='object'||!v)fail('INVALID_JSON');
    if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)fail('INVALID_JSON');
    for(const [key,child] of Object.entries(v)){
      if(forbidden.has(key))fail('INVALID_PATH');
      stack.push([child,depth+1]);
    }
  }
}
function object(value:Json):value is ObjectJson {return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function canonical(value:Json):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(object(value))return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key]!)).join(',')+'}';
  return JSON.stringify(value);
}
function hash(value:Json):string{return createHash('sha256').update(canonical(value)).digest('hex');}
function cardPathValid(p:(string|number)[]):boolean {
  if(p[0]!=='views'||typeof p[1]!=='number')return false;
  let i=2;
  if(p[i]==='sections') {if(typeof p[i+1]!=='number')return false;i+=2;}
  if(p[i]!=='cards'||typeof p[i+1]!=='number')return false;i+=2;
  while(i<p.length){
    if(p[i]==='card'){i++;continue;}
    if(p[i]==='cards'&&typeof p[i+1]==='number'){i+=2;continue;}
    return false;
  }
  return true;
}
export function parseLovelace(input:unknown,apply:false):PreviewInput;
export function parseLovelace(input:unknown,apply:true):ApplyInput;
export function parseLovelace(input:unknown,apply:boolean):PreviewInput|ApplyInput {
  if(Buffer.byteLength(serialized(input))>MAX_INPUT)fail('REQUEST_TOO_LARGE');
  json(input);
  const parsed=(apply?lovelaceApplySchema:lovelacePreviewSchema).safeParse(input);
  if(!parsed.success)fail('INVALID_REQUEST');
  const data=parsed.data;
  if(!cardPathValid(data.cardPath))fail('INVALID_CARD_PATH');
  for(const op of data.operations){
    if(op.path.some(s=>typeof s==='string'&&forbidden.has(s)))fail('INVALID_PATH');
    if(op.op!=='remove'&&!Object.hasOwn(op,'value'))fail('INVALID_REQUEST');
  }
  return data;
}
function child(parent:Json,key:string|number):Json {
  if(Array.isArray(parent)){
    if(typeof key!=='number'||key>=parent.length)fail('INVALID_PATH');
    return parent[key]!;
  }
  if(!object(parent)||typeof key!=='string'||!Object.hasOwn(parent,key)||forbidden.has(key))fail('INVALID_PATH');
  return parent[key]!;
}
function at(root:Json,p:(string|number)[]):Json {return p.reduce<Json>((v,k)=>child(v,k),root);}
function validCard(card:Json):asserts card is ObjectJson {
  if(!object(card)||typeof card.type!=='string'||!card.type.length)fail('INVALID_CARD');
  if(Buffer.byteLength(serialized(card))>MAX_CARD)fail('CARD_TOO_LARGE');
}
function patch(card:ObjectJson,ops:PreviewInput['operations']):void {
  for(const op of ops){
    const parent=at(card,op.path.slice(0,-1)),key=op.path.at(-1)!;
    const value=op.op==='remove'?null:structuredClone(op.value) as Json;
    if(Array.isArray(parent)){
      if(typeof key!=='number'||key>parent.length||(op.op!=='add'&&key===parent.length))fail('INVALID_PATH');
      if(op.op==='add')parent.splice(key,0,value);
      else if(op.op==='remove')parent.splice(key,1);
      else parent[key]=value;
    }else{
      if(!object(parent)||typeof key!=='string'||forbidden.has(key))fail('INVALID_PATH');
      const exists=Object.hasOwn(parent,key);
      if((op.op==='add'&&exists)||(op.op!=='add'&&!exists))fail('INVALID_PATH');
      if(op.op==='remove')delete parent[key];else parent[key]=value;
    }
  }
  validCard(card);
}
export interface LovelacePreview {
  success:true; dashboard:string|null;cardPath:(string|number)[];operations:PreviewInput['operations'];
  expectedVersion:string;previewHash:string;before:ObjectJson;after:ObjectJson;atomic:false;
  saveScope:'entire_dashboard';warning:string;
}
async function read(config:Config,dashboard:string|null,token:string,op:Operation):Promise<Json> {
  const r=await requestWebSocket(config,{command:{type:'lovelace/config',url_path:dashboard,force:true}},token,{...op,markSent:()=>{}});
  if(!r.success)fail('DASHBOARD_READ_FAILED');
  json(r.result);
  if(!object(r.result)||!Array.isArray(r.result.views))fail('INVALID_DASHBOARD');
  return r.result;
}
function plan(config:Config,input:PreviewInput,original:Json,token:string,op:Operation){
  const before=at(original,input.cardPath);validCard(before);
  const changed=structuredClone(original);const after=at(changed,input.cardPath);validCard(after);patch(after,input.operations);
  const command={type:'lovelace/config/save',url_path:input.dashboard,config:changed};
  if(Buffer.byteLength(serialized({...command,id:1}))>op.limits.maxRequestBytes)fail('REQUEST_TOO_LARGE');
  const expectedVersion=hash(original);
  const details={dashboard:input.dashboard,cardPath:input.cardPath,operations:input.operations,before,after};
  const reviewJson:unknown=details;json(reviewJson);
  // Hashes identify content, not authorization. Never return a partially hidden review.
  if(serialized(redact(details,token))!==serialized(details))fail('PREVIEW_NOT_REVIEWABLE');
  const previewHash=hash({instance:config.baseUrl.toString(),expectedVersion,details:reviewJson});
  const preview:LovelacePreview={success:true,...details,expectedVersion,previewHash,atomic:false,saveScope:'entire_dashboard',warning:'Home Assistant saves the entire dashboard without atomic CAS. A change between the final read and save can be overwritten. Pause other editors. Readback detects some races, but cannot prevent them. No automatic retry or rollback.'};
  const text=serialized(preview);
  if(Buffer.byteLength(serialized({content:[{type:'text',text}],structuredContent:preview}))>MAX_REVIEW)fail('PREVIEW_TOO_LARGE');
  return {preview,changed,command};
}
export async function previewLovelace(config:Config,input:PreviewInput,token:string,op:Operation):Promise<LovelacePreview>{
  return plan(config,input,await read(config,input.dashboard,token,op),token,op).preview;
}
export async function applyLovelace(config:Config,input:ApplyInput,token:string,op:Operation){
  const original=await read(config,input.dashboard,token,op);
  if(hash(original)!==input.expectedVersion)fail('STALE_DASHBOARD');
  const p=plan(config,input,original,token,op);
  if(p.preview.previewHash!==input.expectedPreviewHash)fail('PREVIEW_MISMATCH');
  // Best effort only: HA has no expected-version field or cross-client transaction.
  if(hash(await read(config,input.dashboard,token,op))!==input.expectedVersion)fail('STALE_DASHBOARD');
  op.signal.throwIfAborted();
  const saved=await requestWebSocket(config,{command:p.command},token,op);
  if(!saved.success)return {success:false,verified:false,atomic:false,error:{code:'DASHBOARD_SAVE_REJECTED',resultUnknown:false}};
  const actual=await read(config,input.dashboard,token,op);
  if(hash(actual)!==hash(p.changed))fail('READBACK_MISMATCH');
  return {success:true,verified:true,atomic:false,dashboard:input.dashboard,cardPath:input.cardPath,version:hash(actual),previewHash:p.preview.previewHash};
}
