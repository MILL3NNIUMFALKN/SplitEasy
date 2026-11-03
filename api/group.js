// Vercel serverless function: each group is one JSON value in Upstash Redis.
const crypto = require('crypto');
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const TTL = 60 * 60 * 24 * 365; // deleted after 1 year without any change
const CATS = ['Food', 'Travel', 'Stay', 'Shopping', 'Fun', 'Other'];
const CURS = ['₹', '$', '€', '£'];
const key = c => 'splitease:' + c;
const str = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const money = n => Number.isSafeInteger(n) && n > 0 && n <= 999999999999;
const okId = s => typeof s === 'string' && /^[a-z0-9]{3,12}$/.test(s);
const hash = (c, p) => crypto.createHash('sha256').update(c + ':' + p).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const paidOf = e => e.paid || [[e.p, e.a]];
const fresh = name => ({ name, people: [], exp: [], pay: [], cur: '₹', log: [] });

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function pairs(arr, total, has, zero) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const seen = new Set(); const out = []; let s = 0;
  for (const x of arr) {
    if (!Array.isArray(x) || !has(x[0]) || seen.has(x[0]) || !Number.isSafeInteger(x[1]) || x[1] < 0 || (!zero && x[1] === 0)) return null;
    seen.add(x[0]); s += x[1]; if (x[1] > 0) out.push([x[0], x[1]]);
  }
  return s === total && out.length ? out : null;
}

function buildExpense(S, d, old) {
  const has = id => S.people.some(p => p.id === id);
  if (!okId(d.id) || !str(d.d, 60) || !money(d.a) || d.a > 1e11) return 'That expense is not valid.';
  const paid = pairs(d.paid, d.a, has), sh = pairs(d.sh, d.a, has, true);
  if (!paid) return 'The amounts paid must add up to the total.';
  if (!sh) return 'The shares must add up to the amount.';
  return { id: d.id, d: str(d.d, 60), a: d.a, c: CATS.includes(d.c) ? d.c : 'Other',
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : today(), note: str(d.note, 120),
    paid, sh, sp: sh.map(x => x[0]), t: old ? old.t : Date.now() };
}

