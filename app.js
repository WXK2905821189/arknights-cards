'use strict';

const CLASS_COLORS = {
  '先锋': '#4caf50',
  '近卫': '#e74c3c',
  '重装': '#e67e22',
  '狙击': '#3498db',
  '术师': '#9b59b6',
  '医疗': '#1abc9c',
  '辅助': '#f1c40f',
  '特种': '#e84393'
};
const CLASS_ORDER = ['先锋','近卫','重装','狙击','术师','医疗','辅助','特种'];

let DATA = { operators: [] };
let state = { cls: 'all', q: '', sort: 'class' };

const $ = (s) => document.querySelector(s);

function stars(n){ return '★'.repeat(n) + '☆'.repeat(Math.max(0, 6 - n)); }

function buildFilters(){
  const wrap = $('#filters');
  const all = [{ key:'all', label:'全部', color:'#94a1b2' }];
  CLASS_ORDER.forEach(c => {
    const cnt = DATA.operators.filter(o => o.class === c).length;
    if (cnt) all.push({ key:c, label:`${c} ${cnt}`, color: CLASS_COLORS[c] || '#94a1b2' });
  });
  wrap.innerHTML = '';
  all.forEach(f => {
    const b = document.createElement('button');
    b.className = 'fbtn' + (state.cls === f.key ? ' active' : '');
    b.innerHTML = `<span class="dot" style="background:${f.color}"></span>${f.label}`;
    b.onclick = () => { state.cls = f.key; buildFilters(); render(); };
    wrap.appendChild(b);
  });
}

function filtered(){
  let list = DATA.operators.slice();
  if (state.cls !== 'all') list = list.filter(o => o.class === state.cls);
  const q = state.q.trim().toLowerCase();
  if (q) list = list.filter(o => o.name.toLowerCase().includes(q) || (o.en||'').toLowerCase().includes(q));
  if (state.sort === 'name') list.sort((a,b)=> a.name.localeCompare(b.name,'zh'));
  else list.sort((a,b)=> (CLASS_ORDER.indexOf(a.class)-CLASS_ORDER.indexOf(b.class)) || a.name.localeCompare(b.name,'zh'));
  return list;
}

function render(){
  const grid = $('#grid');
  const list = filtered();
  $('#count').textContent = list.length;
  grid.innerHTML = '';
  list.forEach(op => {
    const card = document.createElement('div');
    card.className = 'card';
    const cc = CLASS_COLORS[op.class] || '#94a1b2';
    card.innerHTML = `
      <div class="star">${stars(op.rarity)}</div>
      <div class="thumb"><img loading="lazy" src="${encodeURI(op.avatar)}" alt="${op.name}" onerror="this.style.opacity=.2"></div>
      <div class="body">
        <div class="name">${op.name}</div>
        <div class="en">${op.en || ''}</div>
        <span class="tag" style="background:${cc}">${op.class} · ${op.subclass || '—'}</span>
      </div>`;
    card.onclick = () => openModal(op);
    grid.appendChild(card);
  });
}

