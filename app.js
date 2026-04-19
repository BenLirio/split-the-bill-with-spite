// Split the Bill With Spite — enter the actual receipt total + what everyone did;
// return a spite-adjusted itemized receipt. Per-person amounts SUM to the stated
// bill — spite just redistributes who pays more and who pays less.
//
// Design (post-reshape):
//   - AI-first diner identification. The user writes one free-form paragraph
//     or messy voice dictation; the LLM decides who the diners are, what they
//     did, picks a verdict archetype per person, and writes the line-item
//     quip. No client-side name regex. No verdict keyword table on the hot
//     path (it still exists as a last-ditch fallback if the LLM call fails).
//   - No person cap. The app accepts any number of diners from 2 up — the
//     pettiness scales with whatever the model finds in the text.
//   - Deterministic core money math. Once we have the list of
//     {name, behavior, verdict} records, we compute weights + cents in JS so
//     totals always sum exactly to the stated bill.
//   - TOTAL-PRESERVING: per-person amounts always sum to the stated bill.
//     Spite multipliers bias a weighted split — they don't tack on surplus.
//   - Final state is encoded into location.hash so a shared link re-renders
//     the same receipt without any LLM call or recompute.
//   - Receipt photo intake uses the vision proxy's FAST tier (gemini-2.5-flash)
//     — pulling a grand total off a receipt doesn't need the pro model, and
//     speed matters more than edge-case accuracy at the intake step.
//   - After a successful scan the photo button collapses to a compact
//     confirmation chip — no lingering "snap a photo" affordance once the
//     total is already filled in.

const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
const SPEECH_ENDPOINT = 'https://hwfpnikys5.execute-api.us-east-1.amazonaws.com/speech';
const VISION_ENDPOINT = 'https://sm3y7y9t2a.execute-api.us-east-1.amazonaws.com/vision';
const SLUG = 'split-the-bill-with-spite';

// No upper cap — we'll accept however many diners the LLM can pull out of
// the log. A floor of 2 keeps the math meaningful (one person splitting with
// themselves is not a bill).
const MIN_PEOPLE = 2;
// Soft guard — if somehow the LLM (or fallback) returns more than this many,
// we truncate. Big enough that no real dinner hits it; small enough to keep
// the receipt readable and the fragment URL short.
const HARD_MAX_PEOPLE = 40;

// Upper-bound recording length so the audio blob never nears the 5MB/60s proxy cap.
const MAX_RECORDING_MS = 45000;

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

// ---------- verdict catalog (fallback only) ----------
//
// Used only when the LLM call fails AND the local extractor has pulled out
// diners by crude heuristic. Each entry is an archetype label + a spite
// multiplier range in [min, max] relative to their fair share. Positive
// values skew them toward paying MORE; negative toward paying less. Kept
// small — no tag-matching on the hot path anymore.

const FALLBACK_VERDICTS = [
  { name: 'The Lobster Heiress',         mult: [0.25, 0.55] },
  { name: 'The Unpaid Narrator',         mult: [0.20, 0.50] },
  { name: 'The Crypto Homily Giver',     mult: [0.15, 0.30] },
  { name: 'The Side-Eye Ascetic',        mult: [-0.20, -0.05] },
  { name: 'The Sommelier Volunteer',     mult: [0.20, 0.45] },
  { name: 'The Appetizer Opportunist',   mult: [0.05, 0.15] },
  { name: 'The Split Evangelist',        mult: [-0.05, 0.10] },
  { name: 'The Reservation Dictator',    mult: [0.05, 0.15] },
  { name: 'The Group-Chat Monarch',      mult: [0.10, 0.25] },
  { name: 'The Tip Optimizer',           mult: [0.10, 0.25] },
  { name: 'The Low-Key Defendant',       mult: [0.00, 0.10] },
  { name: 'The Ambient Enabler',         mult: [0.00, 0.12] },
  { name: 'The Procedural Bystander',    mult: [-0.05, 0.05] },
  { name: 'The Deeply Innocent Suspect', mult: [-0.08, 0.03] },
  { name: 'The Unindicted Co-Diner',     mult: [0.00, 0.08] },
];

function fallbackVerdictForSeed(seed) {
  return FALLBACK_VERDICTS[seed % FALLBACK_VERDICTS.length];
}

