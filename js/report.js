// Report page: report.html?id=<test id> shows that test's before/after scan PDFs
// and, when there is one, a live data recording: its CSV (download or replay) and a graph image.
import { hasReports, loadResults, vehicleName } from './adapter-data.js';

const title = document.querySelector('#report-title');
const content = document.querySelector('#report-content');
const message = document.querySelector('#report-message');

const sections = [
  { key: 'before', label: 'Before clearing codes', type: 'pdf' },
  { key: 'after', label: 'After clearing codes', type: 'pdf' },
  { key: 'graph', label: 'Live data recording', type: 'recording' },
];

const has = (reports, { key, type }) => Boolean(reports[key] || (type === 'recording' && reports.csv));

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
function reportSection({ label, type }, src, csv) {
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
    links.append(link(src, type === 'pdf' ? 'Open PDF in a new tab' : 'Open graph full size', { target: '_blank', rel: 'noopener' }));
  }
  panel.append(links);

  details.addEventListener('toggle', () => {
    if (!details.open || !src || panel.querySelector('iframe, img')) return;
    if (type === 'pdf') {
      const frame = document.createElement('iframe');
      frame.src = src;
      frame.title = `${label} scan report (PDF)`;
      panel.append(frame);
    } else {
      const image = document.createElement('img');
      image.src = src;
      image.alt = 'Graphs from a live data recording on a short drive: speed and RPM, fuel trims, O2 sensors, '
        + 'manifold pressure with throttle and load, and coolant temperature with battery voltage.';
      panel.append(image);
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
  document.querySelector('#report-stats').textContent = [
    `Protocol: ${result.protocol ?? 'Not tested'}`,
    `Tested: ${result.dateTested ?? 'Not tested'}`,
    `Read codes: ${yesNo(result.readCodes)}`,
    `Clear codes: ${yesNo(result.clearCodes)}`,
    `Live data: ${yesNo(result.liveData)}`,
  ].join(' · ');
  const notes = document.querySelector('#report-notes');
  notes.textContent = result.notes ?? '';
  notes.hidden = !result.notes;

  if (!hasReports(result)) throw new RangeError('This test has no scan reports yet.');
  document.querySelector('#report-pdfs').replaceChildren(...sections
    .filter((section) => has(result.reports, section))
    .map((section) => reportSection(section, result.reports[section.key],
      section.type === 'recording' ? result.reports.csv : null)));
  content.hidden = false;
} catch (error) {
  if (error instanceof RangeError) {
    showError(`${error.message} Pick one from the Tested Adapters table.`);
  } else {
    console.error('Unable to load adapter report:', error);
    showError('This report could not be loaded. Please try again later.');
  }
}
