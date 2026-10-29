// Explicit installation only. Never run by the web server or job worker.
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {mkdir,copyFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url)),base=path.join(root,'.factory-tools');
const args=new Set(process.argv.slice(2));
if([...args].some(a=>!['--fetch-browser','--skip-camofox','--skip-scrapling','--skip-overture'].includes(a)))throw Error('Unsupported runtime installation option');
async function run(binary,argv,cwd=root){await new Promise((resolve,reject)=>{const p=spawn(binary,argv,{cwd,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:'inherit'});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(Error('Runtime installation failed: '+binary+' (exit '+c+')')));});}
for(const name of ['scrapling','overture'])if(!args.has('--skip-'+name)){
  const target=path.join(base,name);await mkdir(base,{recursive:true,mode:0o700});
  await run('python3.12',['-m','venv',target]);
  await run(path.join(target,'bin/python'),['-I','-m','pip','install','--require-hashes','--only-binary=:all:','-r',path.join(root,'tools',name+'-runtime/requirements.lock')]);
}
if(!args.has('--skip-camofox')){
  const target=path.join(base,'camofox'),vendor=path.join(target,'node_modules/@askjo/camofox-browser');await mkdir(target,{recursive:true,mode:0o700});
  for(const name of ['package.json','package-lock.json'])await copyFile(path.join(root,'tools/camofox-runtime',name),path.join(target,name));
  await run('npm',['ci','--ignore-scripts','--omit=dev','--no-fund','--no-audit'],target);
  // Build only the pinned native SQLite binding; stock postinstall can download
  // browsers implicitly, so all other lifecycle scripts remain disabled.
  await run('npm',['rebuild','better-sqlite3'],target);
  const manifest=JSON.parse(await readFile(path.join(vendor,'package.json'),'utf8'));if(manifest.version!=='1.18.1')throw Error('Unexpected Camofox version');
  await mkdir(path.join(vendor,'plugins/factory'),{recursive:true});
  await copyFile(path.join(root,'tools/camofox-runtime/factory-plugin.mjs'),path.join(vendor,'plugins/factory/index.js'));
  await copyFile(path.join(root,'tools/camofox-runtime/camofox.config.json'),path.join(vendor,'camofox.config.json'));
  if(args.has('--fetch-browser'))await run(process.execPath,[path.join(vendor,'lib/camoufox-download.js')]);
  else process.stdout.write('Camofox package installed. Run again with --fetch-browser to download the genuine Camoufox browser explicitly.\n');
}
process.stdout.write('Runtime packages installed. Connectivity, browser launch and useful source extraction still require the explicit app checks.\n');
