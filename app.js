// Split the Bill With Spite — enter the actual receipt total + what each diner did;
// return a spite-adjusted itemized receipt. Per-person amounts SUM to the stated
// bill — spite just redistributes who pays more and who pays less.
//
// Design decisions (per KB + feedback triage):
//   - One textarea, but parsing is smart: accepts either (a) one person per line
//     OR (b) multiple people in one run-on paragraph. A name-detector splits
//     run-on text into per-person records.
//   - Deterministic core logic (verdict picks, spite weights, totals) — seeded
//     off a hash of the input so the same paste always yields the same receipt.
//   - TOTAL-PRESERVING: the per-person amounts always sum to the stated bill.
//     Spite multipliers bias a weighted split — they don't tack on a surplus.
//   - Optional LLM flourish per person (one snappy quoted line-item quip).
//     Temperature 0, response_format=json_object. Deterministic fallback if the
//     call fails, times out, or returns garbage.
//   - Final state is encoded into location.hash so a shared link re-renders the
//     exact same receipt without any LLM call or recompute.
//   - Mobile-first, modern Venmo/Splitwise aesthetic.

const AI_ENDPOINT = 'https://uy3l6suz07.execute-api.us-east-1.amazonaws.com/ai';
const SPEECH_ENDPOINT = 'https://hwfpnikys5.execute-api.us-east-1.amazonaws.com/speech';
const VISION_ENDPOINT = 'https://sm3y7y9t2a.execute-api.us-east-1.amazonaws.com/vision';
const SLUG = 'split-the-bill-with-spite';
const MIN_PEOPLE = 3;
const MAX_PEOPLE = 6;

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
// [min, max] relative to their fair share. Positive values skew them toward
// paying MORE of the bill; negative values toward paying less. Totals always
// sum to the stated bill — multipliers are applied to a weighted split, not
// added on top. Deterministic pick by keyword match against their description,
// then seeded fallback.

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
//
// Smart parsing: accepts either one-person-per-line OR a run-on paragraph with
// multiple people. We detect capitalized-name boundaries to re-segment a run-on
// block. Voice dictation often produces one long sentence — we refuse to make
// the user babysit "one line per person".

// Common filler words that happen to be capitalized at sentence starts; we do
// NOT want to treat these as a new diner.
const NAME_STOPWORDS = new Set([
  'then','and','but','also','while','meanwhile','okay','ok','so','then,','also,',
  'plus','next','after','before','then.','after.','later','finally','i',"i'll","i'd",'me','my',
  'we','they','he','she','it','the','a','an','this','that','these','those',
  'meanwhile,', 'meanwhile.', 'and,', 'but,', 'so,',
]);

