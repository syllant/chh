import { runLookup, runLandLookup } from '../common/match.js';
import { fetchNotionDatabase, findNotionMatch, fetchNotionPage, patchNotionPage, createNotionPage, getPropertyValue, formatNotionId } from '../common/notion.js';
import { syncNotionToCalendar } from '../common/notion-calendar-sync.js';
import { findLastSellingPrice } from '../common/dvf.js';

let notionCachedItems = null;
let notionLastFetched = 0;
const NOTION_CACHE_TTL = 10 * 60 * 1000; // 10 minutes


const MAX_CACHE_ENTRIES = 200;
const CACHE_TTL_MS = 60 * 60 * 1000;
const LAND_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'chh.cache.v1';
const LAND_STORAGE_KEY = 'chh.cache.land.v1';
const MAX_CONCURRENT = 4;
const MAX_LAND_CONCURRENT = 16;

const memoryCache = new Map();
const landCache = new Map();
let inflight = 0;
let landInflight = 0;
const pending = [];
const landPending = [];

function hashPayload(payload) {
  const kind = payload.kind || 'dpe';
  if (kind === 'land') {
    return [
      'land',
      payload.postal || '',
      payload.city || '',
      payload.surface || '',
      payload.section || '',
    ].join('|');
  }
  const parts = [
    'dpe',
    payload.postal || '',
    payload.surface || '',
    payload.energyClass || '',
    payload.gesClass || '',
    payload.buildingType || '',
    payload.dateRange ? `${payload.dateRange.gte}_${payload.dateRange.lte}` : '',
    payload.isNewBuild ? 'new' : 'ex',
  ];
  return parts.join('|');
}

async function loadPersistedCache() {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEY);
    const data = stored[STORAGE_KEY];
    if (data && typeof data === 'object') {
      const now = Date.now();
      for (const [key, entry] of Object.entries(data)) {
        if (entry && entry.expiresAt > now) {
          memoryCache.set(key, entry);
        }
      }
    }
  } catch (e) {
    // chrome.storage.session unavailable — ignore
  }
}

async function loadLandCache() {
  try {
    const stored = await chrome.storage.local.get(LAND_STORAGE_KEY);
    const data = stored[LAND_STORAGE_KEY];
    if (data && typeof data === 'object') {
      const now = Date.now();
      for (const [key, entry] of Object.entries(data)) {
        if (entry && entry.expiresAt > now) {
          landCache.set(key, entry);
        }
      }
    }
  } catch (e) {
    // ignore
  }
}

async function persistCache() {
  try {
    const obj = {};
    for (const [k, v] of memoryCache.entries()) obj[k] = v;
    await chrome.storage.session.set({ [STORAGE_KEY]: obj });
  } catch (e) {
    // ignore
  }
}

async function persistLandCache() {
  try {
    const obj = {};
    for (const [k, v] of landCache.entries()) obj[k] = v;
    await chrome.storage.local.set({ [LAND_STORAGE_KEY]: obj });
  } catch (e) {
    // ignore
  }
}

