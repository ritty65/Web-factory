// Real pointer/scroll probes for the protected advanced capabilities.
export async function checkCinematicEffect(page,e,{width,capture}){
  const root=page.locator(`[id="${e.targetId}"]`),desktop=await page.evaluate(()=>matchMedia('(min-width:768px) and (hover:hover) and (pointer:fine)').matches);
  if(e.type==='image-trail'){
    const box=await root.boundingBox();await page.mouse.move(box.x+box.width*.25,box.y+Math.min(80,box.height*.5));await page.waitForTimeout(130);await page.mouse.move(box.x+box.width*.6,box.y+Math.min(100,box.height*.65));await page.waitForTimeout(130);
    const trail=await page.locator('[data-cinematic-trail]').evaluateAll(images=>images.map(i=>({loaded:i.complete&&i.naturalWidth>0,x:i.getBoundingClientRect().x,y:i.getBoundingClientRect().y,opacity:Number(getComputedStyle(i).opacity)})));
    await capture(e);await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(80);const cleared=await page.locator('[data-cinematic-trail]').count()===0;await page.emulateMedia({reducedMotion:'no-preference'});
    return{name:e.type,targetId:e.targetId,pass:(desktop?trail.length>=1&&trail.length<=3&&trail.every(i=>i.loaded&&i.opacity>0):trail.length===0)&&cleared,evidence:{desktop,trail,cleared}};
  }
  if(e.type==='distortion'){
    const image=root.locator('img').first(),box=await image.boundingBox();await page.mouse.move(box.x+box.width*.45,box.y+box.height*.45);await page.waitForTimeout(90);
    const state=await root.getAttribute('data-cinematic-gl');
    if(!desktop||state==='unavailable')return{name:e.type,targetId:e.targetId,pass:await image.isVisible()&&await image.evaluate(i=>i.naturalWidth>0),evidence:{desktop,capability:state||'static_pointer_alternative',fallback:'Original approved image remains visible'}};
    const canvas=root.locator('[data-cinematic-distortion]');
    if(await canvas.count()!==1)return{name:e.type,targetId:e.targetId,pass:false,evidence:{state,reason:'No protected shader output was observed'}};
    const sample=()=>canvas.evaluate(canvas=>{const gl=canvas.getContext('webgl'),pixels=new Uint8Array(16*16*4);gl.readPixels(Math.max(0,Math.floor(canvas.width*.5)-8),Math.max(0,Math.floor(canvas.height*.5)-8),16,16,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let sum=0;for(let i=0;i<pixels.length;i++)sum=(sum*31+pixels[i])>>>0;return{checksum:sum,width:canvas.width,height:canvas.height,opacity:Number(getComputedStyle(canvas).opacity)};});
    const before=await sample();await page.mouse.move(box.x+box.width*.62,box.y+box.height*.55);await page.waitForTimeout(100);const after=await sample();await capture(e);
    await canvas.evaluate(c=>c.getContext('webgl').getExtension('WEBGL_lose_context')?.loseContext());await page.waitForTimeout(90);
    const fallback=await image.isVisible()&&await canvas.count()===0;
    return{name:e.type,targetId:e.targetId,pass:before.checksum!==after.checksum&&before.opacity>0&&after.opacity>0&&fallback,evidence:{desktop,before,after,contextLossFallback:fallback}};
  }
  if(e.type==='scroll-scene'){
    const layers=root.locator('[data-scene-layer]'),read=()=>layers.evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).transform));
    const first=await read();await root.evaluate(n=>window.scrollTo(0,window.scrollY+n.getBoundingClientRect().top+90));await page.waitForTimeout(170);const second=await read();await capture(e);
    return{name:e.type,targetId:e.targetId,pass:desktop?first.some((v,i)=>v!==second[i]):second.every(v=>v==='none'),evidence:{desktop,width,first,second}};
  }
  return{name:e.type,targetId:e.targetId,pass:false,evidence:{reason:'Unsupported advanced probe'}};
}
