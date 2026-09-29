#!/usr/bin/env node
/* Site da psicóloga Cinthia Renata Durante — frontend + backend em UM arquivo.
   Rodar: node server.js  →  http://localhost:3000   |  painel: /admin
   Sem dependências. Opcionais: `npm i qrcode nodemailer` (QR Code Pix e e-mails).
   Variáveis: PORT, PIX_KEY, PIX_NAME, PIX_CITY, PRICE, WHATSAPP, ADMIN_TOKEN, SMTP_HOST/PORT/USER/PASS, MAIL_TO */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const E = process.env, PORT = +E.PORT || 3000, DB = path.join(__dirname, 'agendamentos.json');
const C = {
  price: +E.PRICE || 150, whatsapp: E.WHATSAPP || '5513997356921', pixKey: E.PIX_KEY || '',
  pixName: E.PIX_NAME || 'CINTHIA RENATA DURANTE', pixCity: E.PIX_CITY || 'SAO PAULO',
  admin: E.ADMIN_TOKEN || crypto.randomBytes(9).toString('hex'),
  horizon: 30, start: 9, end: 18, lunch: 12, days: [1, 2, 3, 4, 5], owner: E.MAIL_TO || 'durantepsicologia@gmail.com'
};
let QR = null, mail = null;
try { QR = require('qrcode'); } catch {}
try { if (E.SMTP_HOST) mail = require('nodemailer').createTransport({ host: E.SMTP_HOST, port: +E.SMTP_PORT || 587, secure: +E.SMTP_PORT === 465, auth: { user: E.SMTP_USER, pass: E.SMTP_PASS } }); } catch {}

/* ---------- banco (JSON) ---------- */
let db = { appointments: [] };
try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
const save = () => { fs.writeFileSync(DB + '.tmp', JSON.stringify(db, null, 2)); fs.renameSync(DB + '.tmp', DB); };

/* ---------- utilidades ---------- */
const p2 = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const today = () => iso(new Date());
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const br = d => d.split('-').reverse().join('/');
function slots(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = new Date(date + 'T12:00:00'); if (isNaN(d)) return null;
  const max = new Date(); max.setDate(max.getDate() + C.horizon);
  if (date < today() || date > iso(max) || !C.days.includes(d.getDay())) return [];
  const taken = db.appointments.filter(a => a.date === date && a.status !== 'cancelado').map(a => a.time);
  const now = new Date(), out = [];
  for (let h = C.start; h < C.end; h++) {
    const t = p2(h) + ':00';
    if (h === C.lunch || taken.includes(t) || (date === today() && h <= now.getHours())) continue;
    out.push(t);
  }
  return out;
}
function crc(s) { let c = 0xFFFF; for (const b of Buffer.from(s)) { c ^= b << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF; } return c.toString(16).toUpperCase().padStart(4, '0'); }
function pix(amount, txid) {
  if (!C.pixKey) return '';
  const f = (i, v) => i + p2(v.length) + v, ascii = s => s.normalize('NFD').replace(/[^\x20-\x7E]/g, '').toUpperCase();
  const s = f('00', '01') + f('26', f('00', 'br.gov.bcb.pix') + f('01', C.pixKey)) + f('52', '0000') + f('53', '986') +
    f('54', amount.toFixed(2)) + f('58', 'BR') + f('59', ascii(C.pixName).slice(0, 25)) + f('60', ascii(C.pixCity).slice(0, 15)) +
    f('62', f('05', txid)) + '6304';
  return s + crc(s);
}
const hits = new Map();
const limited = ip => { const n = Date.now(), a = (hits.get(ip) || []).filter(t => n - t < 6e5); a.push(n); hits.set(ip, a); return a.length > 6; };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e4) { no(new Error('Corpo grande demais')); req.destroy(); } }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { no(new Error('JSON inválido')); } }); });
const isAdmin = req => { const t = (req.headers.authorization || '').replace('Bearer ', ''); return t.length === C.admin.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(C.admin)); };
async function notify(a, label, wa) {
  if (!mail) return;
  const from = E.SMTP_USER || C.owner;
  try {
    await mail.sendMail({ from, to: a.email, subject: 'Sessão reservada: ' + label, html: '<p>Olá, ' + esc(a.name) + '! Sua sessão de 60 min está reservada para <b>' + label + '</b>.</p><p>Pix copia e cola:</p><pre style="white-space:pre-wrap">' + esc(a.pix) + '</pre><p>No horário, inicie a conversa: <a href="' + wa + '">WhatsApp</a>.</p>' });
    await mail.sendMail({ from, to: C.owner, subject: 'Novo agendamento: ' + a.name, text: label + '\n' + a.name + ' · ' + a.email + ' · ' + a.phone + '\n' + a.message });
  } catch (e) { console.error('E-mail:', e.message); }
}

