const fs = require('fs');
let s = fs.readFileSync('D:/arknights/arknights-cards/game.js', 'utf8');
const subs = [];
function rep(name, o, n) { subs.push([name, o, n]); }
rep('去死亡震屏',
  "try { const _av = el.querySelector('.av'); const _r = _av ? _av.getBoundingClientRect() : null; if (_r && _r.width) FX.burst(_r.left + _r.width / 2, _r.top + _r.height / 2, 10, '#ffb3b3'); if (!G._fxShakenThisFrame) { FX.shake(90, 2); G._fxShakenThisFrame = 1; } } catch (e) {}",
  "try { const _av = el.querySelector('.av'); const _r = _av ? _av.getBoundingClientRect() : null; if (_r && _r.width) FX.burst(_r.left + _r.width / 2, _r.top + _r.height / 2, 10, '#ffb3b3'); } catch (e) {}");
rep('去大伤害震屏',
  'if (!G._fxShakenThisFrame && diff < -50) { FX.shake(90, 2); G._fxShakenThisFrame = 1; }',
  '');
rep('单位尺寸缩小',
  'const _uw = Math.max(40, Math.min(72, _cw - 4)), _uh = Math.max(46, Math.min(80, _ch - 4));',
  'const _uw = Math.max(36, Math.min(62, _cw - 10)), _uh = Math.max(42, Math.min(70, _ch - 10));');
let fail = 0;
for (const [name, o, n] of subs) {
  const cnt = s.split(o).length - 1;
  if (cnt !== 1) { console.log('SKIP ' + name + ' (cnt=' + cnt + ')'); fail++; continue; }
  s = s.replace(o, n); console.log('OK   ' + name);
}
fs.writeFileSync('D:/arknights/arknights-cards/game.js', s);
console.log(fail ? 'FAIL ' + fail : 'ALL_OK');
process.exit(fail ? 1 : 0);
