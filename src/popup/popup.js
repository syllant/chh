const ENERGY_CLASSES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

let currentLandSurface = null;

const dpeForm = document.getElementById('dpe-form');
const landForm = document.getElementById('land-form');
const modeBtnDpe = document.getElementById('mode-dpe');
const modeBtnLand = document.getElementById('mode-land');
const statusBox = document.getElementById('status');
const resultsBox = document.getElementById('results');

let mode = 'dpe';

function normalizePostal(value) {
  if (!value) return null;
  const digits = String(value).replace(/\D+/g, '');
  if (digits.length === 4) return '0' + digits;
  if (digits.length === 5) return digits;
  return null;
}

function normalizeSurface(value) {
  if (!value) return null;
  const num = parseInt(String(value).replace(/\D+/g, ''), 10);
  if (!isFinite(num) || num <= 0) return null;
  return num;
}

function normalizeClass(value) {
  if (!value) return null;
  const letter = String(value).trim().toUpperCase().charAt(0);
  return ENERGY_CLASSES.includes(letter) ? letter : null;
}

function normalizeSection(value) {
  if (!value) return null;
  const m = String(value).trim().toUpperCase().match(/^[A-Z]{1,2}$/);
  return m ? m[0] : null;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function parseUserDate(input) {
  if (!input) return null;
  const t = String(input).trim();
  let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return { year: +m[3], month: +m[2], day: +m[1] };
  m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  m = t.match(/^(\d{1,2})[\/\-.](\d{4})$/);
  if (m) return { year: +m[2], month: +m[1], day: null };
  m = t.match(/^(\d{4})$/);
  if (m) return { year: +m[1], month: null, day: null };
  return null;
}

function parseDateRange(parsed) {
  if (!parsed) return null;
  const { year, month, day } = parsed;
  if (year && month && day) {
    const iso = `${year}-${pad2(month)}-${pad2(day)}`;
    return { gte: iso, lte: iso, precision: 'day' };
  }
  if (year && month) {
    const last = new Date(year, month, 0).getDate();
    return { gte: `${year}-${pad2(month)}-01`, lte: `${year}-${pad2(month)}-${pad2(last)}`, precision: 'month' };
  }
  if (year) return { gte: `${year}-01-01`, lte: `${year}-12-31`, precision: 'year' };
  return null;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function makeCopyBtn(textToCopy) {
  const btn = el('button', { class: 'copy-btn', type: 'button', title: 'Copier l\'adresse' }, '⎘ Copier');
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(textToCopy).then(() => {
      btn.textContent = '✓ Copié';
      btn.classList.add('copy-done');
      setTimeout(() => {
        btn.textContent = '⎘ Copier';
        btn.classList.remove('copy-done');
      }, 2000);
    }).catch(() => {
      btn.textContent = '✗ Erreur';
      setTimeout(() => { btn.textContent = '⎘ Copier'; }, 2000);
    });
  });
  return btn;
}

function setStatus(message, isError = false) {
  if (!message) {
    statusBox.classList.add('hidden');
    statusBox.textContent = '';
    return;
  }
  statusBox.classList.remove('hidden');
  statusBox.classList.toggle('error', isError);
  statusBox.textContent = message;
}

function setMode(next) {
  mode = next;
  modeBtnDpe.classList.toggle('active', mode === 'dpe');
  modeBtnLand.classList.toggle('active', mode === 'land');
  dpeForm.classList.toggle('hidden', mode !== 'dpe');
  landForm.classList.toggle('hidden', mode !== 'land');
  setStatus('');
  resultsBox.innerHTML = '';
}

