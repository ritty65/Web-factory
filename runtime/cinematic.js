/* Protected cinematic capabilities. No server, CDN, account access or hidden copy. */
(() => {
  'use strict';
  const reduced=window.matchMedia?.('(prefers-reduced-motion:reduce)'),fine=window.matchMedia?.('(min-width:768px) and (hover:hover) and (pointer:fine)');
  const roots=[...document.querySelectorAll('[data-effect]')].slice(0,20),animations=new Set(),scenes=[],trails=new Set(),glScenes=new Set();
  const seen=new WeakSet();let lenis=null,keyboardMode=false;
  const moving=()=>!!reduced&&!reduced.matches&&!document.hidden;
  const desktop=()=>moving()&&fine?.matches;
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
    for(const e of entries)if(e.isIntersecting&&!seen.has(e.target)){seen.add(e.target);observer.unobserve(e.target);enter(e.target);}
  },{threshold:.08}):null;
  function enter(root){
    if(!moving()||typeof Element.prototype.animate!=='function')return;
    [...root.querySelectorAll('[data-cinematic-char]')].forEach((char,i)=>{
      const animation=char.animate([{transform:'translateY(28px) rotateX(-35deg)',opacity:.35},{transform:'none',opacity:1}],{duration:600,delay:Math.min(i*16,200),easing:'cubic-bezier(.16,1,.3,1)',fill:'none',id:'factory-effect-entry'});
      animations.add(animation);for(const event of ['finish','cancel'])animation.addEventListener(event,()=>animations.delete(animation),{once:true});
    });
  }
  function clearTrails(){for(const image of trails){image.getAnimations().forEach(a=>a.cancel());image.remove();}trails.clear();}
  function releaseGL(){for(const scene of [...glScenes])scene.dispose();}
  function reset(){for(const a of animations)a.cancel();animations.clear();clearTrails();releaseGL();for(const scene of scenes){scene.trigger?.kill();scene.trigger=null;for(const layer of scene.layers){window.gsap?.killTweensOf(layer);layer.style.removeProperty('transform');}}lenis?.destroy();lenis=null;document.documentElement.dataset.cinematicScroll='native';}
  function refresh(){
    reset();if(!desktop())return;
    if(window.gsap&&window.ScrollTrigger){
      window.gsap.registerPlugin(window.ScrollTrigger);
      for(const scene of scenes)scene.trigger=window.ScrollTrigger.create({trigger:scene.root,start:'top bottom',end:'bottom top',onUpdate:self=>{
        scene.layers.forEach((layer,i)=>window.gsap.set(layer,{y:(self.progress-.5)*(i+1)*28,skewY:clamp(self.getVelocity()/2500,-1.5,1.5)}));
        for(const layer of scene.layers)window.gsap.to(layer,{skewY:0,duration:.45,overwrite:'auto',ease:'power2.out'});
      }});
    }
    if(!keyboardMode&&document.documentElement.hasAttribute('data-smooth-scroll')&&typeof window.Lenis==='function'){
      lenis=new window.Lenis({autoRaf:true,lerp:.12,smoothWheel:true,syncTouch:false,anchors:true,prevent:node=>!!node.closest?.('[data-effect-track],dialog,textarea,select,[data-native-scroll]')});
      lenis.on('scroll',()=>window.ScrollTrigger?.update());document.documentElement.dataset.cinematicScroll='smooth';
    }
    window.ScrollTrigger?.refresh();
  }
  function distortion(root){
    const image=root.querySelector('img');if(!image)return;
    // The app's preview has an opaque sandbox origin. CORS-anonymous local
    // images remain displayable and can legally supply a WebGL texture there.
    // The host serves only checked static image bytes with the matching header.
    if(image.crossOrigin!=='anonymous')image.crossOrigin='anonymous';
    let active=null;
    const create=()=>{
      if(active||!desktop()||!image.complete||!image.naturalWidth)return active;
      // At most two GPU contexts, never one context for every gallery image.
      if(glScenes.size>=2)[...glScenes][0].dispose();
      const canvas=document.createElement('canvas');canvas.setAttribute('data-cinematic-distortion','');canvas.setAttribute('aria-hidden','true');
      const gl=canvas.getContext('webgl',{alpha:false,antialias:false,preserveDrawingBuffer:true});if(!gl){root.dataset.cinematicGl='unavailable';return null;}
      const compile=(type,source)=>{const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){gl.deleteShader(shader);throw Error('shader');}return shader;};
      let program,buffer,texture,vertex,fragment,frame=0,disposed=false,energy=0,last=0,mouse=[.5,.5];
      const dispose=()=>{if(disposed)return;disposed=true;if(frame)cancelAnimationFrame(frame);canvas.remove();if(texture)gl.deleteTexture(texture);if(buffer)gl.deleteBuffer(buffer);if(program)gl.deleteProgram(program);if(vertex)gl.deleteShader(vertex);if(fragment)gl.deleteShader(fragment);glScenes.delete(scene);active=null;root.dataset.cinematicGl='fallback';};
      const scene={dispose};
      try{
        vertex=compile(gl.VERTEX_SHADER,'attribute vec2 a;varying vec2 uv;void main(){uv=(a+1.)*.5;gl_Position=vec4(a,0.,1.);}');
        fragment=compile(gl.FRAGMENT_SHADER,'precision mediump float;varying vec2 uv;uniform sampler2D img;uniform vec2 mouse;uniform vec2 crop;uniform float energy;uniform float time;void main(){vec2 p=(uv-.5)*crop+.5;float d=1.-smoothstep(0.,.65,distance(uv,mouse));p+=sin((p.yx+time*.00012)*19.)*.025*energy*d;gl_FragColor=texture2D(img,clamp(p,.001,.999));}');
        program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('link');gl.useProgram(program);
        buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);const attribute=gl.getAttribLocation(program,'a');gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
        texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGB,gl.RGB,gl.UNSIGNED_BYTE,image);
        const box=image.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,1.5);canvas.width=Math.max(1,Math.round(box.width*ratio));canvas.height=Math.max(1,Math.round(box.height*ratio));gl.viewport(0,0,canvas.width,canvas.height);
        const aspect=canvas.width/canvas.height,original=image.naturalWidth/image.naturalHeight;
        gl.uniform2f(gl.getUniformLocation(program,'crop'),Math.min(1,aspect/original),Math.min(1,original/aspect));
        root.append(canvas);active=scene;glScenes.add(scene);root.dataset.cinematicGl='ready';
        const draw=now=>{frame=0;if(disposed)return;if(!desktop()){dispose();return;}energy*=Math.pow(.90,Math.min(32,now-last)/16||1);last=now;gl.uniform2f(gl.getUniformLocation(program,'mouse'),mouse[0],mouse[1]);gl.uniform1f(gl.getUniformLocation(program,'energy'),energy);gl.uniform1f(gl.getUniformLocation(program,'time'),now);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);canvas.style.opacity='1';if(energy>.01)frame=requestAnimationFrame(draw);};
        scene.move=event=>{const r=image.getBoundingClientRect();mouse=[clamp((event.clientX-r.left)/r.width,0,1),clamp(1-(event.clientY-r.top)/r.height,0,1)];energy=.85;if(!frame)frame=requestAnimationFrame(draw);};
        canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();dispose();});draw(performance.now());return scene;
      }catch{dispose();root.dataset.cinematicGl='error';return null;}
    };
    root.addEventListener('pointermove',event=>{if(event.pointerType==='touch')return;create()?.move(event);});
    root.addEventListener('pointerleave',()=>active?.dispose());
  }
  for(const root of roots){
    if(root.dataset.effect==='split-chars'){
      const text=root.textContent;
      if(!root.matches('h1,h2,h3,h4,h5,h6')||root.children.length||text.length>240||text.trim().split(/\s+/).length>32)continue;
      root.setAttribute('aria-label',text);root.replaceChildren(...text.split(/(\s+)/).filter(Boolean).map(word=>{
        if(/^\s+$/.test(word))return document.createTextNode(word);
        const span=document.createElement('span');span.setAttribute('data-cinematic-word','');span.setAttribute('aria-hidden','true');
        for(const letter of Array.from(word)){const char=document.createElement('span');char.setAttribute('data-cinematic-char','');char.textContent=letter;span.append(char);}return span;
      }));if(observer)observer.observe(root);
    }else if(root.dataset.effect==='image-trail'){
      const images=[...root.querySelectorAll('img[data-trail-image]')].slice(0,12);let last=0,index=0;
      root.addEventListener('pointermove',event=>{
        if(!desktop()||event.pointerType==='touch'||images.length<3||performance.now()-last<110)return;
        last=performance.now();const image=images[index++%images.length].cloneNode();image.removeAttribute('id');image.removeAttribute('data-trail-image');image.removeAttribute('loading');image.setAttribute('data-cinematic-trail','');image.setAttribute('aria-hidden','true');image.alt='';image.style.left=clamp(event.clientX+16,0,innerWidth-310)+'px';image.style.top=clamp(event.clientY+16,0,innerHeight-270)+'px';document.body.append(image);trails.add(image);
        if(trails.size>3){const old=[...trails][0];old.getAnimations().forEach(a=>a.cancel());old.remove();trails.delete(old);}
        if(typeof image.animate==='function'){const a=image.animate([{opacity:0,transform:'translateY(16px) scale(.88) rotate(-3deg)'},{opacity:1,transform:'translateY(0) scale(1) rotate(1deg)',offset:.2},{opacity:0,transform:'translateY(-20px) scale(.96)'}],{duration:800,easing:'ease-out',fill:'none'});a.addEventListener('finish',()=>{image.remove();trails.delete(image);},{once:true});}
        else{image.remove();trails.delete(image);}
      });
      root.addEventListener('pointerleave',clearTrails);root.addEventListener('focusin',clearTrails);
    }else if(root.dataset.effect==='distortion')distortion(root);
    else if(root.dataset.effect==='scroll-scene'){const layers=[...root.querySelectorAll('[data-scene-layer]')].slice(0,3);if(layers.length)scenes.push({root,layers,trigger:null});}
    else continue;
    root.setAttribute('data-cinematic-ready','');
  }
  for(const query of [reduced,fine])if(query?.addEventListener)query.addEventListener('change',refresh);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset();else refresh();});
  document.addEventListener('keydown',event=>{if(['Tab','ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(event.key)&&!keyboardMode){keyboardMode=true;refresh();}},{capture:true});
  window.addEventListener('pagehide',reset);window.addEventListener('blur',()=>{clearTrails();releaseGL();});window.addEventListener('resize',refresh,{passive:true});
  document.fonts?.ready?.then(()=>window.ScrollTrigger?.refresh());refresh();
})();