function trimMap(map, max) {
  while (map.size > max) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function getFromMap(map, key) {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  map.delete(key);
  map.set(key, entry);
  return entry.value;
}

function getFromCache(key) {
  return getFromMap(memoryCache, key);
}

function setCache(key, value) {
  memoryCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  trimMap(memoryCache, MAX_CACHE_ENTRIES);
  persistCache();
}

function getFromLandCache(key) {
  return getFromMap(landCache, key);
}

function setLandCache(key, value) {
  landCache.set(key, { value, expiresAt: Date.now() + LAND_CACHE_TTL_MS });
  trimMap(landCache, MAX_CACHE_ENTRIES);
  persistLandCache();
}

function acquireSlot() {
  return new Promise((resolve) => {
    if (inflight < MAX_CONCURRENT) {
      inflight++;
      resolve();
    } else {
      pending.push(resolve);
    }
  });
}

function releaseSlot() {
  inflight--;
  const next = pending.shift();
  if (next) {
    inflight++;
    next();
  }
}

function acquireLandSlot() {
  return new Promise((resolve) => {
    if (landInflight < MAX_LAND_CONCURRENT) {
      landInflight++;
      resolve();
    } else {
      landPending.push(resolve);
    }
  });
}

function releaseLandSlot() {
  landInflight--;
  const next = landPending.shift();
  if (next) {
    landInflight++;
    next();
  }
}

async function handleLookup(payload) {
  if (payload && payload.kind === 'land') {
    const key = hashPayload(payload);
    const cached = getFromLandCache(key);
    if (cached) return { ...cached, cached: true };

    await acquireLandSlot();
    try {
      const result = await runLandLookup(payload);
      setLandCache(key, result);
      return { ...result, cached: false };
    } finally {
      releaseLandSlot();
    }
  }

  const key = hashPayload(payload);
  const cached = getFromCache(key);
  if (cached) {
    if (cached.candidates && cached.candidates.length > 0) {
      return { ...cached, cached: true };
    }
    if (payload.landSurface) {
      const landPayload = {
        kind: 'land',
        postal: payload.postal,
        surface: payload.landSurface,
        city: payload.city || null
      };
      const landResult = await handleLookup(landPayload);
      if (landResult && landResult.candidates && landResult.candidates.length > 0) {
        return { ...landResult, kind: 'land', cached: landResult.cached };
      }
    }
    return { ...cached, cached: true };
  }

  await acquireSlot();
  let result;
  try {
    result = await runLookup(payload);
    setCache(key, result);
  } finally {
    releaseSlot();
  }

  if (result && result.candidates && result.candidates.length > 0) {
    return { ...result, cached: false };
  }

  if (payload.landSurface) {
    const landPayload = {
      kind: 'land',
      postal: payload.postal,
      surface: payload.landSurface,
      city: payload.city || null
    };
    try {
      const landResult = await handleLookup(landPayload);
      if (landResult && landResult.candidates && landResult.candidates.length > 0) {
        return { ...landResult, kind: 'land', cached: landResult.cached };
      }
    } catch (err) {
      // ignore
    }
  }

  return { ...result, cached: false };
}

async function handleCheckNotion(payload) {
  const config = await chrome.storage.local.get([
    'notionActive',
    'notionToken',
    'notionDatabaseId',
    'notionPriceProp',
    'notionSurfaceProp',
    'notionOtherSurfacesProp',
    'notionPostalProp',
    'notionCityProp',
    'notionPrevPricesProp',
    'notionAddressProp',
    'notionLastSaleProp'
  ]);

  if (!config.notionActive || !config.notionToken || !config.notionDatabaseId) {
    return { active: false, match: null };
  }

  const now = Date.now();
  const forceRefresh = payload.forceRefresh === true;

  if (forceRefresh || !notionCachedItems || now - notionLastFetched > NOTION_CACHE_TTL) {
    try {
      const mappings = {
        price: config.notionPriceProp,
        surface: config.notionSurfaceProp,
        otherSurfaces: config.notionOtherSurfacesProp,
        postal: config.notionPostalProp,
        city: config.notionCityProp,
        prevPrices: config.notionPrevPricesProp,
        address: config.notionAddressProp,
        lastSale: config.notionLastSaleProp
      };
      notionCachedItems = await fetchNotionDatabase(config.notionToken, config.notionDatabaseId, mappings);
      notionLastFetched = now;
    } catch (err) {
      if (!notionCachedItems) throw err;
      // Cache is stale but present — use it rather than failing completely.
    }
  }

  const match = findNotionMatch(payload, notionCachedItems);

  if (payload.isDetailPage && match) {
    // ── Step 1: Fetch fresh address from Notion if missing in cache ────────
    if (!match.address) {
      try {
        const freshPage = await fetchNotionPage(config.notionToken, match.id);
        if (freshPage && freshPage.properties) {
          const addressProp = config.notionAddressProp || 'Adresse';
          const lower = addressProp.toLowerCase();
          let rawAddress = null;
          for (const key of Object.keys(freshPage.properties)) {
            if (key.toLowerCase() === lower) {
              rawAddress = getPropertyValue(freshPage.properties[key]);
              break;
            }
          }
          if (rawAddress) {
            match.address = String(rawAddress).trim();
            const cachedItem = notionCachedItems?.find(it => it.id === match.id);
            if (cachedItem) cachedItem.address = match.address;
          }
        }
      } catch (err) {
        // ignore
      }
    }

    // ── Step 2: ALWAYS run address lookup on detail page ────────────────────
    // Track whether the Notion property already had an address before lookup
    const notionAddress = match.address || null;
    try {
      const lookupResult = await handleLookup(payload);
      if (lookupResult && lookupResult.candidates && lookupResult.candidates.length > 0) {
        const top = lookupResult.candidates[0];
        if (top && top.score >= 25) {
          const isLand = payload.kind === 'land' || lookupResult.kind === 'land';
          let addressStr = isLand
            ? top.parcel.address || top.parcel.street || top.parcel.nom_com || 'Parcelle identifiée'
            : top.record.address || '(adresse inconnue)';

          if (addressStr && addressStr !== '(adresse inconnue)' && addressStr !== 'Parcelle identifiée') {
            const isMacreuses = notionAddress && notionAddress.toLowerCase().includes('macreuses');
            const autoSaveThreshold = 50;

            if (!notionAddress || isMacreuses) {
              // No Notion address (or the macreuses exception) → use lookup address
              match.address = addressStr;
              match.score = top.score;
              match.candidates = lookupResult.candidates;

              const cachedItem = notionCachedItems?.find(it => it.id === match.id);
              if (cachedItem) {
                cachedItem.address = match.address;
                cachedItem.score = match.score;
                cachedItem.candidates = match.candidates;
              }

              // Write the found address back to Notion ONLY if score >= 50
              const cachedItemForWrite = notionCachedItems?.find(it => it.id === match.id);
              if (top.score >= autoSaveThreshold && !cachedItemForWrite?.addressWriteFailed) {
                const addressProp = config.notionAddressProp || 'Adresse';
                try {
                  await patchNotionPage(config.notionToken, match.id, {
                    [addressProp]: {
                      rich_text: [{ type: 'text', text: { content: match.address } }]
                    }
                  });
                } catch (patchErr) {
                  // If the property is of type "place", we can't write it as rich_text.
                  // Mark it in cache so we never retry for this session.
                  if (cachedItemForWrite) cachedItemForWrite.addressWriteFailed = true;
                }
              }
            } else {
              // Notion already has an address → keep it, only update score/candidates
              match.score = match.score || top.score;
              match.candidates = lookupResult.candidates;
            }
          }
        }
      }
    } catch (err) {
      // ignore
    }

    // ── Step 3: DVF lookup ──────────────────────────────────────────────────
    if (match.lastSalePrice) {
      match.dvfPrice = match.lastSalePrice;
      match.dvfDate = match.lastSaleDate || null;
      match.dvfParcelleId = match.lastSaleParcelleId || null;
    } else if (match.address) {
      try {
        const dvfResult = await findLastSellingPrice(
          match.address,
          payload.surface || match.surface,
          payload.buildingType
        );
        if (dvfResult && dvfResult.price) {
          match.dvfPrice = dvfResult.price;
          match.dvfDate = dvfResult.date;
          match.dvfParcelleId = dvfResult.parcelleId || null;

          const lastSalePropName = config.notionLastSaleProp || 'Dernière vente';
          if (lastSalePropName) {
            try {
              const formattedPrice = new Intl.NumberFormat('fr-FR').format(dvfResult.price).replace(/[\u202f\u00a0]/g, ' ');
              const formattedDate = dvfResult.date
                ? new Date(dvfResult.date).toLocaleDateString('fr-FR')
                : null;
              const saleValue = formattedDate
                ? `${formattedPrice} € (${formattedDate})`
                : `${formattedPrice} €`;
              await patchNotionPage(config.notionToken, match.id, {
                [lastSalePropName]: {
                  rich_text: [{ type: 'text', text: { content: saleValue } }]
                }
              });
              const cachedItem = notionCachedItems?.find(it => it.id === match.id);
              if (cachedItem) {
                cachedItem.lastSalePrice = dvfResult.price;
                cachedItem.lastSaleDate = dvfResult.date || null;
                cachedItem.lastSaleParcelleId = dvfResult.parcelleId || null;
              }
            } catch (patchErr) {
              // ignore
            }
          }
        }
      } catch (err) {
        // ignore
      }
    }
  }

  return { active: true, match };
}

loadPersistedCache();
loadLandCache();

// ── Google Calendar alarm (1 h periodic sync) ─────────────────────────────────

const GCAL_ALARM_NAME = 'chh-gcal-sync';

async function runGcalSync() {
  const config = await chrome.storage.local.get([
    'gcalActive',
    'gcalCalendarId',
    'notionActive',
    'notionToken',
    'notionDatabaseId',
  ]);

  if (!config.gcalActive || !config.gcalCalendarId) {
    return; // not configured
  }
  if (!config.notionActive || !config.notionToken || !config.notionDatabaseId) {
    return; // Notion not configured
  }

  const notionConfig = {
    token: config.notionToken,
    databaseId: config.notionDatabaseId,
  };
  const gcalConfig = {
    calendarId: config.gcalCalendarId,
  };

  try {
    await syncNotionToCalendar(notionConfig, gcalConfig);
  } catch (err) {
    // ignore
  }
}

function ensureGcalAlarm() {
  chrome.alarms.get(GCAL_ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(GCAL_ALARM_NAME, { periodInMinutes: 60 });
    }
  });
}

