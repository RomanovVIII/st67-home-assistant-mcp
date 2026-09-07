import { afterEach, expect, it } from 'vitest';
import https from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HaBridge } from '../src/bridge.js';
import { parseConfig } from '../src/config.js';
import { mockHa, TOKEN } from './helpers.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
it('rejects an untrusted TLS certificate for both REST and WebSocket before authorization',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ha-mcp-tls-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=synthetic.invalid'],{stdio:'ignore'});
  let requests=0;
  const server=https.createServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},(_req,res)=>{requests++;res.end();});
  server.on('tlsClientError',()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanup.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing port');
  const config=parseConfig({HA_BASE_URL:`https://127.0.0.1:${address.port}`,HA_TOKEN_SOURCE:'environment',HA_TOKEN_ENV_NAME:'EXAMPLE_TOKEN'});
  const bridge=new HaBridge(config,async()=>TOKEN);cleanup.push(()=>bridge.close());
  await expect(bridge.rest({method:'GET',path:''})).rejects.toMatchObject({code:'NETWORK_ERROR'});
  await expect(bridge.ws({command:{type:'get_states'}})).rejects.toMatchObject({code:'WS_CONNECTION_ERROR'});expect(requests).toBe(0);
});
it('rejects a binary response containing literal credential bytes',async()=>{
  const ha=await mockHa((_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.end(Buffer.from(TOKEN));});cleanup.push(()=>ha.close());
  const bridge=new HaBridge(ha.config,async()=>TOKEN);cleanup.push(()=>bridge.close());
  await expect(bridge.rest({method:'GET',path:'',allowBinary:true})).rejects.toMatchObject({code:'SENSITIVE_RESPONSE'});
});
it.each(['text/event-stream','multipart/x-mixed-replace','video/mp4'])('refuses unbounded streaming media %s',async type=>{
  const ha=await mockHa((_req,res)=>{res.writeHead(200,{'content-type':type});res.end('synthetic-data');});cleanup.push(()=>ha.close());
  const bridge=new HaBridge(ha.config,async()=>TOKEN);cleanup.push(()=>bridge.close());
  await expect(bridge.rest({method:'GET',path:''})).rejects.toMatchObject({code:'UNSUPPORTED_RESPONSE'});
});
it('does not forward a caller-supplied authorization header',async()=>{
  const ha=await mockHa();cleanup.push(()=>ha.close());const bridge=new HaBridge(ha.config,async()=>TOKEN);cleanup.push(()=>bridge.close());
  await expect(bridge.rest({method:'GET',path:'',headers:{Authorization:'Bearer alternate'}})).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(ha.requests).toHaveLength(0);
});
it('bounds aggregate subscription data and marks partial results',async()=>{
  const ha=await mockHa(undefined,(ws,msg)=>{ws.send(JSON.stringify({id:msg.id,type:'result',success:true,result:null}));for(let i=0;i<10;i++)ws.send(JSON.stringify({id:msg.id,type:'event',event:{value:'x'.repeat(150)}}));});cleanup.push(()=>ha.close());
  const bridge=new HaBridge(ha.config,async()=>TOKEN,{maxResponseBytes:1024});cleanup.push(()=>bridge.close());
  const result=await bridge.ws({command:{type:'subscribe_events'},eventLimit:100});expect(result).toMatchObject({stopReason:'size_limit',incomplete:true});expect(result.events.length).toBeGreaterThan(0);expect(result.events.length).toBeLessThan(10);
});
it('requires explicit opt-in before releasing an opaque binary response',async()=>{
  const ha=await mockHa((_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.end(Buffer.from([1,2,3]));});cleanup.push(()=>ha.close());
  const bridge=new HaBridge(ha.config,async()=>TOKEN);cleanup.push(()=>bridge.close());
  await expect(bridge.rest({method:'GET',path:''})).rejects.toMatchObject({code:'BINARY_OPT_IN_REQUIRED'});
});
it('marks explicitly requested opaque binary content as uninspected',async()=>{
  const {gzipSync}=await import('node:zlib');
  const bytes=gzipSync(JSON.stringify({access_token:TOKEN}));
  const ha=await mockHa((_req,res)=>{res.writeHead(200,{'content-type':'application/octet-stream'});res.end(bytes);});cleanup.push(()=>ha.close());
  const bridge=new HaBridge(ha.config,async()=>TOKEN);cleanup.push(()=>bridge.close());
  expect(await bridge.rest({method:'GET',path:'',allowBinary:true})).toMatchObject({encoding:'base64',binaryUninspected:true,data:bytes.toString('base64')});
});
