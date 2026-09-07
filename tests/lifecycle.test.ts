import { afterEach, expect, it } from 'vitest';
import { HaBridge } from '../src/bridge.js';
import { mockHa, TOKEN } from './helpers.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(...args:Parameters<typeof mockHa>){const ha=await mockHa(...args);cleanup.push(()=>ha.close());const bridge=new HaBridge(ha.config,async()=>TOKEN,{timeoutMs:200,authTimeoutMs:100});cleanup.push(()=>bridge.close());return{ha,bridge};}

it('cancels an in-flight write twice, frees capacity and never retries it',async()=>{
  let calls=0;const {bridge}=await setup((_req,res)=>{calls++;if(calls>1){res.writeHead(200,{'content-type':'text/plain'});res.end('ok');}});
  const abort=new AbortController();
  const call=bridge.rest({method:'POST',path:''},abort.signal);
  const assertion=expect(call).rejects.toMatchObject({code:'CANCELLED',resultUnknown:true});
  await expect.poll(()=>calls).toBe(1);abort.abort();abort.abort();await assertion;
  expect(await bridge.rest({method:'GET',path:''})).toMatchObject({status:200});expect(calls).toBe(2);
});
it('rejects already cancelled work without contacting HA',async()=>{
  const {bridge,ha}=await setup();const abort=new AbortController();abort.abort();
  await expect(bridge.ws({command:{type:'get_states'}},abort.signal)).rejects.toMatchObject({code:'CANCELLED',resultUnknown:false});expect(ha.authenticated).toBe(0);
});
it('enforces concurrency per instance and releases every slot after cancellation',async()=>{
  const {bridge}=await setup(()=>{});const controllers=Array.from({length:4},()=>new AbortController());
  const calls=controllers.map(c=>bridge.rest({method:'GET',path:''},c.signal).catch(error=>error));
  await expect(bridge.rest({method:'GET',path:''})).rejects.toMatchObject({code:'BUSY'});
  controllers.forEach(c=>c.abort());expect((await Promise.all(calls)).every(e=>e.code==='CANCELLED')).toBe(true);
  const controller=new AbortController();const next=bridge.rest({method:'GET',path:''},controller.signal).catch(e=>e);controller.abort();expect((await next).code).toBe('CANCELLED');
});
it('isolates profile addresses and credentials',async()=>{
  const a=await setup(),b=await setup();const other='another-synthetic-secret';const otherBridge=new HaBridge(b.ha.config,async()=>other);cleanup.push(()=>otherBridge.close());
  await Promise.all([a.bridge.rest({method:'GET',path:'states/first'}),otherBridge.rest({method:'GET',path:'states/second'})]);
  expect(a.ha.requests[0]).toMatchObject({url:'/api/states/first',authorization:`Bearer ${TOKEN}`});
  expect(b.ha.requests[0]).toMatchObject({url:'/api/states/second',authorization:`Bearer ${other}`});
});
it('closes active work and prevents calls on a closed bridge',async()=>{
  const {bridge,ha}=await setup(undefined,()=>{});
  const call=bridge.ws({command:{type:'get_states'}}).catch(e=>e);await expect.poll(()=>ha.authenticated).toBe(1);
  bridge.close();expect((await call).code).toBe('CANCELLED');await expect(bridge.rest({method:'GET',path:''})).rejects.toMatchObject({code:'BRIDGE_CLOSED'});
});
it('bounds token provider wait even when a provider ignores its abort signal',async()=>{
  const {ha}=await setup();const bridge=new HaBridge(ha.config,()=>new Promise(()=>{}),{timeoutMs:20});cleanup.push(()=>bridge.close());
  await expect(bridge.rest({method:'GET',path:''})).rejects.toMatchObject({code:'TIMEOUT',resultUnknown:false});
},1000);
it('does not accumulate live connections across 200 commands or keep a burst subscription',async()=>{
  const {bridge,ha}=await setup(undefined,(ws,msg)=>{
    ws.send(JSON.stringify({id:msg.id,type:'result',success:true,result:null}));
    if(msg.type==='subscribe_events')for(let i=0;i<1000;i++)ws.send(JSON.stringify({id:msg.id,type:'event',event:{value:i}}));
  });
  for(let i=0;i<200;i++)await bridge.ws({command:{type:'get_states'}});
  const result=await bridge.ws({command:{type:'subscribe_events'},eventLimit:100});expect(result.events).toHaveLength(100);
  await expect.poll(()=>ha.wss.clients.size).toBe(0);
},10000);
it('bounds oversized WS frames and closes the socket',async()=>{
  const {ha}=await setup(undefined,(ws,msg)=>ws.send(JSON.stringify({id:msg.id,type:'result',success:true,result:'x'.repeat(4096)})));
  const bridge=new HaBridge(ha.config,async()=>TOKEN,{maxResponseBytes:1024});cleanup.push(()=>bridge.close());
  await expect(bridge.ws({command:{type:'get_states'}})).rejects.toMatchObject({code:'WS_CONNECTION_ERROR'});await expect.poll(()=>ha.wss.clients.size).toBe(0);
});
it('rejects oversized requests without making an API request',async()=>{
  const {ha}=await setup();const bridge=new HaBridge(ha.config,async()=>TOKEN,{maxRequestBytes:64});cleanup.push(()=>bridge.close());
  await expect(bridge.rest({method:'POST',path:'',body:'x'.repeat(100)})).rejects.toMatchObject({code:'REQUEST_TOO_LARGE',resultUnknown:false});
  await expect(bridge.ws({command:{type:'example',value:'x'.repeat(100)}})).rejects.toMatchObject({code:'REQUEST_TOO_LARGE',resultUnknown:false});expect(ha.requests).toHaveLength(0);expect(ha.authenticated).toBe(0);
});