chrome.runtime.onInstalled.addListener(ensureGcalAlarm);
chrome.runtime.onStartup.addListener(ensureGcalAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === GCAL_ALARM_NAME) {
    runGcalSync();
  }
});

async function handleSaveToNotion(payload) {
  const config = await chrome.storage.local.get([
    'notionActive',
    'notionToken',
    'notionDatabaseId',
    'notionPriceProp',
    'notionSurfaceProp',
    'notionTerrainProp',
    'notionRoomsProp',
    'notionBedroomsProp',
    'notionPostalProp',
    'notionCityProp',
    'notionPrevPricesProp',
    'notionAddressProp',
    'notionLastSaleProp',
    'notionUrlProp',
    'notionStatusProp',
    'notionDescriptionProp',
    'notionAddedAtProp',
    'notionSiteProp'
  ]);

  if (!config.notionToken || !config.notionDatabaseId) {
    throw new Error("Notion non configuré. Veuillez renseigner le jeton API et l'ID de base dans les paramètres de l'extension.");
  }

  const cleanDatabaseId = formatNotionId(config.notionDatabaseId);
  const listingData = { ...payload };

  const mappings = {
    price: config.notionPriceProp,
    surface: config.notionSurfaceProp,
    landSurface: config.notionTerrainProp,
    rooms: config.notionRoomsProp,
    bedrooms: config.notionBedroomsProp,
    postal: config.notionPostalProp,
    city: config.notionCityProp,
    address: config.notionAddressProp,
    lastSale: config.notionLastSaleProp,
    url: config.notionUrlProp,
    status: config.notionStatusProp,
    description: config.notionDescriptionProp,
    addedAt: config.notionAddedAtProp,
    site: config.notionSiteProp
  };

  const page = await createNotionPage(config.notionToken, cleanDatabaseId, listingData, mappings);

  // Parse new item for cache
  const newItem = {
    id: page.id,
    url: page.url,
    price: listingData.price ? parseInt(String(listingData.price).replace(/\D/g, ''), 10) : null,
    surface: listingData.surface ? parseFloat(String(listingData.surface)) : null,
    postal: listingData.postal ? String(listingData.postal).replace(/\D/g, '') : null,
    city: listingData.city ? String(listingData.city).trim() : null,
    address: listingData.address ? String(listingData.address).trim() : null,
    dvfPrice: listingData.dvfPrice || null,
    dvfDate: listingData.dvfDate || null,
  };

  if (!notionCachedItems) {
    notionCachedItems = [];
  }
  notionCachedItems.push(newItem);
  notionLastFetched = Date.now();

  return {
    ok: true,
    match: newItem
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  if (message.type === 'LOOKUP') {
    handleLookup(message.payload || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message.type === 'CHECK_NOTION') {
    handleCheckNotion(message.payload || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message.type === 'SAVE_TO_NOTION') {
    handleSaveToNotion(message.payload || {})
      .then((result) => {
        sendResponse({ ok: true, result });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err.message || err) });
      });
    return true;
  }
  if (message.type === 'CACHE_CLEAR') {
    memoryCache.clear();
    landCache.clear();
    persistCache();
    persistLandCache();
    notionCachedItems = null;
    notionLastFetched = 0;
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'GCAL_CONNECT') {
    // Interactive OAuth — must be called from popup (user gesture context)
    chrome.identity.getAuthToken({ interactive: true })
      .then((res) => sendResponse({ ok: true, connected: !!(res && res.token) }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message.type === 'GCAL_SYNC_NOW') {
    runGcalSync()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message.type === 'GCAL_SYNC_STATUS') {
    chrome.storage.local.get([
      'gcal.syncStatus',
      'gcal.syncError',
      'gcal.lastSync',
      'gcal.syncCount',
    ]).then((data) => sendResponse({ ok: true, result: data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (message.type === 'OPEN_POPUP') {
    const payload = message.payload || null;
    const store = payload ? { 'chh.override.payload': payload } : {};
    Promise.resolve()
      .then(() => payload ? chrome.storage.local.set(store) : Promise.resolve())
      .then(() => chrome.action.openPopup())
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  return false;
});
