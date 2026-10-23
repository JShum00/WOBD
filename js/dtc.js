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
