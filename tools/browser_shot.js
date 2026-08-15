// 浏览器真实渲染验证工具：CDP 驱动 Chrome headless，进对局摆干员 + 截图 + dump 布局
// 用法: node tools/browser_shot.js <url> <out.png> <w> <h> [--keep]
// 依赖: Chrome/Edge + Node22+（内置 WebSocket）
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const CHROME = fs.existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe')
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = process.argv[2];
const OUT = process.argv[3];
const W = parseInt(process.argv[4] || '1400', 10);
const H = parseInt(process.argv[5] || '900', 10);

const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--mute-audio', '--remote-debugging-port=9222',
  '--remote-debugging-address=127.0.0.1', '--window-size=' + W + ',' + H, 'about:blank'], { stdio: 'ignore' });

function done(v) { try { ch.kill(); } catch (e) {} setTimeout(() => process.exit(v), 100); }
function getPage() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    function poll() {
      http.get('http://127.0.0.1:9222/json', (res) => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => {
          try { const arr = JSON.parse(d); const p = arr.find(x => x.type === 'page'); if (p && p.webSocketDebuggerUrl) { resolve(p.webSocketDebuggerUrl); return; } } catch (e) {}
          if (++tries < 30) setTimeout(poll, 200); else reject(new Error('no page'));
        });
      }).on('error', () => { if (++tries < 30) setTimeout(poll, 200); else reject(new Error('net err')); });
    }
    poll();
  });
}

async function main() {
  const wsUrl = await getPage();
  const ws = new WebSocket(wsUrl); let msgId = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const cb = pending.get(m.id); pending.delete(m.id); cb(m); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const page = { send: function (method, params) { const id = ++msgId; return new Promise((res, rej) => { pending.set(id, (m) => m.error ? rej(m.error) : res(m.result)); ws.send(JSON.stringify({ id, method, params })); }); } };
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: URL });

  const ev = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) return 'EXC: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails));
    return r.result ? r.result.value : 'NULL';
  };

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await ev('window.__RH && typeof __DATA !== "undefined"')) break;
  }
  await ev('window.__DATA = __DATA; "ok"');
  // 隐藏 overlay + 摆干员 + 渲染（等价进入对局）
  const setup = [
    "['startScreen','diffScreen','envScreen','equipShopScreen','strategyScreen','metaScreen','battleScreen','resultScreen','tutorial'].forEach(function(id){var el=document.getElementById(id);if(el)el.classList.add('hidden');});",
    "document.getElementById('arena').classList.remove('hidden');",
    "var G=window.__RH.G;var ops=window.__DATA.operators.filter(function(o){return o.stats&&o.stats.cost<=3;});",
    "G.board={};G.board[0]={uid:'s0',op:ops[0],star:2};G.board[8]={uid:'s1',op:ops[1],star:1};G.board[16]={uid:'s2',op:ops[2],star:1};",
    "G.bench=[{uid:'s3',op:ops[3],star:1},{uid:'s4',op:ops[4],star:1}];",
    "G.gold=50;G.level=6;G.env={id:'gold',effects:{}};G.nodes=[{type:'battle',phase:1},{type:'battle',phase:1},{type:'battle',phase:1}];G.nodeIdx=0;",
    "G.currentEnemy=[ops[5],ops[6],ops[7]].map(function(o){return {op:o,star:1,buff:null};});",
    "G.shop=[ops[0],ops[1],ops[2],null,null];",
    "window.__RH.renderAll();'done'"
  ].join('');
  console.log('SETUP:', await ev(setup));
  await new Promise(r => setTimeout(r, 600));
  // dump 布局
  const layout = await ev("[ '.arena','.arena-side','.arena-main','.top-row','.bench-area','#bench','.bench-cell','.board-wrap','.board-battle','.board-grid','.action-bar','#btnFight' ].map(function(s){var el=document.querySelector(s);if(!el)return s+'=NULL';var r=el.getBoundingClientRect();var c=getComputedStyle(el);return s+'=('+Math.round(r.width)+'x'+Math.round(r.height)+'@'+Math.round(r.left)+','+Math.round(r.top)+') d='+c.display+(s==='.board-grid'?' cols=['+c.gridTemplateColumns.replace(/\\s+/g,' ').slice(0,80)+']':'');}).concat(['win='+window.innerWidth+'x'+window.innerHeight,'cells='+document.querySelectorAll('.board-cell').length,'benchCells='+document.querySelectorAll('.bench-cell').length]).join(' | ')");
  console.log('LAYOUT:', layout);
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('saved:', OUT);
  done(0);
}
main().catch(e => { console.error('ERR:', e.message || e); done(1); });
setTimeout(() => { console.error('timeout'); done(2); }, 40000);