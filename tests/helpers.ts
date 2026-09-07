import http, { type RequestListener } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseConfig } from '../src/config.js';

export const TOKEN = 'synthetic-ha-token-not-a-real-credential';
export async function mockHa(handler?: RequestListener, command?: (ws: WebSocket, msg: Record<string,unknown>) => void, auth = true) {
  const requests: Array<{ method: string; url: string; authorization: string; body: string }> = [];
  const server = http.createServer(handler ?? (async (req,res) => {
    let body = ''; for await (const chunk of req) body += String(chunk);
    requests.push({ method:req.method!, url:req.url!, authorization:req.headers.authorization ?? '', body });
    res.writeHead(200, { 'content-type':'application/json' });
    res.end(JSON.stringify({ ok:true }));
  }));
  const wss = new WebSocketServer({ server, path:'/api/websocket' });
  let authenticated = 0;
  wss.on('connection', ws => {
    ws.send(JSON.stringify({ type:'auth_required', ha_version:'synthetic' }));
    ws.on('message', raw => {
      const msg=JSON.parse(raw.toString());
      if (msg.type === 'auth') {
        if(auth && msg.access_token === TOKEN) { authenticated++; ws.send(JSON.stringify({type:'auth_ok',ha_version:'synthetic'})); }
        else ws.send(JSON.stringify({type:'auth_invalid',message:'synthetic rejection'}));
      } else if(command) command(ws,msg);
      else ws.send(JSON.stringify({id:msg.id,type:'result',success:true,result:{echo:msg}}));
    });
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address(); if(!address || typeof address === 'string') throw new Error('No address');
  const url=`http://127.0.0.1:${address.port}`;
  return {
    url, requests, wss, get authenticated(){ return authenticated; },
    config:parseConfig({ HA_BASE_URL:url, HA_ALLOW_HTTP:'true', HA_TOKEN_SOURCE:'environment', HA_TOKEN_ENV_NAME:'SYNTHETIC_TOKEN' }),
    async close() { for(const ws of wss.clients) ws.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
