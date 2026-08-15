const fs = require('fs');
let s = fs.readFileSync('game.css', 'utf8');
const subs = [];
function rep(name, o, n) { subs.push([name, o, n]); }

// 1) 清理重复 .nf-track（line 482-483）
rep('D1-重复 nf-track',
`.nf-track{display:flex;align-items:center;gap:0;flex-wrap:nowrap;overflow-x:auto;padding:0 4px;max-width:100%;justify-content:safe center;flex:1;min-width:0;height:76px}
.nf-track{display:flex;align-items:center;gap:0;flex-wrap:nowrap;overflow-x:auto;padding:4px 2px 8px;max-width:100%;justify-content:safe center}`,
`.nf-track{display:flex;align-items:center;gap:0;flex-wrap:nowrap;overflow-x:auto;padding:0 4px;max-width:100%;justify-content:safe center;flex:1;min-width:0;height:76px}`);

// 2) 删除 v2.5 无滚动 @media (min-width:1200px) 块
rep('D2-v2.5 @media 无滚动布局',
`/* ============ v2.5 无滚动一屏布局（宽屏横排：左收纳栏 + 右主棋盘） ============ */
@media (min-width:1200px){
  .arena{flex-direction:row;align-items:flex-start;gap:14px;max-width:none;padding:12px 16px 16px}
  .arena-side{order:1;width:min(300px,25vw);flex:none;display:flex;flex-direction:column;gap:12px;
    max-height:calc(100vh - 118px);overflow-y:auto}
  .arena-main{order:2;flex:1;min-width:0}
  .board-wrap{margin-bottom:12px}
  .action-bar{margin-top:12px}
  /* v2.7 棋盘格子：grid 等分 + 容器 aspect-ratio:8/6 → 格子永远正方形（不依赖 vh，宽高联动） */
  .board-grid{grid-template-columns:repeat(8,minmax(0,1fr));grid-template-rows:repeat(6,minmax(0,1fr))}
  .board-battle{display:flex !important;flex-direction:row !important;gap:10px;align-items:stretch;width:fit-content;max-width:100%}
  .bench{max-height:66px;overflow-y:hidden}
  .mini-team{flex-wrap:nowrap;overflow-x:auto}
  /* 侧栏商店：3 列紧凑网格（3+2 排 5 卡） */
  .arena-side .shop-cards{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
  .arena-side .shop-card{width:100%;max-width:96px;height:118px}
  .arena-side .shop-card .card-tags{display:none}
  .arena-side .shop-card:hover .card-tags{display:flex}
  .arena-side .shop-card .card-tags{background:rgba(10,14,20,.88);padding:2px 5px;border-radius:5px;font-size:10px}
  .arena-side .shop-card .cf-name{font-size:10px;max-width:64px}
  .arena-side .shop-card .cf-cost{font-size:10px}
  .arena-side .shop-card .card-fade{height:46%}
}
`,
'');

// 3) 删除 Roster Rail
rep('D3-RosterRail',
`/* ============ v3.0 部署区左侧「上场角色栏」Roster Rail ============ */
.board-battle{display:flex;gap:10px;align-items:stretch}
`,
'');

// 4) 删除旧备战区块
rep('D4-旧备战区',
`/* ============ v2.7 备战区下移（独立于棋盘） ============ */
.bench-area{margin-top:12px;padding:10px 12px;background:var(--panel);border:1px solid var(--line);border-radius:10px;
  display:flex;flex-direction:column;gap:6px}
.bench-area-head{font-size:12px;color:var(--text-2);font-weight:700;display:flex;align-items:center;gap:8px}
.bench-cell{position:relative;aspect-ratio:1;border:1px dashed #3a4660;border-radius:8px;background:#10141b;
  display:flex;align-items:center;justify-content:center;min-height:0;color:#5f6b7a;font-size:24px;font-weight:300}
.bench-cell:not(.filled)::before{content:"+";opacity:.5}
.bench-cell.filled{border-style:solid;border-color:var(--line);background:var(--panel-2);color:transparent}
.bench-cell.filled::before{content:none}
.bench-cell .ucard{width:100%;height:100%}
`,
'');

