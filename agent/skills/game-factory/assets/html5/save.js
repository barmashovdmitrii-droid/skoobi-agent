const INITIAL_LIGHTS = [[2,2],[3,1],[4,1],[5,2],[4,3]];
export const freshRound = () => ({ player:[1,2], lights:INITIAL_LIGHTS.map(p=>[...p]), steps:24, status:'playing' });
const integer = (n,min,max) => Number.isInteger(n) && n>=min && n<=max;
export function validateRound(round) {
  if (!round || !Array.isArray(round.player) || round.player.length!==2 || !integer(round.player[0],0,6) || !integer(round.player[1],0,4) || !integer(round.steps,0,24) || !['playing','won','lost'].includes(round.status) || !Array.isArray(round.lights) || round.lights.length>5) return null;
  const keys=round.lights.map(p=>Array.isArray(p)&&p.length===2 ? p.join(',') : 'invalid');
  if(new Set(keys).size!==keys.length || keys.some(k=>!INITIAL_LIGHTS.some(p=>p.join(',')===k)))return null;
  if(round.status==='won' && (round.lights.length || round.player.join(',')!=='1,2'))return null;
  if(round.status==='playing' && round.steps===0)return null;
  return {player:[...round.player],lights:round.lights.map(p=>[...p]),steps:round.steps,status:round.status};
}
export function migrateSave(raw) {
  if (!raw || typeof raw!=='object' || ![1,2].includes(raw.version)) return null;
  if(raw.version===1)raw={version:2,bestMoves:raw.best,wins:0,muted:raw.sound===false,language:raw.lang,round:null};
  return {version:2,bestMoves:integer(raw.bestMoves,1,24)?raw.bestMoves:null,wins:integer(raw.wins,0,1000000)?raw.wins:0,muted:raw.muted===true,language:['en','ru'].includes(raw.language)?raw.language:null,round:validateRound(raw.round)};
}
export function createSaveStore(key, storage) {
  let available=true;
  return {
    read(){try{return migrateSave(JSON.parse(storage.getItem(key)||'null'));}catch{return null;}},
    write(state){try{storage.setItem(key,JSON.stringify({...state,version:2}));available=true;return true;}catch{available=false;return false;}},
    get available(){return available;},
  };
}