/* ---------- API ---------- */
async function api(req, res, url) {
  const r = url.pathname, ip = req.socket.remoteAddress;
  try {
    if (r === '/api/schedule-config' && req.method === 'GET') return json(res, 200, { success: true, horizonDays: C.horizon, today: today(), price: C.price, whatsapp: C.whatsapp, pixEnabled: !!C.pixKey });
    if (r === '/api/slots' && req.method === 'GET') {
      const s = slots(url.searchParams.get('date') || '');
      return s ? json(res, 200, { success: true, slots: s }) : json(res, 400, { success: false, error: 'Data inválida.' });
    }
    if (r === '/api/appointments' && req.method === 'POST') {
      if (limited(ip)) return json(res, 429, { success: false, error: 'Muitas tentativas. Aguarde alguns minutos.' });
      const d = await body(req), t = k => String(d[k] || '').trim();
      if (t('website')) return json(res, 200, { success: true }); // honeypot
      const a = { name: t('name').slice(0, 100), email: t('email').slice(0, 254), phone: t('phone').slice(0, 15), date: t('date'), time: t('time'), message: t('message').slice(0, 1000) };
      let err = '';
      if (!a.name || !a.email) err = 'Preencha nome e e-mail.';
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) err = 'E-mail inválido.';
      else if (d.consent !== true) err = 'Autorize o uso dos dados.';
      else if (!(slots(a.date) || []).includes(a.time)) err = 'Esse horário não está mais disponível. Escolha outro.';
      if (err) return json(res, 409, { success: false, error: err });
      a.id = crypto.randomBytes(5).toString('hex'); a.status = 'reservado'; a.createdAt = new Date().toISOString();
      a.pix = pix(C.price, a.id.toUpperCase());
      db.appointments.push(a); save();
      const label = br(a.date) + ' às ' + a.time;
      const wa = 'https://wa.me/' + C.whatsapp + '?text=' + encodeURIComponent('Olá, Cinthia! Sou ' + a.name + ' e agendei sessão para ' + label + '.');
      let pixImage = ''; if (QR && a.pix) try { pixImage = await QR.toDataURL(a.pix, { margin: 1, width: 240 }); } catch {}
      notify(a, label, wa);
      return json(res, 200, { success: true, scheduledLabel: label, whatsappUrl: wa, pixPayload: a.pix, pixImage, pixAmount: C.price });
    }
    if (r.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { success: false, error: 'Token inválido.' });
      if (r === '/api/admin/appointments' && req.method === 'GET') return json(res, 200, { success: true, appointments: db.appointments.slice().sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time)) });
      const m = r.match(/^\/api\/admin\/appointments\/(\w+)$/);
      if (m && req.method === 'PATCH') {
        const a = db.appointments.find(x => x.id === m[1]), d = await body(req);
        if (!a || !['reservado', 'pago', 'cancelado'].includes(d.status)) return json(res, 400, { success: false, error: 'Requisição inválida.' });
        a.status = d.status; save(); return json(res, 200, { success: true });
      }
    }
    json(res, 404, { success: false, error: 'Não encontrado.' });
  } catch (e) { json(res, 400, { success: false, error: e.message }); }
}

/* ---------- servidor ---------- */
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  const html = (s) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); res.end(s); };
  if (url.pathname === '/') return html(SITE);
  if (url.pathname === '/admin') return html(ADMIN);
  const f = path.join(__dirname, path.basename(url.pathname)); // imagens ao lado do arquivo
  const types = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  if (types[path.extname(f).toLowerCase()] && fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': types[path.extname(f).toLowerCase()] }); return fs.createReadStream(f).pipe(res); }
  res.writeHead(404); res.end('Não encontrado');
}).listen(PORT, () => {
  console.log('Site: http://localhost:' + PORT + '\nAdmin: http://localhost:' + PORT + '/admin\nToken admin: ' + C.admin);
  if (!C.pixKey) console.log('Aviso: defina PIX_KEY para gerar o Pix.');
});

