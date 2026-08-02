(function () {
  'use strict';

  const ex = window.__chhExtract;
  const ui = window.__chhOverlay;
  const STATE = { 
    injectedFor: null,
    intervals: []
  };

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

  // ── 1. Structured Data Extraction from Scripts ──────────────────────────

  function getTargetingData() {
    for (const tag of document.querySelectorAll('script')) {
      const text = tag.textContent || '';
      const m = text.match(/"pageTargeting"\s*:\s*(\{[\s\S]*?\})/);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch {}
      }
    }
    return null;
  }

  function getDataLayerData() {
    for (const tag of document.querySelectorAll('script')) {
      const text = tag.textContent || '';
      const m = text.match(/dataLayer\s*=\s*(\[[\s\S]*?\])/);
      if (m) {
        try {
          const jsonText = m[1].replace(/'/g, '"');
          const data = JSON.parse(jsonText);
          if (data && data[0]) return data[0];
        } catch {}
      }
    }
    return null;
  }

  // ── 2. Payload Extraction (tryExtract / extractFromDom) ─────────────────

  function tryExtract() {
    const pt = getTargetingData();
    const dl = getDataLayerData();

    if (!pt && !dl) return null;

    // Price
    let price = null;
    const priceRaw = pt?.prixmax ?? dl?.gtm_var_prix;
    if (priceRaw) {
      price = parseInt(String(priceRaw).replace(/\D/g, ''), 10);
    }

    // Zip/Postal Code
    const postal = ex.normalizePostal(pt?.CP);

    // City
    const city = dl?.gtm_lib_ville || null;

    // Type of listing (DPE vs Land)
    const isLand = pt?.typebien?.startsWith('TER') || dl?.gtm_lib_rub === 'terrain' || /\/terrain/i.test(window.location.pathname);

    // Surface Area
    const surfaceRaw = pt?.surfmax;
    let surface = null;
    let landSurface = null;

    if (isLand) {
      landSurface = ex.normalizeLandSurface(surfaceRaw);
    } else {
      surface = ex.normalizeSurface(surfaceRaw);
    }

    // Energy / DPE Class
    const energyClass = ex.normalizeClass(pt?.DPE);

    // GES Class
    let gesClass = null;
    const gesEl = document.querySelector('.DPE_effSerreNote');
    if (gesEl) {
      const classStr = gesEl.className || '';
      const mGes = classStr.match(/NoteGES(?:2022)?_([A-G])/i);
      if (mGes) {
        gesClass = ex.normalizeClass(mGes[1]);
      } else {
        gesClass = ex.normalizeClass(gesEl.textContent);
      }
    }

    // Building Type (Maison vs Appartement)
    let buildingType = null;
    const rawType = pt?.typebien || dl?.gtm_lib_rub || '';
    if (rawType.startsWith('APP') || rawType.includes('appartement')) {
      buildingType = 'appartement';
    } else if (rawType.startsWith('MAI') || rawType.includes('maison')) {
      buildingType = 'maison';
    }

    // Description & date range
    const descEl = document.getElementById('txtAnnonceTrunc');
    const descText = descEl?.innerText || descEl?.textContent || '';
    const dateParsed = ex.extractDateFromText(descText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = /neuf|vefa/i.test(descText || document.title || '');

    // Rooms / Bedrooms from DOM
    const roomsEl = document.querySelector('#nbpieces');
    const rooms = roomsEl ? parseInt(roomsEl.value || roomsEl.textContent, 10) || null : null;
    const bedroomsEl = document.querySelector('#nbchambres');
    const bedrooms = bedroomsEl ? parseInt(bedroomsEl.value || bedroomsEl.textContent, 10) || null : null;

    if (isLand) {
      return {
        kind: 'land',
        postal,
        city,
        surface: landSurface,
        price,
        title: document.title || '',
        url: location.href,
        siteName: 'ParuVendu',
        imageUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
        description: (descText || '').slice(0, 2000) || null,
        rooms,
        bedrooms,
        section: ex.normalizeSection(descText),
        source: 'paruvendu-json',
      };
    }

    return {
      kind: 'dpe',
      postal,
      city,
      surface,
      landSurface: null,
      price,
      energyClass,
      gesClass,
      buildingType,
      dateRange,
      isNewBuild,
      title: document.title || '',
      url: location.href,
      siteName: 'ParuVendu',
      imageUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
      description: (descText || '').slice(0, 2000) || null,
      rooms,
      bedrooms,
      source: 'paruvendu-json',
    };
  }

  function extractFromDom() {
    const h1Text = document.querySelector('h1')?.textContent || '';
    const descEl = document.getElementById('txtAnnonceTrunc');
    const descText = descEl?.innerText || descEl?.textContent || '';
    const titleText = document.title || '';

    // Price from DOM
    let price = null;
    const priceInput = document.querySelector('#pxbien');
    if (priceInput && priceInput.value) {
      price = parseInt(priceInput.value, 10);
    } else {
      const priceBox = document.querySelector('#autoprix');
      if (priceBox) {
        const priceM = priceBox.innerText.match(/(\d[\d \t\u202f\u00a0]*)/);
        if (priceM) {
          price = parseInt(priceM[1].replace(/[ \t\u202f\u00a0]/g, ''), 10);
        }
      }
    }

    // Postal & City
    let postal = null;
    let city = null;
    const locEl = document.querySelector('#detail_loc') || document.querySelector('#localisation_bar_header');
    const locText = locEl?.textContent || '';
    
    for (const src of [locText, h1Text, titleText, descText]) {
      const mBefore = src.match(/\b(\d{5})\b/);
      if (mBefore) {
        postal = mBefore[1];
        break;
      }
    }

    const cityMatch = h1Text.match(/(?:vente|location)\s+(?:appartement|maison|terrain)\s+(?:[\d\s]+m(?:\u00b2|2)\s+)?([A-Za-z\u00c0-\u00ff][A-Za-z\u00c0-\u00ff\-' ]+)/i);
    if (cityMatch) {
      city = cityMatch[1].trim();
    }

    // Land detection
    const isLand = /\bterrain[s]?\b/i.test(h1Text + ' ' + titleText) || /\/terrain/i.test(window.location.pathname);

    // Surfaces
    let surface = null;
    let landSurface = null;
    
    const h1SurfM = h1Text.match(/(\d[\d \t\u202f\u00a0]*)\s*m(?:\u00b2|2)(?!\d)/i);
    if (h1SurfM) {
      const surfVal = parseFloat(h1SurfM[1].replace(/[ \t\u202f\u00a0]/g, ''));
      if (isLand) {
        landSurface = ex.normalizeLandSurface(surfVal);
      } else {
        surface = ex.normalizeSurface(surfVal);
      }
    }

    // Energy / GES Class
    let energyClass = null;
    const dpeEl = document.querySelector('.DPE_consEnerNote') || document.querySelector('.DPE_noteglobale .NoteActive');
    if (dpeEl) {
      energyClass = ex.normalizeClass(dpeEl.textContent);
    }

    let gesClass = null;
    const gesEl = document.querySelector('.DPE_effSerreNote');
    if (gesEl) {
      const classStr = gesEl.className || '';
      const mGes = classStr.match(/NoteGES(?:2022)?_([A-G])/i);
      if (mGes) {
        gesClass = ex.normalizeClass(mGes[1]);
      } else {
        gesClass = ex.normalizeClass(gesEl.textContent);
      }
    }

    // Building Type
    let buildingType = null;
    if (/\bmaison\b/i.test(h1Text + ' ' + titleText)) {
      buildingType = 'maison';
    } else if (/\bappart/i.test(h1Text + ' ' + titleText)) {
      buildingType = 'appartement';
    }

    const dateParsed = ex.extractDateFromText(descText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = /neuf|vefa/i.test(descText || titleText || '');

    if (isLand) {
      return {
        kind: 'land',
        postal,
        city,
        surface: landSurface,
        price,
        title: document.title || '',
        url: location.href,
        siteName: 'ParuVendu',
        imageUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
        description: (descText || '').slice(0, 2000) || null,
        rooms: null,
        bedrooms: null,
        section: ex.normalizeSection(descText),
        source: 'paruvendu-dom',
      };
    }

    return {
      kind: 'dpe',
      postal,
      city,
      surface,
      landSurface: null,
      price,
      energyClass,
      gesClass,
      buildingType,
      dateRange,
      isNewBuild,
      title: document.title || '',
      url: location.href,
      siteName: 'ParuVendu',
      imageUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
      description: (descText || '').slice(0, 2000) || null,
      rooms: null,
      bedrooms: null,
      source: 'paruvendu-dom',
    };
  }

  // ── 3. Search Results Listings Card Check ───────────────────────────────

  function extractDetailsFromCard(cardEl) {
    // Replace "m 2" or "m ²" space sequences so standard surface regex matches it
    const text = (cardEl.innerText || cardEl.textContent || '')
      .replace(/m\s*([²2])/gi, 'm2');

    // Extract price
    let price = null;
    const priceM = text.match(/(\d[\d \t\u202f\u00a0]*)\s*€/);
    if (priceM) {
      price = parseInt(priceM[1].replace(/[ \t\u202f\u00a0]/g, ''), 10);
    }

    // Extract surface
    let surface = null;
    const surfaceM = text.match(/(\d[\d \t\u202f\u00a0]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/i);
    if (surfaceM) {
      surface = parseFloat(surfaceM[1].replace(/[ \t\u202f\u00a0]/g, ''));
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

    // Fallback city from location words like "Paris 18"
    if (!city) {
      const cityM = text.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,30}\s+\d{1,2})\b/);
      if (cityM) {
        city = cityM[1].trim();
      }
    }

    return { price, surface, postal, city, cardText: text };
  }

  function findCardContainer(link) {
    return link.closest('.blocAnnonce') || link.closest('div') || link.parentElement;
  }

  async function processListingCards() {
    const links = document.querySelectorAll('a[href*="/immobilier/vente/"], a[href*="/immobilier/location/"]');
    for (const link of links) {
      const val = link.getAttribute('href');
      if (!val) continue;

      // Only check actual detail page URLs, which have a long sequence of digits at the end
      if (!val.match(/\d{5,}/)) continue;

      const cleanVal = val.split('?')[0].split('#')[0];
      if (link.dataset.chhProcessed === cleanVal) continue;

      let cardEl = findCardContainer(link);
      if (!cardEl) continue;

      if (cardEl.querySelector('.chh-card-chh-badge')) {
        link.dataset.chhProcessed = cleanVal;
        continue;
      }

      let details = extractDetailsFromCard(cardEl);

      // Safety fallback: if details are incomplete, climb up
      let attempts = 0;
      let current = cardEl;
      while ((!details.price || !details.surface) && current.parentElement && attempts < 3) {
        current = current.parentElement;
        if (current.tagName === 'BODY' || current.tagName === 'HTML') {
          break;
        }
        const parentDetails = extractDetailsFromCard(current);
        if (parentDetails.price || parentDetails.surface) {
          cardEl = current;
          details = { ...details, ...parentDetails };
        }
        attempts++;
      }

      if (ui.checkAndMarkExcluded(cardEl, (details?.title || "") + " " + (details?.city || ""))) {
        link.dataset.chhProcessed = cleanVal;
        continue;
      }

      if ((details.postal && (details.surface || details.price)) || (details.surface && details.price)) {
        link.dataset.chhProcessed = cleanVal;
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

  // ── 4. Main Overlay/Lookup Orchestration ─────────────────────────────────

  let autoLookupDone = false;
  let autoLookupInFlight = false;

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

  let notionCheckInFlight = false;
  let notionCheckDone = false;
  let currentMatch = null;

  function isAdPage() {
    return /\/immobilier\/(?:vente|location)\/[a-z0-9\-]+\/\d{5,}/i.test(window.location.pathname);
  }

  async function checkNotionStatus(payload) {
    if (notionCheckInFlight || notionCheckDone) return;
    if (!payload || (!payload.postal && !payload.city) || (!payload.surface && !payload.price)) {
      notionCheckDone = true;
      return;
    }

    notionCheckInFlight = true;
    try {
      const response = await chrome.runtime.sendMessage({ 
        type: 'CHECK_NOTION', 
        payload: { ...payload, isDetailPage: true } 
      });
      if (response && response.ok && response.result) {
        if (response.result.active && response.result.match) {
          currentMatch = response.result.match;
          ui.setFloatingContainerChh(response.result.match);
        }
      }
    } catch (err) {
      // ignore
    } finally {
      notionCheckInFlight = false;
      notionCheckDone = true;
    }
  }

  let detailFlowInFlight = false;

  async function startDetailPageFlow() {
    if (detailFlowInFlight) return;
    detailFlowInFlight = true;

    ui.setFloatingContainerLoading('Analyse en cours…');

    let payload = null;
    let attempts = 0;
    while (attempts < 5) {
      payload = tryExtract();
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
      payload = { url: location.href, siteName: 'ParuVendu', title: document.title };
    }

    ui.setFloatingContainerAddress({
      address: null,
      getPayload: () => payload
    });

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
      ui.setFloatingContainerChh(notionMatchLocal);
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
        getPayload: () => payload
      });
    }

    detailFlowInFlight = false;
  }

  function init() {
    processListingCards();
    registerInterval(processListingCards, 2000);

    if (isAdPage()) {
      startDetailPageFlow();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Handle SPA-like or normal resets
  ui.onNavigate(() => {
    STATE.injectedFor = null;
    notionCheckDone = false;
    notionCheckInFlight = false;
    currentMatch = null;
    autoLookupDone = false;
    autoLookupInFlight = false;
    clearAllIntervals();
    ui.removeFloatingContainer();
    ui.closeCard();
    setTimeout(init, 300);
  });
})();
