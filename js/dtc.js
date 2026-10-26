export function isDtcCode(code) {
  return /^[PCBU][0-3][0-9A-F]{3}$/.test(code);
}

export function isManufacturerCode(code) {
  if (!isDtcCode(code)) return false;
  const [letter, d1, d2] = code;
  if (letter === 'P') return d1 === '1' || (d1 === '3' && '0123'.includes(d2));
  return d1 === '1' || d1 === '2';
}

export function manufacturerMakeKey(make) {
  return String(make ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Ford descriptions arrive as "87: Display: Missing Message O: THE DISPLAY... (System)". The leading
// fault-type byte and the lone letter before the symptom are source bookkeeping, and some symptoms
// only repeat the code (for example "B10D9:87").
export function cleanManufacturerDescription(text) {
  const clean = String(text).replace(/\u00a0/g, ' ').trim();
  const structured = /^[0-9A-F]{2}: (.+)$/.exec(clean);
  if (!structured) return clean;
  const split = /^(.*?) [A-Z]{1,2}: (.*)$/.exec(structured[1]);
  if (!split) return structured[1].trim();
  const title = split[1].trim();
  const rest = split[2];
  const system = /\(.*\)\s*$/.exec(rest)?.[0] ?? '';
  const symptom = (system ? rest.slice(0, rest.length - system.length) : rest).trim();
  const echoesCode = /^(DTC )?[A-Z0-9]{5}(:[0-9A-F]{2})?( AND [A-Z0-9]{5}(:[0-9A-F]{2})?)?$/.test(symptom);
  return [echoesCode || !symptom ? title : `${title} — ${symptom}`, system.trim()].filter(Boolean).join(' ');
}
