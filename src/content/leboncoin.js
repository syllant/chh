(function () {
  'use strict';

  const ex = window.__chhExtract;
  const ui = window.__chhOverlay;
  const STATE = { 
    lastPayload: null, 
    injectedFor: null,
    intervals: []
  };

  let autoLookupDone = false;
  let autoLookupInFlight = false;

  function clearAllIntervals() {
    for (const id of STATE.intervals) {
      clearInterval(id);
    }
    STATE.intervals = [];
  }

  function registerInterval(fn, ms) {
    const id = setInterval(fn, ms);
    STATE.intervals.push(id);
    return id;
  }

  function readNextData() {
    const node = document.getElementById('__NEXT_DATA__');
    if (!node || !node.textContent) return null;
    try {
      return JSON.parse(node.textContent);
    } catch {
      return null;
    }
  }

  function findAd(nextData) {
    if (!nextData) return null;
    let ad = ex.getNestedValue(nextData, [
      ['props', 'pageProps', 'ad'],
      ['props', 'pageProps', 'data', 'ad'],
    ]);
    if (!ad) {
      ad = ex.deepFind(nextData, (n) => n && typeof n === 'object' && (n.attributes || n.list_id) && (n.subject || n.title));
    }

    if (ad && ad.list_id) {
      // Ignore stale __NEXT_DATA__ in SPA client-side navigations
      const match = location.pathname.match(/\/(?:ad|vi|locations|ventes_immobilieres)\/(?:.*\/)?(\d{5,})/);
      if (match && match[1] && String(ad.list_id) !== match[1]) {
        return null;
      }
    }
    return ad;
  }

  function attributesToMap(attributes) {
    const map = {};
    if (!Array.isArray(attributes)) return map;
    for (const attr of attributes) {
      if (attr && attr.key) map[attr.key] = attr;
    }
    return map;
  }

  function extractFromAd(ad) {
    if (!ad) return null;
    const attrMap = attributesToMap(ad.attributes);
    const get = (key) => {
      const a = attrMap[key];
      if (!a) return null;
      return a.value_label || a.value || null;
    };

    const location = ad.location || {};
    const postal = ex.normalizePostal(location.zipcode || location.zip_code);
    const city = location.city || null;

    const kind = ex.detectListingKind({
      category: ad.category_name,
      propertyType: get('real_estate_type'),
      title: ad.subject,
    });

    if (kind === 'land') {
      const landSurfaceRaw = get('land_plot_surface') || get('square');
      const surface = ex.normalizeLandSurface(landSurfaceRaw);
      const section = ex.normalizeSection([ad.subject, ad.body, ad.description].filter(Boolean).join(' '));
      return {
        kind: 'land',
        postal,
        city,
        surface,
        section,
        source: 'leboncoin-json',
      };
    }

    const energy = ex.normalizeClass(get('energy_rate'));
    const ges = ex.normalizeClass(get('ges'));
    const surfaceRaw = get('square') || get('surface') || get('size') || get('real_estate_surface') || get('living_space') || get('living_area') || get('surface_area') || get('superficie');
    const surface = ex.normalizeSurface(surfaceRaw);

    let buildingType = ex.normalizePropertyType(get('real_estate_type'));
    if (!buildingType) buildingType = ex.normalizePropertyType(ad.category_name);

    const text = [ad.subject, ad.body, ad.description].filter(Boolean).join('\n');
    const dateParsed = ex.extractDateFromText(text);
    const dateRange = ex.parseDateRange(dateParsed);

    const isNewBuild = /neuf|vefa|programme\s+neuf/i.test(text || '');

    let price = null;
    if (ad.price) {
      if (Array.isArray(ad.price) && ad.price.length > 0) {
        price = ad.price[0];
      } else if (typeof ad.price === 'object' && ad.price.value !== undefined) {
        price = ad.price.value;
      } else if (typeof ad.price === 'number') {
        price = ad.price;
      }
    }

    const title = ad.subject || document.querySelector('h1')?.textContent || document.title || '';
    const imageUrl = (ad.images && ad.images.urls && ad.images.urls[0]) || ad.images?.thumb_url || document.querySelector('img[src*="leboncoin"]')?.src || null;
    const rooms = get('rooms') || get('nb_rooms');
    const bedrooms = get('bedrooms') || get('nb_bedrooms');
    const description = ad.body || ad.description || document.querySelector('[data-qa-id="adview_description"]')?.innerText || null;
    const landSurface = ex.normalizeLandSurface(get('land_plot_surface') || get('land_surface') || get('surface_terrain') || get('terrain'));
    const url = location.href;
    const siteName = 'LeBonCoin';

    return {
      kind: 'dpe',
      title,
      url,
      siteName,
      imageUrl,
      rooms,
      bedrooms,
      description,
      landSurface,
      postal,
      city,
      surface,
      price,
      energyClass: energy,
      gesClass: ges,
      buildingType,
      dateRange,
      isNewBuild,
      source: 'leboncoin-json',
    };
  }

  function extractFromDom() {
    const energyEl =
      document.querySelector('[data-qa-id="criteria_item_energy_rate"]') ||
      document.querySelector('[data-qa-id="adview_energy_rate"]') ||
      document.querySelector('[data-testid="energy-rate"]');
    const gesEl =
      document.querySelector('[data-qa-id="criteria_item_ges"]') ||
      document.querySelector('[data-qa-id="adview_ges"]') ||
      document.querySelector('[data-testid="ges"]');
    const surfaceEl =
      document.querySelector('[data-qa-id="criteria_item_square"]') ||
      document.querySelector('[data-qa-id="criteria_item_surface"]') ||
      document.querySelector('[data-qa-id="criteria_item_real_estate_surface"]') ||
      document.querySelector('[data-qa-id="adview_square"]') ||
      document.querySelector('[data-testid="square"]') ||
      document.querySelector('[data-testid="surface"]');
    const cityEl =
      document.querySelector('[data-qa-id="adview_location_informations"]') ||
      document.querySelector('a[href*="#map"]');
    const descEl =
      document.querySelector('[data-qa-id="adview_description_container"]') ||
      document.querySelector('#readme-content') ||
      document.querySelector('[data-testid="description"]');

    const priceEl = document.querySelector('[data-qa-id="adview_price"]') || document.querySelector('[data-testid="adview_price"]');
    const priceText = priceEl?.textContent || '';
    let price = null;
    if (priceText) {
      const pMatches = Array.from(priceText.matchAll(/(\d[\d \t\u202f\u00a0.]*)\s*€(?!\s*\/\s*m)/gi));
      let maxP = 0;
      for (const pm of pMatches) {
        const val = parseInt(pm[1].replace(/[ \t\u202f\u00a0.]/g, ''), 10);
        if (val > maxP) maxP = val;
      }
      if (maxP > 0) price = maxP;
    }

    const energy = ex.normalizeClass(energyEl?.textContent);
    const ges = ex.normalizeClass(gesEl?.textContent);
    let surface = ex.normalizeSurface(surfaceEl?.textContent);
    let postal = null;
    let city = null;
    if (cityEl?.textContent) {
      const m = cityEl.textContent.match(/\b(\d{5})\b/);
      if (m) postal = m[1];
      const cm = cityEl.textContent.replace(/\d{5}/, '').trim();
      if (cm) city = cm.replace(/[•|·]/g, '').trim();
    }
    const descText = descEl?.textContent || document.body.innerText || '';
    const title = findVisibleTitleElement()?.textContent || document.title || '';

    // Robust fallbacks for new Leboncoin DOM
    const bodyText = document.body.innerText || '';
    if (!price) {
      const pMatches = Array.from(bodyText.matchAll(/(\d[\d \t\u202f\u00a0.]*)\s*€(?!\s*\/\s*m)/gi));
      let maxP = 0;
      for (const pm of pMatches) {
        const val = parseInt(pm[1].replace(/[ \t\u202f\u00a0.]/g, ''), 10);
        if (val > maxP) maxP = val;
      }
      if (maxP > 0) price = maxP;
    }
    if (!surface) {
      const mainContentText = (descEl?.textContent || '') + ' ' + title;
      for (const src of [mainContentText, bodyText]) {
        const m = src.match(/(\d[\d \t\u202f\u00a0.,]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/i);
        if (m) {
          const parsed = parseFloat(m[1].replace(',', '.').replace(/[ \t\u202f\u00a0]/g, ''));
          if (!isNaN(parsed) && parsed > 0) {
            surface = Math.round(parsed);
            break;
          }
        }
      }
    }
    if (!postal) {
      const pM = bodyText.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\s*\(?(\d{5})\)?/);
      if (pM) {
        city = pM[1].trim();
        postal = pM[2];
      } else {
        const postM = bodyText.match(/\b(\d{5})\b/);
        if (postM) postal = postM[1];
      }
    }
    const isLand =
      /\bterrain[s]?\b/i.test(title) ||
      /\bterrain[s]?\b/i.test(descText) ||
      /\/terrain[s]?\b/i.test(location.pathname);

    if (isLand) {
      let landSurface = ex.normalizeLandSurface(surfaceEl?.textContent);
      if (!landSurface) {
        const sources = [title, descText, document.title || ''];
        for (const src of sources) {
          const m = src.match(/(\d{1,6})\s*m(?:²|2)\b/i);
          if (m) {
            landSurface = ex.normalizeLandSurface(m[1]);
            if (landSurface) break;
          }
        }
      }
      const section = ex.normalizeSection(descText + ' ' + title);
      if (!landSurface && !postal) return null;
      return {
        kind: 'land',
        title,
        url: location.href,
        siteName: 'LeBonCoin',
        imageUrl: document.querySelector('img[src*="leboncoin"]')?.src || null,
        description: descText?.slice(0, 2000) || null,
        rooms: null,
        bedrooms: null,
        postal,
        city,
        surface: landSurface,
        price,
        section,
        source: 'leboncoin-dom',
      };
    }

    const dateParsed = ex.extractDateFromText(descText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = /neuf|vefa|programme\s+neuf/i.test(descText || '');

    const roomsEl = document.querySelector('[data-qa-id="criteria_item_rooms"]') || document.querySelector('[data-testid="rooms"]');
    const rooms = roomsEl ? parseInt((roomsEl.textContent || '').replace(/\D/g, ''), 10) || null : null;
    const bedroomsEl = document.querySelector('[data-qa-id="criteria_item_bedrooms"]') || document.querySelector('[data-testid="bedrooms"]');
    const bedrooms = bedroomsEl ? parseInt((bedroomsEl.textContent || '').replace(/\D/g, ''), 10) || null : null;

    if (!surface && !energy && !postal) return null;
    return {
      kind: 'dpe',
      title,
      url: location.href,
      siteName: 'LeBonCoin',
      imageUrl: document.querySelector('img[src*="leboncoin"]')?.src || null,
      description: descText?.slice(0, 2000) || null,
      rooms,
      bedrooms,
      postal,
      city,
      surface,
      price,
      energyClass: energy,
      gesClass: ges,
      buildingType: null,
      dateRange,
      isNewBuild,
      source: 'leboncoin-dom',
    };
  }

  function locateAnchor() {
    for (const h2 of document.querySelectorAll('h2')) {
      if (/diagnostic/i.test(h2.textContent || '')) {
        return h2.parentElement || h2;
      }
    }
    const energyRow =
      document.querySelector('[data-qa-id="criteria_item_energy_rate"]') ||
      document.querySelector('[data-qa-id="criteria_item_ges"]');
    if (energyRow && energyRow.parentElement) return energyRow.parentElement;

    const legacy =
      document.querySelector('[data-qa-id="adview_energy_rate"]') ||
      document.querySelector('[data-qa-id="adview_ges"]') ||
      document.querySelector('[data-qa-id="adview_criterias"]') ||
      document.querySelector('[data-testid="energy-rate"]');
    if (legacy) {
      const parent = legacy.parentElement?.parentElement || legacy.parentElement;
      if (parent) return parent;
    }
    return null;
  }

  async function runLookup(payload) {
    STATE.lastPayload = payload;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'LOOKUP', payload });
      if (!response || response.ok !== true) {
        ui.showError(response?.error || 'Erreur inconnue', payload);
        return;
      }
      if (payload.kind === 'land' || response.result?.kind === 'land') {
        ui.showLandResult(payload, response.result, () => openOverride(payload));
      } else {
        ui.showResult(payload, response.result, () => openOverride(payload));
      }
    } catch (err) {
      ui.showError(String(err.message || err), payload);
    }
  }

  function openOverride(payload) {
    try {
      sessionStorage.setItem('chh.override.payload', JSON.stringify(payload));
    } catch {}
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }).catch(() => {});
    alert("Ouvrez l’extension (icône dans la barre) pour modifier les champs et relancer la recherche.");
  }

  function onButtonClick() {
    try {
      const nextData = readNextData();
      const ad = findAd(nextData);
      let payload = ad ? extractFromAd(ad) : null;
      if (!payload || (!payload.surface && !payload.energyClass)) {
        const fallback = extractFromDom();
        if (fallback) payload = { ...(payload || {}), ...fallback };
      }
      if (!payload) {
        ui.showError("Impossible d'extraire les données DPE de cette page.", null);
        return;
      }

      if (payload.kind === 'land') {
        if (!payload.surface || !payload.postal) {
          ui.showError("Impossible d'extraire la surface ou le code postal de ce terrain.", payload);
          return;
        }
        ui.showLoading(payload);
        runLookup(payload);
        return;
      }

      if (!payload.dateRange) {
        ui.showDatePrompt(payload, (updated) => {
          ui.showLoading(updated);
          runLookup(updated);
        });
        return;
      }

      ui.showLoading(payload);
      runLookup(payload);
    } catch (err) {
      ui.showError('Erreur: ' + (err.message || String(err)), null);
    }
  }

  let notionCheckInFlight = false;
  let notionCheckDone = false;
  let currentMatch = null;
  let detailFlowInFlight = false;

  async function startDetailPageFlow() {
    if (detailFlowInFlight) return;
    detailFlowInFlight = true;

    ui.setFloatingContainerLoading('Analyse en cours…');

    let payload = null;
    let attempts = 0;
    while (attempts < 5) {
      const nextData = readNextData();
      const ad = findAd(nextData);
      payload = ad ? extractFromAd(ad) : null;
      if (!payload || (!payload.surface && !payload.energyClass)) {
        const fallback = extractFromDom();
        if (fallback) payload = { ...(payload || {}), ...fallback };
      }
      if (payload && (payload.postal || payload.city || payload.surface || payload.price)) {
        break;
      }
      attempts++;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!payload) {
      payload = { url: location.href, siteName: 'LeBonCoin', title: document.title };
    }

    let notionMatchLocal = null;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHECK_NOTION',
        payload: { ...payload, isDetailPage: true, forceRefresh: true }
      });
      if (response && response.ok && response.result && response.result.active && response.result.match) {
        notionMatchLocal = response.result.match;
        currentMatch = notionMatchLocal;
      }
    } catch (err) {
    }

    let foundAddress = null;
    let foundScore = null;
    let foundDvfPrice = null;
    let foundDvfDate = null;
    let foundCandidates = null;
    let mapsUrl = null;

    if (payload.postal || payload.city || (payload.surface && payload.price)) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'LOOKUP',
          payload: { ...payload, dateRange: payload.dateRange || null }
        });
        if (response && response.ok && response.result && response.result.candidates?.length > 0) {
          const top = response.result.candidates[0];
          if (top.score >= 25) {
            const isLand = payload.kind === 'land' || response.result.kind === 'land';
            let addressStr = isLand
              ? top.parcel.address || top.parcel.street || top.parcel.nom_com || 'Parcelle identifiée'
              : top.record.address || '(adresse inconnue)';
            if (addressStr && addressStr !== '(adresse inconnue)' && addressStr !== 'Parcelle identifiée') {
              mapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addressStr);
              foundAddress = addressStr;
              foundScore = top.score;
              foundCandidates = response.result.candidates;
              if (response.result.dvf?.price) {
                foundDvfPrice = response.result.dvf.price;
                foundDvfDate = response.result.dvf.date;
              }
            }
          }
        }
      } catch (err) {
      }
    }

    if (notionMatchLocal) {
      if (!notionMatchLocal.address && foundAddress) {
        notionMatchLocal.address = foundAddress;
        notionMatchLocal.score = foundScore;
        notionMatchLocal.candidates = foundCandidates;
        notionMatchLocal.isNotionAddress = false;
      }
      if (!notionMatchLocal.dvfPrice && foundDvfPrice) {
        notionMatchLocal.dvfPrice = foundDvfPrice;
        notionMatchLocal.dvfDate = foundDvfDate;
      }
      ui.setFloatingContainerChh(notionMatchLocal, onButtonClick);
    } else {
      payload.address = foundAddress;
      if (foundDvfPrice) {
        payload.dvfPrice = foundDvfPrice;
        payload.dvfDate = foundDvfDate;
      }
      ui.setFloatingContainerAddress({
        address: foundAddress,
        score: foundScore,
        mapsUrl: mapsUrl,
        dvfPrice: foundDvfPrice,
        dvfDate: foundDvfDate,
        candidates: foundCandidates,
        getPayload: () => payload,
        onSaveNotion: () => handleSaveToNotion(payload)
      });
    }

    detailFlowInFlight = false;
  }

  function isAdPage() {
    // Leboncoin detail page pathname pattern
    return /\/ventes_immobilieres\/|\/locations\/|\/vi\//.test(window.location.pathname);
  }

  function findVisibleTitleElement() {
    // 1. Get the screen reader h1 first to read the exact ad title text
    const h1s = document.querySelectorAll('h1');
    let titleText = '';
    let screenReaderH1 = null;
    for (const el of h1s) {
      if (el.textContent && el.textContent.trim().length > 0) {
        screenReaderH1 = el;
        titleText = el.textContent.trim();
        break;
      }
    }

    if (titleText) {
      // 2. Search for a visible element that displays this title text
      const candidates = document.querySelectorAll('p, div, span, h2, h3, h4');
      for (const el of candidates) {
        if (el.textContent?.trim() === titleText) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 1 && rect.height > 1) {
            // Ensure it's not inside a visually hidden container
            let isHidden = false;
            let curr = el;
            while (curr && curr.tagName !== 'BODY') {
              const style = window.getComputedStyle(curr);
              if (style.position === 'absolute' && (style.width === '1px' || style.height === '1px')) {
                isHidden = true;
                break;
              }
              if (style.position === 'fixed' || style.position === 'sticky') {
                isHidden = true;
                break;
              }
              if (style.display === 'none' || style.visibility === 'hidden') {
                isHidden = true;
                break;
              }
              curr = curr.parentElement;
            }
            if (!isHidden) {
              return el;
            }
          }
        }
      }
    }

    return screenReaderH1 || document.querySelector('h1');
  }

  function extractDetailsFromCard(cardEl) {
    const text = (cardEl.innerText || cardEl.textContent || '').trim();
    
    // Extract price (ignoring price per m²)
    let price = null;
    let maxPrice = 0;
    const priceMatches = Array.from(text.matchAll(/(\d[\d \t\u202f\u00a0.]*)\s*€(?!\s*\/\s*m)/gi));
    for (const m of priceMatches) {
      const val = parseInt(m[1].replace(/[ \t\u202f\u00a0.]/g, ''), 10);
      if (val > maxPrice) maxPrice = val;
    }
    if (maxPrice > 0) price = maxPrice;

    // Extract surface
    let surface = null;
    const surfaceM = text.match(/(\d[\d \t\u202f\u00a0.,]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/i);
    if (surfaceM) {
      const parsed = parseFloat(surfaceM[1].replace(',', '.').replace(/[ \t\u202f\u00a0]/g, ''));
      if (!isNaN(parsed) && parsed > 0) surface = Math.round(parsed);
    }

    // Extract postal/city
    let postal = null;
    let city = null;
    const pM = text.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\s*\((\d{5})\)/);
    if (pM) {
      city = pM[1].trim();
      postal = pM[2];
    } else {
      const postM = text.match(/\b(\d{5})\b/);
      if (postM) {
        postal = postM[1];
      }
    }

    return { price, surface, postal, city, cardText: text };
  }



  function findCardContainer(link) {
    let current = link;
    while (current.parentElement) {
      const parent = current.parentElement;
      if (parent.tagName === 'BODY' || parent.tagName === 'HTML') {
        break;
      }
      const allLinks = parent.querySelectorAll('a[href*="/ad/"], a[href*="/vi/"], a[href*="/locations/"], a[href*="/ventes_immobilieres/"]');
      if (allLinks.length > 1) {
        const hrefs = new Set();
        for (const l of allLinks) {
          const href = l.getAttribute('href');
          if (href) {
            hrefs.add(href.split('?')[0].split('#')[0]);
          }
        }
        if (hrefs.size > 1) {
          break;
        }
      }
      current = parent;
    }
    return current;
  }

  async function processListingCards() {
    const links = document.querySelectorAll('a[href*="/ad/"], a[href*="/vi/"], a[href*="/locations/"], a[href*="/ventes_immobilieres/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      // Only process links that look like actual ad detail pages (must contain a numeric ID of at least 5 digits)
      if (!/\d{5,}/.test(href)) {
        continue;
      }

      const cleanHref = href.split('?')[0].split('#')[0];
      if (link.dataset.chhProcessed === cleanHref) continue;
      link.dataset.chhProcessed = cleanHref;

      let cardEl = findCardContainer(link);
      let details = extractDetailsFromCard(cardEl);

      // Safety fallback: if price or surface is missing, climb parent to find the full card container text
      let attempts = 0;
      let current = cardEl;
      while ((!details.price || !details.surface) && current.parentElement && attempts < 3) {
        const parent = current.parentElement;
        if (parent.tagName === 'BODY' || parent.tagName === 'HTML') {
          break;
        }
        // If the parent contains multiple unique ad links, we've climbed out of the card!
        const siblingLinks = parent.querySelectorAll('a[href*="/ad/"], a[href*="/vi/"], a[href*="/locations/"], a[href*="/ventes_immobilieres/"]');
        const uniqueHrefs = new Set();
        for (const l of siblingLinks) {
          const lHref = l.getAttribute('href');
          if (lHref && /\d{5,}/.test(lHref)) {
            uniqueHrefs.add(lHref.split('?')[0].split('#')[0]);
          }
        }
        if (uniqueHrefs.size > 1) {
          break; // Stop climbing, we reached the grid level!
        }

        current = parent;
        const parentDetails = extractDetailsFromCard(current);
        if (parentDetails.price || parentDetails.surface) {
          cardEl = current;
          details = { ...details, ...parentDetails };
        }
        attempts++;
      }

      if (ui.checkAndMarkExcluded(cardEl, (details?.title || "") + " " + (details?.city || ""))) {
        link.dataset.chhProcessed = cleanHref;
        continue;
      }
      
      if ((details.postal && (details.surface || details.price)) || (details.surface && details.price)) {
        try {
          const response = await chrome.runtime.sendMessage({ 
            type: 'CHECK_NOTION', 
            payload: details 
          });
          if (response && response.ok && response.result && response.result.match) {
            ui.markCardAsMatched(cardEl, response.result.match);
          }
        } catch (err) {
          // ignore
        }
      }
    }
  }



  function init() {
    // 1. Vérification universelle des cartes de listings
    processListingCards();
    registerInterval(processListingCards, 2000);

    // 2. Logique spécifique aux pages d'annonce
    if (isAdPage()) {
      startDetailPageFlow();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  ui.onNavigate(() => {
    STATE.lastPayload = null;
    STATE.injectedFor = null;
    notionCheckDone = false;
    notionCheckInFlight = false;
    currentMatch = null;
    detailFlowInFlight = false;
    autoLookupDone = false;
    autoLookupInFlight = false;
    clearAllIntervals();
    ui.removeFloatingContainer();
    ui.closeCard();
    setTimeout(init, 200);
  });
})();