// Given a verdict *name* picked by the LLM, infer a spite-multiplier range.
// If the name doesn't match any known archetype (the LLM is free to invent
// new ones), we classify it by sentiment heuristics so the math still works.
function multForVerdictName(name) {
  const known = FALLBACK_VERDICTS.find(v => v.name.toLowerCase() === String(name || '').toLowerCase());
  if (known) return known.mult;
  const lower = String(name || '').toLowerCase();
  // Positive / innocent-sounding invented verdicts pay slightly less.
  if (/innocent|ascetic|abstainer|saint|water|quiet|frugal/.test(lower)) return [-0.15, 0.00];
  // Clearly guilty-sounding invented verdicts pay more.
  if (/heiress|glutton|sommelier|lobster|crypto|monarch|dictator|chaos|defendant|freeloader|tyrant|narrator|volunteer|evangelist|opportunist/.test(lower)) return [0.15, 0.40];
  // Default: slight positive bias.
  return [0.00, 0.15];
}

// ---------- LOCAL FALLBACK parsing (used only if the LLM extract fails) ----------
//
// Crude name-first extractor: splits on sentence boundaries, keeps entries
// where the first token is capitalized. Not as smart as the old parser on
// purpose — the LLM is the happy path.

function fallbackParse(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const segments = text.split(/(?:\r?\n|(?<=[.!?])\s+)/).map(s => s.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const seg of segments) {
    const first = seg.split(/\s+/)[0] || '';
    const clean = first.replace(/[^A-Za-z'\-]/g, '');
    if (!clean) continue;
    if (clean[0] !== clean[0].toUpperCase()) continue;
    if (!/[a-z]/.test(clean.slice(1))) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const behavior = seg.slice(first.length).replace(/^[\s\-\u2013\u2014:,.]+/, '').trim() || '(no notes)';
    out.push({ name: clean, behavior });
  }
  return out;
}

// ---------- LLM: extract diners + verdicts + line-items in one call ----------
//
// One call. Receives the stated bill + the free-form log. Returns an ordered
// list of diners with a verdict and line-item for each. Client then does the
// cents-accurate money allocation so totals sum to the bill exactly.

function buildExtractMessages(bill, rawLog) {
  const system =
    `You are a petty, deadpan forensic accountant reading a messy log of what happened at a shared meal. You MUST:\n\n` +
    `1. Identify every distinct diner named in the log. If a person is mentioned but was not actually eating (e.g. "our server", "the host", "the ex she texted"), exclude them. Include anyone who contributed to the bill even if the narrator was mean about them. There is NO upper limit on diners — list everyone.\n` +
    `2. Paraphrase tightly what each diner did in one short clause (≤ 100 chars), keeping the specific damning detail (lobster, crypto speech, forgot wallet, only water, etc.). Quote the user's own wording when it's already good.\n` +
    `3. Assign each diner a "verdict" archetype — a Title-Cased noun phrase that functions as a label on the receipt. Prefer these canonical verdicts when they fit: "The Lobster Heiress", "The Unpaid Narrator", "The Crypto Homily Giver", "The Side-Eye Ascetic", "The Sommelier Volunteer", "The Appetizer Opportunist", "The Split Evangelist", "The Reservation Dictator", "The Group-Chat Monarch", "The Tip Optimizer", "The Low-Key Defendant", "The Ambient Enabler", "The Procedural Bystander", "The Deeply Innocent Suspect", "The Unindicted Co-Diner". You may invent new ones in the same style when nothing canonical fits — always start with "The " and stay under 34 chars. Do NOT reuse a verdict across diners in the same bill.\n` +
    `4. Give each diner a "spite_score" from -1.0 to +1.0. Positive = they ran up the damages or behaved badly and should pay more. Negative = they barely ate / were dragged along and should pay less. 0 = neutral. Be opinionated. A lobster orderer is +0.7. Someone who only had water is -0.6. Forgot their wallet is +0.5. Birthday person is ~0.\n` +
    `5. Write a one-line "item" per diner for the itemized receipt. Rules:\n` +
    `   - Quote the diner's own behavior verbatim in double-quotes somewhere in the line (copy their words; do not paraphrase inside the quotes).\n` +
    `   - ≤ 14 words total.\n` +
    `   - End with an em-dash followed by a charge-name (examples: "— lobster tax", "— narrator fee", "— crypto homily surcharge", "— wallet amnesia penalty"). Invent a specific charge-name for each person. Do NOT reuse the same charge-name twice.\n` +
    `   - No dollar amounts. No numbers. The app computes amounts.\n` +
    `   - Do not address the diner in second person.\n\n` +
    `HARD OUTPUT RULES:\n` +
    `- Respond with ONLY a single JSON object matching the schema. No markdown, no code fences, no commentary, no "here is your receipt", no trailing questions. Do not offer to refine.\n\n` +
    `SCHEMA:\n` +
    `{\n` +
    `  "diners": [\n` +
    `    { "name": string, "behavior": string, "verdict": string, "spite_score": number, "item": string }\n` +
    `  ]\n` +
    `}\n\n` +
    `Examples of the required item style (do not copy verbatim):\n` +
    `- "filed \\"ordered the lobster and then a second lobster\\" — double-entree tariff"\n` +
    `- "logged \\"forgot her wallet. again.\\" — repeat-offender narrator fee"\n` +
    `- "\\"talked about crypto for 40 minutes\\" — airtime tax"\n`;

  const user =
    `Stated bill: $${bill.toFixed(2)}\n\n` +
    `Log of what happened:\n${rawLog.trim()}\n\n` +
    `Return the JSON object only.`;

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ];
}

function sanitizeExtract(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const arr = Array.isArray(parsed.diners) ? parsed.diners : null;
  if (!arr || !arr.length) return null;

  const diners = [];
  const seenNames = new Set();
  const seenVerdicts = new Set();

  for (const entry of arr) {
    if (!entry || typeof entry !== 'object') continue;
    let name = typeof entry.name === 'string' ? entry.name.trim() : '';
    let behavior = typeof entry.behavior === 'string' ? entry.behavior.trim() : '';
    let verdict = typeof entry.verdict === 'string' ? entry.verdict.trim() : '';
    const item = typeof entry.item === 'string' ? entry.item.trim() : '';
    const spite = Number(entry.spite_score);

    if (!name || name.length > 40) continue;
    if (!verdict || verdict.length > 40) verdict = 'The Low-Key Defendant';
    if (!behavior) behavior = '(no notes)';
    if (behavior.length > 200) behavior = behavior.slice(0, 199) + '\u2026';
    if (!item || item.length > 220) continue;
    if (!Number.isFinite(spite)) continue;

    // Dedupe by case-insensitive name (e.g. LLM double-counted the same
    // person mentioned twice in the log).
    const nk = name.toLowerCase();
    if (seenNames.has(nk)) continue;
    seenNames.add(nk);

    // Ensure unique verdicts per bill. If the LLM reused one, append an
    // ordinal suffix so the receipt still reads right.
    let vk = verdict;
    let n = 2;
    while (seenVerdicts.has(vk.toLowerCase())) {
      vk = verdict + ' (' + n + ')';
      n++;
    }
    seenVerdicts.add(vk.toLowerCase());

    diners.push({
      name,
      behavior,
      verdict: vk,
      spite_score: Math.max(-1, Math.min(1, spite)),
      item,
    });

    if (diners.length >= HARD_MAX_PEOPLE) break;
  }

  if (diners.length < MIN_PEOPLE) return null;
  return diners;
}

async function tryLLMExtract(bill, rawLog) {
  try {
    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: SLUG,
        messages: buildExtractMessages(bill, rawLog),
        model: 'gpt-5.4-mini',
        max_tokens: 1400,
        temperature: 0,
        response_format: 'json_object',
      }),
    });
    if (!res.ok) throw new Error('http_' + res.status);
    const data = await res.json();
    const raw = (data && data.content) || '';
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
    return sanitizeExtract(parsed);
  } catch (_) {
    return null;
  }
}

