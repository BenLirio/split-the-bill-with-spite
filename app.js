// Split the Bill With Spite — paste 3-6 diners + what they did at dinner; return
// a spite-adjusted itemized receipt.
//
// Design decisions (per KB + skill rules):
//   - SINGLE paste-all textarea for intake. One line per person, format:
//       "<name> <free-form description of what they did>"
//     First whitespace-separated token is the name; the rest is behavior.
//   - Deterministic core logic (verdict picks, spite deltas, totals) — seeded
//     off a hash of the input so the same paste always yields the same receipt.
//   - Optional LLM flourish per person (one snappy quoted line-item quip).
//     Temperature 0, response_format=json_object. Deterministic fallback if the
//     call fails, times out, or returns garbage.
//   - Final state is encoded into location.hash so a shared link re-renders the
//     exact same receipt without any LLM call or recompute. Re-hydration is the
//     only code path reading the fragment; never re-decides verdicts.
//   - Mobile-first, modern Venmo/Splitwise aesthetic. No retro typewriter.

const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
const SLUG = 'split-the-bill-with-spite';
const MIN_PEOPLE = 3;
const MAX_PEOPLE = 6;

// ---------- util ----------

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  const v = Math.abs(n);
  return sign + '$' + v.toFixed(2);
}

function fmtMoneyDelta(n) {
  if (Math.abs(n) < 0.005) return '$0.00';
  return (n > 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2);
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function receiptIdFromSeed(seed) {
  return 'RCPT-' + String(seed % 1000000).padStart(6, '0');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// base64url of JSON (URL-safe, no padding) — used for fragment state.
function b64urlEncode(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  try {
    let str = s.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) { return null; }
}

// ---------- verdict catalog ----------
//
// Every verdict is a self-contained archetype label + a spite multiplier in
// [min, max] cents-on-the-dollar relative to their fair share. Positive values
// charge the person more; negative values refund them. Deterministic pick by
// keyword match against their description, then seeded fallback.

const VERDICTS = [
  { name: 'The Lobster Heiress',          mult: [0.25, 0.55],  tags: ['lobster','steak','ribeye','wagyu','oyster','truffle','caviar','tasting menu','market price'] },
  { name: 'The Unpaid Narrator',          mult: [0.20, 0.50],  tags: ['wallet','forgot','left','card','venmo','cash','ill pay you back','ill get you next'] },
  { name: 'The Calendar Saboteur',        mult: [0.10, 0.25],  tags: ['late','30 min','40 min','traffic','uber','running','running late','showed up at'] },
  { name: 'The Crypto Homily Giver',      mult: [0.15, 0.30],  tags: ['crypto','bitcoin','btc','eth','ethereum','nft','blockchain','web3','solana','doge','token'] },
  { name: 'The Side-Eye Ascetic',         mult: [-0.20, -0.05], tags: ['water','just water','tap','salad','side salad','didnt eat','not hungry','didnt drink','nothing','just the'] },
  { name: 'The Sommelier Volunteer',      mult: [0.20, 0.45],  tags: ['wine','bottle','second bottle','pinot','chardonnay','cab','cabernet','somm','pairings','pairing','natural wine','glass of','old fashioned','whiskey','neat','cocktail','espresso martini','martini'] },
  { name: 'The Appetizer Opportunist',    mult: [0.05, 0.15],  tags: ['appetizer','app','picked at','shared','everyones fries','split the','nibbled','stole a'] },
  { name: 'The Birthday Freeloader',      mult: [-0.10, 0.05], tags: ['birthday','its my birthday','bday','turning'] },
  { name: 'The Dietary Restrictor',       mult: [-0.05, 0.10], tags: ['gluten','vegan','vegetarian','allergy','allergic','lactose','keto','paleo','intolerant','sub the'] },
  { name: 'The Substitution Surgeon',     mult: [0.05, 0.15],  tags: ['sub','substitute','no onion','no cheese','on the side','dressing on','well done','extra','hold the','swap','modify','modification'] },
  { name: 'The Reservation Dictator',     mult: [0.05, 0.15],  tags: ['reservation','picked','chose','i picked','i chose','my idea','this place','booked'] },
  { name: 'The Split Evangelist',         mult: [-0.05, 0.10], tags: ['split it evenly','even split','split evenly','split the bill','just split','divide it','divide evenly'] },
  { name: 'The Ex-Texter',                mult: [0.05, 0.20],  tags: ['ex','phone','texting','texted','on the phone','stepped out','took a call'] },
  { name: 'The Crying Toddler Delegate',  mult: [-0.10, 0.10], tags: ['baby','toddler','kid','child','stroller','sippy','screaming','cried','highchair'] },
  { name: 'The Group Photographer',       mult: [-0.05, 0.05], tags: ['photo','photos','picture','group photo','selfie','took pictures','for the gram','instagram','posted'] },
  { name: 'The Ambient Vegetarian Judge', mult: [0.00, 0.15],  tags: ['judged','judging','stared','rolled her eyes','rolled his eyes','rolled their eyes','eyerolled','side-eyed','sighed'] },
  { name: 'The Menu Re-Reader',           mult: [0.05, 0.15],  tags: ['menu','still looking','took forever','couldnt decide','changed my order','changed their order'] },
  { name: 'The Group-Chat Monarch',       mult: [0.10, 0.25],  tags: ['group chat','organized','planned','planning','sent the link','who sent','picked the time'] },
  { name: 'The Dessert Insurgent',        mult: [0.05, 0.20],  tags: ['dessert','tiramisu','creme brulee','cheesecake','cake','affogato','sundae'] },
  { name: 'The Tip Optimizer',            mult: [0.10, 0.25],  tags: ['tip','15','18','20','percent','%','gratuity','service charge','tip calculator'] },
  { name: 'The Upsell Casualty',          mult: [0.10, 0.25],  tags: ['upgrade','added','got the','deluxe','chef special','specials','upsell'] },
  { name: 'The Unsolicited Sommelier',    mult: [0.15, 0.30],  tags: ['recommended','explained the wine','explained','lectured','lecture','gave a speech','held court'] },
  { name: 'The Double-Entree Defendant',  mult: [0.30, 0.55],  tags: ['two entrees','second lobster','second entree','ordered two','a second','ordered a second','extra entree'] },
  { name: 'The Complimentary-Bread Loyalist', mult: [-0.10, 0.05], tags: ['bread','breadbasket','bread basket','more bread','basket of bread','butter'] },
];

// Broad keyword rules that fire when nothing in the per-verdict tag list matches.
// Deterministic secondary fallback: pick by seeded index.
const FALLBACK_VERDICTS = [
  { name: 'The Low-Key Defendant',        mult: [0.00, 0.10] },
  { name: 'The Ambient Enabler',          mult: [0.00, 0.12] },
  { name: 'The Procedural Bystander',     mult: [-0.05, 0.05] },
  { name: 'The Deeply Innocent Suspect',  mult: [-0.08, 0.03] },
  { name: 'The Unindicted Co-Diner',      mult: [0.00, 0.08] },
];

function pickVerdict(name, behaviorText, seed) {
  const lower = (name + ' ' + behaviorText).toLowerCase();
  // Strip punctuation for robust tag matching.
  const norm = lower.replace(/[^\w\s%]/g, ' ').replace(/\s+/g, ' ');

  // Score each verdict by number of tag hits.
  let best = null;
  let bestScore = 0;
  for (const v of VERDICTS) {
    let score = 0;
    for (const t of v.tags) {
      if (norm.indexOf(t) !== -1) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  if (best) return best;

  const idx = seed % FALLBACK_VERDICTS.length;
  return FALLBACK_VERDICTS[idx];
}

// ---------- parsing + totals ----------

function parseLog(raw) {
  // Returns list of { name, behavior } — first token is the name, rest is text.
  const lines = String(raw || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    // Remove leading bullets/dashes.
    const cleaned = line.replace(/^[-*\u2022]\s*/, '').trim();
    if (!cleaned) continue;

    // Split on first separator: em-dash, en-dash, colon, comma, or whitespace.
    let m = cleaned.match(/^([A-Za-z][\w.'\-]*)\s*[\u2014\u2013:,\-]\s*(.+)$/);
    let name, behavior;
    if (m) {
      name = m[1];
      behavior = m[2].trim();
    } else {
      // Fall back to first whitespace-separated token as the name.
      const parts = cleaned.split(/\s+/);
      name = parts[0];
      behavior = parts.slice(1).join(' ').trim();
    }
    if (!name) continue;
    if (!behavior) behavior = '(no notes)';
    // Clean up trailing period on the whole behavior string so quoting looks neat.
    behavior = behavior.replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
    out.push({ name, behavior });
  }
  return out;
}

function validateInput(bill, people) {
  if (!(bill >= 1 && bill <= 99999)) {
    return 'bill total needs to be a number between $1 and $99,999.';
  }
  if (people.length < MIN_PEOPLE) {
    return `we need at least ${MIN_PEOPLE} people on this receipt. add a line per person.`;
  }
  if (people.length > MAX_PEOPLE) {
    return `max ${MAX_PEOPLE} people per receipt — the pettiness doesn't scale past six.`;
  }
  return null;
}

// ---------- core computation (deterministic) ----------

function computeReceipt(bill, people) {
  const fullInput = JSON.stringify({ b: bill.toFixed(2), p: people });
  const seed = hash(fullInput);
  const rand = mulberry32(seed);

  const fairShare = bill / people.length;

  // Per-person: pick verdict, compute deltas deterministically.
  const draft = people.map((p, i) => {
    const localSeed = hash(p.name + '|' + p.behavior + '|' + i);
    const verdict = pickVerdict(p.name, p.behavior, localSeed);

    // Spite multiplier: interpolate deterministically between mult[0] and mult[1].
    const r = mulberry32(localSeed)();
    const mult = verdict.mult[0] + (verdict.mult[1] - verdict.mult[0]) * r;
    const spiteDelta = fairShare * mult;

    return {
      name: p.name,
      behavior: p.behavior,
      fair_share: fairShare,
      spite_delta: spiteDelta,
      verdict: verdict.name,
      is_spicy: Math.abs(mult) >= 0.2,
      line_items: buildLocalLineItems(p, verdict, spiteDelta, fairShare, localSeed),
    };
  });

  // Zero-sum across the group so the stated bill still equals sum(amounts)
  // EXCEPT that we intentionally *add* a spite surplus — the whole joke is that
  // the new total is > stated. We add deltas directly and surface the surplus.
  const totalSpite = draft.reduce((s, p) => s + p.spite_delta, 0);
  const newTotal = bill + totalSpite;

  const results = draft.map(p => ({
    ...p,
    amount_owed: Math.max(0, p.fair_share + p.spite_delta),
  }));

  return {
    bill,
    fair_share: fairShare,
    spite_surplus: totalSpite,
    new_total: newTotal,
    people: results,
    seed,
    receipt_id: receiptIdFromSeed(seed),
    date: todayStr(),
    _source: 'local',
  };
}

// Locally-composed line-items: one snarky quote of the person's own line, one
// spite adjustment, one friendly share label. These are replaced by the LLM
// flourish when it succeeds.
function buildLocalLineItems(person, verdict, spiteDelta, fairShare, localSeed) {
  const quipBank = [
    (b) => `"${b}" — surcharge`,
    (b) => `"${b}" — filed as evidence`,
    (b) => `"${b}" — petty tax`,
    (b) => `"${b}" — assessed`,
    (b) => `"${b}" — noted for the record`,
    (b) => `"${b}" — line-itemed`,
    (b) => `"${b}" — billed`,
  ];
  const quip = quipBank[localSeed % quipBank.length](truncate(person.behavior, 64));

  const items = [
    { desc: 'share of dinner',                 amount: fairShare,  cls: '' },
    { desc: quip,                              amount: spiteDelta, cls: spiteDelta >= 0 ? 'pos' : 'neg' },
  ];
  return items;
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '\u2026';
}

// ---------- LLM flourish (one call per user journey; deterministic fallback) ----------

function buildMessages(receipt) {
  const peopleSummaries = receipt.people.map((p, i) =>
    `  ${i + 1}. name: ${JSON.stringify(p.name)}; behavior: ${JSON.stringify(p.behavior)}; verdict: ${JSON.stringify(p.verdict)}`
  ).join('\n');

  const system =
    `You are a petty, deadpan bill-splitter writing a single one-line "item" per diner for a fake itemized restaurant receipt. Voice: dry, slightly mean, surgically specific. No emojis. No hashtags. No preamble.\n\n` +
    `You will be given 3–6 diners. For each one you MUST return ONE snarky line-item that:\n` +
    `- Quotes the diner's own behavior verbatim in double-quotes somewhere in the line (copy their words; do not paraphrase).\n` +
    `- Is ≤ 14 words total.\n` +
    `- Ends with an em-dash followed by a charge-name (examples: "— lobster tax", "— narrator fee", "— crypto homily surcharge", "— wallet amnesia penalty"). Invent a specific charge-name for each person. Do NOT reuse the same charge-name twice in one response.\n` +
    `- Does NOT include a dollar amount. No numbers. The amount is computed by the app.\n` +
    `- Does NOT address the diner in second person.\n\n` +
    `HARD RULES:\n` +
    `- Respond with ONLY a single JSON object matching the schema below. No markdown, no code fences, no commentary, no "here is your receipt", no trailing questions.\n` +
    `- Do not offer to refine, expand, or regenerate. The UI has no chat input.\n\n` +
    `SCHEMA:\n` +
    `{\n` +
    `  "items": [\n` +
    `    { "name": string, "item": string }   // exactly ${receipt.people.length} entries, in the SAME order as input, each "name" matching the input name\n` +
    `  ]\n` +
    `}\n\n` +
    `Examples of the required item style (do not copy verbatim):\n` +
    `- "filed \\"ordered the lobster and then a second lobster\\" — double-entree tariff"\n` +
    `- "logged \\"forgot her wallet. again.\\" — repeat-offender narrator fee"\n` +
    `- "\\"talked about crypto for 40 minutes\\" — airtime tax"\n`;

  const user =
    `Stated bill: $${receipt.bill.toFixed(2)} across ${receipt.people.length} diners.\n\n` +
    `Diners:\n${peopleSummaries}\n\n` +
    `Return the JSON object only.`;

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ];
}

function sanitizeLLMItems(parsed, receipt) {
  if (!parsed || typeof parsed !== 'object') return null;
  const arr = Array.isArray(parsed.items) ? parsed.items : null;
  if (!arr || arr.length !== receipt.people.length) return null;

  const lineMap = {};
  for (let i = 0; i < receipt.people.length; i++) {
    const entry = arr[i];
    if (!entry || typeof entry !== 'object') return null;
    const item = typeof entry.item === 'string' ? entry.item.trim() : '';
    if (!item) return null;
    if (item.length > 220) return null;
    lineMap[i] = item;
  }
  return lineMap;
}

async function tryLLMFlourish(receipt) {
  try {
    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: SLUG,
        messages: buildMessages(receipt),
        model: 'gpt-5.4-mini',
        max_tokens: 400,
        temperature: 0,
        response_format: 'json_object',
      }),
    });
    if (!res.ok) throw new Error('http_' + res.status);
    const data = await res.json();
    const raw = (data && data.content) || '';
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    const map = sanitizeLLMItems(parsed, receipt);
    if (!map) return null;
    return map;
  } catch (_) {
    return null;
  }
}

// Apply the LLM quip into the first "quote" line-item for each person, keeping
// the spite-delta dollar amount intact.
function applyFlourish(receipt, map) {
  if (!map) return receipt;
  const out = { ...receipt, _source: 'ai', people: receipt.people.map((p, i) => {
    const quip = map[i];
    if (!quip) return p;
    const items = p.line_items.slice();
    // Replace the "quote" line-item (index 1) description but keep the amount.
    if (items[1]) {
      items[1] = { ...items[1], desc: quip };
    }
    return { ...p, line_items: items };
  })};
  return out;
}

// ---------- fragment state ----------
//
// Shape:
//   #r=<base64url of { b: billCents, d: [ { n, v, a, q } ] }>
// where each entry has:
//   n: name
//   v: verdict
//   a: amount owed (cents, integer)
//   q: per-person quip line (the flourish item text)
// plus a short optional behavior echo so the share link is self-describing.
// Re-hydration reconstructs fair_share and spite_delta from amount+bill/count.

function encodeReceiptToFragment(receipt) {
  const payload = {
    b: Math.round(receipt.bill * 100),
    n: receipt.new_total ? Math.round(receipt.new_total * 100) : null,
    d: receipt.people.map(p => ({
      n: p.name,
      b: p.behavior,
      v: p.verdict,
      a: Math.round(p.amount_owed * 100),
      q: (p.line_items && p.line_items[1] && p.line_items[1].desc) || '',
      s: p.is_spicy ? 1 : 0,
    })),
    id: receipt.receipt_id,
    dt: receipt.date,
  };
  return '#r=' + b64urlEncode(payload);
}

function decodeFragment() {
  const m = (location.hash || '').match(/^#r=([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const obj = b64urlDecode(m[1]);
  if (!obj || typeof obj !== 'object') return null;
  if (!Array.isArray(obj.d) || obj.d.length < MIN_PEOPLE || obj.d.length > MAX_PEOPLE) return null;
  return obj;
}

function receiptFromFragment(obj) {
  const bill = (obj.b || 0) / 100;
  const fairShare = obj.d.length ? bill / obj.d.length : 0;
  const people = obj.d.map(entry => {
    const amount = (entry.a || 0) / 100;
    const spiteDelta = amount - fairShare;
    return {
      name: String(entry.n || '').slice(0, 40),
      behavior: String(entry.b || '(no notes)').slice(0, 240),
      fair_share: fairShare,
      spite_delta: spiteDelta,
      verdict: String(entry.v || 'The Low-Key Defendant').slice(0, 60),
      amount_owed: amount,
      is_spicy: entry.s === 1,
      line_items: [
        { desc: 'share of dinner', amount: fairShare, cls: '' },
        { desc: String(entry.q || '"(filed)" — receipt charge'), amount: spiteDelta, cls: spiteDelta >= 0 ? 'pos' : 'neg' },
      ],
    };
  });
  const totalOwed = people.reduce((s, p) => s + p.amount_owed, 0);
  const newTotal = obj.n != null ? obj.n / 100 : totalOwed;
  return {
    bill,
    fair_share: fairShare,
    spite_surplus: newTotal - bill,
    new_total: newTotal,
    people,
    seed: 0,
    receipt_id: String(obj.id || '').slice(0, 16) || 'RCPT-000000',
    date: String(obj.dt || todayStr()).slice(0, 10),
    _source: 'fragment',
  };
}

// ---------- rendering ----------

const $ = (id) => document.getElementById(id);

function showScreen(name) {
  ['intake', 'loading', 'result'].forEach(n => {
    const el = $(n);
    if (!el) return;
    el.classList.toggle('hidden', n !== name);
  });
  window.scrollTo(0, 0);
}

function updateLineCount() {
  const el = $('log');
  const countEl = $('line-count');
  if (!el || !countEl) return;
  const lines = parseLog(el.value);
  const n = lines.length;
  countEl.textContent = `${n} / ${MAX_PEOPLE} people`;
  countEl.classList.toggle('ready', n >= MIN_PEOPLE && n <= MAX_PEOPLE);
  countEl.classList.toggle('over',  n > MAX_PEOPLE);
}

function renderReceipt(receipt) {
  $('receipt-date').textContent = receipt.date;
  $('receipt-id').textContent = receipt.receipt_id;
  $('foot-id').textContent = `${receipt.receipt_id} · filed ${receipt.date}`;

  const container = $('people');
  container.innerHTML = '';
  receipt.people.forEach(p => {
    const div = document.createElement('div');
    div.className = 'person';

    const head = document.createElement('div');
    head.className = 'person-head';
    const nm = document.createElement('div');
    nm.className = 'person-name';
    nm.textContent = p.name;
    const amt = document.createElement('div');
    amt.className = 'person-amount mono';
    amt.textContent = fmtMoney(p.amount_owed);
    head.appendChild(nm);
    head.appendChild(amt);

    const verdict = document.createElement('span');
    verdict.className = 'verdict' + (p.is_spicy ? ' spicy' : '');
    verdict.textContent = p.verdict;

    const items = document.createElement('ul');
    items.className = 'line-items';
    p.line_items.forEach(li => {
      const row = document.createElement('li');
      const desc = document.createElement('span');
      desc.className = 'li-desc';
      desc.textContent = li.desc;
      const amt2 = document.createElement('span');
      amt2.className = 'li-amt ' + (li.cls || '');
      amt2.textContent = (li.cls === 'pos' || li.cls === 'neg') ? fmtMoneyDelta(li.amount) : fmtMoney(li.amount);
      row.appendChild(desc);
      row.appendChild(amt2);
      items.appendChild(row);
    });

    div.appendChild(head);
    div.appendChild(verdict);
    div.appendChild(items);
    container.appendChild(div);
  });

  $('bill-stated').textContent = fmtMoney(receipt.bill);
  $('spite-adj').textContent = fmtMoneyDelta(receipt.spite_surplus);
  $('bill-total-out').textContent = fmtMoney(receipt.new_total);

  showScreen('result');
}

// ---------- flow ----------

function parseBill(raw) {
  const cleaned = String(raw || '').replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : NaN;
}

async function runSplit({ bill, people }, { updateFragment = true } = {}) {
  showScreen('loading');

  // Deterministic local receipt first.
  let receipt = computeReceipt(bill, people);

  // Run the LLM flourish in parallel with a minimum loader time (~900ms).
  const minDelay = new Promise(r => setTimeout(r, 900));
  try {
    const [flourish] = await Promise.all([tryLLMFlourish(receipt), minDelay]);
    if (flourish) receipt = applyFlourish(receipt, flourish);
  } catch (_) { /* keep local receipt */ }

  if (updateFragment) {
    history.replaceState(null, '', encodeReceiptToFragment(receipt));
  }
  renderReceipt(receipt);
}

function onSubmit(e) {
  e.preventDefault();
  const bill = parseBill($('bill-total').value);
  const people = parseLog($('log').value);

  const err = validateInput(bill, people);
  const errEl = $('intake-error');
  if (err) {
    errEl.textContent = err;
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');

  runSplit({ bill, people });
}

function onReset() {
  history.replaceState(null, '', location.pathname + location.search);
  $('log').value = '';
  $('bill-total').value = '184.00';
  updateLineCount();
  $('intake-error').classList.add('hidden');
  showScreen('intake');
  const logEl = $('log');
  if (logEl) logEl.focus();
}

const SAMPLE = [
  'Ben ordered the lobster and a second lobster',
  'Sarah forgot her wallet. again.',
  'Kai talked about crypto for 40 minutes',
  'Priya ordered water and judged everyone',
  'Marcus split an appetizer and called it dinner',
].join('\n');

function onSample() {
  $('log').value = SAMPLE;
  $('bill-total').value = '184.00';
  updateLineCount();
  $('intake-error').classList.add('hidden');
}

// Share: prefer navigator.share (URL contains fragment); fall back to clipboard.
function share() {
  const url = location.href;
  const total = ($('bill-total-out') && $('bill-total-out').textContent) || '';
  const text = total
    ? `spitesplit: new total ${total}. see who got charged for what.`
    : `spitesplit — split the bill with spite.`;
  if (navigator.share) {
    navigator.share({ title: document.title, text, url }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(`${text} ${url}`)
      .then(() => alert('link copied — paste it anywhere.'))
      .catch(() => alert(url));
  } else {
    alert(url);
  }
}
window.share = share;

// ---------- init ----------

document.addEventListener('DOMContentLoaded', () => {
  updateLineCount();

  const form = $('intake-form');
  if (form) form.addEventListener('submit', onSubmit);
  const resetBtn = $('reset-btn');
  if (resetBtn) resetBtn.addEventListener('click', onReset);
  const sampleBtn = $('sample-btn');
  if (sampleBtn) sampleBtn.addEventListener('click', onSample);
  const logEl = $('log');
  if (logEl) logEl.addEventListener('input', updateLineCount);
  const ownCta = $('own-cta');
  if (ownCta) ownCta.addEventListener('click', (e) => {
    e.preventDefault();
    onReset();
  });

  // Deep-link replay: render from fragment without any re-compute / LLM call.
  const frag = decodeFragment();
  if (frag) {
    const receipt = receiptFromFragment(frag);
    renderReceipt(receipt);
  }
});
