const http=require('http');
const fs=require('fs');
async function main(){
  const p=await new Promise((res,rej)=>{let n=0;function f(){http.get('http://127.0.0.1:9222/json',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const a=JSON.parse(d);const x=a.find(y=>y.type==='page');if(x&&x.webSocketDebuggerUrl){res(x.webSocketDebuggerUrl);return;}}catch(e){}if(++n<30)setTimeout(f,200);else rej('no');});}).on('error',()=>{if(++n<30)setTimeout(f,200);else rej('err');});}f();});
  const ws=new WebSocket(p);let id=0;const pend=new Map();
  ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const c=pend.get(m.id);pend.delete(m.id);c(m);}};
  await new Promise(r=>ws.onopen=r);
  const send=(method,params)=>{const i=++id;return new Promise((res,rej)=>{pend.set(i,m=>m.error?rej(m.error):res(m.result));ws.send(JSON.stringify({id:i,method,params}));});};
  const ev=async(expr)=>{const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true});if(r.exceptionDetails)return 'EXC';return r.result?r.result.value:'NULL';};
  await send('Page.enable',{});await send('Runtime.enable',{});
  await send('Page.navigate',{url:'http://127.0.0.1:8141/game.html'});
  for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,200));if(await ev('window.__RH && typeof __DATA!==\"undefined\"'))break;}
  await ev('window.__DATA=__DATA; "ok"');
  await ev('["startScreen","diffScreen","envScreen","equipShopScreen","strategyScreen","metaScreen","resultScreen","tutorial"].forEach(function(id){var el=document.getElementById(id);if(el)el.classList.add("hidden")});document.getElementById("arena").classList.remove("hidden");var G=window.__RH.G;var ops=window.__DATA.operators.filter(function(o){return o.stats&&o.stats.cost<=3;});G.board={};[0,1,2,3].forEach(function(slot,i){G.board[slot]={uid:"s"+i,op:ops[i],star:1};});G.bench=[];G.gold=99;G.level=6;G.env={id:"gold",effects:{}};G.nodes=[{type:"battle",phase:1}];G.nodeIdx=0;G.currentEnemy=[ops[5],ops[6]].map(function(o){return {op:o,star:1,buff:null};});G.shop=[ops[0],null,null,null,null];window.__RH.renderAll();"ok"');
  await new Promise(r=>setTimeout(r,500));
  await ev('window.__RH.onFight(); "f"');
  await new Promise(r=>setTimeout(r,100));
  // 看第一个 bf-unit 的 inline style + 所有匹配的 CSS rules
  const out = await ev(`(function(){
    var u = document.querySelector('.bf-unit');
    if (!u) return 'NONE';
    var cs = getComputedStyle(u);
    var css = cs.cssText.length>500?cs.cssText.slice(0,500):cs.cssText;
    return 'inlineStyle=' + u.getAttribute('style') + ' | pos=' + cs.position + ' | display=' + cs.display + ' | top=' + cs.top + ' | left=' + cs.left;
  })()`);
  console.log(out);
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