function gmapsLink(address, postal, city) {
  const q = encodeURIComponent([address, postal, city].filter(Boolean).join(', '));
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function confidenceClass(score) {
  if (score >= 80) return 'green';
  if (score >= 50) return 'yellow';
  return 'red';
}

function landConfidenceClass(score) {
  if (score >= 70) return 'green';
  if (score >= 40) return 'yellow';
  return 'red';
}

function renderDpeResult(result) {
  resultsBox.innerHTML = '';
  if (!result.candidates || result.candidates.length === 0) {
    resultsBox.appendChild(el('div', { class: 'empty' }, 'Aucune correspondance dans le registre ADEME.'));
    return;
  }
  const top = result.candidates[0];
  const conf = confidenceClass(top.score);
  const box = el('div', { class: `result-top ${conf}` });
  const addressText = top.record.address || '(adresse inconnue)';
  box.appendChild(el('div', { class: 'result-address' }, addressText));
  box.appendChild(makeCopyBtn([addressText, top.record.postal, top.record.city].filter(Boolean).join(', ')));
  const metaParts = [top.record.postal, top.record.city, top.record.surface != null ? `${top.record.surface} m²` : null, top.record.date ? String(top.record.date).slice(0, 10) : null].filter(Boolean);
  box.appendChild(el('div', { class: 'result-meta' }, metaParts.join(' • ')));
  box.appendChild(el('div', { class: 'result-meta' }, `Score ${top.score}/100` + (result.matchMethod ? ` (${result.matchMethod === 'ademe' ? 'Registre DPE' : 'Cadastre IGN'})` : '')));
  const links = el(
    'div',
    { class: 'result-links' },
    el(
      'a',
      { href: gmapsLink(top.record.address, top.record.postal, top.record.city), target: '_blank', rel: 'noopener noreferrer' },
      'Google Maps'
    )
  );
  if (top.record.id) {
    links.appendChild(
      el(
        'a',
        { href: `https://observatoire-dpe-audit.ademe.fr/afficher-dpe/${encodeURIComponent(top.record.id)}`, target: '_blank', rel: 'noopener noreferrer' },
        'Fiche ADEME'
      )
    );
  }
  box.appendChild(links);
  resultsBox.appendChild(box);

  const alts = result.candidates.slice(1);
  if (alts.length > 0) {
    const list = el('div', { class: 'result-alt' });
    list.appendChild(el('div', { class: 'result-meta' }, `${alts.length} autre(s) candidat(s)`));
    for (const alt of alts) {
      list.appendChild(
        el(
          'div',
          { class: 'alt-row' },
          el('div', null, alt.record.address || '(adresse inconnue)'),
          el(
            'div',
            { class: 'result-meta' },
            [
              alt.record.postal,
              alt.record.city,
              alt.record.surface != null ? `${alt.record.surface} m²` : null,
              alt.record.date ? String(alt.record.date).slice(0, 10) : null,
              `score ${alt.score}`,
            ]
              .filter(Boolean)
              .join(' • ')
          )
        )
      );
    }
    resultsBox.appendChild(list);
  }
}

function renderLandResult(result) {
  resultsBox.innerHTML = '';
  if (!result.candidates || result.candidates.length === 0) {
    resultsBox.appendChild(el('div', { class: 'empty' }, 'Aucune parcelle trouvée dans le cadastre IGN.'));
    return;
  }
  const top = result.candidates[0];
  const parcel = top.parcel;
  const conf = landConfidenceClass(top.score);
  const box = el('div', { class: `result-top ${conf}` });
  const addressText = parcel.address || parcel.street || '(adresse approximative)';
  box.appendChild(el('div', { class: 'result-address' }, addressText));
  box.appendChild(makeCopyBtn([addressText, parcel.nom_com].filter(Boolean).join(', ')));
  const metaParts = [parcel.nom_com, parcel.codeInsee ? `INSEE ${parcel.codeInsee}` : null, parcel.contenance != null ? `${parcel.contenance} m²` : null].filter(Boolean);
  box.appendChild(el('div', { class: 'result-meta' }, metaParts.join(' • ')));
  const idParts = [parcel.idu, parcel.section ? `section ${parcel.section}` : null, parcel.numero ? `n°${parcel.numero}` : null].filter(Boolean);
  if (idParts.length) box.appendChild(el('div', { class: 'result-meta parcel-id' }, idParts.join(' — ')));
  box.appendChild(el('div', { class: 'result-meta' }, `Score ${top.score}/100` + (result.matchMethod ? ` (${result.matchMethod === 'ademe' ? 'Registre DPE' : 'Cadastre IGN'})` : '')));
  if (Array.isArray(parcel.centroid)) {
    const [lon, lat] = parcel.centroid;
    box.appendChild(
      el(
        'div',
        { class: 'result-links' },
        el('a', { href: `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`, target: '_blank', rel: 'noopener noreferrer' }, 'Google Maps'),
        el(
          'a',
          {
            href: `https://www.geoportail.gouv.fr/carte?c=${lon.toFixed(6)},${lat.toFixed(6)}&z=19&l0=CADASTRALPARCELS.PARCELLAIRE_EXPRESS::GEOPORTAIL:OGC:WMTS(1)&permalink=yes`,
            target: '_blank',
            rel: 'noopener noreferrer',
          },
          'Géoportail'
        )
      )
    );
  }
  resultsBox.appendChild(box);

  const alts = result.candidates.slice(1);
  if (alts.length > 0) {
    const list = el('div', { class: 'result-alt' });
    list.appendChild(el('div', { class: 'result-meta' }, `${alts.length} autre(s) parcelle(s)`));
    for (const alt of alts) {
      const ap = alt.parcel;
      list.appendChild(
        el(
          'div',
          { class: 'alt-row' },
          el('div', null, ap.address || ap.street || ap.idu || '(parcelle)'),
          el(
            'div',
            { class: 'result-meta' },
            [
              ap.nom_com,
              ap.contenance != null ? `${ap.contenance} m²` : null,
              ap.section ? `section ${ap.section}` : null,
              ap.numero ? `n°${ap.numero}` : null,
              `score ${alt.score}`,
            ]
              .filter(Boolean)
              .join(' • ')
          )
        )
      );
    }
    resultsBox.appendChild(list);
  }
}

async function onDpeSubmit(ev) {
  ev.preventDefault();
  const data = new FormData(dpeForm);
  const payload = {
    kind: 'dpe',
    postal: normalizePostal(data.get('postal')),
    surface: normalizeSurface(data.get('surface')),
    energyClass: normalizeClass(data.get('energyClass')),
    gesClass: normalizeClass(data.get('gesClass')),
    buildingType: data.get('buildingType') || null,
    dateRange: parseDateRange(parseUserDate(data.get('date'))),
    isNewBuild: false,
    landSurface: currentLandSurface,
  };
  if (!payload.postal) return setStatus('Code postal invalide.', true);
  if (!payload.surface) return setStatus('Surface invalide.', true);
  setStatus('Recherche…');
  resultsBox.innerHTML = '';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'LOOKUP', payload });
    if (!response || response.ok !== true) return setStatus(response?.error || 'Erreur inconnue', true);
    if (response.result.kind === 'land') {
      setStatus(response.result.cached ? 'Cache (Cadastre)' : `OK (Cadastre tier ${response.result.tier}, ${response.result.total ?? 0} candidat(s))`);
      renderLandResult(response.result);
    } else {
      setStatus(response.result.cached ? 'Cache' : `OK (dataset ${response.result.dataset}, tier ${response.result.tier})`);
      renderDpeResult(response.result);
    }
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
}

