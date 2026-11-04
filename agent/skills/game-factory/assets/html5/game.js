import { config } from './config.js';
import { messages, languageOf } from './localization.js';
import { createSaveStore, freshRound } from './save.js';
import { connectPlatform } from './platform.js';

const byId=id=>document.getElementById(id),canvas=byId('game'),ctx=canvas.getContext('2d');
let storage;
try{storage=window.localStorage;}catch{storage={getItem(){return null;},setItem(){throw new Error('Storage unavailable');}};}
const saves=createSaveStore(config.saveKey,storage), saved=saves.read();
const state=saved||{version:2,bestMoves:null,wins:0,muted:false,language:null,round:null};
let round=state.round?.status==='playing'?state.round:freshRound(),screen='ready',platform=null,connected=false,failed=false,audio=null,lastKeyAt=0;
const pauses=new Set(document.hidden?['hidden']:[]);
const vectors={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]};
const keys={ArrowUp:'up',w:'up',W:'up',ArrowDown:'down',s:'down',S:'down',ArrowLeft:'left',a:'left',A:'left',ArrowRight:'right',d:'right',D:'right'};
const t=key=>messages[state.language||'en'][key];
const active=()=>connected&&screen==='playing'&&!pauses.size;
function persist(){state.round=round;saves.write(state);}
function sound(note=520){
  if(state.muted||pauses.size)return;
  try{audio??=new(window.AudioContext||window.webkitAudioContext)();audio.resume().catch(()=>{});const o=audio.createOscillator(),g=audio.createGain();o.connect(g);g.connect(audio.destination);o.frequency.value=note;g.gain.setValueAtTime(.06,audio.currentTime);g.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.12);o.start();o.stop(audio.currentTime+.13);}catch{}
}
function sync(){
  document.documentElement.lang=state.language||'en';document.title=t('title');
  for(const element of document.querySelectorAll('[data-text]'))element.textContent=t(element.dataset.text);
  byId('language').value=state.language||'en';byId('mute').textContent=t(state.muted?'soundOff':'soundOn');byId('mute').setAttribute('aria-pressed',String(state.muted));byId('mute').disabled=!connected;
  byId('pause').textContent=t(pauses.has('manual')?'resume':'pause');byId('pause').disabled=!connected||screen!=='playing';
  byId('score').textContent=`${t('lights')}: ${5-round.lights.length} / 5`;byId('steps').textContent=`${t('steps')}: ${round.steps}`;
  byId('record').textContent=state.bestMoves===null?t('noRecord'):`${t('record')}: ${state.bestMoves} · ${t('wins')}: ${state.wins}`;
  for(const button of document.querySelectorAll('[data-move]')){button.setAttribute('aria-label',t(button.dataset.move));button.disabled=!active();}
  canvas.setAttribute('aria-label',`${t('title')}. ${t('lights')}: ${5-round.lights.length}/5. ${t('steps')}: ${round.steps}.`);
  const panel=byId('panel'),play=byId('play');panel.hidden=active();play.hidden=!connected||failed|| (screen==='playing'&&[...pauses].some(p=>p!=='manual'));
  let heading='loading',detail='',label='start';
  if(failed){heading='error';detail='errorDetail';}
  else if(connected){
    if(screen==='ready'){heading='ready';detail='instructions';label=state.round?.status==='playing'?'continue':'start';}
    else if(screen==='won'){heading='win';detail='winDetail';label='again';}
    else if(screen==='lost'){heading='lost';detail='lostDetail';label='again';}
    else{heading='paused';detail=[...pauses].some(p=>p!=='manual')?'externalPause':'pausedDetail';label='resume';}
  }
  byId('heading').textContent=t(heading);byId('detail').textContent=detail?t(detail):'';play.textContent=t(label);
  if(!saves.available)byId('record').textContent=t('saveUnavailable');
  platform?.gameplay(active());
}
function pause(reason){pauses.add(reason);audio?.suspend().catch(()=>{});sync();}
function resume(reason){pauses.delete(reason);sync();}
function move(direction){
  if(!active())return;
  const [dx,dy]=vectors[direction],x=round.player[0]+dx,y=round.player[1]+dy;
  if(x<0||x>6||y<0||y>4)return;
  round.player=[x,y];round.steps--;
  const prior=round.lights.length;round.lights=round.lights.filter(p=>p[0]!==x||p[1]!==y);
  if(round.lights.length<prior)sound(460+(5-round.lights.length)*90);
  if(round.lights.length===0&&x===1&&y===2){screen=round.status='won';state.wins++;const used=24-round.steps;state.bestMoves=state.bestMoves===null?used:Math.min(used,state.bestMoves);sound(1040);}
  else if(round.steps===0)screen=round.status='lost';
  persist();sync();draw(performance.now());
}
byId('play').addEventListener('click',()=>{
  if(!connected)return;
  if(screen==='won'||screen==='lost')round=freshRound();
  pauses.delete('manual');screen='playing';persist();sync();canvas.focus({preventScroll:true});
});
byId('pause').addEventListener('click',()=>pauses.has('manual')?resume('manual'):pause('manual'));
byId('mute').addEventListener('click',()=>{state.muted=!state.muted;if(state.muted)audio?.suspend().catch(()=>{});else sound();persist();sync();});
byId('language').addEventListener('change',event=>{state.language=languageOf(event.target.value);persist();sync();});
for(const button of document.querySelectorAll('[data-move]'))button.addEventListener('click',()=>move(button.dataset.move));
window.addEventListener('keydown',event=>{
  if(event.target instanceof HTMLSelectElement||event.altKey||event.metaKey||event.ctrlKey)return;
  if(event.key==='Escape'&&screen==='playing'){event.preventDefault();pauses.has('manual')?resume('manual'):pause('manual');return;}
  const direction=keys[event.key];if(!direction)return;event.preventDefault();
  if(event.repeat&&performance.now()-lastKeyAt<130)return;lastKeyAt=performance.now();move(direction);
});
canvas.addEventListener('pointerdown',event=>{
  event.preventDefault();canvas.focus({preventScroll:true});const rect=canvas.getBoundingClientRect();
  const x=Math.floor((event.clientX-rect.left)/rect.width*7),y=Math.floor((event.clientY-rect.top)/rect.height*5),dx=x-round.player[0],dy=y-round.player[1];
  if(Math.abs(dx)+Math.abs(dy)===1)move(dx<0?'left':dx>0?'right':dy<0?'up':'down');
});
document.addEventListener('visibilitychange',()=>document.hidden?pause('hidden'):resume('hidden'));
window.addEventListener('blur',()=>pause('blur'));
window.addEventListener('focus',()=>resume('blur'));
window.addEventListener('pagehide',()=>{persist();platform?.dispose();});
function draw(time){
  const rect=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2),width=Math.max(1,Math.round(rect.width*ratio)),height=Math.max(1,Math.round(rect.height*ratio));
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  ctx.setTransform(width/700,0,0,height/500,0,0);ctx.clearRect(0,0,700,500);
  for(let y=0;y<5;y++)for(let x=0;x<7;x++){ctx.fillStyle=(x+y)%2?'#1c3c32':'#204237';ctx.beginPath();ctx.roundRect(x*100+4,y*100+4,92,92,16);ctx.fill();ctx.fillStyle='#31533c';for(let leaf=0;leaf<3;leaf++){ctx.beginPath();ctx.ellipse(x*100+19+leaf*20,y*100+78-leaf*9,3,8,.5,0,Math.PI*2);ctx.fill();}}
  ctx.fillStyle=round.lights.length?'#82976e':'#ffe79c';ctx.fillRect(139,219,22,32);ctx.strokeStyle='#e4d991';ctx.lineWidth=3;ctx.beginPath();ctx.arc(150,219,8,Math.PI,0);ctx.stroke();
  const bob=matchMedia('(prefers-reduced-motion: reduce)').matches?0:Math.sin(time/300)*3;
  for(const [x,y] of round.lights){ctx.fillStyle='#efce7350';ctx.beginPath();ctx.arc(x*100+50,y*100+50+bob,21,0,Math.PI*2);ctx.fill();ctx.fillStyle='#f6d77f';ctx.beginPath();ctx.arc(x*100+50,y*100+50+bob,9,0,Math.PI*2);ctx.fill();}
  const [x,y]=round.player;ctx.fillStyle='#0c211b50';ctx.beginPath();ctx.ellipse(x*100+50,y*100+73,22,7,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#b8dba1';ctx.beginPath();ctx.roundRect(x*100+32,y*100+30,36,42,14);ctx.fill();ctx.fillStyle='#173c32';ctx.fillRect(x*100+40,y*100+44,4,6);ctx.fillRect(x*100+56,y*100+44,4,6);
}
function frame(time){draw(time);requestAnimationFrame(frame);}requestAnimationFrame(frame);sync();
try{platform=await connectPlatform({pause,resume});state.language??=languageOf(platform.language||navigator.language);connected=true;sync();platform.ready();}
catch{failed=true;state.language??=languageOf(navigator.language);sync();}