function openModal(op){
  const cc = CLASS_COLORS[op.class] || '#94a1b2';
  $('#m-art').src = encodeURI(op.art);
  $('#m-art').alt = op.name + ' 立绘';

  const prof = op.profile || {};
  const profRows = [
    ['性别', prof['性别']], ['生日', prof['生日']], ['身高', prof['身高']],
    ['战斗经验', prof['战斗经验']], ['矿石病感染', prof['矿石病感染']]
  ].filter(r => r[1]);

  const infoRows = [
    ['种族', op.race], ['国家·地区', op.region], ['出身', op.origin], ['所属', op.affiliation]
  ].filter(r => r[1]);

  const lines = op.lines || {};
  const lineHtml = Object.keys(lines).map(k => `<div class="line"><span class="lk">${k}</span>${lines[k]}</div>`).join('') || '<div class="line">—</div>';

  const sk = op.skill;
  const skillHtml = sk ? `
    <div class="section-title">技能</div>
    <div class="skill-card">
      <div class="skill-head">
        <span class="skill-name">${sk.name}</span>
        <span class="badge gold">${sk.archLabel || ''}</span>
        ${sk.type ? `<span class="badge">${sk.type}</span>` : ''}
      </div>
      <div class="skill-desc">${sk.desc || '—'}</div>
      <div class="skill-meta">技力上限 ${sk.spMax} · 每 tick 回技力 ${sk.spRegen} · 费用 ${op.stats.cost}★</div>
    </div>
    ${op.skillsAll && op.skillsAll.length > 1 ? `
    <div class="skill-others">
      <span class="muted">其余技能：</span>
      ${op.skillsAll.slice(0, 2).map(s => `<span class="skill-mini">${s.name}</span>`).join('')}
    </div>` : ''}
  ` : '';

  // 游戏内签名羁绊：与 game.js 的 SIGNATURE 机制一致（5费干员上场即生效）
  const sd = (typeof SIGNATURE_DESC !== 'undefined') && SIGNATURE_DESC[op.name];
  const sigHtml = sd ? `
    <div class="section-title">游戏内签名羁绊（5费 · 上场即生效）</div>
    <div class="skill-card sig-card">
      <div class="skill-head">
        <span class="skill-name">${sd.title}</span>
        <span class="badge gold">签名</span>
      </div>
      <div class="skill-desc">${sd.desc}</div>
    </div>` : '';

  $('#m-info').innerHTML = `
    <h2>${op.name}</h2>
    <div class="en2">${op.en || ''}　${stars(op.rarity)}</div>
    <div class="badges">
      <span class="badge gold">${stars(op.rarity)} ${op.rarity}★</span>
      <span class="badge cls" style="background:${cc}">${op.class}</span>
      <span class="badge">${op.subclass || '—'}</span>
      ${sk ? `<span class="badge gold">${sk.archLabel || ''}</span>` : ''}
    </div>
    <div class="info-grid">
      ${infoRows.map(r=>`<div><div class="k">${r[0]}</div><div class="v">${r[1]}</div></div>`).join('')}
      ${profRows.map(r=>`<div><div class="k">${r[0]}</div><div class="v">${r[1]}</div></div>`).join('')}
    </div>
    ${op.intro ? `<div class="section-title">简介</div><div class="intro">${op.intro}</div>` : ''}
    ${skillHtml}
    ${sigHtml}
    <div class="section-title">台词</div>
    <div class="lines">${lineHtml}</div>
  `;
  // 重置立绘缩放
  zoom = 1; applyZoom();
  $('#modal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

let zoom = 1;
function applyZoom(){ const img = $('#m-art'); if (!img) return; img.style.transform = 'scale(' + zoom + ')'; img.classList.toggle('zoomed', zoom !== 1); }

function closeModal(){
  $('#modal').classList.add('hidden');
  document.body.style.overflow = '';
}

function init(){
  if (typeof __DATA !== 'undefined') { DATA = __DATA; }
  // 实机接入：按 assets/{id}_头像.png / _立绘.png 派生卡面（data.js 无此字段）
  DATA.operators.forEach(o => {
    if (!o.avatar) o.avatar = 'assets/' + o.id + '_头像.png';
    if (!o.art) o.art = 'assets/' + o.id + '_立绘.png';
  });
  buildFilters();
  $('#total').textContent = DATA.operators.length;
  $('#search').addEventListener('input', e => { state.q = e.target.value; render(); });
  $('#sort').addEventListener('change', e => { state.sort = e.target.value; render(); });
  document.querySelectorAll('[data-close]').forEach(el => el.onclick = closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  // 立绘缩放：按钮 / 滚轮 / 点击切换
  document.querySelectorAll('[data-zoom]').forEach(b => b.onclick = () => {
    const z = b.dataset.zoom;
    if (z === 'in') zoom = Math.min(3, zoom + 0.25);
    else if (z === 'out') zoom = Math.max(0.5, zoom - 0.25);
    else zoom = 1;
    applyZoom();
  });
  const artBox = document.querySelector('.modal-art');
  if (artBox) {
    artBox.addEventListener('wheel', e => {
      e.preventDefault();
      zoom = Math.max(0.5, Math.min(3, zoom + (e.deltaY < 0 ? 0.15 : -0.15)));
      applyZoom();
    }, { passive: false });
    artBox.addEventListener('click', e => {
      if (e.target.closest('[data-zoom]')) return;
      zoom = (zoom === 1) ? 2.2 : 1;
      applyZoom();
    });
  }
  render();
}

init();