function looksLikeName(token) {
  if (!token) return false;
  // Strip punctuation.
  const clean = token.replace(/[^A-Za-z'\-]/g, '');
  if (!clean) return false;
  if (clean.length < 2 || clean.length > 20) return false;
  // Must start with uppercase and have at least one more lowercase (rejects
  // "I", "OK", "NYC" etc.).
  if (clean[0] !== clean[0].toUpperCase()) return false;
  if (!/[a-z]/.test(clean.slice(1))) return false;
  if (NAME_STOPWORDS.has(clean.toLowerCase())) return false;
  return true;
}

// Given a single run-on line like "Ben ordered the lobster. Sarah forgot her
// wallet. Kai talked about crypto.", return an array of per-person strings.
// If we can't confidently split, return the whole line as one entry.
function splitRunOnLine(line) {
  if (!line) return [];
  // First try sentence-level splits (.?!).
  const sentenceParts = line
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map(s => s.trim())
    .filter(Boolean);

  // Start from sentences, then try to detect within-sentence name boundaries
  // for very long sentences that forgot their periods.
  const results = [];
  for (const seg of sentenceParts) {
    const split = splitBySecondaryNames(seg);
    if (split.length > 1) {
      for (const s of split) if (s.trim()) results.push(s.trim());
    } else {
      results.push(seg.trim());
    }
  }
  // Only accept the split if at least 2 candidate names emerged AND the first
  // token of each candidate looks like a name. Otherwise, fall back to the
  // whole line.
  const nameLike = results.filter(r => {
    const first = r.split(/\s+/)[0] || '';
    return looksLikeName(first);
  });
  if (nameLike.length >= 2) return results;
  // Otherwise the line is probably a single person; keep as-is.
  return [line.trim()];
}

// Within a single sentence, split at capitalized-name boundaries that are
// preceded by a conjunction/connector or a comma/"then". Conservative: only
// splits if the boundary candidate starts a new capitalized word that isn't
// a stopword.
function splitBySecondaryNames(sentence) {
  // Candidate boundaries: ", Name " or " then Name " or " and Name " or " meanwhile Name ".
  const boundaries = [];
  const re = /(?:,\s*|\s+(?:then|and|but|so|meanwhile|plus|also|next)\s+)([A-Z][a-z'\-]+)\b/g;
  let m;
  while ((m = re.exec(sentence)) !== null) {
    const nameIdx = m.index + m[0].indexOf(m[1]);
    // Skip if this "name" is actually a stopword.
    if (NAME_STOPWORDS.has(m[1].toLowerCase())) continue;
    boundaries.push(nameIdx);
  }
  if (!boundaries.length) return [sentence];
  const out = [];
  let prev = 0;
  for (const idx of boundaries) {
    out.push(sentence.slice(prev, idx));
    prev = idx;
  }
  out.push(sentence.slice(prev));
  return out;
}

function parseLog(raw) {
  // Returns list of { name, behavior }.
  // Accept both "one person per line" AND a single run-on paragraph with
  // multiple people. We split the raw text on newlines first, then apply
  // smart sentence-splitting to any line that contains multiple name-like
  // boundaries.
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  const expanded = [];
  for (const line of lines) {
    const parts = splitRunOnLine(line);
    for (const p of parts) if (p.trim()) expanded.push(p.trim());
  }

  const out = [];
  const seen = new Set();
  for (const rawEntry of expanded) {
    // Remove leading bullets/dashes.
    const cleaned = rawEntry.replace(/^[-*\u2022]\s*/, '').trim();
    if (!cleaned) continue;

    // Primary: explicit separator between name and behavior.
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
    // If the "name" looks like it isn't actually a name (lowercase word from a
    // mid-sentence fragment), skip the entry rather than emit a bogus diner.
    if (!looksLikeName(name)) continue;
    if (!behavior) behavior = '(no notes)';
    // Clean up stray leading connector words that survived the split (e.g.
    // "then Sarah forgot her wallet" → name=Sarah, behavior leftover "forgot...").
    behavior = behavior.replace(/^(then|and|but|so|meanwhile|plus|also|next)\s+/i, '');
    // Clean up trailing separators/conjunctions and punctuation.
    behavior = behavior
      .replace(/\s+/g, ' ')
      .replace(/[.,;]+$/, '')
      .replace(/\s+(then|and|but|so|meanwhile|plus|also|next)\s*$/i, '')
      .trim();

    // Dedupe by normalized name (voice dictation sometimes emits the same
    // sentence twice). Keep the first occurrence.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ name, behavior });
  }
  return out;
}

function validateInput(bill, people) {
  if (!(bill >= 1 && bill <= 99999)) {
    return 'bill total needs to be a number between $1 and $99,999.';
  }
  if (people.length < MIN_PEOPLE) {
    return `we need at least ${MIN_PEOPLE} diners. name a few more people and what they did.`;
  }
  if (people.length > MAX_PEOPLE) {
    return `max ${MAX_PEOPLE} people per receipt — the pettiness doesn't scale past six.`;
  }
  return null;
}

// ---------- core computation (deterministic, total-preserving) ----------
//
// Strategy: each person starts with weight 1. Apply their spite multiplier to
// get a biased weight (1 + mult). Normalize weights to sum to 1, then multiply
// by the stated bill. This guarantees sum(amounts) === bill exactly (to cents,
// after a final rounding pass that reconciles any half-cent drift into the
// last person). Per-person spite delta = amount_owed − fair_share.

function computeReceipt(bill, people) {
  const fullInput = JSON.stringify({ b: bill.toFixed(2), p: people });
  const seed = hash(fullInput);

  const fairShare = bill / people.length;

  // Per-person: pick verdict, compute weights deterministically.
  const draft = people.map((p, i) => {
    const localSeed = hash(p.name + '|' + p.behavior + '|' + i);
    const verdict = pickVerdict(p.name, p.behavior, localSeed);

    // Spite multiplier: interpolate deterministically between mult[0] and mult[1].
    const r = mulberry32(localSeed)();
    const mult = verdict.mult[0] + (verdict.mult[1] - verdict.mult[0]) * r;
    // Clamp to a sane weight range so no one gets a zero share.
    const weight = Math.max(0.2, 1 + mult);

    return {
      name: p.name,
      behavior: p.behavior,
      verdict: verdict.name,
      mult,
      weight,
      is_spicy: Math.abs(mult) >= 0.2,
      localSeed,
    };
  });

  // Normalize weights so their sum == bill.
  const weightSum = draft.reduce((s, d) => s + d.weight, 0);
  // Cents-accurate allocation: compute each cent amount, track rounding residue.
  const billCents = Math.round(bill * 100);
  let allocated = 0;
  const amountsCents = draft.map((d, i) => {
    if (i === draft.length - 1) {
      // Last person absorbs the rounding residue so the sum equals the bill exactly.
      return billCents - allocated;
    }
    const share = (d.weight / weightSum) * billCents;
    const c = Math.round(share);
    allocated += c;
    return c;
  });

  const results = draft.map((d, i) => {
    const amount_owed = amountsCents[i] / 100;
    const spite_delta = amount_owed - fairShare;
    return {
      name: d.name,
      behavior: d.behavior,
      fair_share: fairShare,
      spite_delta,
      verdict: d.verdict,
      is_spicy: d.is_spicy,
      amount_owed,
      line_items: buildLocalLineItems(
        { name: d.name, behavior: d.behavior },
        { name: d.verdict },
        spite_delta,
        fairShare,
        d.localSeed
      ),
    };
  });

  // Redistribution magnitude = sum of positive deltas (equals abs(sum of negatives)).
  const spiteRedistribution = results.reduce(
    (s, p) => s + Math.max(0, p.spite_delta),
    0
  );

  return {
    bill,
    fair_share: fairShare,
    spite_redistribution: spiteRedistribution,
    new_total: bill,  // total-preserving: always equals stated bill
    people: results,
    seed,
    receipt_id: receiptIdFromSeed(seed),
    date: todayStr(),
    _source: 'local',
  };
}

// Locally-composed line-items: one "share of dinner" at fair-share, one spite
// adjustment (the delta from fair-share). These sum to amount_owed, and across
// all diners sum to the stated bill.
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

// Apply the LLM quip into the "quote" line-item for each person, keeping the
// spite-delta dollar amount intact.
function applyFlourish(receipt, map) {
  if (!map) return receipt;
  const out = { ...receipt, _source: 'ai', people: receipt.people.map((p, i) => {
    const quip = map[i];
    if (!quip) return p;
    const items = p.line_items.slice();
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
// Re-hydration reconstructs fair_share and spite_delta from amount+bill/count.

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
  const spiteRedistribution = people.reduce(
    (s, p) => s + Math.max(0, p.spite_delta),
    0
  );
  // Use the sum of encoded amounts as the authoritative total so that old
  // additive-model share links still render a coherent receipt (total matches
  // per-person sum). New links sum to the stated bill by construction.
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
  // Redistribution magnitude, shown as ±$X — spite moves X dollars from the
  // innocents to the guilty, but total paid stays equal to the stated bill.
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
  stopVoice();
  updateLineCount();
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
//
// Tap the mic to start, tap again to stop. When stopped, the recording is
// POSTed to the factory's speech proxy (OpenAI Whisper) and the transcript
// is appended to the textarea. Whisper is materially more accurate than the
// browser's Web Speech API and works uniformly on Firefox/Safari/iOS/Android.
// Text path always works as a fallback. Audio is sent to OpenAI for transcription.

const hasMediaRecorder =
  typeof window !== 'undefined' &&
  !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
  typeof window.MediaRecorder !== 'undefined';

let mediaStream = null;
let mediaRecorder = null;
let voiceChunks = [];
let voiceState = 'idle';      // 'idle' | 'starting' | 'listening' | 'transcribing'
let voiceStopTimer = null;
let voiceBaseText = '';       // textarea value at the start of the current session

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
    'audio/mp4',           // Safari
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
    // Safety cap — don't let a forgotten-on mic blow through the 5MB proxy limit.
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
    const blobType = (mediaRecorder && mediaRecorder.mimeType) || mimeType || 'audio/webm';
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
      const parsedCount = parseLog(($('log') || {}).value || '').length;
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
    // Bail out before the recorder started capturing.
    cleanupStream();
    setMicButtonState('idle');
    setMicStatus('');
  }
}

function toggleVoice() {
  if (voiceState === 'idle') startVoice();
  else if (voiceState === 'listening' || voiceState === 'starting') stopVoice();
  // 'transcribing' is a no-op — button is disabled during the POST.
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

// ---------- receipt photo intake (vision proxy) ----------
//
// User snaps / uploads a photo of the physical receipt; we downscale client-side,
// POST to the vision proxy, and fill the bill-total input with the extracted total.

const RECEIPT_MAX_EDGE = 1280;
const RECEIPT_JPEG_QUALITY = 0.82;

async function fileToScaledJpegDataURL(file) {
  // Decode with createImageBitmap when available (handles HEIC on iOS, faster).
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
  const lbl = btn.querySelector('.scan-label');
  btn.classList.remove('loading');
  if (state === 'loading') {
    btn.classList.add('loading');
    btn.disabled = true;
    if (lbl) lbl.textContent = 'reading\u2026';
  } else {
    btn.disabled = false;
    if (lbl) lbl.textContent = 'snap receipt';
  }
}

async function onReceiptFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    setScanStatus('that\u2019s not an image \u2014 try a photo', 'error');
    return;
  }
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
        quality: 'pro',
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
      // Let any input listeners (line count, validation) react.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    setScanButtonState('idle');
    setScanStatus('total read: $' + total.toFixed(2), '');
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
  const btn = $('scan-btn');
  const input = $('scan-input');
  if (!btn || !input) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    input.value = '';
    input.click();
  });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    onReceiptFile(file);
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

  // Voice testimony — MediaRecorder → Whisper proxy.
  wireMic();
  // Receipt photo intake — file picker → vision proxy.
  wireReceiptScan();

  // Deep-link replay: render from fragment without any re-compute / LLM call.
  const frag = decodeFragment();
  if (frag) {
    const receipt = receiptFromFragment(frag);
    renderReceipt(receipt);
  }
});
