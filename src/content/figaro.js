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
  const checkingIds = new Set();

  function registerInterval(fn, delay) {
    const id = setInterval(fn, delay);
    STATE.intervals.push(id);
    return id;
  }

  function clearAllIntervals() {
    STATE.intervals.forEach(clearInterval);
    STATE.intervals = [];
  }

  function extractListingId(href) {
    if (!href) return null;
    const match = href.match(/\b\d{6,12}\b/);
    return match ? match[0] : null;
  }

  function isDetailLink(href) {
    if (!href) return false;
    const cleanUrl = href.split('?')[0].split('#')[0];
    if ((cleanUrl.includes('/annonces/') || cleanUrl.includes('/annonce-') || cleanUrl.includes('/annonces-')) && /\b\d{6,12}\b/.test(cleanUrl)) {
      return true;
    }
    return false;
  }

  function isAdPage() {
    const path = window.location.pathname;
    return (path.includes('/annonces/') || path.includes('/annonce-') || path.includes('/annonces-')) && /\b\d{6,12}\b/.test(path);
  }

  // ── 1. Structured Data Extraction (JSON-LD, dataLayer, Scripts) ──────────

  function findPriceInJson(obj) {
    if (!obj || typeof obj !== 'object') return null;

    if (typeof obj.price === 'number' && obj.price > 5000) return obj.price;
    if (typeof obj.price === 'string') {
      const p = parseInt(obj.price.replace(/\D/g, ''), 10);
      if (p > 5000) return p;
    }
    if (obj.offers) {
      if (Array.isArray(obj.offers)) {
        for (const off of obj.offers) {
          const p = findPriceInJson(off);
          if (p) return p;
        }
      } else {
        const p = findPriceInJson(obj.offers);
        if (p) return p;
      }
    }
    return null;
  }

  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      if (!script.textContent) continue;
      try {
        let json = JSON.parse(script.textContent);
        if (!json) continue;
        const items = Array.isArray(json) ? json : [json];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;

          // Check for property / listing / product types
          const typeStr = String(item['@type'] || '').toLowerCase();
          const isRealEstate = /residence|house|apartment|singlefamily|realestate|product|place|listing/i.test(typeStr);

          if (isRealEstate || item.address || item.offers) {
            const price = findPriceInJson(item);
            const address = item.address || {};
            const postal = ex.normalizePostal(address.postalCode);
            const city = address.addressLocality || null;

            const category = item.category || item.accommodationCategory || typeStr;
            const isLand = /terrain|land/i.test(category) || /terrain/i.test(window.location.pathname);

            let surface = null;
            let landSurface = null;
            if (item.floorSize?.value) {
              surface = ex.normalizeSurface(item.floorSize.value);
            } else if (item.livingArea?.value) {
              surface = ex.normalizeSurface(item.livingArea.value);
            }

            if (item.landArea?.value) {
              landSurface = ex.normalizeLandSurface(item.landArea.value);
            }

            if (isLand) {
              return {
                kind: 'land',
                postal,
                city,
                surface: landSurface || ex.normalizeLandSurface(surface),
                price,
                title: document.title || '',
                url: location.href,
                siteName: 'FigaroImmo',
                imageUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
                description: null,
                rooms: null,
                bedrooms: null,
                source: 'figaro-jsonld',
              };
            }

            return {
              kind: 'dpe',
              postal,
              city,
              surface,
              price,
              landSurface,
              buildingType: ex.normalizePropertyType(category),
              title: document.title || '',
              url: location.href,
              siteName: 'FigaroImmo',
              imageUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
              description: null,
              rooms: item.numberOfRooms ? parseInt(String(item.numberOfRooms), 10) || null : null,
              bedrooms: item.numberOfBedrooms ? parseInt(String(item.numberOfBedrooms), 10) || null : null,
              source: 'figaro-jsonld',
            };
          }
        }
      } catch (e) {
        // ignore parse error
      }
    }
    return null;
  }

  function extractFromScriptData() {
    const scripts = document.querySelectorAll('script');
    for (const tag of scripts) {
      const text = tag.textContent || '';
      if (!text) continue;

      // Check dataLayer or custom JS data object
      if (text.includes('dataLayer') || text.includes('__NEXT_DATA__') || text.includes('pageTargeting')) {
        let price = null;
        let postal = null;
        let city = null;
        let surface = null;

        const priceM = text.match(/"prix"\s*:\s*"?(\d+)"?/i) || text.match(/"price"\s*:\s*"?(\d+)"?/i);
        if (priceM) price = parseInt(priceM[1], 10);

        const cpM = text.match(/"code_postal"\s*:\s*"?(\d{5})"?/i) || text.match(/"postal_code"\s*:\s*"?(\d{5})"?/i) || text.match(/"zipCode"\s*:\s*"?(\d{5})"?/i);
        if (cpM) postal = ex.normalizePostal(cpM[1]);

        const cityM = text.match(/"ville"\s*:\s*"([^"]+)"/i) || text.match(/"city"\s*:\s*"([^"]+)"/i);
        if (cityM) city = cityM[1];

        const surfM = text.match(/"surface"\s*:\s*"?(\d+)"?/i);
        if (surfM) surface = ex.normalizeSurface(surfM[1]);

        if (price || postal || surface) {
          const isLand = /terrain/i.test(text) || /terrain/i.test(window.location.pathname);
          return {
            kind: isLand ? 'land' : 'dpe',
            postal,
            city,
            surface: isLand ? null : surface,
            landSurface: isLand ? ex.normalizeLandSurface(surface) : null,
            price,
            source: 'figaro-script',
          };
        }
      }
    }
    return null;
  }

  function tryExtract() {
    const jsonLd = extractFromJsonLd();
    if (jsonLd && (jsonLd.postal || jsonLd.city) && (jsonLd.surface || jsonLd.price)) {
      return jsonLd;
    }

    const scriptData = extractFromScriptData();
    if (scriptData && (scriptData.postal || scriptData.city) && (scriptData.surface || scriptData.price)) {
      return { ...(jsonLd || {}), ...scriptData };
    }

    return jsonLd || scriptData || null;
  }

  // ── 2. DOM Fallback Extraction ──────────────────────────────────────────

  function extractFromDom() {
    const title = document.title || '';
    const metaDesc =
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      '';
    const sources = [title, metaDesc, document.body.innerText || ''];

    let postal = null;
    let city = null;

    for (const text of sources) {
      const m = text.match(/\b(\d{5})\b/);
      if (m) {
        postal = m[1];
        break;
      }
    }

    for (const text of sources) {
      const m = text.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\s*\((\d{5})\)/) ||
                text.match(/\b\d{5}\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})/);
      if (m) {
        if (m[2] && /^\d{5}$/.test(m[2])) {
          city = m[1].trim();
          postal = postal || m[2];
        } else if (m[1] && /[A-Za-z]/.test(m[1])) {
          city = m[1].trim();
        }
        break;
      }
    }

    const bodyText = document.body.innerText || '';

    const isLand =
      /\bterrain[s]?\b/i.test(title) ||
      /\/terrain/i.test(location.pathname) ||
      /\bterrain[s]?\b/i.test(metaDesc);

    let price = null;
    const priceM = bodyText.match(/(\d[\d \t\u202f\u00a0]*)\s*€/);
    if (priceM) {
      price = parseInt(priceM[1].replace(/[ \t\u202f\u00a0]/g, ''), 10);
    }

    if (isLand) {
      let landSurface = null;
      const surfM = bodyText.match(/(\d[\d \t\u202f\u00a0]*)\s*(?:m²|m2)/i);
      if (surfM) {
        landSurface = ex.normalizeLandSurface(surfM[1]);
      }
      const section = ex.normalizeSection(bodyText);
      return {
        kind: 'land',
        postal,
        city,
        surface: landSurface,
        price,
        section,
        source: 'figaro-dom',
      };
    }

    let surface = null;
    const surfM = bodyText.match(/(\d[\d \t\u202f\u00a0]*)\s*(?:m²|m2)/i);
    if (surfM) {
      surface = ex.normalizeSurface(surfM[1]);
    }

    let energyClass = null;
    let gesClass = null;

    const dpeM = bodyText.match(/(?:DPE|Classe énergétique|Classe énergie)\s*:?\s*([A-G])\b/i);
    if (dpeM) {
      energyClass = ex.normalizeClass(dpeM[1]);
    }

    const gesM = bodyText.match(/(?:GES|Classe climat)\s*:?\s*([A-G])\b/i);
    if (gesM) {
      gesClass = ex.normalizeClass(gesM[1]);
    }

    let buildingType = null;
    if (/\bmaison\b|\bhouse\b|\bvilla\b/i.test(title) || /\bmaison\b|\bhouse\b|\bvilla\b/i.test(metaDesc)) {
      buildingType = 'maison';
    } else if (/\bappartement\b|\bappart\b|\bflat\b/i.test(title) || /\bappartement\b|\bappart\b|\bflat\b/i.test(metaDesc)) {
      buildingType = 'appartement';
    }

    const dateParsed = ex.extractDateFromText(bodyText);
    const dateRange = ex.parseDateRange(dateParsed);

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
      title: document.title || '',
      url: location.href,
      siteName: 'FigaroImmo',
      imageUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
      description: (document.querySelector('meta[name="description"]')?.getAttribute('content') || '').slice(0, 2000) || null,
      rooms: null,
      bedrooms: null,
      source: 'figaro-dom',
    };
  }

  // ── 3. Search Result Listing Cards Processing ───────────────────────────

  function findCardContainer(linkEl) {
    let current = linkEl;
    while (current.parentElement) {
      const parent = current.parentElement;
      if (parent.tagName === 'BODY' || parent.tagName === 'HTML') {
        break;
      }

      if (parent.getAttribute('data-testid') === 'map-card-testid' ||
          parent.getAttribute('data-testid') === 'map-card' ||
          parent.classList.contains('leaflet-popup') ||
          parent.classList.contains('leaflet-popup-content-wrapper') ||
          parent.classList.contains('mapboxgl-popup') ||
          parent.classList.contains('mapboxgl-popup-content') ||
          parent.classList.contains('gm-style-iw') ||
          parent.classList.contains('gm-style-iw-c') ||
          /popup/i.test(parent.className || '')) {
        current = parent;
        break;
      }

      const siblings = parent.querySelectorAll('a, [data-href], [data-url], [data-id]');
      const uniqueIds = new Set();
      for (const el of siblings) {
        const val = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-id') || '';
        const elId = extractListingId(val);
        if (elId) {
          uniqueIds.add(elId);
        }
      }
      if (uniqueIds.size > 1) {
        break;
      }
      current = parent;
    }
    return current;
  }

  function extractDetailsFromCard(cardEl, href = '') {
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
    const surfaceM = text.match(/(\d[\d \t\u202f\u00a0.]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/i);
    if (surfaceM) {
      const parsedSurf = parseFloat(surfaceM[1].replace(',', '.').replace(/[ \t\u202f\u00a0]/g, ''));
      if (!isNaN(parsedSurf) && parsedSurf > 0) {
        surface = Math.round(parsedSurf);
      }
    }

    // Extract postal & city from text
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

    // Fallback: try to extract city or postal from href URL slug
    if ((!city || !postal) && href) {
      const urlMatch = href.match(/\/(?:annonces|annonce-)\/([^\/]+)\/(\d{6,12})/i);
      if (urlMatch) {
        const slug = urlMatch[1];
        const parts = slug.split('-');

        // Check if any part is a 5-digit postal code
        for (const p of parts) {
          if (!postal && /^\d{5}$/.test(p)) {
            postal = p;
          }
        }

        // Filter out non-city terms from slug
        const NOISE_TERMS = new Set([
          'appartement', 'maison', 'terrain', 'propriete', 'villa', 'loft', 'duplex',
          'chateau', 'manoir', 'immeuble', 'hotel-particulier', 'bureau', 'commerce',
          'france', 'dom-tom', 'herault', 'var', 'alpes-maritimes', 'bouches-du-rhone',
          'rhone', 'gironde', 'haute-garonne', 'loire-atlantique', 'nord',
          'languedoc-roussillon', 'provence-alpes-cote-d-azur', 'ile-de-france',
          'auvergne-rhone-alpes', 'nouvelle-aquitaine', 'occitanie'
        ]);

        const cityParts = parts.filter(p => !/^\d+$/.test(p) && !/^\d+(?:er|eme)$/i.test(p) && !NOISE_TERMS.has(p.toLowerCase()));
        if (!city && cityParts.length > 0) {
          city = cityParts.join(' ').trim();
        }
      }
    }

    return { price, surface, postal, city, cardText: text };
  }

  function findImageContainer(cardEl, linkEl) {
    if (!cardEl) return null;

    if (linkEl) {
      if (linkEl.querySelector('img, picture') || /photo|image|visuel|media|thumb/i.test(linkEl.className || '')) {
        return linkEl;
      }
      const linkImg = linkEl.closest('[class*="photo" i], [class*="visuel" i], [class*="media" i], [class*="slider" i], [class*="image" i], picture, figure');
      if (linkImg) return linkImg;
    }

    const imgWrapper = cardEl.querySelector('[class*="photo" i], [class*="visuel" i], [class*="media" i], [class*="slider" i], [class*="carousel" i], [class*="image" i], picture, figure');
    if (imgWrapper && !imgWrapper.querySelector('h1, h2, h3, [class*="title" i], [class*="titre" i]')) {
      return imgWrapper;
    }

    const img = cardEl.querySelector('img');
    if (img) {
      const parent = img.closest('a, div, figure, picture');
      if (parent && parent !== cardEl && !parent.querySelector('h1, h2, h3, [class*="title" i], [class*="titre" i]')) {
        return parent;
      }
      return img.parentElement || cardEl;
    }

    return cardEl;
  }

  async function processListingCards() {
    const elements = document.querySelectorAll('a, [data-href], [data-url], [data-id]');
    for (const el of elements) {
      const val = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-id') || '';
      if (!isDetailLink(val)) continue;

      const cleanVal = val.split('?')[0].split('#')[0];
      if (el.dataset.chhProcessed === cleanVal) continue;

      const id = extractListingId(val);
      if (!id) continue;

      if (checkingIds.has(id)) continue;

      let cardEl = findCardContainer(el);
      if (!cardEl) continue;

      if (cardEl.querySelector('.chh-card-chh-badge')) {
        el.dataset.chhProcessed = cleanVal;
        continue;
      }

      let details = extractDetailsFromCard(cardEl, val);

      let attempts = 0;
      let current = cardEl;
      while ((!details.price || !details.surface) && current.parentElement && attempts < 3) {
        const parent = current.parentElement;
        if (parent.tagName === 'BODY' || parent.tagName === 'HTML') break;

        const siblingLinks = parent.querySelectorAll('a, [data-href], [data-url], [data-id]');
        const uniqueIds = new Set();
        for (const sibling of siblingLinks) {
          const siblingVal = sibling.getAttribute('href') || sibling.getAttribute('data-href') || sibling.getAttribute('data-url') || sibling.getAttribute('data-id') || '';
          const siblingId = extractListingId(siblingVal);
          if (siblingId) uniqueIds.add(siblingId);
        }
        if (uniqueIds.size > 1) break;

        current = parent;
        const parentDetails = extractDetailsFromCard(current, val);
        if (parentDetails.price || parentDetails.surface) {
          cardEl = current;
          details = { ...details, ...parentDetails };
        }
        attempts++;
      }

      if (ui.checkAndMarkExcluded(cardEl, (details?.title || "") + " " + (details?.city || ""))) {
        el.dataset.chhProcessed = cleanVal;
        continue;
      }

      const hasEnoughData = (details.postal && (details.surface || details.price)) || (details.surface && details.price) || (details.city && details.price);
      if (!hasEnoughData) continue;

      el.dataset.chhProcessed = cleanVal;
      checkingIds.add(id);

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'CHECK_NOTION',
          payload: details,
        });
        if (response && response.ok && response.result && response.result.match) {
          const targetEl = findImageContainer(cardEl, el);
          ui.markCardAsMatched(targetEl, response.result.match, true);
          cardEl.style.setProperty('opacity', '0.5', 'important');
          cardEl.style.transition = 'opacity 0.25s ease';
        }
      } catch (err) {
      } finally {
        checkingIds.delete(id);
      }
    }
  }

  // ── 4. Main Overlay/Lookup Orchestration ─────────────────────────────────

  function runAutoLookup(payload) {
    if (autoLookupDone || autoLookupInFlight) return;
    autoLookupInFlight = true;

    ui.setFloatingContainerLoading('Recherche d\'adresse…');

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
                getPayload: () => payload,
              });
              return;
            }
          }
        }
      }
      ui.setFloatingContainerAddress({ address: null, getPayload: () => payload });
    });
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
        payload: { ...payload, isDetailPage: true },
      });
      if (response && response.ok && response.result) {
        if (response.result.active && response.result.match) {
          notionMatch = response.result.match;
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
      payload = { url: location.href, siteName: 'FigaroImmo', title: document.title };
    }

    let notionMatchLocal = null;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHECK_NOTION',
        payload: { ...payload, isDetailPage: true, forceRefresh: true }
      });
      if (response && response.ok && response.result && response.result.active && response.result.match) {
        notionMatchLocal = response.result.match;
        notionMatch = notionMatchLocal;
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

  ui.onNavigate(() => {
    STATE.injectedFor = null;
    notionCheckDone = false;
    notionCheckInFlight = false;
    notionMatch = null;
    autoLookupDone = false;
    autoLookupInFlight = false;
    checkingIds.clear();
    clearAllIntervals();
    ui.removeFloatingContainer();
    ui.closeCard();
    setTimeout(init, 200);
  });
})();
