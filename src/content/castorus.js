(function () {
  'use strict';

  const ex = window.__chhExtract;
  const ui = window.__chhOverlay;

  const STATE = {
    injectedFor: null,
    intervals: []
  };

  let notionCheckInFlight = false;
  let notionCheckDone = false;
  let notionMatch = null;
  let autoLookupDone = false;
  let autoLookupInFlight = false;

  function registerInterval(fn, delay) {
    const id = setInterval(fn, delay);
    STATE.intervals.push(id);
    return id;
  }

  function clearAllIntervals() {
    STATE.intervals.forEach(clearInterval);
    STATE.intervals = [];
  }

  function isAdPage() {
    const path = window.location.pathname;
    return path.includes('/annonce/');
  }

  // ── 1. Structured / Config Data Extraction ────────────────────────────────

  function getPropertyConfig() {
    for (const tag of document.querySelectorAll('script')) {
      const text = tag.textContent || '';
      if (text.includes('PROPERTY_CONFIG')) {
        const m = text.match(/PROPERTY_CONFIG\s*=\s*(\{[\s\S]*?\});/);
        if (m) {
          try {
            return eval('(' + m[1] + ')');
          } catch {
            try {
              return JSON.parse(m[1]);
            } catch {}
          }
        }
      }
    }
    return null;
  }

  function extractFromConfig() {
    const cfg = getPropertyConfig();
    const prop = cfg?.property;
    if (!prop) return null;

    const price = typeof prop.prix === 'number' && prop.prix > 0
      ? prop.prix
      : (prop.prix ? parseInt(String(prop.prix).replace(/\D/g, ''), 10) : null);

    const surface = ex.normalizeSurface(prop.superficie);
    const city = prop.commune || null;

    let postal = ex.normalizePostal(prop.code_postal || prop.postalCode || prop.cp);
    if (!postal) {
      const urlM = location.pathname.match(/\/([a-z\-]+)-(\d{5})\//i) || location.pathname.match(/\b(\d{5})\b/);
      if (urlM) postal = urlM[urlM.length - 1];
    }

    let rawType = String(prop.type || '');
    if (rawType === '1') rawType = 'maison';
    else if (rawType === '2') rawType = 'appartement';

    const isLand = /terrain|land/i.test(rawType) || /\bterrain[s]?\b/i.test(document.title) || /\/terrain/i.test(location.pathname);
    const rooms = prop.piece ? parseInt(String(prop.piece), 10) || null : null;

    return {
      kind: isLand ? 'land' : 'dpe',
      postal,
      city,
      surface: isLand ? null : surface,
      landSurface: isLand ? ex.normalizeLandSurface(prop.superficie) : null,
      price,
      buildingType: ex.normalizePropertyType(rawType),
      rooms,
      title: document.title || '',
      url: location.href,
      siteName: 'Castorus',
      source: 'castorus-config'
    };
  }

  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      if (!script.textContent) continue;
      try {
        const json = JSON.parse(script.textContent);
        if (!json) continue;
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const typeStr = String(item['@type'] || '').toLowerCase();
          if (/realestatelisting|residence|house|apartment|singlefamily|realestate|product|place|listing/i.test(typeStr) || item.address || item.offers) {
            const offers = item.offers || {};
            const price = typeof offers.price === 'number'
              ? offers.price
              : (offers.price ? parseInt(String(offers.price).replace(/\D/g, ''), 10) : null);

            const address = item.address || {};
            const postal = ex.normalizePostal(address.postalCode);
            const city = address.addressLocality || null;
            const surface = item.floorSize?.value
              ? ex.normalizeSurface(item.floorSize.value)
              : (item.livingArea?.value ? ex.normalizeSurface(item.livingArea.value) : null);

            const isLand = /terrain|land/i.test(item.name || typeStr) || /\bterrain[s]?\b/i.test(document.title);
            const rooms = item.numberOfRooms ? parseInt(String(item.numberOfRooms), 10) || null : null;

            return {
              kind: isLand ? 'land' : 'dpe',
              postal,
              city,
              surface: isLand ? null : surface,
              landSurface: isLand ? ex.normalizeLandSurface(surface) : null,
              price,
              buildingType: ex.normalizePropertyType(item.name || typeStr),
              rooms,
              title: item.name || document.title || '',
              description: item.description || null,
              url: item.url || location.href,
              siteName: 'Castorus',
              source: 'castorus-jsonld'
            };
          }
        }
      } catch {}
    }
    return null;
  }

  // ── 2. DOM Extraction Fallback ────────────────────────────────────────────

  function extractFromDom() {
    const title = document.title || '';
    const h1Text = document.querySelector('h1')?.textContent || '';
    const locationText = document.querySelector('.prop-location')?.textContent || '';
    const metaDesc =
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      '';
    const descEl = document.querySelector('.prop-desc');
    const descText = descEl?.innerText || descEl?.textContent || metaDesc;

    let postal = null;
    let city = null;

    const pM = (locationText + ' ' + title + ' ' + metaDesc).match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\s*\((\d{5})\)/);
    if (pM) {
      city = pM[1].trim();
      postal = pM[2];
    }

    if (!postal) {
      const postM = (locationText + ' ' + location.pathname + ' ' + title + ' ' + metaDesc).match(/\b(\d{5})\b/);
      if (postM) postal = postM[1];
    }

    if (!city) {
      const urlCityM = location.pathname.match(/\/annonce\/([a-z\-]+)-\d{5}\//i) || location.pathname.match(/\/recherche\/([a-z\-]+)-\d{5}/i);
      if (urlCityM) city = urlCityM[1].replace(/-/g, ' ').toUpperCase();
    }

    let price = null;
    const priceEl = document.querySelector('.price-budget, .prop-price, [data-field="prix"]');
    if (priceEl) {
      const pM = priceEl.textContent.match(/(\d[\d \t\u202f\u00a0]*)\s*€/);
      if (pM) price = parseInt(pM[1].replace(/[ \t\u202f\u00a0]/g, ''), 10);
    }
    if (!price) {
      const priceM = (title + ' ' + metaDesc + ' ' + (document.body?.innerText || '')).match(/(\d[\d \t\u202f\u00a0]*)\s*€/);
      if (priceM) price = parseInt(priceM[1].replace(/[ \t\u202f\u00a0]/g, ''), 10);
    }

    let surface = null;
    const surfM = (h1Text + ' ' + title + ' ' + descText).match(/(\d[\d \t\u202f\u00a0]*)\s*m(?:²|2)(?!\w)/i);
    if (surfM) {
      surface = ex.normalizeSurface(surfM[1].replace(/[ \t\u202f\u00a0]/g, ''));
    }

    let energyClass = null;
    let gesClass = null;

    const dpeLines = document.querySelectorAll('.prop-dpe-line');
    for (const line of dpeLines) {
      const label = line.querySelector('.prop-dpe-label')?.textContent || '';
      const badge = line.querySelector('.prop-energy-badge')?.textContent || '';
      if (/DPE/i.test(label) && badge) {
        energyClass = ex.normalizeClass(badge);
      } else if (/GES/i.test(label) && badge) {
        gesClass = ex.normalizeClass(badge);
      }
    }

    if (!energyClass) {
      const dpeM = descText.match(/\bDPE\s*[:\s]?\s*([A-G])\b/i);
      if (dpeM) energyClass = ex.normalizeClass(dpeM[1]);
    }
    if (!gesClass) {
      const gesM = descText.match(/\bGES\s*[:\s]?\s*([A-G])\b/i);
      if (gesM) gesClass = ex.normalizeClass(gesM[1]);
    }

    const isLand = /\bterrain[s]?\b/i.test(h1Text + ' ' + title) || /\/terrain/i.test(location.pathname);
    const buildingType = ex.normalizePropertyType(h1Text) || ex.normalizePropertyType(title);
    const dateParsed = ex.extractDateFromText(descText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = /neuf|vefa/i.test(descText || title);

    const imageUrl = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;

    if (isLand) {
      return {
        kind: 'land',
        postal,
        city,
        surface: ex.normalizeLandSurface(surface),
        price,
        title: title || h1Text,
        url: location.href,
        siteName: 'Castorus',
        imageUrl,
        description: descText.slice(0, 2000) || null,
        section: ex.normalizeSection(descText),
        source: 'castorus-dom'
      };
    }

    return {
      kind: 'dpe',
      postal,
      city,
      surface,
      price,
      energyClass,
      gesClass,
      buildingType,
      dateRange,
      isNewBuild,
      title: title || h1Text,
      url: location.href,
      siteName: 'Castorus',
      imageUrl,
      description: descText.slice(0, 2000) || null,
      source: 'castorus-dom'
    };
  }

  function tryExtract() {
    const cfgData = extractFromConfig();
    const jsonLd = extractFromJsonLd();
    const domData = extractFromDom();

    let merged = ex.mergePayloads ? ex.mergePayloads(cfgData, jsonLd) : { ...(jsonLd || {}), ...(cfgData || {}) };
    merged = ex.mergePayloads ? ex.mergePayloads(merged, domData) : { ...(domData || {}), ...(merged || {}) };

    if (merged && (merged.postal || merged.city) && (merged.surface || merged.price)) {
      return merged;
    }
    return null;
  }

  // ── 3. Search Result Cards Extraction ────────────────────────────────────

  function extractDetailsFromCard(cardEl, href = '') {
    let price = null;
    let surface = null;
    let postal = null;
    let city = null;

    const dataJsAttr = cardEl.getAttribute('data-js');
    if (dataJsAttr) {
      try {
        const dataJs = JSON.parse(dataJsAttr);
        if (dataJs.sort_prix) {
          price = parseInt(String(dataJs.sort_prix).replace(/\D/g, ''), 10);
        }
        if (dataJs.sort_superficie) {
          surface = parseFloat(String(dataJs.sort_superficie).replace(',', '.'));
        }
        if (dataJs.sort_ville) {
          city = String(dataJs.sort_ville).trim();
        }
      } catch {}
    }

    if (!price) {
      const prixCell = cardEl.querySelector('[data-column="prix"], .col-prix, .price-budget');
      if (prixCell) {
        const val = prixCell.getAttribute('data-sort-value') || prixCell.textContent;
        const pM = val.match(/(\d[\d \t\u202f\u00a0.]*)/);
        if (pM) price = parseInt(pM[1].replace(/[ \t\u202f\u00a0.]/g, ''), 10);
      }
    }

    if (!surface) {
      const surfCell = cardEl.querySelector('[data-column="superficie"], .col-superficie');
      if (surfCell) {
        const val = surfCell.getAttribute('data-sort-value') || surfCell.textContent;
        const sM = val.match(/(\d[\d \t\u202f\u00a0.]*)/);
        if (sM) surface = parseFloat(sM[1].replace(',', '.').replace(/[ \t\u202f\u00a0.]/g, ''));
      }
    }

    const cardText = (cardEl.innerText || cardEl.textContent || '').replace(/m\s*([²2])/gi, 'm2');

    if (!price || price <= 0) {
      const priceMatches = Array.from(cardText.matchAll(/(\d[\d \t\u202f\u00a0.]*)\s*€(?!\s*\/\s*m)/gi));
      let maxPrice = 0;
      for (const m of priceMatches) {
        const val = parseInt(m[1].replace(/[ \t\u202f\u00a0.]/g, ''), 10);
        if (val > maxPrice) maxPrice = val;
      }
      if (maxPrice > 0) price = maxPrice;
    }

    if (!surface || surface <= 0) {
      const surfM = cardText.match(/(\d[\d \t\u202f\u00a0.]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/i);
      if (surfM) {
        const parsedSurf = parseFloat(surfM[1].replace(',', '.').replace(/[ \t\u202f\u00a0.]/g, ''));
        if (!isNaN(parsedSurf) && parsedSurf > 0) surface = Math.round(parsedSurf);
      }
    }

    const pM = cardText.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\s*\((\d{5})\)/);
    if (pM) {
      city = city || pM[1].trim();
      postal = pM[2];
    } else {
      const postM = cardText.match(/\b(\d{5})\b/);
      if (postM) postal = postM[1];
    }

    const targetUrl = href || cardEl.getAttribute('data-href') || '';
    if (targetUrl) {
      const urlM = targetUrl.match(/\/annonce\/([a-z\-]+)-(\d{5})\//i) || targetUrl.match(/\/([a-z\-]+)-(\d{5})\b/i);
      if (urlM) {
        if (!postal) postal = urlM[2];
        if (!city) city = urlM[1].replace(/-/g, ' ').toUpperCase();
      }
    }

    if (!postal) {
      const pageUrlM = location.pathname.match(/\/recherche\/([a-z\-]+)-(\d{5})/i) || location.pathname.match(/\b(\d{5})\b/);
      if (pageUrlM) {
        postal = pageUrlM[pageUrlM.length - 1];
        if (!city && pageUrlM[1]) city = pageUrlM[1].replace(/-/g, ' ').toUpperCase();
      }
    }

    return { price, surface, postal, city, cardText };
  }

  async function processListingCards() {
    const elements = document.querySelectorAll('a[href*="/annonce/"], [data-href*="/annonce/"], tr[data-property-id], tr.sr-row-clickable');

    for (const el of elements) {
      const href = el.getAttribute('href') || el.getAttribute('data-href') || '';
      if (!href || !href.includes('/annonce/')) continue;

      const cleanVal = href.split('?')[0].split('#')[0];
      if (el.dataset.chhProcessed === cleanVal) continue;

      let cardEl = el.closest('tr, article, [class*="card"], [data-property-id], [data-row-id]') || el;

      if (cardEl.querySelector('.chh-card-chh-badge')) {
        el.dataset.chhProcessed = cleanVal;
        continue;
      }

      const details = extractDetailsFromCard(cardEl, href);

      if (ui.checkAndMarkExcluded(cardEl, (details?.title || "") + " " + (details?.city || ""))) {
        el.dataset.chhProcessed = cleanVal;
        continue;
      }

      if ((details.postal && (details.surface || details.price)) || (details.surface && details.price)) {
        el.dataset.chhProcessed = cleanVal;
        try {
          const response = await chrome.runtime.sendMessage({
            type: 'CHECK_NOTION',
            payload: details
          });
          if (response && response.ok && response.result && response.result.match) {
            ui.markCardAsMatched(cardEl, response.result.match);
          }
        } catch (err) {
        }
      }
    }
  }

  // ── 4. Main Overlay / Lookup Orchestration ───────────────────────────────

  function runAutoLookup(payload) {
    if (autoLookupDone || autoLookupInFlight) return;
    autoLookupInFlight = true;

    ui.setFloatingContainerLoading("Recherche d'adresse…");

    chrome.runtime.sendMessage({ type: 'LOOKUP', payload }, (response) => {
      autoLookupInFlight = false;
      autoLookupDone = true;

      if (response && response.ok && response.result) {
        if (response.result.candidates && response.result.candidates.length > 0) {
          const top = response.result.candidates[0];
          if (top.score >= 25) {
            const isLand = payload.kind === 'land' || response.result.kind === 'land';
            let addressStr;
            if (isLand) {
              addressStr = top.parcel.address || top.parcel.street || top.parcel.nom_com || 'Parcelle identifiée';
            } else {
              addressStr = top.record.address || '(adresse inconnue)';
            }
            if (addressStr && addressStr !== '(adresse inconnue)' && addressStr !== 'Parcelle identifiée') {
              ui.setFloatingContainerAddress({
                address: addressStr,
                confidence: top.score,
                dvfPrice: response.result.dvf?.price,
                dvfDate: response.result.dvf?.date,
                candidates: response.result.candidates,
                getPayload: () => payload
              });
              return;
            }
          }
        }
      }
      ui.setFloatingContainerAddress({ address: null, getPayload: () => payload });
    });
  }

  function runDetailOrchestration() {
    if (!isAdPage()) return;
    const payload = tryExtract();
    if (!payload || (!payload.postal && !payload.city) || (!payload.surface && !payload.price)) {
      return;
    }

    if (STATE.injectedFor === location.href && document.querySelector('.chh-floating-container')) {
      return;
    }
    STATE.injectedFor = location.href;

    const onRefresh = () => {
      autoLookupDone = false;
      autoLookupInFlight = false;
      runAutoLookup(payload);
    };

    const onFindOnNotion = async () => {
      const matchDetails = {
        postal: payload.postal,
        city: payload.city,
        surface: payload.surface || payload.landSurface,
        price: payload.price
      };
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'CHECK_NOTION', payload: matchDetails });
        if (resp && resp.ok && resp.result && resp.result.match) {
          notionMatch = resp.result.match;
          ui.setFloatingContainerNotionMatch(notionMatch);
        } else {
          ui.showToast('Aucun bien correspondant dans Notion');
        }
      } catch (e) {
      }
    };

    ui.injectFloatingContainer(payload, onRefresh, onFindOnNotion);

    if (!notionCheckDone && !notionCheckInFlight) {
      notionCheckInFlight = true;
      const matchDetails = {
        postal: payload.postal,
        city: payload.city,
        surface: payload.surface || payload.landSurface,
        price: payload.price
      };
      chrome.runtime.sendMessage({ type: 'CHECK_NOTION', payload: matchDetails }, (response) => {
        notionCheckInFlight = false;
        notionCheckDone = true;
        if (response && response.ok && response.result && response.result.match) {
          notionMatch = response.result.match;
          ui.setFloatingContainerNotionMatch(notionMatch);
        }
      });
    }

    runAutoLookup(payload);
  }

  function init() {
    clearAllIntervals();
    notionCheckDone = false;
    notionCheckInFlight = false;
    notionMatch = null;
    autoLookupDone = false;
    autoLookupInFlight = false;
    STATE.injectedFor = null;

    if (isAdPage()) {
      runDetailOrchestration();
      registerInterval(runDetailOrchestration, 1500);
    }

    processListingCards();
    registerInterval(processListingCards, 2000);
  }

  let lastUrl = location.href;
  registerInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      init();
    }
  }, 500);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
