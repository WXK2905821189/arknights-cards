const http=require('http');
async function main(){
  const p=await new Promise((res,rej)=>{let n=0;function f(){http.get('http://127.0.0.1:9222/json',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{const a=JSON.parse(d);const x=a.find(y=>y.type==='page');if(x&&x.webSocketDebuggerUrl){res(x.webSocketDebuggerUrl);return;}}catch(e){}if(++n<30)setTimeout(f,200);else rej('no');});}).on('error',()=>{if(++n<30)setTimeout(f,200);else rej('err');});}f();});
  const ws=new WebSocket(p);let id=0;const pend=new Map();
  ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const c=pend.get(m.id);pend.delete(m.id);c(m);}};
  await new Promise(r=>ws.onopen=r);
  const send=(m,p)=>{const i=++id;return new Promise((res,rej)=>{pend.set(i,x=>x.error?rej(x.error):res(x.result));ws.send(JSON.stringify({id:i,method:m,params:p}));});};
  await send('Page.enable',{});await send('Runtime.enable',{});
  await send('Page.navigate',{url:'http://127.0.0.1:8141/game.html'});
  for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,200));const r=await send('Runtime.evaluate',{expression:'window.__RH && typeof __DATA!==\"undefined\"',returnByValue:true});if(r.result && r.result.value) break;}
  await send('Runtime.evaluate',{expression:'window.__DATA=__DATA'});
  await send('Runtime.evaluate',{expression:'["startScreen","diffScreen","envScreen","equipShopScreen","strategyScreen","metaScreen","resultScreen","tutorial"].forEach(function(id){var el=document.getElementById(id);if(el)el.classList.add("hidden")});document.getElementById("arena").classList.remove("hidden");var G=window.__RH.G;var ops=window.__DATA.operators.filter(function(o){return o.stats&&o.stats.cost<=3;});G.board={};[0,1].forEach(function(slot,i){G.board[slot]={uid:"s"+i,op:ops[i],star:1};});G.bench=[];G.gold=99;G.level=6;G.env={id:"gold",effects:{}};G.nodes=[{type:"battle",phase:1}];G.nodeIdx=0;G.currentEnemy=[ops[5]].map(function(o){return {op:o,star:1,buff:null};});G.shop=[ops[0],null,null,null,null];window.__RH.renderAll()'});
  await new Promise(r=>setTimeout(r,500));
  await send('Runtime.evaluate',{expression:'window.__RH.onFight()'});
  await new Promise(r=>setTimeout(r,100));
  // dump CSS rules matching bf-unit
  const expr = `(function(){
    var u = document.querySelector('.bf-unit');
    if (!u) return ['NONE'];
    var sheets = Array.from(document.styleSheets);
    var hits = [];
    for (var i = 0; i < sheets.length; i++) {
      try {
        var rules = Array.from(sheets[i].cssRules || []);
        for (var r = 0; r < rules.length; r++) {
          var rule = rules[r];
          if (rule.type === 1 && rule.selectorText && rule.selectorText.indexOf('bf-unit') >= 0) {
            hits.push(rule.selectorText + ' {pos=' + rule.style.position + '}');
          }
        }
      } catch(e){}
    }
    return hits;
  })()`;
  const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true});
  console.log(JSON.stringify(r.result ? r.result.value : 'NULL'));
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