// ---------- core computation (deterministic, total-preserving) ----------
//
// Strategy: each diner has a spite_score in [-1, 1]. Convert to a weight
// biased by (1 + score * k). Normalize weights to sum to 1, then multiply
// by the stated bill. This guarantees sum(amounts) === bill exactly (to
// cents, after a final rounding pass that reconciles any half-cent drift
// into the last person). Per-person spite delta = amount_owed − fair_share.

const SPITE_SCALE = 0.5; // maps [-1, 1] → weight multiplier of [-0.5, +0.5]

function buildReceiptFromDiners(bill, diners, { source }) {
  const fullInput = JSON.stringify({ b: bill.toFixed(2), d: diners });
  const seed = hash(fullInput);
  const fairShare = bill / diners.length;

  const draft = diners.map((d, i) => {
    const localSeed = hash(d.name + '|' + d.behavior + '|' + i);

    // Prefer an explicit spite_score from the LLM; otherwise derive a
    // deterministic multiplier from the verdict name's known range.
    let mult;
    if (Number.isFinite(d.spite_score)) {
      mult = Math.max(-1, Math.min(1, d.spite_score)) * SPITE_SCALE;
    } else {
      const range = multForVerdictName(d.verdict);
      const r = mulberry32(localSeed)();
      mult = range[0] + (range[1] - range[0]) * r;
    }

    const weight = Math.max(0.2, 1 + mult);
    return { ...d, localSeed, mult, weight };
  });

  const weightSum = draft.reduce((s, d) => s + d.weight, 0);
  const billCents = Math.round(bill * 100);
  let allocated = 0;
  const amountsCents = draft.map((d, i) => {
    if (i === draft.length - 1) return billCents - allocated;
    const share = (d.weight / weightSum) * billCents;
    const c = Math.round(share);
    allocated += c;
    return c;
  });

  const people = draft.map((d, i) => {
    const amount_owed = amountsCents[i] / 100;
    const spite_delta = amount_owed - fairShare;
    const item_text = d.item || buildLocalItem(d, spite_delta, d.localSeed);
    return {
      name: d.name,
      behavior: d.behavior,
      fair_share: fairShare,
      spite_delta,
      verdict: d.verdict,
      is_spicy: Math.abs(d.mult) >= 0.15,
      amount_owed,
      line_items: [
        { desc: 'share of dinner', amount: fairShare,  cls: '' },
        { desc: item_text,         amount: spite_delta, cls: spite_delta >= 0 ? 'pos' : 'neg' },
      ],
    };
  });

  const spiteRedistribution = people.reduce(
    (s, p) => s + Math.max(0, p.spite_delta),
    0
  );

  return {
    bill,
    fair_share: fairShare,
    spite_redistribution: spiteRedistribution,
    new_total: bill,
    people,
    seed,
    receipt_id: receiptIdFromSeed(seed),
    date: todayStr(),
    _source: source,
  };
}

