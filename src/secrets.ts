import { execFile } from 'node:child_process';
import type { Config } from './config.js';
import type { TokenProvider } from './bridge.js';
import { BridgeError } from './errors.js';

export function createTokenProvider(config:Config,env:Readonly<Record<string,string|undefined>>=process.env):TokenProvider {
  const source=config.secret;
  return async signal=>{
    signal.throwIfAborted();
    if(source.kind==='environment') {
      const value=env[source.name];
      if(!value)throw new BridgeError('SECRET_UNAVAILABLE');
      return value;
    }
    if(process.platform!=='darwin')throw new BridgeError('KEYCHAIN_UNSUPPORTED');
    return new Promise((resolve,reject)=>{
      execFile('/usr/bin/security',['find-generic-password','-s',source.service,'-a',source.account,'-w'],
        {encoding:'utf8',timeout:10_000,maxBuffer:16385,signal,shell:false},(error,stdout)=>{
          if(error)reject(new BridgeError('SECRET_UNAVAILABLE'));
          else resolve(stdout.replace(/\r?\n$/,''));
        });
    });
  };
}