/* ---------- frontend ---------- */
const SITE = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cinthia Renata Durante | Psicóloga clínica online · CRP 06/149814</title>
<meta name="description" content="Atendimento psicológico online com Cinthia Renata Durante (CRP 06/149814). Sessões de 60 min, agendamento automático e pagamento por Pix.">
<meta name="theme-color" content="#f8f5f1"><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='20' fill='%231a1715'/><text x='50' y='68' text-anchor='middle' font-size='58' font-family='Georgia,serif' fill='%23b78945'>C</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Newsreader:opsz,wght@6..72,400;6..72,600&display=swap">
<style>
:root{--pr:#1a1715;--ac:#b78945;--tx:#171513;--mu:#5e5954;--ok:#1d8b64;--sh:0 24px 60px rgba(17,15,14,.09);--h:'Newsreader',Georgia,serif;--b:'Figtree',system-ui,sans-serif}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font-family:var(--b);color:var(--tx);background:radial-gradient(circle at top left,rgba(183,137,69,.12),transparent 24%),linear-gradient(#f8f5f1,#f3efe9)}
a{color:inherit;text-decoration:none}button,input,textarea,select{font:inherit}:focus-visible{outline:3px solid var(--ac);outline-offset:3px}
.c{width:min(1180px,calc(100% - 32px));margin:0 auto}
header{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.85);backdrop-filter:blur(16px);border-bottom:1px solid rgba(23,21,19,.06)}
.nav{min-height:76px;display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand{font:600 1.2rem var(--h);display:flex;align-items:center;gap:10px}.mark{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:linear-gradient(135deg,var(--pr),var(--ac));color:#fff}
.links{display:flex;gap:22px;color:var(--mu);font-size:.95rem}.links a:hover,.links a.active{color:var(--pr);font-weight:600}
.btn{display:inline-flex;justify-content:center;align-items:center;border:0;border-radius:999px;padding:.85rem 1.4rem;font-weight:700;cursor:pointer;transition:transform .2s}.btn:hover{transform:translateY(-1px)}
.p{background:linear-gradient(135deg,var(--pr),#2a211d);color:#fff}.s{background:#fff;border:1px solid rgba(183,137,69,.25);color:var(--tx)}.btn[disabled]{opacity:.6;cursor:wait}
.tg{display:none;border:1px solid rgba(183,137,69,.25);background:#fff;border-radius:12px;padding:.6rem .8rem}
section{padding:40px 0}.pg{display:none}.pg.on{display:block}
.hero{display:grid;grid-template-columns:1.1fr .9fr;gap:32px;align-items:center;padding-top:48px}
h1,h2,h3{font-family:var(--h);font-weight:600;margin:0}h1{font-size:clamp(2.3rem,5vw,4rem);line-height:1;letter-spacing:-.03em}
.ey{display:inline-block;padding:.45rem .85rem;border-radius:999px;background:rgba(255,255,255,.7);border:1px solid rgba(17,15,14,.06);font-size:.85rem;font-weight:700;margin-bottom:14px}
.lead{margin:18px 0 0;max-width:620px;line-height:1.8;color:var(--mu)}.row{display:flex;flex-wrap:wrap;gap:12px;margin-top:24px}
.bd{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid rgba(183,137,69,.15);border-radius:999px;padding:.4rem .75rem;color:var(--mu);font-size:.88rem}.bd:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ok)}
.card{background:rgba(255,255,255,.9);border:1px solid rgba(183,137,69,.13);border-radius:22px;box-shadow:var(--sh);padding:22px}
.card h3{font-size:1.5rem;margin-bottom:8px}.card p{margin:0;color:var(--mu);line-height:1.7}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.g2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.hd{text-align:center;max-width:720px;margin:0 auto 26px}.hd h2{font-size:clamp(1.8rem,3vw,2.6rem)}.hd p{color:var(--mu);line-height:1.7}
.num{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:var(--pr);color:#fff;font-weight:800;margin-bottom:12px}
.ck{list-style:none;padding:0;margin:14px 0 0;display:grid;gap:10px;color:var(--mu)}.ck li{padding-left:26px;position:relative}.ck li:before{content:"✓";position:absolute;left:0;color:var(--ok);font-weight:800}
.faq{padding:0;overflow:hidden}.faq button{all:unset;box-sizing:border-box;width:100%;display:flex;justify-content:space-between;padding:20px;font-weight:700;cursor:pointer}.faq button:focus-visible{outline:3px solid var(--ac)}
.faq div{display:none;padding:0 20px 18px;color:var(--mu);line-height:1.7}.faq.open div{display:block}.faq.open i{transform:rotate(45deg)}.faq i{font-style:normal;color:var(--ac);font-size:1.3rem}
.cta{display:grid;grid-template-columns:1.2fr .8fr;gap:20px;align-items:center;border-radius:28px;background:linear-gradient(135deg,#1a1715,#2a211d);padding:32px;color:#fff}.cta p{color:rgba(255,255,255,.8)}.cta h2{font-size:clamp(1.6rem,3vw,2.3rem)}
.ph{padding:44px 0 10px}.ph .card{padding:28px}.ph h2{font-size:clamp(1.7rem,3vw,2.5rem)}.ph p{max-width:720px;margin-top:12px}
.cl{display:grid;grid-template-columns:1.2fr .8fr;gap:22px;align-items:start}
form{display:grid;gap:14px;margin-top:14px}.f{display:grid;gap:6px}.f label{font-weight:700;font-size:.95rem}
.f input,.f textarea,.f select{width:100%;border-radius:14px;border:1px solid rgba(183,137,69,.25);background:#fff;padding:.85rem 1rem;color:var(--tx)}.f textarea{min-height:100px;resize:vertical}.f select:disabled{opacity:.6}
.f small{font-size:.8rem;color:var(--mu)}.chk{display:flex;gap:10px;color:var(--mu);font-size:.9rem;line-height:1.45}.hp{position:absolute;left:-9999px}
#st{min-height:22px;font-weight:700;font-size:.92rem}#st.ok{color:var(--ok)}#st.er{color:#cc3a4a}
.res{margin-top:20px;display:grid;gap:16px}.res .card{background:#faf7f2}.res img{max-width:200px;width:100%;background:#fff;padding:8px;border-radius:14px;margin:10px 0}.res textarea{width:100%;min-height:90px;border-radius:14px;border:1px solid rgba(183,137,69,.25);padding:.8rem}
.ban{padding:12px 14px;border-radius:14px;background:rgba(29,139,100,.12);color:var(--ok);margin:12px 0!important}
footer{padding:24px 0 40px;color:var(--mu)}footer .c{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;border-top:1px solid rgba(183,137,69,.15);padding-top:20px}
.toast{position:fixed;right:20px;bottom:88px;z-index:200;max-width:300px;padding:.85rem 1rem;border-radius:14px;color:#fff;font-weight:700;opacity:0;transform:translateY(12px);transition:.3s}.toast.show{opacity:1;transform:none}.toast.ok{background:#1f6f54}.toast.er{background:#b12d3f}
.wa{position:fixed;bottom:22px;right:22px;z-index:190;width:56px;height:56px;border-radius:50%;display:grid;place-items:center;background:#25d366;box-shadow:0 10px 28px rgba(37,211,102,.4)}.wa svg{width:28px;fill:#fff}
@media(max-width:980px){.hero,.cl,.cta,.g2{grid-template-columns:1fr}.g3{grid-template-columns:1fr 1fr}.tg{display:inline-flex}.links{display:none;position:absolute;top:76px;left:16px;right:16px;flex-direction:column;padding:16px;background:#fff;border-radius:14px;box-shadow:var(--sh)}.links.on{display:flex}}
@media(max-width:680px){.g3{grid-template-columns:1fr}.row .btn{width:100%}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}
</style></head><body>
<header><div class="c nav"><a href="#inicio" class="brand" data-nav="inicio"><span class="mark">C</span>Cinthia Renata Durante</a>
<nav class="links" id="menu" aria-label="Menu principal"><a href="#inicio" data-nav="inicio">Início</a><a href="#sobre" data-nav="sobre">Sobre</a><a href="#servicos" data-nav="servicos">Serviços</a><a href="#contato" data-nav="contato">Contato</a></nav>
<div><a class="btn s" href="#contato" data-nav="contato">Agendar</a> <button class="tg" id="tg" aria-label="Abrir menu" aria-expanded="false">☰</button></div></div></header>
<main>
<div class="pg on" id="page-inicio">
<section class="c hero"><div><span class="ey">Atendimento psicológico online</span><p style="margin:0 0 8px;font-weight:700">Cinthia Renata Durante · CRP 06/149814</p>
<h1>Um espaço de escuta acolhedora, ética e sigilosa.</h1><p class="lead">Psicoterapia online com atenção individual. Escolha data e horário, pague por Pix e faça a sessão pelo WhatsApp.</p>
<div class="row"><a class="btn p" href="#contato" data-nav="contato">Agendar atendimento</a><a class="btn s" href="#como">Como agendar</a></div>
<div class="row"><span class="bd">Psicóloga registrada no CRP</span><span class="bd">Sigilo profissional</span><span class="bd">Agendamento automático</span><span class="bd">Pagamento por Pix</span></div></div>
<div class="card"><img src="add26a35-9f28-4e00-8442-8a508b110c36.jpg" alt="Atendimento psicológico online" width="900" height="600" style="width:100%;height:300px;object-fit:cover;border-radius:18px" onerror="this.remove()">
<h3 style="margin-top:14px">Sessão de 60 min</h3><p>Valor por sessão: <b class="price">—</b> · somente Pix · pelo WhatsApp</p></div></section>
<section class="c"><div class="hd"><h2>Como é o atendimento</h2><p>Um processo organizado e acolhedor desde o primeiro contato.</p></div><div class="g3">
<article class="card"><h3>Acolhimento</h3><p>Você é recebido com empatia e atenção, em um ambiente pensado para o seu conforto.</p></article>
<article class="card"><h3>Processo simples</h3><p>Escolha o horário, pague por Pix e faça a sessão pelo WhatsApp no dia agendado.</p></article>
<article class="card"><h3>Privacidade e sigilo</h3><p>Tudo o que é conversado é protegido pelo sigilo profissional do Código de Ética da Psicologia.</p></article></div></section>
<section class="c" id="como"><div class="hd"><h2>Como funciona em 3 passos</h2></div><div class="g3">
<article class="card"><div class="num">1</div><h3>Escolha data e horário</h3><p>Informe seus dados e selecione um horário disponível.</p></article>
<article class="card"><div class="num">2</div><h3>Pague por Pix</h3><p>O código copia e cola aparece na tela e chega por e-mail.</p></article>
<article class="card"><div class="num">3</div><h3>Sessão no WhatsApp</h3><p>No horário reservado, inicie a conversa pelo WhatsApp.</p></article></div></section>
<section class="c"><div class="hd"><h2>Perguntas frequentes</h2></div><div class="g2">
<div class="card faq open"><button aria-expanded="true">Como funciona o agendamento?<i>+</i></button><div>Você escolhe data e horário. O sistema reserva o horário, gera o Pix e envia confirmação por e-mail. A sessão é pelo WhatsApp.</div></div>
<div class="card faq"><button aria-expanded="false">Qual é o valor?<i>+</i></button><div>Cada sessão de 60 minutos custa <b class="price">—</b>, pagos por Pix.</div></div>
<div class="card faq"><button aria-expanded="false">O atendimento é confidencial?</button><div>Sim. Protegido por sigilo profissional, conforme o Código de Ética do Psicólogo.</div></div>
<div class="card faq"><button aria-expanded="false">Posso cancelar ou remarcar?<i>+</i></button><div>Sim. Avise pelo WhatsApp com antecedência para combinar um novo horário.</div></div></div></section>
<section class="c"><div class="cta"><div><h2>Você não precisa enfrentar tudo sozinho.</h2><p>Agende seu atendimento online com acolhimento e sigilo.</p></div><div style="text-align:center"><a class="btn s" href="#contato" data-nav="contato">Quero agendar</a></div></div></section></div>

<div class="pg" id="page-sobre"><section class="ph c"><div class="card"><span class="ey">Sobre</span><h2>Um espaço de acolhimento, cuidado e confiança.</h2><p>Cinthia Renata Durante é psicóloga clínica (CRP 06/149814) e atende online, de forma individual, com escuta cuidadosa, ética e sigilo.</p></div></section>
<section class="c g2"><div class="card"><h3>Como é o atendimento</h3><p>Online, individual e voltado às necessidades de cada pessoa.</p><ul class="ck"><li>Sessões de 60 minutos</li><li>Ambiente acolhedor e confidencial</li><li>Agendamento automático pelo site</li><li>Pagamento por Pix</li></ul></div>
<div class="card"><h3>Valores</h3><ul class="ck"><li>Respeito à individualidade</li><li>Ética, sigilo e cuidado emocional</li><li>Combate ao estigma e ao isolamento</li><li>Escuta ativa e acolhimento</li></ul></div></section>
<section class="c"><div class="hd"><h2>Temas que podem ser trazidos</h2></div><div class="g3"><article class="card"><h3>Ansiedade e estresse</h3><p>Tensão emocional, excesso de demandas e cansaço mental.</p></article><article class="card"><h3>Relacionamentos</h3><p>Comunicação, autoestima, limites e vínculos.</p></article><article class="card"><h3>Bem-estar emocional</h3><p>Autoconhecimento e saúde emocional.</p></article></div></section></div>

<div class="pg" id="page-servicos"><section class="ph c"><div class="card"><span class="ey">Serviços</span><h2>Atendimento online pensado para você se sentir acolhido.</h2><p>Suporte emocional com psicóloga registrada no CRP, sigilo profissional e acolhimento em cada sessão.</p></div></section>
<section class="c"><div class="g3"><article class="card"><h3>Atendimento individual</h3><p>Sessões online para entender emoções, aliviar o estresse e fortalecer a saúde mental.</p></article><article class="card"><h3>Suporte emocional</h3><p>Ansiedade, relacionamentos, autoestima e dificuldades do cotidiano.</p></article><article class="card"><h3>Acompanhamento contínuo</h3><p>Organização e presença para seguir com progresso consistente.</p></article></div></section></div>

<div class="pg" id="page-contato"><section class="ph c"><div class="card"><span class="ey">Agende seu atendimento</span><h2>Entre em contato com a Cinthia.</h2><p>Escolha data e horário. Você recebe o Pix na tela e por e-mail. A sessão é pelo WhatsApp.</p></div></section>
<section class="c cl"><div class="card"><h3>Solicitar atendimento</h3>
<form id="fm" novalidate>
<div class="f"><label for="name">Nome</label><input id="name" name="name" autocomplete="name" maxlength="100" required></div>
<div class="f"><label for="email">E-mail</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required></div>
<div class="f"><label for="phone">Telefone (opcional)</label><input id="phone" name="phone" type="tel" placeholder="(00) 00000-0000" maxlength="15"></div>
<div class="f"><label for="date">Data da sessão</label><input id="date" name="date" type="date" required><small>Atendimento de segunda a sexta.</small></div>
<div class="f"><label for="time">Horário</label><select id="time" name="time" disabled><option value="">Escolha a data primeiro</option></select><small id="th"></small></div>
<div class="f"><label for="message">Mensagem (opcional)</label><textarea id="message" name="message" maxlength="1000" placeholder="Se quiser, conte um pouco sobre sua necessidade"></textarea></div>
<div class="hp" aria-hidden="true"><input name="website" tabindex="-1" autocomplete="off"></div>
<label class="chk"><input type="checkbox" name="consent"><span>Autorizo o uso dos meus dados para agendar e confirmar o atendimento.</span></label>
<button class="btn p" type="submit">Solicitar agendamento</button><div id="st" role="status" aria-live="polite"></div></form>
<div class="res" id="res" tabindex="-1" hidden><div class="card"><h3>Horário reservado</h3><p class="ban"><b>Horário:</b> <span id="lb"></span></p><a id="wl" class="btn p" target="_blank" rel="noopener">Iniciar sessão no WhatsApp</a></div>
<div class="card" id="px"><h3>Pagamento por Pix</h3><p>Valor: <b id="am"></b></p><img id="qr" alt="QR Code Pix" hidden><label for="pp" style="display:block;font-weight:700;margin:8px 0 6px">Pix copia e cola</label><textarea id="pp" readonly></textarea><button class="btn s" id="cp" type="button" style="margin-top:8px">Copiar código</button></div></div></div>
<div class="card"><h3>Outros contatos</h3><p>Tire dúvidas por WhatsApp ou e-mail.</p><p style="margin-top:14px"><b>WhatsApp</b><br><a id="wn" target="_blank" rel="noopener">(13) 99735-6921</a></p><p style="margin-top:14px;word-break:break-all"><b>E-mail</b><br><a href="mailto:durantepsicologia@gmail.com">durantepsicologia@gmail.com</a></p><p style="margin-top:14px">Somente Pix · sessões de 60 min pelo WhatsApp</p><p style="margin-top:16px"><b>Em situação de crise?</b> Ligue 188 (CVV, 24h) ou 192 (SAMU). Este site não é serviço de urgência.</p></div></section></div>
</main>
<footer><div class="c"><div><b>Cinthia Renata Durante</b> · Psicóloga · CRP 06/149814</div><a href="mailto:durantepsicologia@gmail.com">durantepsicologia@gmail.com</a></div></footer>
<a class="wa" id="wf" target="_blank" rel="noopener" aria-label="WhatsApp"><svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.435 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></a>
<script>
'use strict';
const $=s=>document.querySelector(s),$$=s=>document.querySelectorAll(s);
const today=()=>{const n=new Date();return n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0')};
function toast(m,t){const o=$('.toast');if(o)o.remove();const e=document.createElement('div');e.className='toast '+(t||'ok');e.setAttribute('role','status');e.textContent=m;document.body.appendChild(e);requestAnimationFrame(()=>e.classList.add('show'));setTimeout(()=>{e.classList.remove('show');setTimeout(()=>e.remove(),300)},2800)}
const PAGES=['inicio','sobre','servicos','contato'];
function show(id){$$('.pg').forEach(s=>s.classList.remove('on'));$('#page-'+id).classList.add('on');$$('[data-nav]').forEach(a=>a.classList.toggle('active',a.dataset.nav===id));scrollTo({top:0,behavior:'smooth'});$('#menu').classList.remove('on');$('#tg').setAttribute('aria-expanded','false')}
$$('[data-nav]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();history.pushState(null,'','#'+a.dataset.nav);show(a.dataset.nav)}));
const route=()=>{const h=location.hash.slice(1);show(PAGES.includes(h)?h:'inicio')};addEventListener('hashchange',route);route();
$('#tg').addEventListener('click',()=>{const o=$('#menu').classList.toggle('on');$('#tg').setAttribute('aria-expanded',o)});
$$('.faq button').forEach(b=>b.addEventListener('click',()=>{const it=b.parentElement,w=!it.classList.contains('open');$$('.faq').forEach(o=>{o.classList.remove('open');o.querySelector('button').setAttribute('aria-expanded','false')});if(w){it.classList.add('open');b.setAttribute('aria-expanded','true')}}));
$('#phone').addEventListener('input',e=>{let v=e.target.value.replace(/\\D/g,'').slice(0,11);e.target.value=v.length>6?'('+v.slice(0,2)+') '+v.slice(2,7)+'-'+v.slice(7):v.length>2?'('+v.slice(0,2)+') '+v.slice(2):v?'('+v:''});
const fm=$('#fm'),st=(m,t)=>{$('#st').className=t;$('#st').textContent=m},dt=fm.elements.date,tm=fm.elements.time;
const noTime=m=>{tm.innerHTML='<option value="">'+m+'</option>';tm.disabled=true;$('#th').textContent=''};
let cfg={horizonDays:30,whatsapp:'5513997356921'};
const money=v=>Number(v).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
fetch('/api/schedule-config').then(r=>r.json()).then(d=>{if(!d.success)return;cfg=d;$$('.price').forEach(e=>e.textContent=money(d.price));const w='https://wa.me/'+d.whatsapp;$('#wf').href=w+'?text='+encodeURIComponent('Olá, Cinthia! Gostaria de agendar um atendimento.');$('#wn').href=w;
dt.min=d.today;const m=new Date();m.setDate(m.getDate()+d.horizonDays);dt.max=m.getFullYear()+'-'+String(m.getMonth()+1).padStart(2,'0')+'-'+String(m.getDate()).padStart(2,'0')}).catch(()=>{$('#wf').href='https://wa.me/5513997356921';$('#wn').href=$('#wf').href});
dt.min=today();
dt.addEventListener('change',async()=>{if(!dt.value)return noTime('Escolha a data primeiro');noTime('Carregando horários...');
try{const r=await fetch('/api/slots?date='+encodeURIComponent(dt.value)),d=await r.json();
if(!d.success)return noTime(d.error||'Indisponível');
if(!d.slots.length){noTime('Nenhum horário livre');$('#th').textContent='Escolha outro dia útil.';return}
tm.innerHTML='<option value="">Selecione o horário</option>'+d.slots.map(t=>'<option>'+t+'</option>').join('');tm.disabled=false;$('#th').textContent=d.slots.length+' horário(s) disponível(is)'}catch{noTime('Servidor offline')}});
fm.addEventListener('submit',async e=>{e.preventDefault();const fd=new FormData(fm),t=k=>(fd.get(k)||'').toString().trim();
const d={name:t('name'),email:t('email'),phone:t('phone'),date:t('date'),time:t('time'),message:t('message'),website:t('website'),consent:fd.get('consent')==='on'};
let er='';if(!d.name||!d.email)er='Preencha nome e e-mail.';else if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(d.email))er='E-mail inválido.';else if(!d.date)er='Escolha a data.';else if(!d.time)er='Escolha o horário.';else if(!d.consent)er='Autorize o uso dos dados.';
if(er){st(er,'er');return toast(er,'er')}
const b=fm.querySelector('[type=submit]');b.disabled=true;st('Reservando horário...','ok');
try{const r=await fetch('/api/appointments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}),x=await r.json().catch(()=>({}));
if(!r.ok||!x.success)throw new Error(x.error||'Não foi possível agendar.');
$('#lb').textContent=x.scheduledLabel;$('#wl').href=x.whatsappUrl;$('#am').textContent=money(x.pixAmount);
$('#px').hidden=!x.pixPayload;$('#pp').value=x.pixPayload||'';const q=$('#qr');q.hidden=!x.pixImage;if(x.pixImage)q.src=x.pixImage;
$('#res').hidden=false;$('#res').scrollIntoView({behavior:'smooth'});st('Horário reservado: '+x.scheduledLabel+'. Conclua o Pix.','ok');toast('Horário reservado!');fm.reset();noTime('Escolha a data primeiro')}
catch(err){const m=err instanceof TypeError?'Servidor offline. Rode node server.js.':err.message;st(m,'er');toast(m,'er');if(dt.value)dt.dispatchEvent(new Event('change'))}
finally{b.disabled=false}});
$('#cp').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#pp').value);toast('Pix copiado!')}catch{$('#pp').select();toast('Copie com Ctrl+C','er')}});
</script></body></html>`;

/* ---------- painel admin ---------- */
const ADMIN = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin · Agendamentos</title>
<style>body{font-family:system-ui,sans-serif;background:#f8f5f1;color:#171513;margin:0;padding:24px}main{max-width:980px;margin:0 auto}h1{font-family:Georgia,serif}
input,select,button{font:inherit;padding:.6rem .8rem;border-radius:10px;border:1px solid #d9cdb8;background:#fff}button{background:#1a1715;color:#fff;cursor:pointer}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:14px;overflow:hidden;margin-top:16px}th,td{padding:.7rem;text-align:left;border-bottom:1px solid #eee;font-size:.92rem}th{background:#faf7f2}
.reservado{color:#9a6b00}.pago{color:#1d8b64}.cancelado{color:#b12d3f;text-decoration:line-through}#m{color:#b12d3f;margin-top:8px}</style></head><body><main>
<h1>Agendamentos</h1><p><input id="t" type="password" placeholder="Token de admin" autocomplete="current-password"> <button id="go">Entrar</button></p><div id="m"></div><div style="overflow-x:auto"><table id="tb" hidden><thead><tr><th>Data</th><th>Hora</th><th>Paciente</th><th>Contato</th><th>Status</th></tr></thead><tbody></tbody></table></div></main>
<script>
const $=s=>document.querySelector(s),H=()=>({Authorization:'Bearer '+$('#t').value,'Content-Type':'application/json'});
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function load(){$('#m').textContent='';const r=await fetch('/api/admin/appointments',{headers:H()}),d=await r.json();
if(!d.success){$('#tb').hidden=true;$('#m').textContent=d.error;return}
$('#tb').hidden=false;$('#tb tbody').innerHTML=d.appointments.map(a=>'<tr><td>'+esc(a.date.split('-').reverse().join('/'))+'</td><td>'+esc(a.time)+'</td><td>'+esc(a.name)+'<br><small>'+esc(a.message||'')+'</small></td><td>'+esc(a.email)+'<br>'+esc(a.phone||'')+'</td><td><select data-id="'+esc(a.id)+'" class="'+esc(a.status)+'">'+['reservado','pago','cancelado'].map(s=>'<option'+(s===a.status?' selected':'')+'>'+s+'</option>').join('')+'</select></td></tr>').join('')||'<tr><td colspan=5>Nenhum agendamento.</td></tr>'}
$('#go').onclick=load;$('#tb').addEventListener('change',async e=>{if(e.target.dataset.id){await fetch('/api/admin/appointments/'+e.target.dataset.id,{method:'PATCH',headers:H(),body:JSON.stringify({status:e.target.value})});load()}});
</script></body></html>`;