function apply(S, op, d, by, code) {
  const has = id => S.people.some(p => p.id === id);
  const nm = id => (S.people.find(p => p.id === id) || { name: '?' }).name;
  const m = a => S.cur + (a / 100).toFixed(2);
  const L = msg => { S.log.unshift({ t: Date.now(), m: by + ' ' + msg }); S.log = S.log.slice(0, 100); };
  if (op === 'addPerson') {
    const name = str(d.name, 30);
    if (!okId(d.id) || !name) return 'Enter a name.';
    if (has(d.id)) return null;
    if (S.people.some(p => p.name.toLowerCase() === name.toLowerCase())) return 'That name is already in the group.';
    if (S.people.length >= 30) return 'A group can have up to 30 people.';
    S.people.push({ id: d.id, name }); L('added ' + name);
  } else if (op === 'setUpi') {
    const p = S.people.find(x => x.id === d.id); const u = str(d.upi, 60);
    if (!p) return 'Unknown person.';
    if (u && !/^[\w.\-]{2,}@[a-zA-Z][\w.\-]{1,}$/.test(u)) return 'That UPI ID does not look right (example: name@bank).';
    if (u) p.upi = u; else delete p.upi;
    L('updated the UPI ID of ' + p.name);
  } else if (op === 'removePerson') {
    const used = S.exp.some(e => paidOf(e).some(x => x[0] === d.id) || (e.sp || []).includes(d.id)) || S.pay.some(p => p.from === d.id || p.to === d.id);
    if (used) return 'That person is part of an expense or payment.';
    const n = nm(d.id); S.people = S.people.filter(p => p.id !== d.id); L('removed ' + n);
  } else if (op === 'addExpense') {
    if (S.exp.some(e => e.id === d.id)) return null;
    if (S.exp.length >= 2000) return 'This group has too many expenses.';
    const e = buildExpense(S, d); if (typeof e === 'string') return e;
    S.exp.unshift(e); L(`added “${e.d}” (${m(e.a)})`);
  } else if (op === 'editExpense') {
    const i = S.exp.findIndex(e => e.id === d.id); if (i < 0) return 'That expense no longer exists.';
    const e = buildExpense(S, d, S.exp[i]); if (typeof e === 'string') return e;
    S.exp[i] = e; L(`edited “${e.d}” (${m(e.a)})`);
  } else if (op === 'delExpense') {
    const e = S.exp.find(x => x.id === d.id); if (!e) return null;
    S.exp = S.exp.filter(x => x.id !== d.id); L(`deleted “${e.d}”`);
  } else if (op === 'addPay') {
    if (S.pay.some(p => p.id === d.id)) return null;
    if (!okId(d.id) || !has(d.from) || !has(d.to) || d.from === d.to || !money(d.a)) return 'That payment is not valid.';
    S.pay.push({ id: d.id, from: d.from, to: d.to, a: d.a, t: Date.now() }); L(`marked ${nm(d.from)} paying ${nm(d.to)} ${m(d.a)} as paid`);
  } else if (op === 'delPay') {
    const p = S.pay.find(x => x.id === d.id); if (!p) return null;
    S.pay = S.pay.filter(x => x.id !== d.id); L(`undid a payment from ${nm(p.from)} to ${nm(p.to)}`);
  } else if (op === 'setCur') {
    if (!CURS.includes(d.cur)) return 'Unknown currency.';
    S.cur = d.cur; L('changed the currency to ' + d.cur);
  } else if (op === 'rename') {
    const n = str(d.name, 40); if (!n) return 'Enter a group name.';
    S.name = n; L('renamed the group to ' + n);
  } else if (op === 'setPin') {
    const p = String(d.pin || '');
    if (p && !/^\d{4,8}$/.test(p)) return 'The PIN must be 4 to 8 digits.';
    if (p) S._pin = hash(code, p); else delete S._pin;
    L(p ? 'set a group PIN' : 'removed the group PIN');
  } else if (op === 'reset') {
    S.people = []; S.exp = []; S.pay = []; L('cleared all data');
  } else return 'Unknown action.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'The database is not connected yet. Add Upstash Redis under Storage in Vercel, then redeploy.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { op, code, pin, data } = body;
    const by = str(body.by, 30) || 'Someone';
    const out = S => { const o = { ...S }; delete o._pin; return { state: o, hasPin: !!S._pin }; };
    if (op === 'create') {
      const d = data || {}; const name = str(d.name, 40) || 'Our group'; const p = String(d.pin || '');
      if (p && !/^\d{4,8}$/.test(p)) return res.status(400).json({ error: 'The PIN must be 4 to 8 digits.' });
      for (let i = 0; i < 20; i++) {
        const c = String(Math.floor(10000 + Math.random() * 90000));
        const S = fresh(name); if (p) S._pin = hash(c, p);
        if (await redis(['SET', key(c), JSON.stringify(S), 'NX', 'EX', TTL]) === 'OK') return res.json({ code: c, ...out(S) });
      }
      return res.status(503).json({ error: 'Could not make a code. Try again.' });
    }
    if (!/^\d{5}$/.test(String(code))) return res.status(400).json({ error: 'Enter a 5-digit code.' });
    const raw = await redis(['GET', key(code)]);
    if (!raw) return res.status(404).json({ error: 'No group with that code.' });
    const S = Object.assign(fresh('Our group'), JSON.parse(raw));
    if (S._pin && (!pin || hash(code, String(pin)) !== S._pin)) return res.status(401).json({ error: pin ? 'Wrong PIN.' : 'This group needs a PIN.', pin: true });
    if (op !== 'get') {
      const err = apply(S, op, data || {}, by, code);
      if (err) return res.status(400).json({ error: err });
      await redis(['SET', key(code), JSON.stringify(S), 'EX', TTL]);
    }
    return res.json(out(S));
  } catch (e) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};
