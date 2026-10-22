// Report page: report.html?id=<test id> shows that test's before/after scan PDFs
// and, when there is one, a live data recording: its CSV (download or replay) and a graph image.
import { infoTip } from './info-tip.js';
import { hasReports, loadResults, vehicleName } from './adapter-data.js';

const title = document.querySelector('#report-title');
const content = document.querySelector('#report-content');
const message = document.querySelector('#report-message');

const sections = [
  { key: 'before', label: 'Before clearing codes', type: 'pdf' },
  { key: 'after', label: 'After clearing codes', type: 'pdf' },
  { key: 'graph', label: 'Live data recording', type: 'recording' },
  { key: 'traffic', label: 'Adapter traffic log', type: 'text' },
];

const has = (reports, { key, type }) => Boolean(reports[key] || (type === 'recording' && reports.csv));
const linkText = { pdf: 'Open PDF in a new tab', recording: 'Open graph full size', text: 'Open the log in a new tab' };

function link(href, text, props = {}) {
  return Object.assign(document.createElement('a'), { href, textContent: text }, props);
}

function showError(text) {
  message.textContent = text;
  message.setAttribute('role', 'alert');
  message.hidden = false;
}

function yesNo(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return 'Not tested';
}

// The PDF or image is only built the first time its section opens, so closed
// sections never download anything.
function reportSection({ label, type }, src, csv, vehicleLabel, caption) {
  const details = document.createElement('details');
  details.className = 'report-pdf';

  const summary = document.createElement('summary');
  summary.textContent = label;

  const panel = document.createElement('div');
  panel.className = 'report-pdf-body';
  const links = document.createElement('p');
  links.className = 'report-pdf-link';
  if (csv) {
    const name = csv.split('/').pop();
    links.append(
      link(csv, 'Download the CSV', { download: name }), ' · ',
      link(`replay.html?csv=${encodeURIComponent(csv)}`, 'Replay this drive →'));
  }
  if (src) {
    if (csv) links.append(' · ');
    links.append(link(src, linkText[type], type === 'text' ? { target: '_blank', rel: 'noopener', download: src.split('/').pop() } : { target: '_blank', rel: 'noopener' }));
  }
  panel.append(links);

  details.addEventListener('toggle', () => {
    if (!details.open || !src || panel.querySelector('iframe, img, pre')) return;
    if (type === 'pdf') {
      const frame = document.createElement('iframe');
      frame.src = src;
      frame.title = `${label} scan report (PDF)`;
      panel.append(frame);
    } else if (type === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'report-log';
      pre.textContent = 'Loading…';
      panel.append(pre);
      fetch(src).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      }).then((text) => { pre.textContent = text; })
        .catch(() => { pre.textContent = 'The log could not be loaded. Use the link above to open it.'; });
    } else {
      const image = document.createElement('img');
      image.src = src;
      image.alt = `Graphs of the ${vehicleLabel} live data recording over time: speed and RPM, fuel trims, `
        + 'oxygen sensors, airflow and load, and temperatures and voltage.';
      panel.append(image);
      if (caption) panel.append(Object.assign(document.createElement('p'), { className: 'report-caption', textContent: caption }));
    }
  });

  details.append(summary, panel);
  return details;
}

try {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) throw new RangeError('No report was chosen.');

  const result = (await loadResults()).find((entry) => entry.id === id);
  if (!result) throw new RangeError('That report could not be found.');

  const vehicle = vehicleName(result.vehicle);
  title.textContent = result.product;
  document.title = `${result.product} · ${vehicle} · WOBD`;
  document.querySelector('#report-vehicle').textContent = vehicle;
  const stats = [
    ['Protocol', result.protocol ?? 'Not tested'],
    ['Tested', result.dateTested ?? 'Not tested'],
    ['Read codes', yesNo(result.readCodes), 'readCodes'],
    ['Clear codes', yesNo(result.clearCodes), 'clearCodes'],
    ['Live data', yesNo(result.liveData), 'liveData'],
  ];
  document.querySelector('#report-stats').replaceChildren(...stats.flatMap(([name, value, key], index) => {
    const tip = key && result.explanations?.[key];
    return [index ? ' · ' : '', `${name}: ${value}`, ...(tip ? [' ', infoTip(tip, `Why: ${name}`)] : [])];
  }));
  const notes = document.querySelector('#report-notes');
  notes.textContent = result.notes ?? '';
  notes.hidden = !result.notes;

  if (!hasReports(result)) throw new RangeError('This test has no scan reports yet.');
  document.querySelector('#report-pdfs').replaceChildren(...sections
    .filter((section) => has(result.reports, section))
    .map((section) => reportSection(section, result.reports[section.key],
      section.type === 'recording' ? result.reports.csv : null, vehicle, result.graphNote)));
  content.hidden = false;
} catch (error) {
  if (error instanceof RangeError) {
    showError(`${error.message} Pick one from the Tested Adapters table.`);
  } else {
    console.error('Unable to load adapter report:', error);
    showError('This report could not be loaded. Please try again later.');
  }
}
