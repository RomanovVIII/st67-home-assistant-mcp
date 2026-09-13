import { afterEach, expect, it } from 'vitest';
import { HaBridge } from '../src/bridge.js';
import { mockHa, TOKEN } from './helpers.js';
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
const target={dashboard:'synthetic-dashboard',cardPath:['views',0,'sections',1,'cards',0]};
const operations=[{op:'replace',path:['name'],value:'New title'}];
type Fixture={title:string;templates:{large:string};views:Array<{sections:Array<{cards:Array<Record<string,unknown>&{type:string;name?:string}>}>}>};
function fixture():Fixture{return {title:'Synthetic',templates:{large:'x'.repeat(250_000)},views:[{sections:[{cards:[{type:'markdown',content:'Keep adjacent card exactly'}]},{cards:[{type:'custom:button-card',name:'Old title',show_state:true,custom_fields:{template:'[[[ return entity.state; ]]]'},styles:{card:[{width:'100%'}]}},{type:'button',name:'Other'}]}]}]};}
async function setup(options:{beforeRead?:(read:number,config:ReturnType<typeof fixture>)=>void;afterSave?:(config:ReturnType<typeof fixture>)=>void;disconnectSave?:boolean;rejectSave?:boolean;failReadback?:boolean}={}){
 let config=fixture(),reads=0,saves=0;
 const ha=await mockHa(undefined,(ws,msg)=>{
  if(msg.type==='lovelace/config'){
   reads++;options.beforeRead?.(reads,config);
   if(options.failReadback&&saves){ws.terminate();return;}
   ws.send(JSON.stringify({id:msg.id,type:'result',success:true,result:config}));
  }else if(msg.type==='lovelace/config/save'){
   saves++;
   if(options.rejectSave){ws.send(JSON.stringify({id:msg.id,type:'result',success:false,error:{code:'not_supported'}}));return;}
   config=structuredClone(msg.config) as typeof config;options.afterSave?.(config);
   if(options.disconnectSave){ws.terminate();return;}
   ws.send(JSON.stringify({id:msg.id,type:'result',success:true,result:null}));
  }else throw new Error('Unexpected request');
 });cleanup.push(()=>ha.close());
 const bridge=new HaBridge(ha.config,async()=>TOKEN);cleanup.push(()=>bridge.close());
 return {bridge,get config(){return config;},get reads(){return reads;},get saves(){return saves;}};
}
function applyInput(preview:any){return {...target,operations,expectedVersion:preview.expectedVersion,expectedPreviewHash:preview.previewHash,acknowledgeNonAtomicSave:true};}
it('previews a single card inside a >200 KB fixture without saving or leaking unrelated content',async()=>{
 const s=await setup();const before=structuredClone(s.config);
 const p=await s.bridge.lovelacePreview({...target,operations});
 expect(p.before).toMatchObject({name:'Old title'});expect(p.after).toMatchObject({name:'New title'});
 expect(p.expectedVersion).toMatch(/^[a-f0-9]{64}$/);expect(p.previewHash).toMatch(/^[a-f0-9]{64}$/);
 expect(JSON.stringify(p)).not.toContain('Keep adjacent');expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(160_000);
 expect(s.saves).toBe(0);expect(s.config).toEqual(before);
});
it('applies only the reviewed change and verifies the complete saved result',async()=>{
 const s=await setup();const before=structuredClone(s.config);const p=await s.bridge.lovelacePreview({...target,operations});
 const result=await s.bridge.lovelaceApply(applyInput(p));
 before.views[0]!.sections[1]!.cards[0]!.name='New title';
 expect(s.config).toEqual(before);expect(s.saves).toBe(1);expect(result).toMatchObject({success:true,verified:true,atomic:false});
});
it('rejects a stale whole-dashboard version, including edits outside the target',async()=>{
 const s=await setup();const p=await s.bridge.lovelacePreview({...target,operations});s.config.title='Concurrent edit';
 await expect(s.bridge.lovelaceApply(applyInput(p))).rejects.toMatchObject({code:'STALE_DASHBOARD',resultUnknown:false});
 expect(s.saves).toBe(0);expect(s.config.title).toBe('Concurrent edit');
});
it('rechecks immediately before writing and preserves a concurrent edit',async()=>{
 const s=await setup({beforeRead:(read,c)=>{if(read===3)c.title='Concurrent edit';}});const p=await s.bridge.lovelacePreview({...target,operations});
 await expect(s.bridge.lovelaceApply(applyInput(p))).rejects.toMatchObject({code:'STALE_DASHBOARD',resultUnknown:false});expect(s.saves).toBe(0);
});
it('binds apply to the exact preview operations',async()=>{
 const s=await setup();const p=await s.bridge.lovelacePreview({...target,operations});
 await expect(s.bridge.lovelaceApply({...applyInput(p),operations:[{op:'replace',path:['name'],value:'Unreviewed'}]})).rejects.toMatchObject({code:'PREVIEW_MISMATCH'});expect(s.saves).toBe(0);
});
it.each([
 {...target,cardPath:['views',0],operations},
 {...target,cardPath:['views',0,'sections',0],operations},
 {...target,operations:[{op:'replace',path:['__proto__','polluted'],value:true}]},
 {...target,operations:[{op:'move',path:['name'],from:['type']}]},
 {...target,operations:[{op:'replace',path:[],value:{type:'button'}}]},
 {...target,operations:[{op:'replace',path:['missing','name'],value:'x'}]},
 {...target,operations:[{op:'remove',path:['type']}]},
 {...target,operations:[{op:'replace',path:['name'],value:'x'}],unexpected:true},
])('rejects invalid paths, operations or card shape without writing: %j',async input=>{
 const s=await setup();await expect(s.bridge.lovelacePreview(input)).rejects.toBeDefined();expect(s.saves).toBe(0);
 expect(({} as Record<string,unknown>).polluted).toBeUndefined();
});
it('supports explicit add/remove and array element replacement within one card',async()=>{
 const s=await setup();const p=await s.bridge.lovelacePreview({...target,operations:[{op:'add',path:['icon'],value:'mdi:test-tube'},{op:'remove',path:['show_state']},{op:'replace',path:['styles','card',0,'width'],value:'75%'}]});
 expect(p.after).toMatchObject({icon:'mdi:test-tube',styles:{card:[{width:'75%'}]}});expect(p.after).not.toHaveProperty('show_state');expect(s.saves).toBe(0);
});
it('refuses an oversized card instead of truncating the review',async()=>{
 const s=await setup();s.config.views[0]!.sections[1]!.cards[0]!.name='x'.repeat(70_000);
 await expect(s.bridge.lovelacePreview({...target,operations})).rejects.toMatchObject({code:'CARD_TOO_LARGE'});expect(s.saves).toBe(0);
});
it('previews and applies a 32,240-byte UTF-8 template card without truncation or adjacent changes',async()=>{
 const s=await setup();const card=s.config.views[0]!.sections[1]!.cards[0]!;
 card.styles={card:[{'max-width':'700px'}]};
 card.custom_fields={template:'[[[ return "quoted"; ]]]\\\n'.repeat(200)+'ж'.repeat(425)};
 card.name='x'.repeat(31_815-JSON.stringify(card).length+card.name!.length);
 expect(JSON.stringify(card).length).toBe(31_815);expect(Buffer.byteLength(JSON.stringify(card))).toBe(32_240);
 const before=structuredClone(s.config);
 const edit={...target,operations:[{op:'replace',path:['styles','card',0,'max-width'],value:'480px'}]};
 const p=await s.bridge.lovelacePreview(edit);
 const expected=structuredClone(card);expected.styles={card:[{'max-width':'480px'}]};
 expect(p.before).toEqual(card);expect(p.after).toEqual(expected);expect(s.saves).toBe(0);
 const review={content:[{type:'text',text:JSON.stringify(p)}],structuredContent:p};
 expect(Buffer.byteLength(JSON.stringify(review))).toBeLessThanOrEqual(160_000);
 expect(await s.bridge.lovelaceApply({...edit,expectedVersion:p.expectedVersion,expectedPreviewHash:p.previewHash,acknowledgeNonAtomicSave:true})).toMatchObject({success:true,verified:true});
 before.views[0]!.sections[1]!.cards[0]=expected;expect(s.config).toEqual(before);
});
it('counts UTF-8 bytes rather than characters for the individual card limit',async()=>{
 const s=await setup();s.config.views[0]!.sections[1]!.cards[0]!.name='ж'.repeat(40_000);
 expect(JSON.stringify(s.config.views[0]!.sections[1]!.cards[0]).length).toBeLessThan(65_536);
 await expect(s.bridge.lovelacePreview({...target,operations})).rejects.toMatchObject({code:'CARD_TOO_LARGE'});expect(s.saves).toBe(0);
});
it('can review a card above 36 KB when the complete before/after fits the overall budget',async()=>{
 const s=await setup();const card=s.config.views[0]!.sections[1]!.cards[0]!;card.name='ж'.repeat(25_000);
 const p=await s.bridge.lovelacePreview({...target,operations});
 expect(p.before).toEqual(card);expect(p.after.name).toBe('New title');
 expect(Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(p)}],structuredContent:p}))).toBeLessThanOrEqual(160_000);
 expect(s.saves).toBe(0);
});
it('refuses growth past the card byte limit before any write',async()=>{
 const s=await setup();const card=s.config.views[0]!.sections[1]!.cards[0]!;card.name='x'.repeat(60_000);
 await expect(s.bridge.lovelacePreview({...target,operations:[{op:'add',path:['label'],value:'y'.repeat(7_000)}]})).rejects.toMatchObject({code:'CARD_TOO_LARGE'});expect(s.saves).toBe(0);
});
it('counts escaped text, structured content and operations toward the unchanged total review limit',async()=>{
 const s=await setup();const card=s.config.views[0]!.sections[1]!.cards[0]!;card.name='"'.repeat(16_000);
 const edit={...target,operations:[{op:'add',path:['label'],value:'x'.repeat(2_000)}]};
 expect(Buffer.byteLength(JSON.stringify(card))).toBeLessThan(65_536);
 await expect(s.bridge.lovelacePreview(edit)).rejects.toMatchObject({code:'PREVIEW_TOO_LARGE'});expect(s.saves).toBe(0);
});
it.each([65_536,65_537])('enforces the individual UTF-8 boundary at %i bytes independently of review size',async bytes=>{
 const s=await setup();const card=s.config.views[0]!.sections[1]!.cards[0]!;
 card.name='x'.repeat(bytes-Buffer.byteLength(JSON.stringify(card))+card.name!.length);
 expect(Buffer.byteLength(JSON.stringify(card))).toBe(bytes);
 const result=s.bridge.lovelacePreview({...target,operations});
 if(bytes===65_536)expect((await result).before).toEqual(card);
 else await expect(result).rejects.toMatchObject({code:'CARD_TOO_LARGE'});
 expect(s.saves).toBe(0);
});
it('refuses a large diff even when input and both cards separately fit',async()=>{
 const s=await setup();const card=s.config.views[0]!.sections[1]!.cards[0]!;card.name='x'.repeat(30_000);
 const edit={...target,operations:[{op:'add',path:['label'],value:'y'.repeat(25_000)}]};
 expect(Buffer.byteLength(JSON.stringify(edit))).toBeLessThan(32_000);
 expect(Buffer.byteLength(JSON.stringify({...card,label:'y'.repeat(25_000)}))).toBeLessThan(65_536);
 await expect(s.bridge.lovelacePreview(edit)).rejects.toMatchObject({code:'PREVIEW_TOO_LARGE'});expect(s.saves).toBe(0);
});
it('refuses a review whose contents would be redacted',async()=>{
 const s=await setup();s.config.views[0]!.sections[1]!.cards[0]!.name=TOKEN;
 await expect(s.bridge.lovelacePreview({...target,operations})).rejects.toMatchObject({code:'PREVIEW_NOT_REVIEWABLE'});expect(s.saves).toBe(0);
});
it('requires explicit acknowledgement of non-atomic saving',async()=>{
 const s=await setup();const p=await s.bridge.lovelacePreview({...target,operations});
 await expect(s.bridge.lovelaceApply({...applyInput(p),acknowledgeNonAtomicSave:false})).rejects.toMatchObject({code:'INVALID_REQUEST'});expect(s.saves).toBe(0);
});
it.each([{disconnectSave:true},{failReadback:true}])('reports an unknown outcome without retrying or rolling back: %j',async options=>{
 const s=await setup(options);const p=await s.bridge.lovelacePreview({...target,operations});
 await expect(s.bridge.lovelaceApply(applyInput(p))).rejects.toMatchObject({resultUnknown:true});expect(s.saves).toBe(1);
 expect(s.config.views[0]!.sections[1]!.cards[0]!.name).toBe('New title');
});
it('reports a readback mismatch without overwriting the later edit',async()=>{
 const s=await setup({afterSave:c=>{c.title='Later edit';}});const p=await s.bridge.lovelacePreview({...target,operations});
 await expect(s.bridge.lovelaceApply(applyInput(p))).rejects.toMatchObject({code:'READBACK_MISMATCH',resultUnknown:true});expect(s.saves).toBe(1);expect(s.config.title).toBe('Later edit');
});
it('serializes competing applies in one bridge instance',async()=>{
 const s=await setup();const p=await s.bridge.lovelacePreview({...target,operations});
 const results=await Promise.allSettled([s.bridge.lovelaceApply(applyInput(p)),s.bridge.lovelaceApply(applyInput(p))]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'DASHBOARD_BUSY'}});expect(s.saves).toBe(1);
});
it('returns a definite save rejection without retrying',async()=>{
 const s=await setup({rejectSave:true});const before=structuredClone(s.config);const p=await s.bridge.lovelacePreview({...target,operations});
 expect(await s.bridge.lovelaceApply(applyInput(p))).toMatchObject({success:false,error:{code:'DASHBOARD_SAVE_REJECTED',resultUnknown:false}});expect(s.saves).toBe(1);expect(s.config).toEqual(before);
});
it('blocks a competing generic save while a scoped apply holds the instance lock',async()=>{
 const s=await setup();const p=await s.bridge.lovelacePreview({...target,operations});const applying=s.bridge.lovelaceApply(applyInput(p));
 await expect(s.bridge.ws({command:{type:'lovelace/config/save',url_path:target.dashboard,config:fixture()}})).rejects.toMatchObject({code:'DASHBOARD_BUSY'});
 await applying;expect(s.saves).toBe(1);
});
