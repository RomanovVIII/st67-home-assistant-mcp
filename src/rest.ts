import http from 'node:http';
import https from 'node:https';
import { z } from 'zod';
import { type Config, restUrl } from './config.js';
import { BridgeError } from './errors.js';
import type { Operation } from './operation.js';

export const restSchema = z.object({
  method:z.enum(['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE']),
  path:z.string().max(2048),
  query:z.array(z.tuple([z.string(),z.string()])).max(256).optional(),
  body:z.unknown().optional(),
  contentType:z.enum(['application/json','text/plain','application/yaml']).optional(),
  allowBinary:z.boolean().default(false).describe('Enable only when the user explicitly authorizes returning this binary content. Its contents cannot be reliably scrubbed for secrets.'),
}).strict();
export type RestInput = z.infer<typeof restSchema>;
export interface RestResult { status:number; contentType:string; encoding:'json'|'text'|'base64'; data:unknown; binaryUninspected?:boolean }

export async function requestRest(config:Config, input:unknown, token:string, op:Operation):Promise<RestResult> {
  const parsed=restSchema.safeParse(input);
  if(!parsed.success) throw new BridgeError('INVALID_REQUEST');
  const {method,path,query,body,contentType,allowBinary}=parsed.data;
  const url=restUrl(config,path,query);
  if(body !== undefined && ['GET','HEAD'].includes(method)) throw new BridgeError('INVALID_REQUEST');
  if(contentType && contentType !== 'application/json' && typeof body !== 'string') throw new BridgeError('INVALID_REQUEST');
  let payload:string|undefined;
  try { payload=body === undefined ? undefined : contentType && contentType !== 'application/json' ? String(body) : JSON.stringify(body); }
  catch { throw new BridgeError('INVALID_REQUEST'); }
  if(payload && Buffer.byteLength(payload)>op.limits.maxRequestBytes) throw new BridgeError('REQUEST_TOO_LARGE');
  op.signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const request=(url.protocol === 'https:' ? https : http).request(url,{
      method, signal:op.signal, agent:false,
      headers:{ authorization:`Bearer ${token}`, ...(payload !== undefined ? {'content-type':contentType ?? 'application/json','content-length':Buffer.byteLength(payload)}:{}) },
    },response=>{
      const status=response.statusCode ?? 0;
      const type=(response.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
      const fail=(code:string)=>{ reject(new BridgeError(code));response.destroy(); };
      if(status>=300 && status<400 && status !== 304) { fail('REDIRECT_BLOCKED');return; }
      if(type === 'text/event-stream' || type.startsWith('multipart/') || type.startsWith('video/')) {fail('UNSUPPORTED_RESPONSE');return;}
      const chunks:Buffer[]=[];let size=0;
      response.on('error',()=>reject(new BridgeError('NETWORK_ERROR')));
      response.on('aborted',()=>reject(new BridgeError('NETWORK_ERROR')));
      response.on('data',(chunk:Buffer)=>{
        size+=chunk.length;
        if(size>op.limits.maxResponseBytes) {fail('RESPONSE_TOO_LARGE');return;}
        chunks.push(chunk);
      });
      response.on('end',()=>{
        const bytes=Buffer.concat(chunks);
        if(bytes.length===0) {resolve({status,contentType:type,encoding:'text',data:''});return;}
        if(type === 'application/json' || type.endsWith('+json')) {
          try {resolve({status,contentType:type,encoding:'json',data:JSON.parse(bytes.toString('utf8'))});}
          catch {reject(new BridgeError('INVALID_JSON_RESPONSE'));}
        } else if(type.startsWith('text/') || ['application/yaml','application/xml'].includes(type)) {
          resolve({status,contentType:type,encoding:'text',data:bytes.toString('utf8')});
        } else {
          if(!allowBinary) {reject(new BridgeError('BINARY_OPT_IN_REQUIRED'));return;}
          // Binary payloads cannot be structurally scrubbed: reject any literal token bytes.
          if(bytes.includes(Buffer.from(token))) {reject(new BridgeError('SENSITIVE_RESPONSE'));return;}
          resolve({status,contentType:type,encoding:'base64',data:bytes.toString('base64'),binaryUninspected:true});
        }
      });
    });
    request.on('error',()=>reject(new BridgeError('NETWORK_ERROR')));
    if(!['GET','HEAD','OPTIONS'].includes(method)) op.markSent();
    request.end(payload);
  });
}
