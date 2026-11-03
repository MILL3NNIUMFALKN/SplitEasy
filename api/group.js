// Vercel serverless function: stores each group as one JSON value in Upstash Redis.
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const TTL = 60 * 60 * 24 * 365; // a group is deleted after 1 year without any change
const CATS = ['Food', 'Travel', 'Stay', 'Shopping', 'Fun', 'Other'];
const CURS = ['₹', '$', '€', '£'];
const key = c => 'splitease:' + c;
const empty = () => ({ people: [], exp: [], pay: [], cur: '₹' });
const str = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const money = n => Number.isSafeInteger(n) && n > 0 && n <= 999999999999;
const okId = s => typeof s === 'string' && /^[a-z0-9]{3,12}$/.test(s);

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

function apply(S, op, d) {
  const has = id => S.people.some(p => p.id === id);
  if (op === 'addPerson') {
    const name = str(d.name, 30);
    if (!okId(d.id) || !name) return 'Enter a name.';
    if (S.people.some(p => p.id === d.id)) return null;
    if (S.people.some(p => p.name.toLowerCase() === name.toLowerCase())) return 'That name is already in the group.';
    if (S.people.length >= 30) return 'A group can have up to 30 people.';
    S.people.push({ id: d.id, name });
  } else if (op === 'removePerson') {
    const used = S.exp.some(e => e.p === d.id || e.sp.includes(d.id)) || S.pay.some(p => p.from === d.id || p.to === d.id);
    if (used) return 'That person is part of an expense or payment.';
    S.people = S.people.filter(p => p.id !== d.id);
  } else if (op === 'addExpense') {
    if (S.exp.some(e => e.id === d.id)) return null;
    const sh = Array.isArray(d.sh) ? d.sh : [];
    const ids = sh.map(x => x && x[0]);
    if (!okId(d.id) || !str(d.d, 60) || !money(d.a) || !has(d.p)) return 'That expense is not valid.';
    if (!sh.length || sh.some(x => !Array.isArray(x) || !has(x[0]) || !Number.isSafeInteger(x[1]) || x[1] < 0)
      || new Set(ids).size !== ids.length || sh.reduce((s, x) => s + x[1], 0) !== d.a) return 'The shares must add up to the amount.';
    if (S.exp.length >= 2000) return 'This group has too many expenses.';
    S.exp.unshift({ id: d.id, d: str(d.d, 60), a: d.a, p: d.p, c: CATS.includes(d.c) ? d.c : 'Other', sp: ids, sh: sh.map(x => [x[0], x[1]]), t: Date.now() });
  } else if (op === 'delExpense') {
    S.exp = S.exp.filter(e => e.id !== d.id);
  } else if (op === 'addPay') {
    if (S.pay.some(p => p.id === d.id)) return null;
    if (!okId(d.id) || !has(d.from) || !has(d.to) || d.from === d.to || !money(d.a)) return 'That payment is not valid.';
    S.pay.push({ id: d.id, from: d.from, to: d.to, a: d.a, t: Date.now() });
  } else if (op === 'delPay') {
    S.pay = S.pay.filter(p => p.id !== d.id);
  } else if (op === 'setCur') {
    if (!CURS.includes(d.cur)) return 'Unknown currency.';
    S.cur = d.cur;
  } else if (op === 'reset') {
    S.people = []; S.exp = []; S.pay = [];
  } else return 'Unknown action.';
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'The database is not connected yet. Add Upstash Redis under Storage in Vercel, then redeploy.' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { op, code, data } = body;
    if (op === 'create') {
      for (let i = 0; i < 20; i++) {
        const c = String(Math.floor(10000 + Math.random() * 90000));
        if (await redis(['SET', key(c), JSON.stringify(empty()), 'NX', 'EX', TTL]) === 'OK') return res.json({ code: c, state: empty() });
      }
      return res.status(503).json({ error: 'Could not make a code. Try again.' });
    }
    if (!/^\d{5}$/.test(String(code))) return res.status(400).json({ error: 'Enter a 5-digit code.' });
    const raw = await redis(['GET', key(code)]);
    if (!raw) return res.status(404).json({ error: 'No group with that code.' });
    const S = JSON.parse(raw);
    if (op !== 'get') {
      const err = apply(S, op, data || {});
      if (err) return res.status(400).json({ error: err });
      await redis(['SET', key(code), JSON.stringify(S), 'EX', TTL]);
    }
    return res.json({ state: S });
  } catch (e) {
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
};