function buildLocalItem(person, spiteDelta, localSeed) {
  const quipBank = [
    (b) => `"${b}" — surcharge`,
    (b) => `"${b}" — filed as evidence`,
    (b) => `"${b}" — petty tax`,
    (b) => `"${b}" — assessed`,
    (b) => `"${b}" — noted for the record`,
    (b) => `"${b}" — line-itemed`,
    (b) => `"${b}" — billed`,
  ];
  return quipBank[localSeed % quipBank.length](truncate(person.behavior, 64));
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '\u2026';
}

// ---------- fragment state ----------
//
// Shape:
//   #r=<base64url of { b: billCents, d: [ { n, b, v, a, q, s } ] }>

function encodeReceiptToFragment(receipt) {
  const payload = {
    b: Math.round(receipt.bill * 100),
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
  if (!Array.isArray(obj.d) || obj.d.length < MIN_PEOPLE || obj.d.length > HARD_MAX_PEOPLE) return null;
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
  const spiteRedistribution = people.reduce(
    (s, p) => s + Math.max(0, p.spite_delta),
    0
  );
  const totalOwed = people.reduce((s, p) => s + p.amount_owed, 0);
  return {
    bill,
    fair_share: fairShare,
    spite_redistribution: spiteRedistribution,
    new_total: totalOwed,
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
  // Lightweight guess at diner count for the intake hint — just counts
  // non-empty lines / sentences that start with a capitalized token. The
  // real extraction happens on submit via the LLM.
  const el = $('log');
  const countEl = $('line-count');
  if (!el || !countEl) return;
  const guess = fallbackParse(el.value).length;
  if (guess === 0) {
    countEl.textContent = 'no diners yet';
  } else if (guess === 1) {
    countEl.textContent = '1 diner';
  } else {
    countEl.textContent = `${guess} diners`;
  }
  countEl.classList.toggle('ready', guess >= MIN_PEOPLE);
  countEl.classList.remove('over');
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
  $('spite-adj').textContent = '\u00B1' + fmtMoney(receipt.spite_redistribution);
  $('bill-total-out').textContent = fmtMoney(receipt.new_total);

  showScreen('result');
}

// ---------- flow ----------

function parseBill(raw) {
  const cleaned = String(raw || '').replace(/[^0-9.]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : NaN;
}

async function runSplit({ bill, rawLog }, { updateFragment = true } = {}) {
  showScreen('loading');

  // Happy path: the LLM extracts diners, verdicts, and item-lines all in
  // one call. Run a minimum loader time in parallel so the transition
  // doesn't feel glitchy on fast connections.
  const minDelay = new Promise(r => setTimeout(r, 900));
  let diners = null;
  try {
    const [ext] = await Promise.all([tryLLMExtract(bill, rawLog), minDelay]);
    diners = ext;
  } catch (_) { /* fall through */ }

  let receipt;
  if (diners && diners.length >= MIN_PEOPLE) {
    receipt = buildReceiptFromDiners(bill, diners, { source: 'ai' });
  } else {
    // Fallback: crude local extraction, then deterministic verdict assignment.
    const local = fallbackParse(rawLog).slice(0, HARD_MAX_PEOPLE).map((p, i) => {
      const seed = hash(p.name + '|' + p.behavior + '|' + i);
      const v = fallbackVerdictForSeed(seed);
      const r = mulberry32(seed)();
      const mult = v.mult[0] + (v.mult[1] - v.mult[0]) * r;
      // Convert our [-1, +1]-ish mult back into a spite_score for the builder.
      const spite_score = Math.max(-1, Math.min(1, mult / SPITE_SCALE));
      return {
        name: p.name,
        behavior: p.behavior,
        verdict: v.name,
        spite_score,
        item: null, // buildReceiptFromDiners will synth a local quip
      };
    });
    if (local.length < MIN_PEOPLE) {
      // Couldn't even find 2 names locally — bail back to intake with copy.
      showScreen('intake');
      const errEl = $('intake-error');
      if (errEl) {
        errEl.textContent = 'couldn\u2019t pull names out of that. name at least two diners and what they did.';
        errEl.classList.remove('hidden');
      }
      return;
    }
    receipt = buildReceiptFromDiners(bill, local, { source: 'local' });
  }

  if (updateFragment) {
    history.replaceState(null, '', encodeReceiptToFragment(receipt));
  }
  renderReceipt(receipt);
}

function onSubmit(e) {
  e.preventDefault();
  const bill = parseBill($('bill-total').value);
  const rawLog = String($('log').value || '').trim();
  const errEl = $('intake-error');

  if (!(bill >= 1 && bill <= 99999)) {
    errEl.textContent = 'bill total needs to be a number between $1 and $99,999.';
    errEl.classList.remove('hidden');
    return;
  }
  // We only guard against an empty log on the client. The real diner-count
  // floor is enforced after the LLM extract in runSplit — this lets the
  // model handle messy inputs where a cheap regex couldn't find names.
  if (!rawLog) {
    errEl.textContent = `tell us who was there and what they did. at least ${MIN_PEOPLE} people.`;
    errEl.classList.remove('hidden');
    return;
  }
  errEl.classList.add('hidden');
  runSplit({ bill, rawLog });
}

function onReset() {
  history.replaceState(null, '', location.pathname + location.search);
  $('log').value = '';
  $('bill-total').value = '184.00';
  stopVoice();
  updateLineCount();
  resetScanUI();
  $('intake-error').classList.add('hidden');
  showScreen('intake');
  const logEl = $('log');
  if (logEl) logEl.focus();
}

const SAMPLE = [
  'Ben ordered the lobster and a second lobster.',
  'Sarah forgot her wallet. again.',
  'Kai talked about crypto for 40 minutes.',
  'Priya ordered water and judged everyone.',
  'Marcus split an appetizer and called it dinner.',
].join('\n');

function onSample() {
  $('log').value = SAMPLE;
  $('bill-total').value = '184.00';
  updateLineCount();
  $('intake-error').classList.add('hidden');
}

// ---------- voice intake (MediaRecorder → Whisper proxy) ----------

const hasMediaRecorder =
  typeof window !== 'undefined' &&
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
  typeof window.MediaRecorder !== 'undefined';

let mediaStream = null;
let mediaRecorder = null;
let voiceChunks = [];
let voiceState = 'idle';      // 'idle' | 'starting' | 'listening' | 'transcribing'
let voiceStopTimer = null;
let voiceBaseText = '';

function setMicStatus(text, cls) {
  const el = $('mic-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('active', 'error');
  if (cls) el.classList.add(cls);
}

function setMicButtonState(state) {
  voiceState = state;
  const btn = $('mic-btn');
  if (!btn) return;
  const lbl = btn.querySelector('.mic-label');
  btn.classList.remove('starting', 'listening', 'transcribing');
  if (state === 'starting') {
    btn.classList.add('starting');
    btn.setAttribute('aria-pressed', 'true');
    if (lbl) lbl.textContent = 'opening mic\u2026';
  } else if (state === 'listening') {
    btn.classList.add('listening');
    btn.setAttribute('aria-pressed', 'true');
    if (lbl) lbl.textContent = 'listening\u2026 tap to stop';
  } else if (state === 'transcribing') {
    btn.classList.add('transcribing');
    btn.setAttribute('aria-pressed', 'true');
    btn.disabled = true;
    if (lbl) lbl.textContent = 'transcribing\u2026';
  } else {
    btn.setAttribute('aria-pressed', 'false');
    btn.disabled = false;
    if (lbl) lbl.textContent = 'tap to testify';
  }
}

function pickAudioMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];
  if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
    for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

async function startVoice() {
  if (voiceState !== 'idle') return;
  if (!hasMediaRecorder) {
    setMicStatus('this browser can\u2019t record \u2014 type it instead', 'error');
    return;
  }
  setMicButtonState('starting');
  setMicStatus('opening mic\u2026', 'active');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setMicButtonState('idle');
    const msg = (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError'))
      ? 'mic blocked by the browser \u2014 allow it or type'
      : 'no mic detected \u2014 type it instead';
    setMicStatus(msg, 'error');
    return;
  }

  const mimeType = pickAudioMime();
  try {
    mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
  } catch (_) {
    cleanupStream();
    setMicButtonState('idle');
    setMicStatus('mic unavailable \u2014 type it instead', 'error');
    return;
  }

  voiceChunks = [];
  const ta = $('log');
  voiceBaseText = ta ? ta.value : '';

  mediaRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) voiceChunks.push(ev.data);
  };
  mediaRecorder.onstart = () => {
    setMicButtonState('listening');
    setMicStatus('listening\u2026 say everyone\u2019s names and what they did', 'active');
    voiceStopTimer = setTimeout(() => {
      try { if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch (_) {}
    }, MAX_RECORDING_MS);
  };
  mediaRecorder.onerror = () => {
    cleanupStream();
    setMicButtonState('idle');
    setMicStatus('mic error \u2014 type it instead', 'error');
  };
  mediaRecorder.onstop = async () => {
    if (voiceStopTimer) { clearTimeout(voiceStopTimer); voiceStopTimer = null; }
    const rawType = (mediaRecorder && mediaRecorder.mimeType) || mimeType || 'audio/webm';
    const blobType = rawType.split(';')[0].trim() || 'audio/webm';
    const blob = new Blob(voiceChunks, { type: blobType });
    voiceChunks = [];
    cleanupStream();

    if (blob.size < 500) {
      setMicButtonState('idle');
      setMicStatus('didn\u2019t catch that \u2014 try again', 'error');
      return;
    }

    setMicButtonState('transcribing');
    setMicStatus('transcribing\u2026', 'active');

    try {
      const dataUrl = await blobToDataURL(blob);
      const res = await fetch(SPEECH_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: SLUG, audio: dataUrl, language: 'en' })
      });
      if (!res.ok) {
        let errBody = null;
        try { errBody = await res.json(); } catch (_) {}
        setMicButtonState('idle');
        setMicStatus(speechErrorCopy(res.status, errBody && errBody.error), 'error');
        return;
      }
      const { text } = await res.json();
      const out = (text || '').trim();
      if (!out) {
        setMicButtonState('idle');
        setMicStatus('didn\u2019t catch that \u2014 try again', 'error');
        return;
      }
      appendVoiceText(out);
      setMicButtonState('idle');
      const parsedCount = fallbackParse(($('log') || {}).value || '').length;
      setMicStatus('filed ' + parsedCount + ' diner' + (parsedCount === 1 ? '' : 's') + ' into the record', '');
    } catch (_) {
      setMicButtonState('idle');
      setMicStatus('transcription failed \u2014 try again or type', 'error');
    }
  };

  try { mediaRecorder.start(); }
  catch (_) {
    cleanupStream();
    setMicButtonState('idle');
    setMicStatus('mic unavailable \u2014 type it instead', 'error');
  }
}