async function onLandSubmit(ev) {
  ev.preventDefault();
  const data = new FormData(landForm);
  const payload = {
    kind: 'land',
    postal: normalizePostal(data.get('postal')),
    surface: normalizeSurface(data.get('surface')),
    city: (data.get('city') || '').toString().trim() || null,
    section: normalizeSection(data.get('section')),
  };
  if (!payload.postal) return setStatus('Code postal invalide.', true);
  if (!payload.surface) return setStatus('Surface invalide.', true);
  setStatus('Recherche cadastrale…');
  resultsBox.innerHTML = '';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'LOOKUP', payload });
    if (!response || response.ok !== true) return setStatus(response?.error || 'Erreur inconnue', true);
    setStatus(response.result.cached ? 'Cache' : `OK (tier ${response.result.tier}, ${response.result.total ?? 0} candidat(s))`);
    renderLandResult(response.result);
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
}

dpeForm.addEventListener('submit', onDpeSubmit);
landForm.addEventListener('submit', onLandSubmit);
modeBtnDpe.addEventListener('click', () => setMode('dpe'));
modeBtnLand.addEventListener('click', () => setMode('land'));

// ── Tab switching ────────────────────────────────────────────────────────────
const tabSearch = document.getElementById('tab-search');
const tabCalendar = document.getElementById('tab-calendar');
const tabConfig = document.getElementById('tab-config');

const panelSearch = document.getElementById('panel-search');
const panelCalendar = document.getElementById('panel-calendar');
const panelConfig = document.getElementById('panel-config');

