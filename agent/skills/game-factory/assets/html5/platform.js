import { config } from './config.js';

async function deadline(promise, milliseconds) {
  let timer;
  try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Platform unavailable')),milliseconds);})]);}
  finally{clearTimeout(timer);}
}
async function loadYandex() {
  if(!window.YaGames)await deadline(new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='/sdk.js';script.onload=resolve;script.onerror=reject;document.head.append(script);
  }),15000);
  if(typeof window.YaGames?.init!=='function')throw new Error('Platform unavailable');
  return deadline(window.YaGames.init(),15000);
}
export async function connectPlatform({pause,resume}) {
  // CrazyGames Basic intentionally has no SDK, ads, account or payment calls.
  if(config.platform!=='yandex')return {language:navigator.language,ready(){},gameplay(){},dispose(){}};
  const sdk=await loadYandex();
  if(typeof sdk.features?.LoadingAPI?.ready!=='function' || typeof sdk.features?.GameplayAPI?.start!=='function' || typeof sdk.features?.GameplayAPI?.stop!=='function' || typeof sdk.on!=='function' || typeof sdk.off!=='function')throw new Error('Platform unavailable');
  const pauseCallback=()=>pause('platform'), resumeCallback=()=>resume('platform');
  sdk.on('game_api_pause',pauseCallback);sdk.on('game_api_resume',resumeCallback);
  let playing=false,ready=false;
  return {language:sdk.environment?.i18n?.lang,
    ready(){if(!ready){ready=true;sdk.features.LoadingAPI.ready();}},
    gameplay(active){if(active!==playing){playing=active;sdk.features.GameplayAPI[active?'start':'stop']();}},
    dispose(){if(playing)sdk.features.GameplayAPI.stop();sdk.off('game_api_pause',pauseCallback);sdk.off('game_api_resume',resumeCallback);},
  };
}
