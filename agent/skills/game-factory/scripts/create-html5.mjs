#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../assets/html5');
const profiles=['local','yandex','crazygames-basic'];
const files=['index.html','style.css','game.js','localization.js','save.js','platform.js','README.txt'];

/** Only copies this public starter into an existing, empty, private work dir.
 * Does not claim a factory lease or grant permission to publish a game. */
export function createHtml5Starter({destination,platform='all',projectId='lantern-garden'}){
  if(!path.isAbsolute(destination||'')||!profiles.concat('all').includes(platform)||!/^[a-z][a-z0-9-]{2,48}$/.test(projectId))throw new Error('Use an absolute destination, a supported platform and a simple project ID');
  const root=path.resolve(destination),stat=fs.lstatSync(root);
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(root)!==root||(stat.mode&0o077)!==0||stat.uid!==process.getuid())throw new Error('Destination must be a canonical private directory owned by this user');
  if(fs.readdirSync(root).length)throw new Error('Destination must be empty; existing work is never overwritten');
  const selected=platform==='all'?profiles:[platform],result=[];
  for(const profile of selected){
    const directory=path.join(root,profile);fs.mkdirSync(directory,{mode:0o700});
    const manifest=[];
    for(const name of files){
      const filename=path.join(source,name),s=fs.lstatSync(filename);
      if(!s.isFile()||s.isSymbolicLink()||s.size>128*1024)throw new Error('Template file unavailable');
      const bytes=fs.readFileSync(filename);fs.writeFileSync(path.join(directory,name),bytes,{flag:'wx',mode:0o600});
      manifest.push({path:name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
    }
    const configuration=`export const config = Object.freeze(${JSON.stringify({platform:profile,saveKey:`${projectId}:${profile}:save`})});\n`;
    fs.writeFileSync(path.join(directory,'config.js'),configuration,{flag:'wx',mode:0o600});
    manifest.push({path:'config.js',sha256:createHash('sha256').update(configuration).digest('hex'),bytes:Buffer.byteLength(configuration)});
    const metadata={schema:1,template:'lantern-garden-v1',platform:profile,entrypoint:'index.html',network:profile==='yandex'?['/sdk.js']:[],ads:false,payments:false,publication:'prepare_only',portalVerified:false,files:manifest};
    fs.writeFileSync(path.join(directory,'template.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx',mode:0o600});
    result.push({platform:profile,directory,entrypoint:'index.html',portalVerified:false});
  }
  return {created:result,publicationAuthorized:false};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),options={};
    if(args.includes('--help')){console.log('node create-html5.mjs --destination /absolute/empty/private/workdir [--platform all|local|yandex|crazygames-basic] [--project-id lantern-garden]');process.exit(0);}
    for(let i=0;i<args.length;i+=2){const names={'--destination':'destination','--platform':'platform','--project-id':'projectId'};if(!names[args[i]]||!args[i+1])throw new Error('Invalid arguments; use --help');options[names[args[i]]]=args[i+1];}
    console.log(JSON.stringify(createHtml5Starter(options),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