function stopVoice() {
  if (voiceState === 'listening' && mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch (_) {}
    return;
  }
  if (voiceState === 'starting') {
    cleanupStream();
    setMicButtonState('idle');
    setMicStatus('');
  }
}

function toggleVoice() {
  if (voiceState === 'idle') startVoice();
  else if (voiceState === 'listening' || voiceState === 'starting') stopVoice();
}

function cleanupStream() {
  if (voiceStopTimer) { clearTimeout(voiceStopTimer); voiceStopTimer = null; }
  if (mediaStream) {
    try { mediaStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    mediaStream = null;
  }
  mediaRecorder = null;
}

function appendVoiceText(text) {
  const ta = $('log');
  if (!ta) return;
  const base = (voiceBaseText || '').replace(/\s+$/, '');
  const sep = base ? '\n' : '';
  ta.value = base + sep + text;
  updateLineCount();
}

function speechErrorCopy(status, code) {
  if (status === 429 && code === 'daily_cap_reached') return 'voice maxed out for today \u2014 type it instead';
  if (status === 429) return 'too many requests \u2014 wait a minute, then try again';
  if (code === 'audio_too_large') return 'that ran long \u2014 keep it under 45 seconds';
  if (code === 'audio_too_small') return 'didn\u2019t catch that \u2014 try again';
  if (code === 'bad_audio' || code === 'bad_audio_type') return 'couldn\u2019t read that recording \u2014 try again or type';
  return 'transcription failed \u2014 try again or type';
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function wireMic() {
  const btn = $('mic-btn');
  if (!btn) return;
  if (!hasMediaRecorder) {
    btn.disabled = true;
    const lbl = btn.querySelector('.mic-label');
    if (lbl) lbl.textContent = 'voice unavailable';
    setMicStatus('voice input needs a modern browser with mic access', '');
    return;
  }

  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.classList.add('tapping');
  });
  const clearTap = () => btn.classList.remove('tapping');
  btn.addEventListener('pointerup', clearTap);
  btn.addEventListener('pointerleave', clearTap);
  btn.addEventListener('pointercancel', clearTap);

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    clearTap();
    toggleVoice();
  });

  btn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggleVoice();
    }
  });
}

