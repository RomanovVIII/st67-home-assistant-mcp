#!/usr/bin/env node
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createRuntimeServer } from './server.js';

const handle=serveStdio(()=>createRuntimeServer(),{
  transport:new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:2_097_152}),
  onerror:()=>{process.stderr.write('Home Assistant MCP: protocol transport error\n');},
});
let closing=false;
async function shutdown() {
  if(closing)return;
  closing=true;
  try {await handle.close();}
  catch {process.stderr.write('Home Assistant MCP: shutdown error\n');process.exitCode=1;}
  process.stdin.pause();
}
process.once('SIGINT',()=>{void shutdown();});
process.once('SIGTERM',()=>{void shutdown();});
process.stdin.once('end',()=>{void shutdown();});
