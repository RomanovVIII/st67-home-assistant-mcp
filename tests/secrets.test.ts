import { beforeEach, expect, it, vi } from 'vitest';
const exec = vi.hoisted(()=>vi.fn());
vi.mock('node:child_process',()=>({execFile:exec}));
import { createTokenProvider } from '../src/secrets.js';
import { parseConfig } from '../src/config.js';
const keychain=parseConfig({HA_BASE_URL:'https://ha.example.invalid',HA_TOKEN_SOURCE:'keychain',HA_KEYCHAIN_SERVICE:'synthetic-service',HA_KEYCHAIN_ACCOUNT:'synthetic-account'});
beforeEach(()=>{exec.mockReset();});
it('reads environment lazily and fails safely when missing',async()=>{
  const env:Record<string,string>={};const config=parseConfig({HA_BASE_URL:'https://ha.example.invalid',HA_TOKEN_SOURCE:'environment',HA_TOKEN_ENV_NAME:'EXAMPLE_TOKEN'});
  const get=createTokenProvider(config,env);env.EXAMPLE_TOKEN='synthetic-token';expect(await get(new AbortController().signal)).toBe('synthetic-token');
  delete env.EXAMPLE_TOKEN;await expect(get(new AbortController().signal)).rejects.toMatchObject({code:'SECRET_UNAVAILABLE'});
});
it('uses an exact Keychain reference without shell interpolation or write',async()=>{
  exec.mockImplementation((file,args,opts,callback)=>{expect(file).toBe('/usr/bin/security');expect(args).toEqual(['find-generic-password','-s','synthetic-service','-a','synthetic-account','-w']);expect(opts.shell).not.toBe(true);callback(null,'synthetic-token\n','');});
  expect(await createTokenProvider(keychain)(new AbortController().signal)).toBe('synthetic-token');
});
it('never returns Keychain stderr in an error',async()=>{
  exec.mockImplementation((_file,_args,_opts,callback)=>callback(new Error('sensitive diagnostic'),'', 'sensitive diagnostic'));
  await expect(createTokenProvider(keychain)(new AbortController().signal)).rejects.toMatchObject({code:'SECRET_UNAVAILABLE',message:'SECRET_UNAVAILABLE'});
});
