// Explains where a connection failed. Pure functions: app.js shows the result.
// Failures are told apart by where the conversation stopped, since "the adapter
// is silent", "the car is silent", and "the bus is unhappy" need different fixes.
import { PROTOCOLS } from './obd.js';
import { t } from './i18n.js';

export const CATEGORIES = ['adapter', 'adapter-timeout', 'car-silent', 'no-data', 'bus-error', 'unreadable', 'adapter-command', 'unknown'];

export function categorize(err) {
  switch (err?.code) {
    case 'NOT_ELM': return 'adapter';
    case 'TIMEOUT': return 'adapter-timeout';
    case 'UNABLE_TO_CONNECT': return 'car-silent';
    case 'NO_DATA': return 'no-data';
    case 'BUS_ERROR': return 'bus-error';
    case 'MALFORMED_RESPONSE': return 'unreadable';
    case 'COMMAND_ERROR': return 'adapter-command';
    default: break;
  }
  if (['NetworkError', 'InvalidStateError', 'SecurityError'].includes(err?.name)) return 'adapter';
  return 'unknown';
}

const MESSAGE_KEYS = {
  adapter: 'app.trouble.adapter',
  'adapter-timeout': 'app.trouble.adapterTimeout',
  'car-silent': 'app.trouble.carSilent',
  'no-data': 'app.trouble.noData',
  'bus-error': 'app.trouble.busError',
  unreadable: 'app.trouble.unreadable',
  'adapter-command': 'app.trouble.adapterCommand',
  unknown: 'app.trouble.unknown',
};

const CAR_CATEGORIES = new Set(['car-silent', 'no-data', 'bus-error']);

// What the search link looks for: the car, the topic, and the kind of failure.
export function protocolSearchUrl(car = {}, category = null) {
  const failure = { 'car-silent': 'unable to connect', 'bus-error': 'communication error' }[category];
  const query = [car.year, car.make, car.model, 'OBD-II diagnostic protocol', failure].filter(Boolean).join(' ');
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// protocol: the number the user forced ('6'), or null/undefined for automatic.
// Returns { category, text, adapterReply, suggestAutomatic, searchUrl }.
export function diagnoseConnection(err, { protocol = null, car = {} } = {}) {
  const category = categorize(err);
  const forced = protocol != null && protocol !== '' && protocol !== '0';
  const carFailed = CAR_CATEGORIES.has(category) || category === 'unreadable';
  const parts = [t(MESSAGE_KEYS[category])];

  if (forced && carFailed) {
    const name = PROTOCOLS[String(protocol).toUpperCase()] ?? `protocol ${protocol}`;
    parts.push(t('app.trouble.forcedProtocol', { name }));
  }

  const hasCar = Boolean(car.year || car.make || car.model);
  const canSearch = hasCar && carFailed;
  if (canSearch) {
    parts.push(t('app.trouble.searchHint'));
  }

  return {
    category,
    text: parts.join(' '),
    adapterReply: err?.reply ?? null,
    suggestAutomatic: forced && carFailed,
    searchUrl: canSearch ? protocolSearchUrl(car, category) : null,
  };
}