function switchTab(activeTab, activePanel) {
  [tabSearch, tabCalendar, tabConfig].forEach(btn => {
    btn.classList.toggle('active', btn === activeTab);
    btn.setAttribute('aria-selected', btn === activeTab ? 'true' : 'false');
  });
  [panelSearch, panelCalendar, panelConfig].forEach(panel => {
    panel.classList.toggle('hidden', panel !== activePanel);
  });
}

tabSearch.addEventListener('click', () => switchTab(tabSearch, panelSearch));
tabCalendar.addEventListener('click', () => switchTab(tabCalendar, panelCalendar));
tabConfig.addEventListener('click', () => switchTab(tabConfig, panelConfig));

resultsBox.addEventListener('click', (ev) => {
  const link = ev.target.closest('a');
  if (link && link.href) {
    ev.preventDefault();
    chrome.tabs.create({ url: link.href, active: false });
  }
});

// ── Pre-fill from "Modifier les champs" ──────────────────────────────────────

function setFieldValue(form, name, value) {
  if (value == null || value === '') return;
  const el = form.elements[name];
  if (!el) return;
  el.value = value;
}

function dateRangeToDisplay(dateRange) {
  if (!dateRange) return '';
  if (dateRange.precision === 'day') return dateRange.gte; // YYYY-MM-DD
  if (dateRange.precision === 'month') return dateRange.gte.slice(0, 7).replace('-', '/'); // MM/YYYY
  if (dateRange.precision === 'year') return dateRange.gte.slice(0, 4); // YYYY
  return '';
}

async function loadOverride() {
  try {
    const OVERRIDE_KEY = 'chh.override.payload';
    const stored = await chrome.storage.local.get(OVERRIDE_KEY);
    const payload = stored[OVERRIDE_KEY];
    if (!payload || typeof payload !== 'object') return;

    // Consume immediately — one shot
    await chrome.storage.local.remove(OVERRIDE_KEY);

    currentLandSurface = payload.landSurface || null;

    // ── Champs communs aux deux formulaires ──────────────────────────────────
    const postal  = payload.postal  || '';
    const surface = payload.surface ?? '';
    const city    = payload.city    || '';

    // ── Onglet DPE ───────────────────────────────────────────────────────────
    setFieldValue(dpeForm, 'postal',       postal);
    setFieldValue(dpeForm, 'surface',      payload.kind === 'dpe' ? surface : '');
    setFieldValue(dpeForm, 'energyClass',  payload.energyClass  || '');
    setFieldValue(dpeForm, 'gesClass',     payload.gesClass     || '');
    setFieldValue(dpeForm, 'buildingType', payload.buildingType || '');
    setFieldValue(dpeForm, 'date',         dateRangeToDisplay(payload.dateRange));

    // ── Onglet Terrain ───────────────────────────────────────────────────────
    setFieldValue(landForm, 'postal',  postal);
    setFieldValue(landForm, 'surface', payload.kind === 'land' ? surface : (payload.landSurface || ''));
    setFieldValue(landForm, 'city',    city);
    setFieldValue(landForm, 'section', payload.section || '');

    // ── Activer l'onglet correspondant au type détecté ───────────────────────
    setMode(payload.kind === 'land' ? 'land' : 'dpe');
  } catch (e) {
    // chrome.storage unavailable — ignore
  }
}

loadOverride();

// ── Notion integration settings ──────────────────────────────────────────────

