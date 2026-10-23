// Page glue for the browser backup (js/flight-store.js): the opt-in checkbox, storage warnings,
// and the list of saved or interrupted recordings. Interrupted ones are never resumed or
// deleted without a click.
import { Recording } from './recorder.js';
import { formatDate, formatNumber, onLanguageChange, t } from './i18n.js';
import {
  BackupWriter, RETENTION_DAYS, listSessions, loadSession, openIndexedDb, projectedHours, purgeExpired,
  requestPersistence, storageStatus,
} from './flight-store.js';
import { wobdVersion } from './version-info.js';
import { nativeModel } from './csv-lossless.js';
import { writeWobd } from './wobd.js';

const PREF_KEY = 'wobd.backup.v1';
const CHECK_MS = 30000;
const mb = (bytes) => t('app.backup.megabytes', { size: formatNumber(Math.round(bytes / 1048576), { useGrouping: false }) });
const when = (ms) => formatDate(ms, { dateStyle: 'medium', timeStyle: 'short' });

export function createBackup({ $, download }) {
  let backend = null;
  let writer = null;
  let timer = null;
  let preferenceStatus = null;

  const status = (text, tone = '') => {
    const el = $('backup-status');
    el.textContent = text;
    el.hidden = !text;
    el.dataset.tone = tone;
  };

  async function refreshList() {
    const section = $('saved-recordings');
    const sessions = backend ? await listSessions(backend) : [];
    section.hidden = sessions.length === 0;
    if (!sessions.length) return;
    const interrupted = sessions.filter((s) => s.status === 'open' && s.id !== writer?.meta.id);
    $('saved-note').textContent = interrupted.length
      ? interrupted.length === 1 ? t('app.backup.interruptedOne') : t('app.backup.interruptedMany', { count: formatNumber(interrupted.length) })
      : t('app.backup.retention', { days: formatNumber(RETENTION_DAYS) });
    $('saved-list').replaceChildren(...sessions.filter((s) => s.id !== writer?.meta.id).map(renderSession));
  }

  function renderSession(meta) {
    const li = document.createElement('li');
    li.className = `saved-item${meta.status === 'open' ? ' is-interrupted' : ''}`;
    const text = document.createElement('span');
    text.textContent = `${when(meta.startedAt)} · ${t('app.backup.readings', { count: formatNumber(meta.rows) })} · ${t(meta.status === 'open' ? 'app.backup.interruptedStatus' : 'app.backup.savedStatus')}`;
    const get = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('app.backup.downloadCsv') });
    get.addEventListener('click', async () => {
      const s = await loadSession(backend, meta.id);
      if (!s?.rows.length) { status(t('app.backup.nothingReadable'), 'warn'); return; }
      const csv = Recording.csvFromStored(s.meta, s.rows);
      download(csv, new Recording(meta.startedAt).filename(), 'text/csv');
      if (!s.complete) status(t('app.backup.downloadedPartial', { count: formatNumber(s.rows.length), details: s.problems.join('; ') }), 'warn');
    });
    const pack = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('app.backup.downloadWobd') });
    pack.addEventListener('click', async () => {
      const s = await loadSession(backend, meta.id);
      if (!s?.rows.length) { status(t('app.backup.nothingReadable'), 'warn'); return; }
      const model = nativeModel(s.meta, s.rows);
      const archive = await writeWobd(model, {
        version: wobdVersion(), recordedWith: s.meta.version, sessionId: s.meta.id,
        status: s.meta.status === 'open' || !s.complete ? 'partial' : 'complete',
      });
      download(archive, new Recording(meta.startedAt).filename().replace(/\.csv$/, '.wobd'), 'application/vnd.wobd.session+zip');
      if (!s.complete) status(t('app.backup.savedPartial', { count: formatNumber(s.rows.length), details: s.problems.join('; ') }), 'warn');
    });
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('app.backup.delete') });
    del.addEventListener('click', async () => {
      if (!confirm(t('app.backup.confirmDelete'))) return;
      await backend.remove(meta.id);
      refreshList();
    });
    li.append(text, get, pack, del);
    return li;
  }

  async function checkStorage() {
    const s = await storageStatus();
    if (writer?.failure) {
      status(t('app.backup.writeFailed'), 'warn');
      return;
    }
    const free = s.quota - s.usage;
    const hours = writer && projectedHours(free, writer.meta);
    if (s.level === 'critical') status(t('app.backup.storageCritical', { usage: mb(s.usage), quota: mb(s.quota) }), 'warn');
    else if (s.level === 'warn') status(t('app.backup.storageWarning', { room: hours ? t(hours < 1 ? 'app.backup.underHour' : 'app.backup.moreHours', { hours: formatNumber(Math.floor(hours)) }) : '' }), 'warn');
    else if (s.persisted === false && writer) status(t('app.backup.bestEffort')); 
    else if (writer) status(t('app.backup.backupOn'));
  }

  onLanguageChange(() => {
    refreshList();
    if (writer) checkStorage();
    else if (preferenceStatus) status(t(preferenceStatus));
  });

  return {
    async init() {
      const box = $('record-backup');
      backend = await openIndexedDb();
      if (!backend) {
        box.disabled = true;
        box.parentElement.title = t('app.backup.storageBlocked');
        return;
      }
      box.checked = localStorage.getItem(PREF_KEY) === '1';
      box.addEventListener('change', async () => {
        localStorage.setItem(PREF_KEY, box.checked ? '1' : '0');
        if (!box.checked) { preferenceStatus = null; status(''); return; }
        const kept = await requestPersistence();
        preferenceStatus = kept ? 'app.backup.keptPersistently' : 'app.backup.bestEffort';
        status(t(preferenceStatus));  
      });
      await purgeExpired(backend);
      await refreshList();
    },

    get enabled() { return Boolean(backend && $('record-backup').checked); },

    start(rec) {
      if (!this.enabled) return null;
      writer = new BackupWriter(backend, {
        startedAt: rec.startedAt, protocol: rec.protocol, baud: rec.baud, version: wobdVersion(),
      });
      checkStorage();
      timer = setInterval(checkStorage, CHECK_MS);
      return writer;
    },

    async finish() {
      clearInterval(timer);
      const w = writer;
      writer = null;
      if (!w) return;
      await w.finish();
      preferenceStatus = null;
      status(w.failure ? t('app.backup.failedButCsvSaved') : '');
      await refreshList();
    },
  };
}
