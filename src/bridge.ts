import type { Config } from './config.js';
import { BridgeError } from './errors.js';
import { DEFAULT_LIMITS, type Limits, type Operation } from './operation.js';
import { redact } from './redaction.js';
import { requestRest, type RestResult } from './rest.js';
import { requestWebSocket, type WsResult } from './websocket.js';

export type TokenProvider=(signal:AbortSignal)=>Promise<string>;
export class HaBridge {
  readonly #active=new Set<AbortController>();
  readonly #limits:Limits;
  #closed=false;
  constructor(readonly config:Config, readonly tokenProvider:TokenProvider, limits:Partial<Limits>={}) {
    this.#limits={...DEFAULT_LIMITS,...limits};
    if(Object.values(this.#limits).some(v=>!Number.isSafeInteger(v)||v<=0))throw new BridgeError('INVALID_LIMITS');
  }
  rest(input:unknown,signal?:AbortSignal):Promise<RestResult> {return this.#call((token,op)=>requestRest(this.config,input,token,op),signal);}
  ws(input:unknown,signal?:AbortSignal):Promise<WsResult> {return this.#call((token,op)=>requestWebSocket(this.config,input,token,op),signal);}
  close():void {this.#closed=true;for(const controller of this.#active)controller.abort();}
  async #call<T>(execute:(token:string,op:Operation)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    if(this.#closed)throw new BridgeError('BRIDGE_CLOSED');
    if(this.#active.size>=this.#limits.maxConcurrent)throw new BridgeError('BUSY');
    const controller=new AbortController();this.#active.add(controller);
    let timedOut=false,sent=false;
    const cancel=()=>controller.abort();
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},this.#limits.timeoutMs);
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    try {
      controller.signal.throwIfAborted();
      const token=await abortable(this.tokenProvider(controller.signal),controller.signal);
      controller.signal.throwIfAborted();
      if(!token || token.length>16384 || /[\s\x00-\x1f\x7f]/u.test(token))throw new BridgeError('SECRET_UNAVAILABLE');
      const result=await execute(token,{signal:controller.signal,limits:this.#limits,markSent:()=>{sent=true;}});
      return redact(result,token) as T;
    }catch(error){
      if(controller.signal.aborted)throw new BridgeError(timedOut?'TIMEOUT':'CANCELLED',sent);
      throw new BridgeError(error instanceof BridgeError?error.code:'REQUEST_FAILED',sent);
    }finally{
      clearTimeout(timer);signal?.removeEventListener('abort',cancel);this.#active.delete(controller);
    }
  }
}

function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new BridgeError('CANCELLED'));};
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