async function loadNotionSettings() {
  try {
    const config = await chrome.storage.local.get([
      'notionActive',
      'notionToken',
      'notionDatabaseId',
      'notionPriceProp',
      'notionSurfaceProp',
      'notionTerrainProp',
      'notionRoomsProp',
      'notionBedroomsProp',
      'notionOtherSurfacesProp',
      'notionPostalProp',
      'notionCityProp',
      'notionPrevPricesProp',
      'notionAddressProp',
      'notionLastSaleProp',
      'notionUrlProp',
      'notionStatusProp',
      'notionDescriptionProp',
      'notionAddedAtProp',
      'notionSiteProp',
      'excludedTerms'
    ]);

    document.getElementById('notion-active').checked = !!config.notionActive;
    document.getElementById('notion-token').value = config.notionToken || '';
    document.getElementById('notion-db-id').value = config.notionDatabaseId || '';
    document.getElementById('notion-prop-price').value = config.notionPriceProp || 'Prix';
    document.getElementById('notion-prop-surface').value = config.notionSurfaceProp || 'Surface';
    document.getElementById('notion-prop-terrain').value = config.notionTerrainProp || 'Terrain';
    document.getElementById('notion-prop-rooms').value = config.notionRoomsProp || 'Pièces';
    document.getElementById('notion-prop-bedrooms').value = config.notionBedroomsProp || 'Chambres';
    document.getElementById('notion-prop-other-surfaces').value = config.notionOtherSurfacesProp || 'Autre surface';
    document.getElementById('notion-prop-postal').value = config.notionPostalProp || 'Code postal';
    document.getElementById('notion-prop-city').value = config.notionCityProp || 'Ville';
    document.getElementById('notion-prop-prev-prices').value = config.notionPrevPricesProp || 'Prix précédents';
    document.getElementById('notion-prop-address').value = config.notionAddressProp || 'Adresse';
    document.getElementById('notion-prop-last-sale').value = config.notionLastSaleProp || 'Dernière vente';
    document.getElementById('notion-prop-url').value = config.notionUrlProp || 'Portal URL';
    document.getElementById('notion-prop-status').value = config.notionStatusProp || 'Statut';
    document.getElementById('notion-prop-description').value = config.notionDescriptionProp || 'Description';
    document.getElementById('notion-prop-added-at').value = config.notionAddedAtProp || 'Ajouté le';
    document.getElementById('notion-prop-site').value = config.notionSiteProp || 'Site';

    const excludedInput = document.getElementById('excluded-terms');
    if (excludedInput) {
      excludedInput.value = (Array.isArray(config.excludedTerms) && config.excludedTerms.length > 0)
        ? config.excludedTerms.join(', ')
        : 'Courtarelles, Courtarelle, Estanove, Aiguelongue, Seigneurs, Domaine des Oliviers, Jacou, Clapiers, Caylus, Celleneuve, Védas';
    }
  } catch (e) {
    // ignore
  }
}

async function saveNotionSettings() {
  const active = document.getElementById('notion-active').checked;
  const token = document.getElementById('notion-token').value.trim();
  const dbId = document.getElementById('notion-db-id').value.trim();
  const priceProp = document.getElementById('notion-prop-price').value.trim();
  const prevPricesProp = document.getElementById('notion-prop-prev-prices').value.trim();
  const surfaceProp = document.getElementById('notion-prop-surface').value.trim();
  const terrainProp = document.getElementById('notion-prop-terrain').value.trim();
  const roomsProp = document.getElementById('notion-prop-rooms').value.trim();
  const bedroomsProp = document.getElementById('notion-prop-bedrooms').value.trim();
  const otherSurfacesProp = document.getElementById('notion-prop-other-surfaces').value.trim();
  const postalProp = document.getElementById('notion-prop-postal').value.trim();
  const cityProp = document.getElementById('notion-prop-city').value.trim();
  const addressProp = document.getElementById('notion-prop-address').value.trim();
  const lastSaleProp = document.getElementById('notion-prop-last-sale').value.trim();
  const urlProp = document.getElementById('notion-prop-url').value.trim();
  const statusPropName = document.getElementById('notion-prop-status').value.trim();
  const descriptionProp = document.getElementById('notion-prop-description').value.trim();
  const addedAtProp = document.getElementById('notion-prop-added-at').value.trim();
  const siteProp = document.getElementById('notion-prop-site').value.trim();

  const rawExcluded = (document.getElementById('excluded-terms')?.value || '').trim();
  const excludedTerms = rawExcluded
    ? rawExcluded.split(',').map(s => s.trim()).filter(Boolean)
    : ['Courtarelles', 'Courtarelle', 'Estanove', 'Aiguelongue', 'Seigneurs', 'Domaine des Oliviers', 'Jacou', 'Clapiers', 'Caylus', 'Celleneuve', 'Védas'];

  const statusMsg = document.getElementById('notion-settings-status');
  statusMsg.classList.add('hidden');
  statusMsg.className = 'status-msg';

  if (active && (!token || !dbId)) {
    statusMsg.textContent = 'Erreur : Token et ID requis pour activer.';
    statusMsg.classList.add('error');
    statusMsg.classList.remove('hidden');
    return;
  }

  try {
    await chrome.storage.local.set({
      notionActive: active,
      notionToken: token,
      notionDatabaseId: dbId,
      notionPriceProp: priceProp,
      notionPrevPricesProp: prevPricesProp,
      notionSurfaceProp: surfaceProp,
      notionTerrainProp: terrainProp,
      notionRoomsProp: roomsProp,
      notionBedroomsProp: bedroomsProp,
      notionOtherSurfacesProp: otherSurfacesProp,
      notionPostalProp: postalProp,
      notionCityProp: cityProp,
      notionAddressProp: addressProp,
      notionLastSaleProp: lastSaleProp,
      notionUrlProp: urlProp,
      notionStatusProp: statusPropName,
      notionDescriptionProp: descriptionProp,
      notionAddedAtProp: addedAtProp,
      notionSiteProp: siteProp,
      excludedTerms
    });

    statusMsg.textContent = 'Configuration enregistrée !';
    statusMsg.classList.add('success');
    statusMsg.classList.remove('hidden');

    if (active) {
      await chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' });
    }
  } catch (err) {
    statusMsg.textContent = 'Erreur lors de la sauvegarde.';
    statusMsg.classList.add('error');
    statusMsg.classList.remove('hidden');
  }

  setTimeout(() => statusMsg.classList.add('hidden'), 3000);
}

