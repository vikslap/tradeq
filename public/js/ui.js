import { $, esc, nf0, xpPill } from './util.js';
import { S } from './state.js';


// =====================================================================
// Modals
// =====================================================================
export function openModal(html, { dismissable = false } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay" ${dismissable ? 'data-dismiss' : ''}>${html}</div>`;
  return root.firstElementChild.firstElementChild;
}

export function closeModal() { const hadBig = Boolean(S.big); S.big?.inst?.destroy(); S.big = null; $('#modal-root').innerHTML = ''; if (hadBig) S.cv?.inst?.draw?.reload(); }


export function confirmBox(title, body, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const el = openModal(`<div class="modal narrow"><div class="modal-h"><h2>${title}</h2></div><div class="modal-b"><p class="muted" style="margin:0;line-height:1.6">${body}</p></div>
      <div class="modal-f"><button class="btn ghost" data-r="0">Cancel</button><button class="btn danger" data-r="1">${okLabel}</button></div></div>`, { dismissable: true });
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) { closeModal(); resolve(b.dataset.r === '1'); } });
  });
}


// =====================================================================
// Celebrations
// =====================================================================
export function toast(html, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.innerHTML = html;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, kind === 'badge-t' ? 6000 : 4500);
}


export function celebrateDiff(prev, next) {
  const before = new Set(prev.events.map((e) => e.key + e.xp));
  const fresh = next.events.filter((e) => !before.has(e.key + e.xp));
  const delta = next.xp - prev.xp;
  if (fresh.length || delta) {
    toast(`<div class="t-h"><span class="t-xp ${delta < 0 ? 'neg' : 'gold'}">${delta > 0 ? '+' : ''}${delta} XP</span><span>${delta > 0 ? 'Nice process.' : delta < 0 ? 'Rules broken — XP lost.' : 'XP updated.'}</span></div>
      ${fresh.length ? `<ul>${fresh.slice(0, 7).map((e) => `<li><span>${esc(e.label)}</span>${xpPill(e.xp)}</li>`).join('')}</ul>` : ''}`);
  }
  const had = new Set(prev.badges.filter((b) => b.earned).map((b) => b.id));
  const newBadges = next.badges.filter((b) => b.earned && !had.has(b.id));
  newBadges.forEach((b, i) => setTimeout(() => toast(`<div class="t-h"><span style="font-size:28px">${b.icon}</span><div><div class="gold" style="font-size:11px;text-transform:uppercase;letter-spacing:.1em">Badge unlocked</div><div>${esc(b.name)}</div></div></div><div class="muted" style="font-size:12px;margin-top:4px">${esc(b.desc)}</div>`, 'badge-t'), 400 + i * 500));
  if (next.level.lvl > prev.level.lvl) setTimeout(() => levelUp(next.level), 300);
  else if (newBadges.length) confetti(80);
}


export function levelUp(L) {
  confetti(200);
  const el = openModal(`<div class="modal narrow"><div class="levelup"><div class="muted" style="text-transform:uppercase;letter-spacing:.2em;font-size:12px">Level up</div>
    <div class="lv">${L.lvl}</div><h2>${esc(L.title)}</h2><p>Discipline compounds. ${nf0.format(L.next - L.xp)} XP to the next rank.</p>
    <button class="btn primary" data-action="close-modal" style="margin-top:10px">Keep going</button></div></div>`, { dismissable: true });
  el.querySelector('button').focus();
}


export function confetti(count = 160) {
  const c = $('#confetti'); const ctx = c.getContext('2d'); const dpr = window.devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ['#8b6cff', '#5ad1ff', '#fbbf24', '#22c55e', '#f4506b', '#ffffff'];
  const P = Array.from({ length: count }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 240, y: innerHeight * 0.38, vx: (Math.random() - 0.5) * 16, vy: -Math.random() * 15 - 4,
    w: Math.random() * 7 + 4, h: Math.random() * 4 + 3, c: colors[(Math.random() * colors.length) | 0], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.35,
  }));
  const t0 = performance.now(); const DUR = 2800;
  const frame = (t) => {
    const el = t - t0; ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of P) {
      p.vy += 0.34; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.max(0, 1 - el / DUR);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
    if (el < DUR) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  };
  requestAnimationFrame(frame);
}
