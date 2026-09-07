import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { HaBridge } from './bridge.js';
import { parseConfig } from './config.js';
import { BridgeError } from './errors.js';
import { restSchema } from './rest.js';
import { createTokenProvider } from './secrets.js';
import { wsSchema } from './websocket.js';

export const VERSION='0.1.0';
const apiAnnotations={readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true};
function response(data:Record<string,unknown>,isError=false) {
  const result={content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data,...(isError?{isError:true}:{})};
  // Both MCP representations and their JSON escaping count toward the output budget.
  if(Buffer.byteLength(JSON.stringify(result))>2_097_152) {
    const safe={error:{code:'MCP_RESPONSE_TOO_LARGE',resultUnknown:true}};
    return {content:[{type:'text' as const,text:JSON.stringify(safe)}],structuredContent:safe,isError:true};
  }
  return result;
}

export function createRuntimeServer(env:Readonly<Record<string,string|undefined>>=process.env):McpServer {
  let bridge:HaBridge|undefined;
  let configurationError:string|undefined;
  if(Object.keys(env).some(key=>key.startsWith('HA_'))) {
    try {const config=parseConfig(env);bridge=new HaBridge(config,createTokenProvider(config,env));}
    catch {configurationError='INVALID_CONFIG';}
  }
  const server=new McpServer({name:'st67-home-assistant-mcp',version:VERSION},{capabilities:{tools:{}},instructions:'On-demand Home Assistant API bridge. REST and WebSocket tools can change or delete data. Follow user authorization and verify effects. No automatic monitoring or retries.'});
  server.server.onclose=()=>bridge?.close();
  server.registerTool('ha_status',{
    title:'Home Assistant bridge status',description:'Local configuration status only. Does not read credentials or contact Home Assistant.',inputSchema:z.object({}).strict(),
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },async()=>response({version:VERSION,configured:bridge!==undefined,tokenSource:bridge?.config.secret.kind ?? null,monitoring:false,...(configurationError?{configurationError}:{})}));
  async function execute(kind:'rest'|'ws',input:unknown,signal:AbortSignal) {
    if(!bridge)return response({error:{code:configurationError ?? 'NOT_CONFIGURED',resultUnknown:false}},true);
    try {
      const result=kind==='rest'?await bridge.rest(input,signal):await bridge.ws(input,signal);
      const isError='status' in result?result.status>=400:!result.success;
      return response({...result},isError);
    }catch(error){
      return response({error:{code:error instanceof BridgeError?error.code:'REQUEST_FAILED',resultUnknown:error instanceof BridgeError?error.resultUnknown:false}},true);
    }
  }
  server.registerTool('ha_rest',{
    title:'Home Assistant REST API',description:'Call a supported method under /api/. Path is relative, for example states or services/light/turn_on. Never retries writes. Responses and duration are bounded.',inputSchema:restSchema,annotations:apiAnnotations,
  },(input,ctx)=>execute('rest',input,ctx.mcpReq.signal));
  server.registerTool('ha_ws',{
    title:'Home Assistant WebSocket API',description:'Send one supported Home Assistant command. The bridge owns authentication and request IDs. Optional bounded event collection stays within this call; the socket always closes afterwards. No monitoring or retries.',inputSchema:wsSchema,annotations:apiAnnotations,
  },(input,ctx)=>execute('ws',input,ctx.mcpReq.signal));
  return server;
}