async function clearNotionCache() {
  const statusMsg = document.getElementById('notion-settings-status');
  statusMsg.classList.add('hidden');
  statusMsg.className = 'status-msg';

  try {
    await chrome.runtime.sendMessage({ type: 'CACHE_CLEAR' });
    statusMsg.textContent = 'Cache vidé !';
    statusMsg.classList.add('success');
    statusMsg.classList.remove('hidden');
  } catch (err) {
    statusMsg.textContent = 'Erreur lors de la vidange du cache.';
    statusMsg.classList.add('error');
    statusMsg.classList.remove('hidden');
  }

  setTimeout(() => statusMsg.classList.add('hidden'), 3000);
}

document.getElementById('notion-save-btn').addEventListener('click', saveNotionSettings);
document.getElementById('notion-clear-cache-btn').addEventListener('click', clearNotionCache);

loadNotionSettings();

const openTabBtn = document.getElementById('open-tab-btn');
if (openTabBtn) {
  if (window.location.search.includes('tab=true')) {
    openTabBtn.style.display = 'none';
  } else {
    openTabBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/popup/popup.html?tab=true') });
    });
  }
}

// ── Google Calendar settings ──────────────────────────────────────────────────

const gcalStatusBar = document.getElementById('gcal-sync-status-bar');
const gcalStatusText = document.getElementById('gcal-status-text');
const gcalSyncNowBtn = document.getElementById('gcal-sync-now-btn');
const gcalConnectBtn = document.getElementById('gcal-connect-btn');
const gcalConnectLabel = document.getElementById('gcal-connect-label');
const gcalConnectStatus = document.getElementById('gcal-connect-status');