// ---------- receipt photo intake (vision proxy — fast tier) ----------

const RECEIPT_MAX_EDGE = 1280;
const RECEIPT_JPEG_QUALITY = 0.82;

async function fileToScaledJpegDataURL(file) {
  let bitmap = null;
  try {
    if (typeof createImageBitmap === 'function') {
      bitmap = await createImageBitmap(file);
    }
  } catch (_) {}
  let srcW, srcH, drawable;
  if (bitmap) {
    srcW = bitmap.width; srcH = bitmap.height; drawable = bitmap;
  } else {
    const url = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    srcW = img.naturalWidth; srcH = img.naturalHeight; drawable = img;
  }
  const scale = Math.min(1, RECEIPT_MAX_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(drawable, 0, 0, w, h);
  return c.toDataURL('image/jpeg', RECEIPT_JPEG_QUALITY);
}

function setScanStatus(text, cls) {
  const el = $('scan-status');
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('active', 'error');
  if (cls) el.classList.add(cls);
}

function setScanButtonState(state) {
  const btn = $('scan-btn');
  if (!btn) return;
  const row = btn.parentElement;
  const lbl = btn.querySelector('.scan-label');
  const input = $('scan-input');
  btn.classList.remove('loading');
  if (row) row.classList.remove('loading');
  if (state === 'loading') {
    btn.classList.add('loading');
    if (row) row.classList.add('loading');
    if (input) input.disabled = true;
    if (lbl) lbl.textContent = 'reading\u2026';
  } else {
    if (input) input.disabled = false;
    if (lbl) lbl.textContent = 'Snap a photo of the receipt';
  }
}

// After a successful scan, collapse the scan row into a compact "filed"
// chip so the button no longer dominates the form. User can tap the chip
// to re-open the picker (clears the state first).
function collapseScanRow(total) {
  const row = $('scan-row');
  if (!row) return;
  row.classList.add('filed');
  const lbl = $('scan-btn') && $('scan-btn').querySelector('.scan-label');
  if (lbl) lbl.textContent = 'total filed: $' + total.toFixed(2) + ' \u2014 tap to redo';
  // Hide the dashed-border look; the .filed class in CSS replaces it with a
  // compact confirmation pill.
}

function resetScanUI() {
  const row = $('scan-row');
  if (!row) return;
  row.classList.remove('filed');
  setScanButtonState('idle');
  setScanStatus('');
}

async function onReceiptFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    setScanStatus('that\u2019s not an image \u2014 try a photo', 'error');
    return;
  }
  // If the user is re-scanning, un-collapse first so the "reading..." copy
  // is visible on the full-size button.
  const row = $('scan-row');
  if (row) row.classList.remove('filed');

  setScanButtonState('loading');
  setScanStatus('reading the receipt\u2026', 'active');

  let image;
  try {
    image = await fileToScaledJpegDataURL(file);
  } catch (_) {
    setScanButtonState('idle');
    setScanStatus('couldn\u2019t read that image \u2014 try another', 'error');
    return;
  }

  const prompt =
    'You are looking at a photo. If it is a restaurant / cafe / bar receipt, find the FINAL TOTAL — the grand total the customer owed, after tax and tip if they are printed. If tip is not printed, use the total before tip. Return strict JSON only: ' +
    '{"total": <number, decimal dollars, e.g. 45.23>, "found": <true|false>, "reason": <short string>}. ' +
    'Set "found": false (and total: 0) if it is not a receipt, or if the total cannot be read with confidence. No prose outside the JSON.';

  try {
    const res = await fetch(VISION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: SLUG,
        image,
        prompt,
        // Fast tier — pulling a grand total off a receipt doesn't need the
        // pro model, and the latency win matters at intake.
        quality: 'fast',
        response_format: 'json_object'
      })
    });
    if (!res.ok) {
      let errBody = null;
      try { errBody = await res.json(); } catch (_) {}
      setScanButtonState('idle');
      setScanStatus(visionErrorCopy(res.status, errBody && errBody.error), 'error');
      return;
    }
    const body = await res.json();
    let parsed = null;
    try { parsed = JSON.parse(body.text); } catch (_) {}
    if (!parsed || parsed.found !== true || typeof parsed.total !== 'number' || !(parsed.total > 0)) {
      setScanButtonState('idle');
      setScanStatus('couldn\u2019t find a total on that \u2014 enter it manually', 'error');
      return;
    }
    const total = Math.round(parsed.total * 100) / 100;
    const input = $('bill-total');
    if (input) {
      input.value = total.toFixed(2);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setScanButtonState('idle');
    // Collapse the scan row into a small "filed" chip — the big button is
    // no longer needed once the total is in.
    collapseScanRow(total);
    setScanStatus('');
  } catch (_) {
    setScanButtonState('idle');
    setScanStatus('couldn\u2019t reach the scanner \u2014 enter it manually', 'error');
  }
}

function visionErrorCopy(status, code) {
  if (status === 429 && code === 'daily_cap_reached') return 'scanner maxed out for today \u2014 enter it manually';
  if (status === 429) return 'too many requests \u2014 wait a minute, then try again';
  if (code === 'image_too_large') return 'image too big \u2014 try a smaller photo';
  if (code === 'bad_image' || code === 'bad_image_type') return 'couldn\u2019t read that image \u2014 try another';
  return 'scanner glitched \u2014 enter it manually';
}

function wireReceiptScan() {
  const input = $('scan-input');
  if (!input) return;
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    onReceiptFile(file);
    try { input.value = ''; } catch (_) {}
  });
}

// Share: prefer navigator.share (URL contains fragment); fall back to clipboard.
function share() {
  const url = location.href;
  const total = ($('bill-total-out') && $('bill-total-out').textContent) || '';
  const text = total
    ? `spitesplit: total ${total}, spite-redistributed. see who got charged for what.`
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

  wireMic();
  wireReceiptScan();

  const frag = decodeFragment();
  if (frag) {
    const receipt = receiptFromFragment(frag);
    renderReceipt(receipt);
  }
});