// 5) 删除 v3.1 + media（896-929 到文件末尾）
rep('D5-v3.1 + media',
`/* ============ v3.1 方案B：三段式布局（row 布局无条件生效，窄屏降级堆叠） ============ */
/* 默认：宽屏 row 布局（侧栏左 + 主区右 + 备战席下）；min-height 撑满视口 → resize 跟着重算 */
.arena{display:flex;flex-direction:row;align-items:stretch;gap:14px;padding:12px 16px 16px;width:1280px;height:calc(100vh - 160px);max-height:680px;min-height:480px;margin:0 auto;position:relative;overflow:hidden}
.arena-side{order:1;width:220px;flex:none;display:flex;flex-direction:column;gap:8px;min-width:0;
  overflow-y:auto;padding-right:2px}
.arena-main{order:2;flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;gap:12px;padding-right:24px;overflow:hidden}
.board-wrap{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:visible}
.board-battle{position:relative;width:640px;height:480px;margin:0 auto;flex:none;
  background:#0c0f14;border:1px solid var(--line);border-radius:8px;padding:0;overflow:hidden}
.board-grid{position:relative;width:640px;height:480px;max-width:100%;max-height:100%;aspect-ratio:8/6;display:grid;grid-template-columns:repeat(8,1fr);grid-template-rows:repeat(6,1fr);gap:0;background:transparent}
.board-cell{width:80px;height:80px;min-width:0;min-height:0}
#board::after{left:320px;top:6px;bottom:6px}
.enemy-overlay{left:320px;top:0;right:0;bottom:0;
  grid-template-columns:repeat(4,80px);grid-template-rows:repeat(6,80px);gap:0}
.bench-area{flex:none;height:140px;padding:10px 12px;background:var(--panel);border:1px solid var(--line);border-radius:10px}
.bench-area-head{font-size:12px;color:var(--text-2);font-weight:700;margin-bottom:8px}
.bench{display:flex;gap:6px;padding:0;width:1014px;height:96px;margin:0 auto;justify-content:flex-start}
.bench-cell{width:96px;height:96px;min-width:0;min-height:0;border:1px dashed #3a4660;border-radius:8px;background:#10141b;overflow:hidden;
  display:flex;align-items:center;justify-content:center;font-size:22px;color:#5f6b7a}
.bench-cell:not(.filled)::before{content:"+";opacity:.5}
.bench-cell.filled{border-style:solid;border-color:var(--line);background:var(--panel-2)}
.bench-cell.filled::before{content:none}
.bench-cell .ucard{width:100%;height:100%}
.action-bar{flex:none;min-height:40px;display:flex;align-items:center;gap:14px;margin-top:0}
.action-bar .btn.primary{height:34px;padding:0 22px;font-size:15px}

/* <900px：纯堆叠（顶部→棋盘→备战席→侧栏）；棋盘缩到 ~80vh */
@media (max-width:899px){
  .arena{flex-direction:column;padding:8px 12px 12px}
  .arena-side{order:2;width:100%;flex-direction:row;flex-wrap:wrap;max-height:none;overflow:visible;padding-right:0}
  .arena-side > *{flex:1 1 45%;min-width:200px}
  .arena-main{order:1;width:100%;padding-right:0}
  .board-battle{max-height:70vh}
}
`,
'');

let fail = 0;
for (const [name, o, n] of subs) {
  const cnt = s.split(o).length - 1;
  if (cnt !== 1) { console.log('SKIP ' + name + ' (cnt=' + cnt + ')'); fail++; continue; }
  s = s.replace(o, n); console.log('OK   ' + name);
}
fs.writeFileSync('game.css', s);
console.log(fail ? 'FAIL ' + fail : 'ALL_OK');
process.exit(fail ? 1 : 0);
