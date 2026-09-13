import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { mockHa, TOKEN } from './helpers.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function connect(env:Record<string,string>={}) {
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve(process.env.HA_TEST_ENTRY ?? 'dist/index.js')],env,stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',data=>{stderr+=String(data);});
  const client=new Client({name:'synthetic-integration-client',version:'1.0.0'});cleanup.push(()=>client.close());
  await client.connect(transport);return {client,transport,get stderr(){return stderr;}};
}
it('exposes the five tools and a secret-free unconfigured status',async()=>{
  const {client}=await connect();
  expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual(['ha_lovelace_apply','ha_lovelace_preview','ha_rest','ha_status','ha_ws']);
  const status=await client.callTool({name:'ha_status',arguments:{}});
  expect(status.structuredContent).toMatchObject({configured:false});
  const result=await client.callTool({name:'ha_rest',arguments:{method:'GET',path:''}});
  expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({error:{code:'NOT_CONFIGURED'}});
});
it('completes REST and WS calls through STDIO without exposing a synthetic secret',async()=>{
  const ha=await mockHa();cleanup.push(()=>ha.close());
  const connection=await connect({HA_BASE_URL:ha.url,HA_ALLOW_HTTP:'true',HA_TOKEN_SOURCE:'environment',HA_TOKEN_ENV_NAME:'SYNTHETIC_TOKEN',SYNTHETIC_TOKEN:TOKEN});
  const rest=await connection.client.callTool({name:'ha_rest',arguments:{method:'POST',path:'services/light/turn_on',body:{entity_id:'light.example'}}});
  expect(rest.isError).not.toBe(true);expect(rest.structuredContent).toMatchObject({status:200});
  const ws=await connection.client.callTool({name:'ha_ws',arguments:{command:{type:'get_states'}}});
  expect(ws.isError).not.toBe(true);expect(ws.structuredContent).toMatchObject({success:true});
  const events=await connection.client.callTool({name:'ha_ws',arguments:{command:{type:'subscribe_events'},eventLimit:1,waitMs:10}});
  expect(events.structuredContent).toMatchObject({events:[],stopReason:'wait_timeout'});
  expect(JSON.stringify([rest,ws,events])).not.toContain(TOKEN);expect(connection.stderr).toBe('');
});
it('propagates MCP cancellation and frees the active WebSocket',async()=>{
  const ha=await mockHa(undefined,()=>{});cleanup.push(()=>ha.close());
  const {client}=await connect({HA_BASE_URL:ha.url,HA_ALLOW_HTTP:'true',HA_TOKEN_SOURCE:'environment',HA_TOKEN_ENV_NAME:'SYNTHETIC_TOKEN',SYNTHETIC_TOKEN:TOKEN});
  const controller=new AbortController();
  const call=client.callTool({name:'ha_ws',arguments:{command:{type:'get_states'}}},{signal:controller.signal}).catch(error=>error);
  await expect.poll(()=>ha.authenticated).toBe(1);controller.abort();expect(await call).toBeInstanceOf(Error);
  await expect.poll(()=>ha.wss.clients.size).toBe(0);
});
it('terminates active sockets on SIGTERM and starts a fresh instance without replay',async()=>{
  let commands=0;const ha=await mockHa(undefined,()=>{commands++;});cleanup.push(()=>ha.close());
  const env={HA_BASE_URL:ha.url,HA_ALLOW_HTTP:'true',HA_TOKEN_SOURCE:'environment',HA_TOKEN_ENV_NAME:'SYNTHETIC_TOKEN',SYNTHETIC_TOKEN:TOKEN};
  const connection=await connect(env);const call=connection.client.callTool({name:'ha_ws',arguments:{command:{type:'get_states'}}}).catch(error=>error);
  await expect.poll(()=>commands).toBe(1);const pid=connection.transport.pid!;process.kill(pid,'SIGTERM');await call;
  await expect.poll(()=>{try{process.kill(pid,0);return true;}catch{return false;}}).toBe(false);
  await expect.poll(()=>ha.wss.clients.size).toBe(0);
  const fresh=await connect(env);expect((await fresh.client.callTool({name:'ha_status',arguments:{}})).structuredContent).toMatchObject({configured:true});expect(commands).toBe(1);
});
it('closes sockets when the MCP client closes during a call',async()=>{
  const ha=await mockHa(undefined,()=>{});cleanup.push(()=>ha.close());
  const {client}=await connect({HA_BASE_URL:ha.url,HA_ALLOW_HTTP:'true',HA_TOKEN_SOURCE:'environment',HA_TOKEN_ENV_NAME:'SYNTHETIC_TOKEN',SYNTHETIC_TOKEN:TOKEN});
  const call=client.callTool({name:'ha_ws',arguments:{command:{type:'get_states'}}}).catch(e=>e);
  await expect.poll(()=>ha.authenticated).toBe(1);await client.close();await call;await expect.poll(()=>ha.wss.clients.size).toBe(0);
});
it('returns a bounded error when JSON escaping would overflow the client buffer',async()=>{
  const ha=await mockHa((_req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('\\'.repeat(2_097_152));});cleanup.push(()=>ha.close());
  const {client}=await connect({HA_BASE_URL:ha.url,HA_ALLOW_HTTP:'true',HA_TOKEN_SOURCE:'environment',HA_TOKEN_ENV_NAME:'SYNTHETIC_TOKEN',SYNTHETIC_TOKEN:TOKEN});
  const result=await client.callTool({name:'ha_rest',arguments:{method:'GET',path:''}}).catch(error=>({caughtError:error}));
  expect(result).toMatchObject({isError:true,structuredContent:{error:{code:'MCP_RESPONSE_TOO_LARGE'}}});
  expect(JSON.stringify(result).length).toBeLessThan(1024);
});
it('previews and applies a bounded card edit end-to-end over STDIO on a large dashboard',async()=>{
  let saves=0;
  let config={templates:{keep:'unchanged'.repeat(32_000)},views:[{cards:[{type:'button',name:'Before'},{type:'markdown',content:'Neighbor'}]}]};
  const ha=await mockHa(undefined,(ws,msg)=>{
    if(msg.type==='lovelace/config/save'){saves++;config=msg.config as typeof config;}
    ws.send(JSON.stringify({id:msg.id,type:'result',success:true,result:msg.type==='lovelace/config'?config:null}));
  });cleanup.push(()=>ha.close());
  const {client,stderr}=await connect({HA_BASE_URL:ha.url,HA_ALLOW_HTTP:'true',HA_TOKEN_SOURCE:'environment',HA_TOKEN_ENV_NAME:'SYNTHETIC_TOKEN',SYNTHETIC_TOKEN:TOKEN});
  const input={dashboard:'synthetic-dashboard',cardPath:['views',0,'cards',0],operations:[{op:'replace',path:['name'],value:'After'}]};
  const preview=await client.callTool({name:'ha_lovelace_preview',arguments:input});
  expect(preview.isError).not.toBe(true);expect(preview.structuredContent).toMatchObject({before:{name:'Before'},after:{name:'After'},saveScope:'entire_dashboard',atomic:false});expect(saves).toBe(0);
  const review=preview.structuredContent as Record<string,unknown>;
  const applied=await client.callTool({name:'ha_lovelace_apply',arguments:{...input,expectedVersion:review.expectedVersion,expectedPreviewHash:review.previewHash,acknowledgeNonAtomicSave:true}});
  expect(applied.isError).not.toBe(true);expect(applied.structuredContent).toMatchObject({success:true,verified:true});expect(saves).toBe(1);
  expect(config.views[0]!.cards).toEqual([{type:'button',name:'After'},{type:'markdown',content:'Neighbor'}]);expect(config.templates.keep).toBe('unchanged'.repeat(32_000));expect(stderr).toBe('');
});
