// Trusted build step: copy only fixed assets from the exact locked packages.
// Never executes generated customer code or downloads a CDN runtime.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
// GSAP publishes its licence by URL, not as a package file. Its separately
// retained official licence snapshot must be reviewed when changing versions.
const files=[['gsap/dist/gsap.min.js','gsap.min.js'],['gsap/dist/ScrollTrigger.min.js','ScrollTrigger.min.js'],['lenis/dist/lenis.min.js','lenis.min.js'],['lenis/LICENSE','LENIS-LICENSE.txt']];
await mkdir(new URL('../runtime/vendor/',import.meta.url),{recursive:true});
for(const[source,target]of files)await writeFile(new URL('../runtime/vendor/'+target,import.meta.url),await readFile(new URL('../node_modules/'+source,import.meta.url)));
