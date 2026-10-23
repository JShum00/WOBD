// Explains where a connection failed. Pure functions: app.js shows the result.
// Failures are told apart by where the conversation stopped, since "the adapter
// is silent", "the car is silent", and "the bus is unhappy" need different fixes.
import { PROTOCOLS } from './obd.js';

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

const MESSAGES = {
  adapter: "I can't find your adapter. Make sure it's plugged in all the way, then try again.",
  'adapter-timeout': "Your adapter stopped answering partway through. Unplug it, plug it back in, and click Connect again.",
  'car-silent': "Your adapter's working, but the car isn't answering. Make sure the key is in the On position, then try again.",
  'no-data': "Your adapter's working, but the car had no answer for that request. It may not support it, or the ignition may be off.",
  'bus-error': "Your adapter reported a communication error on the car's data line. This often means the wrong protocol or a loose connection.",
  unreadable: "The car answered, but I couldn't make sense of the reply. Your adapter or car may be sending something unusual.",
  'adapter-command': "Your adapter didn't understand a command. It may be an unusual clone. Unplug it, plug it back in, and try again.",
  unknown: 'Something went wrong talking to your adapter. Try unplugging it and plugging it back in.',
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
  const parts = [MESSAGES[category]];

  if (forced && carFailed) {
    const name = PROTOCOLS[String(protocol).toUpperCase()] ?? `protocol ${protocol}`;
    parts.push(`You forced ${name}. Uncheck "Override automatic protocol selection" and let the adapter choose before trying anything else.`);
  }

  const hasCar = Boolean(car.year || car.make || car.model);
  const canSearch = hasCar && carFailed;
  if (canSearch) {
    parts.push("Still stuck? I can open a search for your car's protocol. Treat what you find as a hint, not a verdict.");
  }

  return {
    category,
    text: parts.join(' '),
    adapterReply: err?.reply ?? null,
    suggestAutomatic: forced && carFailed,
    searchUrl: canSearch ? protocolSearchUrl(car, category) : null,
  };
}