function formatRelativeTime(isoString) {
  if (!isoString) return null;
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'à l\'instant';
  if (mins < 60) return `il y a ${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `il y a ${hrs} h`;
  return `il y a ${Math.floor(hrs / 24)} j`;
}

function renderGcalStatus(data) {
  const status = data['gcal.syncStatus'];
  const errorMsg = data['gcal.syncError'];
  const lastSync = data['gcal.lastSync'];
  const count = data['gcal.syncCount'];
  const statusMatches = data['gcal.debugStatusMatches'] || 0;
  const dateMatches = data['gcal.debugDateMatches'] || 0;

  if (!status) {
    gcalStatusBar.classList.add('hidden');
    return;
  }

  gcalStatusBar.classList.remove('hidden');
  gcalStatusBar.setAttribute('data-status', status);

  if (status === 'ok') {
    const when = formatRelativeTime(lastSync);
    if (count === 0 && statusMatches > 0) {
      gcalStatusText.textContent = `0 sync (${statusMatches} pages sans date/colonne incorrecte) · ${when || ''}`;
    } else {
      gcalStatusText.textContent = `${count ?? 0} événement(s) · ${when || ''}`;
    }
  } else if (status === 'error') {
    gcalStatusText.textContent = errorMsg || 'Erreur inconnue';
  } else if (status === 'syncing') {
    gcalStatusText.textContent = 'Synchronisation…';
  }
}

async function refreshGcalStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GCAL_SYNC_STATUS' });
    if (response && response.ok) renderGcalStatus(response.result);
  } catch (_) { /* service worker not ready */ }
}

async function connectGoogle() {
  gcalConnectBtn.disabled = true;
  gcalConnectLabel.textContent = 'Connexion…';
  gcalConnectStatus.textContent = '';

  try {
    const response = await chrome.runtime.sendMessage({ type: 'GCAL_CONNECT' });
    if (response && response.ok && response.connected) {
      gcalConnectLabel.textContent = 'Connecté ✓';
      gcalConnectBtn.classList.add('connected');
      gcalConnectStatus.textContent = '';
    } else {
      gcalConnectLabel.textContent = 'Se connecter à Google';
      gcalConnectStatus.textContent = response?.error || 'Échec';
    }
  } catch (err) {
    gcalConnectLabel.textContent = 'Se connecter à Google';
    gcalConnectStatus.textContent = err.message || 'Erreur';
  } finally {
    gcalConnectBtn.disabled = false;
  }
}

async function loadGcalSettings() {
  try {
    const config = await chrome.storage.local.get([
      'gcalActive',
      'gcalCalendarId',
    ]);

    document.getElementById('gcal-active').checked = !!config.gcalActive;
    document.getElementById('gcal-calendar-id').value = config.gcalCalendarId || '';

    // Check silently if already connected
    try {
      const res = await chrome.identity.getAuthToken({ interactive: false });
      if (res && res.token) {
        gcalConnectLabel.textContent = 'Connecté ✓';
        gcalConnectBtn.classList.add('connected');
      }
    } catch (_) { /* not connected yet */ }


    if (config.gcalActive) await refreshGcalStatus();
  } catch (e) { /* ignore */ }
}

async function saveGcalSettings() {
  const active = document.getElementById('gcal-active').checked;
  const calendarId = document.getElementById('gcal-calendar-id').value.trim();

  const statusMsg = document.getElementById('gcal-settings-status');
  statusMsg.className = 'status-msg hidden';

  if (active && !calendarId) {
    statusMsg.textContent = 'Erreur : l\'ID du calendrier est requis pour activer.';
    statusMsg.classList.add('error');
    statusMsg.classList.remove('hidden');
    return;
  }

  try {
    await chrome.storage.local.set({
      gcalActive: active,
      gcalCalendarId: calendarId,
    });

    statusMsg.textContent = 'Configuration enregistrée !';
    statusMsg.classList.add('success');
    statusMsg.classList.remove('hidden');

    if (active) await refreshGcalStatus();
  } catch (err) {
    statusMsg.textContent = 'Erreur lors de la sauvegarde.';
    statusMsg.classList.add('error');
    statusMsg.classList.remove('hidden');
  }

  setTimeout(() => statusMsg.classList.add('hidden'), 3000);
}

async function forceGcalSync() {
  gcalSyncNowBtn.disabled = true;
  gcalSyncNowBtn.classList.add('syncing');

  gcalStatusBar.classList.remove('hidden');
  gcalStatusBar.setAttribute('data-status', 'syncing');
  gcalStatusText.textContent = 'Synchronisation…';

  try {
    await chrome.runtime.sendMessage({ type: 'GCAL_SYNC_NOW' });
    await new Promise(r => setTimeout(r, 500));
    await refreshGcalStatus();
  } catch (err) {
    gcalStatusBar.setAttribute('data-status', 'error');
    gcalStatusText.textContent = err.message || 'Erreur';
  } finally {
    gcalSyncNowBtn.disabled = false;
    gcalSyncNowBtn.classList.remove('syncing');
  }
}

gcalConnectBtn.addEventListener('click', connectGoogle);
document.getElementById('gcal-save-btn').addEventListener('click', saveGcalSettings);
gcalSyncNowBtn.addEventListener('click', forceGcalSync);

loadGcalSettings();

// Poll gcal status while popup is open (every 5s) to catch background syncs
setInterval(async () => {
  const config = await chrome.storage.local.get('gcalActive');
  if (config.gcalActive) await refreshGcalStatus();
}, 5000);


