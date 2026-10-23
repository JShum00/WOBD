import './i18n-boot.js';
// Report page: report.html?id=<test id> shows that test's before/after scan PDFs
// and, when there is one, a live data recording: its CSV (download or replay) and a graph image.
import { infoTip } from './info-tip.js';
import { hasReports, loadResults, vehicleName, versionInfo } from './adapter-data.js';
import { onLanguageChange, t } from './i18n.js';

const title = document.querySelector('#report-title');
const content = document.querySelector('#report-content');
const message = document.querySelector('#report-message');

const sections = () => [
  { key: 'before', label: t('bob.report.before'), type: 'pdf' },
  { key: 'after', label: t('bob.report.after'), type: 'pdf' },
  { key: 'graph', label: t('bob.report.graph'), type: 'recording' },
  { key: 'traffic', label: t('bob.report.traffic'), type: 'text' },
];

const has = (reports, { key, type }) => Boolean(reports[key] || (type === 'recording' && reports.csv));
const linkText = { pdf: () => t('bob.report.openPdf'), recording: () => t('bob.report.openGraph'), text: () => t('bob.report.openText') };

function link(href, text, props = {}) {
  return Object.assign(document.createElement('a'), { href, textContent: text }, props);
}

function showError(text) {
  message.textContent = text;
  message.setAttribute('role', 'alert');
  message.hidden = false;
}

function yesNo(value) {
  if (value === true) return t('bob.report.yes');
  if (value === false) return t('bob.report.no');
  return t('bob.report.notTested');
}

// "1.51 (set manually)" or "1.71 (read from the files)", with each file's own version
// when they differ from what's shown.
function versionText(result) {
  const info = versionInfo(result);
  if (!info) return t('bob.report.unknown');
  const files = Object.entries(info.files).map(([key, version]) => `${t(key === 'csv' ? 'bob.report.recording' : 'bob.report.trafficLog')} v${version}`);
  const source = info.manual ? t('bob.report.setManually') : t('bob.report.readFromFiles');
  return `${info.version} (${source}${files.length && info.manual ? t('bob.report.filesSay', { files: files.join(', ') }) : ''})`;
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
      link(csv, t('bob.report.downloadCsv'), { download: name }), ' · ',
      link(`replay.html?csv=${encodeURIComponent(csv)}`, t('bob.report.replay')));
  }
  if (src) {
    if (csv) links.append(' · ');
    links.append(link(src, linkText[type](), type === 'text' ? { target: '_blank', rel: 'noopener', download: src.split('/').pop() } : { target: '_blank', rel: 'noopener' }));
  }
  panel.append(links);

  details.addEventListener('toggle', () => {
    if (!details.open || !src || panel.querySelector('iframe, img, pre')) return;
    if (type === 'pdf') {
      const frame = document.createElement('iframe');
      frame.src = src;
      frame.title = t('bob.report.pdfTitle', { label });
      panel.append(frame);
    } else if (type === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'report-log';
      pre.textContent = t('bob.report.loading');
      panel.append(pre);
      fetch(src).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      }).then((text) => { pre.textContent = text; })
        .catch(() => { pre.textContent = t('bob.report.logFailure'); });
    } else {
      const image = document.createElement('img');
      image.src = src;
      image.alt = t('bob.report.graphAlt', { vehicle: vehicleLabel });
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

  const render = () => {
    const vehicle = vehicleName(result.vehicle);
    title.textContent = result.product;
    document.title = t('bob.report.reportTitle', { product: result.product, vehicle });
    document.querySelector('#report-vehicle').textContent = vehicle;
    const stats = [
      [t('bob.report.protocol'), result.protocol ?? t('bob.report.notTested')],
      [t('bob.report.tested'), result.dateTested ?? t('bob.report.notTested')],
      [t('bob.report.version'), versionText(result)],
      [t('bob.report.readCodes'), yesNo(result.readCodes), 'readCodes'],
      [t('bob.report.clearCodes'), yesNo(result.clearCodes), 'clearCodes'],
      [t('bob.report.liveData'), yesNo(result.liveData), 'liveData'],
    ];
    document.querySelector('#report-stats').replaceChildren(...stats.flatMap(([name, value, key], index) => {
      const tip = key && result.explanations?.[key];
      return [index ? ' · ' : '', `${name}: ${value}`, ...(tip ? [' ', infoTip(tip, t('bob.report.why', { label: name }))] : [])];
    }));
    const notes = document.querySelector('#report-notes');
    notes.textContent = result.notes ?? '';
    notes.hidden = !result.notes;
    document.querySelector('#report-pdfs').replaceChildren(...sections()
      .filter((section) => has(result.reports, section))
      .map((section) => reportSection(section, result.reports[section.key],
        section.type === 'recording' ? result.reports.csv : null, vehicle, result.graphNote)));
    content.hidden = false;
  };

  if (!hasReports(result)) throw new RangeError('This test has no scan reports yet.');
  render();
  onLanguageChange(render);
} catch (error) {
  if (error instanceof RangeError) {
    const key = error.message === 'No report was chosen.' ? 'bob.report.noChoice'
      : error.message === 'That report could not be found.' ? 'bob.report.notFound' : 'bob.report.noReports';
    showError(`${t(key)}${key === 'bob.report.noReports' || key === 'bob.report.notFound' || key === 'bob.report.noChoice' ? ` ${t('bob.report.chooseFromTable')}` : ''}`);
  } else {
    console.error('Unable to load adapter report:', error);
    showError(t('bob.report.loadFailure'));
  }
}
