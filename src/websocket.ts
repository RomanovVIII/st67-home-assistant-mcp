import WebSocket from 'ws';
import { z } from 'zod';
import type { Config } from './config.js';
import { BridgeError } from './errors.js';
import type { Operation } from './operation.js';

export const wsSchema=z.object({
  command:z.object({type:z.string().min(1).max(256)}).catchall(z.unknown()),
  eventLimit:z.number().int().min(0).max(100).default(0),
  waitMs:z.number().int().min(1).max(30_000).default(5000),
}).strict();
export type WsInput=z.input<typeof wsSchema>;
export interface WsResult { success:boolean; result:unknown; events:unknown[]; stopReason:string; incomplete?:boolean; error?:unknown }

export async function requestWebSocket(config:Config,input:unknown,token:string,op:Operation):Promise<WsResult> {
  const parsed=wsSchema.safeParse(input);
  if(!parsed.success) throw new BridgeError('INVALID_REQUEST');
  const {command,eventLimit,waitMs}=parsed.data;
  if('id' in command || ['auth','auth_required','auth_ok','auth_invalid'].includes(command.type)) throw new BridgeError('INVALID_REQUEST');
  let payload:string;
  try {payload=JSON.stringify({...command,id:1});}catch{throw new BridgeError('INVALID_REQUEST');}
  if(Buffer.byteLength(payload)>op.limits.maxRequestBytes) throw new BridgeError('REQUEST_TOO_LARGE');
  op.signal.throwIfAborted();
  const url=new URL('/api/websocket',config.baseUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url,{followRedirects:false,handshakeTimeout:op.limits.authTimeoutMs,maxPayload:op.limits.maxResponseBytes,perMessageDeflate:false});
    let phase:'auth_required'|'auth_ok'|'result'|'events'='auth_required';
    let settled=false,received=0;
    const events:unknown[]=[];
    let commandResult:unknown=null;
    let waitTimer:ReturnType<typeof setTimeout>|undefined;
    const authTimer=setTimeout(()=>fail('AUTH_TIMEOUT'),op.limits.authTimeoutMs);
    const cleanup=()=>{
      clearTimeout(authTimer);clearTimeout(waitTimer);op.signal.removeEventListener('abort',abort);
      // Keep the error listener installed: terminating a connecting socket emits an error.
      if(ws.readyState !== WebSocket.CLOSED) ws.terminate();
    };
    const fail=(code:string)=>{if(settled)return;settled=true;cleanup();reject(new BridgeError(code));};
    const finish=(stopReason:string,incomplete=false)=>{
      if(settled)return;settled=true;cleanup();
      resolve({success:true,result:commandResult,events,stopReason,...(incomplete?{incomplete:true}:{})});
    };
    const abort=()=>fail('CANCELLED');
    op.signal.addEventListener('abort',abort,{once:true});
    if(op.signal.aborted) {abort();return;}
    ws.on('unexpected-response',(_request,response)=>{response.destroy();fail('WS_HANDSHAKE_FAILED');});
    ws.on('error',()=>fail('WS_CONNECTION_ERROR'));
    ws.on('close',()=>{
      if(phase==='events') finish('connection_closed',true); else fail('WS_CONNECTION_CLOSED');
    });
    ws.on('message',(raw,isBinary)=>{
      if(settled)return;
      received+=raw instanceof ArrayBuffer?raw.byteLength:Array.isArray(raw)?raw.reduce((n,b)=>n+b.length,0):raw.length;
      if(received>op.limits.maxResponseBytes) {if(phase==='events')finish('size_limit',true);else fail('RESPONSE_TOO_LARGE');return;}
      if(isBinary) {fail('WS_PROTOCOL_ERROR');return;}
      let msg:Record<string,unknown>;
      try {const value:unknown=JSON.parse(raw.toString());if(!value || typeof value!=='object' || Array.isArray(value))throw new Error();msg=value as Record<string,unknown>;}
      catch{fail('WS_PROTOCOL_ERROR');return;}
      if(phase==='auth_required') {
        if(msg.type!=='auth_required') {fail('WS_PROTOCOL_ERROR');return;}
        phase='auth_ok';ws.send(JSON.stringify({type:'auth',access_token:token}));return;
      }
      if(phase==='auth_ok') {
        if(msg.type==='auth_invalid') {fail('AUTH_FAILED');return;}
        if(msg.type!=='auth_ok') {fail('WS_PROTOCOL_ERROR');return;}
        clearTimeout(authTimer);phase='result';op.markSent();ws.send(payload);return;
      }
      if(msg.id!==1)return;
      if(phase==='result') {
        if(msg.type==='pong' && command.type==='ping') {finish('result');return;}
        if(msg.type!=='result' || typeof msg.success!=='boolean') {fail('WS_PROTOCOL_ERROR');return;}
        if(!msg.success) {
          settled=true;cleanup();resolve({success:false,result:null,error:msg.error ?? null,events:[],stopReason:'api_error'});return;
        }
        commandResult=msg.result ?? null;
        if(eventLimit===0) {finish('result');return;}
        phase='events';waitTimer=setTimeout(()=>finish('wait_timeout'),waitMs);return;
      }
      if(msg.type!=='event' || !('event' in msg)) {fail('WS_PROTOCOL_ERROR');return;}
      events.push(msg.event);
      if(events.length>=eventLimit)finish('event_limit');
    });
  });
}
