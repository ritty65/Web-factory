// Launch the pinned upstream server with no provider credentials in its env.
import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
const token=process.env.FACTORY_CAMOFOX_TOKEN;if(!token||token.length<32)throw Error('A private internal reader token is required');
const allowed=['PATH','LANG','HOME','XDG_CACHE_HOME','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','CAMOUFOX_EXECUTABLE'];
const env=Object.fromEntries(allowed.filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{NODE_ENV:'production',FACTORY_READER_ROOT:root,FACTORY_CAMOFOX_TOKEN:token,CAMOFOX_API_KEY:token,CAMOFOX_ADMIN_KEY:token,CAMOFOX_BIND_HOST:'127.0.0.1',CAMOFOX_PORT:'9378',CAMOFOX_CRASH_REPORT_ENABLED:'false',CAMOFOX_INTERACTIVE:'off',CAMOFOX_DISABLE_DEFAULT_ADDONS:'true',MAX_SESSIONS:'2',MAX_TABS_PER_SESSION:'1',MAX_TABS_GLOBAL:'2',SESSION_TIMEOUT_MS:'60000',TAB_INACTIVITY_MS:'60000'});
const child=spawn(process.execPath,[path.join(root,'.factory-tools/camofox/node_modules/@askjo/camofox-browser/server.js')],{cwd:root,env,stdio:'inherit'});
child.on('error',()=>{process.stderr.write('Pinned Camofox source service could not start.\n');process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
