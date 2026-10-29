export const CINEMATIC_PROFILE='cinematic-director-v2';
export const BASIC_PROFILE='premium-practical-v1';
export const SITE_PROFILES=Object.freeze([BASIC_PROFILE,CINEMATIC_PROFILE]);
export const CINEMATIC_EFFECTS=Object.freeze(['split-chars','image-trail','distortion','scroll-scene']);
export function siteBudget(profile){return profile===CINEMATIC_PROFILE?{total:8*1024*1024,js:256*1024,css:80*1024}:{total:2*1024*1024,js:50*1024,css:50*1024};}
export const CINEMATIC_HOST_ASSETS=Object.freeze([
 ['assets/factory-gsap.js','../runtime/vendor/gsap.min.js'],
 ['assets/factory-scrolltrigger.js','../runtime/vendor/ScrollTrigger.min.js'],
 ['assets/factory-lenis.js','../runtime/vendor/lenis.min.js'],
 ['assets/factory-cinematic.js','../runtime/cinematic.js'],
 ['assets/factory-cinematic.css','../runtime/cinematic.css'],
 ['assets/GSAP-LICENSE.txt','../runtime/vendor/GSAP-LICENSE.txt'],
 ['assets/LENIS-LICENSE.txt','../runtime/vendor/LENIS-LICENSE.txt'],
]);
