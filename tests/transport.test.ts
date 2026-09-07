import { afterEach, describe, expect, it } from 'vitest';
import { HaBridge } from '../src/bridge.js';
import { mockHa, TOKEN } from './helpers.js';
const cleanup: Array<()=>void|Promise<void>>=[];
afterEach(async()=>{ for(const close of cleanup.splice(0).reverse()) await close(); });
async function setup(...args: Parameters<typeof mockHa>) {
  const ha=await mockHa(...args); cleanup.push(()=>ha.close());
  const bridge=new HaBridge(ha.config, async()=>TOKEN, { timeoutMs:300, authTimeoutMs:100 }); cleanup.push(()=>bridge.close());
  return {ha,bridge};
}
describe('REST exchange',()=>{
  it.each(['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE'] as const)('forwards %s with exact query and JSON body',async method=>{
    const {ha,bridge}=await setup();
    const result=await bridge.rest({method,path:'services/light/turn_on',query:[['a','one'],['a','two']],...(!['GET','HEAD'].includes(method)?{body:{entity_id:'light.example'}}:{})});
    expect(result.status).toBe(200);
    expect(ha.requests).toEqual([{method,url:'/api/services/light/turn_on?a=one&a=two',authorization:`Bearer ${TOKEN}`,body:['GET','HEAD'].includes(method)?'':'{"entity_id":"light.example"}'}]);
  });
  it('preserves HTTP errors but removes tokens',async()=>{
    const {bridge}=await setup((_req,res)=>{res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({message:TOKEN,access_token:'another-token'}));});
    const result=await bridge.rest({method:'GET',path:''});
    expect(result.status).toBe(401); expect(JSON.stringify(result)).not.toContain(TOKEN); expect(JSON.stringify(result)).not.toContain('another-token');
  });
  it.each([['text/plain','plain text','text','plain text'],['application/octet-stream','\x01\x02','base64','AQI=']] as const)('returns bounded %s response',async(type,body,encoding,data)=>{
    const {bridge}=await setup((_req,res)=>{res.writeHead(200,{'content-type':type});res.end(body);});
    expect(await bridge.rest({method:'GET',path:'',allowBinary:encoding==='base64'})).toMatchObject({encoding,data});
  });
  it('does not follow redirects or return response headers with secrets',async()=>{
    const {bridge,ha}=await setup((_req,res)=>{res.writeHead(302,{location:'https://elsewhere.invalid/', 'set-cookie':TOKEN});res.end();});
    await expect(bridge.rest({method:'GET',path:''})).rejects.toMatchObject({code:'REDIRECT_BLOCKED'});
    expect(ha.authenticated).toBe(0);
  });
  it('limits a chunked response without content length',async()=>{
    const {ha}=await setup((_req,res)=>{res.writeHead(200);res.write('12345');res.end('67890');});
    const bridge=new HaBridge(ha.config,async()=>TOKEN,{maxResponseBytes:8});cleanup.push(()=>bridge.close());
    await expect(bridge.rest({method:'POST',path:'test'})).rejects.toMatchObject({code:'RESPONSE_TOO_LARGE',resultUnknown:true});
  });
  it('rejects GET bodies and unsupported content types before network access',async()=>{
    const {bridge,ha}=await setup();
    await expect(bridge.rest({method:'GET',path:'',body:{bad:true}})).rejects.toMatchObject({code:'INVALID_REQUEST'});
    await expect(bridge.rest({method:'POST',path:'',body:'x',contentType:'multipart/form-data'})).rejects.toMatchObject({code:'INVALID_REQUEST'});
    expect(ha.requests).toHaveLength(0);
  });
  it('times out a write without retry and marks result unknown',async()=>{
    let calls=0;const {bridge}=await setup(()=>{calls++;});
    await expect(bridge.rest({method:'POST',path:'test'})).rejects.toMatchObject({code:'TIMEOUT',resultUnknown:true});expect(calls).toBe(1);
  });
});
describe('WebSocket exchange',()=>{
  it('authenticates, assigns id and returns arbitrary supported command results',async()=>{
    const {bridge,ha}=await setup();
    expect(await bridge.ws({command:{type:'config/entity_registry/list'}})).toMatchObject({success:true,result:{echo:{id:1,type:'config/entity_registry/list'}},events:[],stopReason:'result'});
    expect(ha.authenticated).toBe(1);
  });
  it('rejects auth failure without exposing server message',async()=>{
    const {bridge}=await setup(undefined,undefined,false);
    await expect(bridge.ws({command:{type:'get_states'}})).rejects.toMatchObject({code:'AUTH_FAILED'});
  });
  it('retains API command errors and handles pong',async()=>{
    const {bridge}=await setup(undefined,(ws,msg)=>ws.send(JSON.stringify(msg.type==='ping'?{id:msg.id,type:'pong'}:{id:msg.id,type:'result',success:false,error:{code:'unknown_command',message:TOKEN}})));
    expect(await bridge.ws({command:{type:'ping'}})).toMatchObject({success:true,result:null});
    const result=await bridge.ws({command:{type:'unknown'}});expect(result.success).toBe(false);expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
  it('collects matching subscription events up to the limit then closes',async()=>{
    const {bridge}=await setup(undefined,(ws,msg)=>{
      ws.send(JSON.stringify({id:msg.id,type:'result',success:true,result:null}));
      ws.send(JSON.stringify({id:999,type:'event',event:{wrong:true}}));
      for(let i=0;i<10;i++)ws.send(JSON.stringify({id:msg.id,type:'event',event:{value:i}}));
    });
    expect(await bridge.ws({command:{type:'subscribe_events'},eventLimit:2,waitMs:100})).toMatchObject({events:[{value:0},{value:1}],stopReason:'event_limit'});
  });
  it('returns an empty subscription after its waiting period',async()=>{
    const {bridge}=await setup();
    expect(await bridge.ws({command:{type:'subscribe_events'},eventLimit:1,waitMs:20})).toMatchObject({events:[],stopReason:'wait_timeout'});
  });
  it.each([{type:'auth'},{type:'get_states',id:9}])('rejects reserved protocol input',async command=>{
    const {bridge,ha}=await setup();await expect(bridge.ws({command})).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(ha.authenticated).toBe(0);
  });
  it('rejects malformed frames and closes on unexpected disconnect',async()=>{
    const {bridge}=await setup(undefined,ws=>ws.send('{malformed'));
    await expect(bridge.ws({command:{type:'get_states'}})).rejects.toMatchObject({code:'WS_PROTOCOL_ERROR'});
  });
  it('returns partial events explicitly when the connection closes',async()=>{
    const {bridge}=await setup(undefined,(ws,msg)=>{
      ws.send(JSON.stringify({id:msg.id,type:'result',success:true,result:null}));
      ws.send(JSON.stringify({id:msg.id,type:'event',event:{value:1}}));ws.close();
    });
    expect(await bridge.ws({command:{type:'subscribe_events'},eventLimit:2,waitMs:100})).toMatchObject({events:[{value:1}],stopReason:'connection_closed',incomplete:true});
  });
});
