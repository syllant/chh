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

  const checkingIds = new Set();
  let notionMatch = null;
  let notionCheckInFlight = false;
  let notionCheckDone = false;
  let autoLookupDone = false;
  let autoLookupInFlight = false;

  function isAdPage() {
    return /\/(?:annonce|realEstateAd)\//i.test(location.href);
  }

  function isDetailLink(href) {
    if (!href) return false;
    return /\/(?:annonce|realEstateAd)\//i.test(href);
  }

  function extractListingId(val) {
    if (!val) return null;
    const cleanVal = val.split('?')[0].split('#')[0];
    const m = cleanVal.match(/\/(?:annonce|realEstateAd)\/(?:[^\/]+\/)*([^\/]+)$/i) || cleanVal.match(/\/(?:annonce|realEstateAd)\/(.+)$/i);
    if (m) return m[1];
    return cleanVal;
  }

  // ── 1. Structured Data / State Extraction ────────────────────────────────

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
          const isRealEstate = /residence|house|apartment|singlefamily|realestate|product|place|listing/i.test(typeStr);
          if (isRealEstate || item.address || item.offers) {
            let price = null;
            if (typeof item.price === 'number') price = item.price;
            else if (item.offers) {
              const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
              if (offer && offer.price) price = parseInt(String(offer.price).replace(/\D/g, ''), 10);
            }
            const address = item.address || {};
            const postal = ex.normalizePostal(address.postalCode);
            const city = address.addressLocality || null;
            const isLand = /terrain|land/i.test(typeStr) || /terrain/i.test(window.location.pathname);
            let surface = null;
            if (item.floorSize?.value) surface = ex.normalizeSurface(item.floorSize.value);
            else if (item.livingArea?.value) surface = ex.normalizeSurface(item.livingArea.value);

            if (isLand) {
              return {
                kind: 'land',
                postal,
                city,
                surface: ex.normalizeLandSurface(surface || item.landArea?.value),
                price,
                source: 'bienici-jsonld',
              };
            }
            return {
              kind: 'dpe',
              postal,
              city,
              surface,
              price,
              buildingType: ex.normalizePropertyType(typeStr),
              source: 'bienici-jsonld',
            };
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function readInitialState() {
    // Try multiple known BienIci global state variable names
    const candidates = [
      '__INITIAL_STATE__', 'REDUX_STATE', '__SERVER_DATA__', '__BIENICI__',
      '__APP_STATE__', 'appState', '__STORE__', '__DATA__', '__PROPS__'
    ];
    for (const varName of candidates) {
      const val = window[varName];
      if (val && typeof val === 'object') return val;
    }

    // Try regex scanning of inline scripts for any of those variable assignments
    for (const tag of document.querySelectorAll('script:not([src])')) {
      const t = tag.textContent || '';
      if (!t) continue;
      for (const varName of candidates) {
        const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = t.match(new RegExp(`(?:window\.)?${escaped}\\s*=\\s*(\\{[\\s\\S]{10,}\\})\\s*;`));
        if (m) {
          try {
            const parsed = JSON.parse(m[1]);
            if (parsed && typeof parsed === 'object') return parsed;
          } catch {}
        }
      }
    }

    if (typeof window.realEstateAd === 'object' && window.realEstateAd) return { realEstateAd: window.realEstateAd };
    return null;
  }

  function findAd(state, listingId) {
    if (!state) return null;
    if (state.realEstateAd && typeof state.realEstateAd === 'object') return state.realEstateAd;

    if (listingId) {
      const matchById = ex.deepFind(
        state,
        (n) =>
          n &&
          typeof n === 'object' &&
          ('surfaceArea' in n || 'price' in n || 'postalCode' in n) &&
          (n.id === listingId || n.reference === listingId || (n.id && String(n.id).includes(listingId)) || (n.reference && String(n.reference).includes(listingId)))
      );
      if (matchById) return matchById;
    }

    return ex.deepFind(
      state,
      (n) =>
        n &&
        typeof n === 'object' &&
        ('energyClassification' in n || 'greenhouseGasEmission' in n || 'surfaceArea' in n) &&
        ('postalCode' in n || 'city' in n)
    );
  }

  function extractPriceFromAd(ad) {
    if (!ad) return null;
    let raw = ad.price ?? ad.priceAmount ?? ad.priceWithFees ?? ad.priceRaw ?? ad.displayPrice;
    if (raw && typeof raw === 'object') {
      raw = raw.amount ?? raw.price ?? raw.value ?? raw.priceWithFees ?? raw.priceAmount;
    }
    if (!raw && typeof ad.priceCents === 'number') {
      raw = Math.round(ad.priceCents / 100);
    }
    if (raw) {
      const p = parseInt(String(raw).replace(/\D/g, ''), 10);
      if (isFinite(p) && p > 1000) return p;
    }
    return null;
  }

  function extractFromAd(ad) {
    if (!ad) return null;
    const postal = ex.normalizePostal(ad.postalCode);
    const city = ad.city || null;
    const text = [ad.title, ad.description, ad.descriptive].filter(Boolean).join('\n');

    const price = extractPriceFromAd(ad);

    const rawType = ad.propertyType || ad.adType || '';
    const kindFromType = /terrain|land/i.test(String(rawType));
    const kindFromTitle = /terrain/i.test(ad.title || '');
    const onlyLandSurface = ad.landSurface != null && (ad.livingArea == null && ad.surfaceArea == null);
    const isLand = kindFromType || kindFromTitle || onlyLandSurface;

    if (isLand) {
      const surface = ex.normalizeLandSurface(ad.landSurface ?? ad.surfaceArea ?? ad.surface);
      const section = ex.normalizeSection(text);
      return {
        kind: 'land',
        postal,
        city,
        surface,
        price,
        section,
        source: 'bienici-state',
      };
    }

    const surface = ex.normalizeSurface(ad.surfaceArea ?? ad.surface ?? ad.livingArea);
    const energy = ex.normalizeClass(ad.energyClassification ?? ad.energyValue);
    const ges = ex.normalizeClass(
      ad.greenhouseGazClassification ??
      ad.greenhouseGazValueClassification ??
      ad.greenhouseGasEmissionValueClassification ??
      ad.greenhouseGasEmissionClassification ??
      ad.greenhouseGazValue
    );
    const buildingType = ex.normalizePropertyType(rawType);
    
    let dateRange = null;
    if (ad.energyPerformanceDiagnosticDate) {
      const parsedDate = ex.parseUserDate(ad.energyPerformanceDiagnosticDate);
      dateRange = ex.parseDateRange(parsedDate);
    }
    if (!dateRange) {
      const dateParsed = ex.extractDateFromText(text);
      dateRange = ex.parseDateRange(dateParsed);
    }

    const isNewBuild = ad.isNewProperty === true || /neuf|vefa/i.test(text || '');

    const title = ad.title || ad.subject || document.querySelector('h1')?.textContent || document.title || '';
    const imageUrl = (ad.photos && ad.photos[0]) ? (ad.photos[0].url_medium || ad.photos[0].url) : (document.querySelector('img[src*="photos"], img[src*="bienici"]')?.src || null);
    const rooms = ad.roomsQuantity ?? ad.roomsCount ?? ad.rooms ?? null;
    const bedrooms = ad.bedroomsQuantity ?? ad.bedroomsCount ?? ad.bedrooms ?? null;
    const description = ad.description || ad.descriptive || document.querySelector('.fullAdDescription, [class*="description"]')?.innerText || null;
    const url = location.href;
    const siteName = 'BienIci';

    const landSurface = ex.normalizeLandSurface(ad.landSurface);
    return {
      kind: 'dpe',
      title,
      url,
      siteName,
      imageUrl,
      rooms,
      bedrooms,
      description,
      postal,
      city,
      surface,
      landSurface,
      price,
      energyClass: energy,
      gesClass: ges,
      buildingType,
      dateRange,
      isNewBuild,
      source: 'bienici-state',
    };
  }

  // ── 2. DOM Extraction ────────────────────────────────────────────────────

  function extractFromDom() {
    const energyEl = document.querySelector(
      '.energy-diagnostic__letter--active, .dpe-bar__letter--active, [class*="energyClassification"][class*="active"], [class*="energyDiagnostic"] .active, [data-testid*="dpe"]'
    );
    const gesEl = document.querySelector(
      '.ges-diagnostic__letter--active, .ges-bar__letter--active, [class*="greenhouseGasEmission"][class*="active"], [class*="gesDiagnostic"] .active, [data-testid*="ges"]'
    );
    const surfaceEl =
      document.querySelector('[class*="surfaceArea"]') ||
      document.querySelector('.fullAdSummary__data--surfaceArea');
    const postalEl = document.querySelector('[class*="postalCode"], .fullAdHeader__address');
    const descEl = document.querySelector('.fullAdDescription, .ad-description, [class*="description"]');

    let energy = ex.normalizeClass(energyEl?.textContent);
    let ges = ex.normalizeClass(gesEl?.textContent);
    let surface = ex.normalizeSurface(surfaceEl?.textContent);
    let postal = null;
    let city = null;
    if (postalEl?.textContent) {
      const m = postalEl.textContent.match(/\b(\d{5})\b/);
      if (m) postal = m[1];
      const cm = postalEl.textContent.replace(/\d{5}/, '').trim();
      if (cm) city = cm;
    }

    const pageTitle =
      document.querySelector('h1, [class*="adTitle"], [class*="ad-title"]')?.textContent ||
      document.title ||
      '';
    const docText = document.documentElement.textContent || '';
    const bodyTextEarly = document.body.innerText || '';
    const metaDesc =
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      '';

    // Extract Price
    // IMPORTANT: do NOT fall back to full body text — it contains prices from "Ces annonces
    // pourraient vous intéresser" sections, which would pick up wrong (higher/lower) prices.
    // Use the dedicated price element, or fall back to document.title + og:title + meta description.
    let price = null;
    let maxPrice = 0;
    const priceEl = document.querySelector('.priceComponent__price, .fullAdSummary__price, [class*="priceComponent"], [class*="fullAdSummary__price"]');
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
    const priceText = priceEl?.textContent || (pageTitle + ' ' + document.title + ' ' + ogTitle + ' ' + metaDesc);
    const priceMatches = Array.from(priceText.matchAll(/(\d[\d \t\u202f\u00a0\.]*) *€/g));
    for (const m of priceMatches) {
      const val = parseInt(m[1].replace(/[\. \t\u202f\u00a0]/g, ''), 10);
      if (isFinite(val) && val > maxPrice) maxPrice = val;
    }
    if (maxPrice > 0) price = maxPrice;

    if (!surface) {
      const sources = [pageTitle, docText, bodyTextEarly, metaDesc];
      for (const src of sources) {
        const m = src.match(/(\d{1,4})\s*m(?:²|2)(?!\w)/i);
        if (m) {
          surface = ex.normalizeSurface(m[1]);
          if (surface) break;
        }
      }
    }

    if (!postal) {
      const decodedUrl = decodeURIComponent(location.href);
      const pathSegments = location.pathname.split('/').filter(Boolean);
      for (const seg of pathSegments) {
        if (/^annonce$|^realEstateAd$|^vente$|^location$|^achat$|^vente-de-prestige$/i.test(seg)) continue;
        const segEsc = seg.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        const segMatch = decodedUrl.match(new RegExp(`${segEsc}-(\\d{5})`, 'i'));
        if (segMatch) {
          postal = segMatch[1];
          if (!city) city = seg.replace(/-/g, ' ');
          break;
        }
      }
    }

    if (!postal) {
      const decodedUrl = decodeURIComponent(location.href);
      const urlPostal = decodedUrl.match(/\b(\d{5})\b/);
      if (urlPostal) postal = urlPostal[1];
    }

    let buildingType = null;
    if (/maison/i.test(pageTitle)) buildingType = 'maison';
    else if (/appart/i.test(pageTitle)) buildingType = 'appartement';

    const descText = descEl?.textContent || '';
    const bodyText = document.body.innerText || '';

    const isLand =
      /\bterrain\b/i.test(pageTitle) ||
      /\bterrain\b/i.test(document.title || '') ||
      /\/terrain[s]?\b|\/achat-terrain/i.test(location.pathname);

    if (isLand) {
      let landSurface = ex.normalizeLandSurface(surfaceEl?.textContent);
      if (!landSurface) {
        const sources = [pageTitle, document.title || '', metaDesc, descText, bodyText];
        for (const src of sources) {
          const m = src.match(/(\d{1,6})\s*m(?:²|2)(?!\w)/i);
          if (m) {
            landSurface = ex.normalizeLandSurface(m[1]);
            if (landSurface) break;
          }
        }
      }
      const section = ex.normalizeSection([descText, bodyText, pageTitle].join(' '));
      if (!landSurface || !postal) return null;
      return {
        kind: 'land',
        postal,
        city,
        surface: landSurface,
        price,
        section,
        source: 'bienici-dom',
      };
    }

    const dateParsed =
      ex.extractDateFromText(descText) || ex.extractDateFromText(bodyText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = /neuf|vefa/i.test(descText || bodyText || '');

    let landSurface = null;
    const landM = bodyText.match(/terrain(?:\s+de)?\s+([\d\s]{1,10})\s*m(?:²|2)(?!\w)/i);
    if (landM) {
      landSurface = ex.normalizeLandSurface(landM[1].replace(/\s/g, ''));
    }

    // Rooms & bedrooms from DOM
    let rooms = null;
    let bedrooms = null;
    // BienIci exposes criteria badges with class like "ad-summary__rooms"
    const roomsEl = document.querySelector('[class*="roomsQuantity"], [class*="rooms-quantity"], [data-cy="rooms"]');
    if (roomsEl) rooms = parseInt((roomsEl.textContent || '').replace(/\D/g, ''), 10) || null;
    const bedroomsEl = document.querySelector('[class*="bedroomsQuantity"], [class*="bedrooms-quantity"], [data-cy="bedrooms"]');
    if (bedroomsEl) bedrooms = parseInt((bedroomsEl.textContent || '').replace(/\D/g, ''), 10) || null;
    // Fallback: look for "X pièces" / "X chambres" in page title or body
    if (!rooms) {
      const rm = pageTitle.match(/(\d+)\s*p(?:ièces?|ieces?)/i) || bodyText.match(/(\d+)\s*pièces?/i);
      if (rm) rooms = parseInt(rm[1], 10) || null;
    }
    if (!bedrooms) {
      const bm = pageTitle.match(/(\d+)\s*ch(?:ambres?)?/i) || bodyText.match(/(\d+)\s*chambres?/i);
      if (bm) bedrooms = parseInt(bm[1], 10) || null;
    }

    const imageUrl =
      document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      document.querySelector('img[src*="photos"], img[src*="bienici"], img[src*="cdn"]')?.src ||
      null;

    if (!surface || !postal) return null;
    return {
      kind: 'dpe',
      title: pageTitle || document.title || '',
      url: location.href,
      siteName: 'BienIci',
      imageUrl,
      description: (descText || metaDesc || '').slice(0, 2000) || null,
      rooms,
      bedrooms,
      postal,
      city,
      surface,
      landSurface,
      price,
      energyClass: energy,
      gesClass: ges,
      buildingType: buildingType,
      dateRange,
      isNewBuild,
      source: 'bienici-dom',
    };
  }

  // ── 3. Search Results Listings Card Check ─────────────────────────────────

  function extractDetailsFromCard(cardEl, url) {
    const text = (cardEl.innerText || cardEl.textContent || '')
      .replace(/m\s*([²2])/gi, 'm2');

    // Extract price (pick maximum to avoid per-m² prices)
    let price = null;
    let maxPrice = 0;
    const priceMatches = Array.from(text.matchAll(/(\d[\d \t\u202f\u00a0\.]*)\s*€/g));
    for (const m of priceMatches) {
      const val = parseInt(m[1].replace(/[\. \t\u202f\u00a0]/g, ''), 10);
      if (isFinite(val) && val > maxPrice) maxPrice = val;
    }
    if (maxPrice > 0) price = maxPrice;

    // Extract surface
    let surface = null;
    const surfaceM = text.match(/(\d[\d \t\u202f\u00a0\.,]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/i);
    if (surfaceM) {
      const cleaned = surfaceM[1].replace(/[\. \t\u202f\u00a0]/g, '').replace(',', '.');
      const s = parseFloat(cleaned);
      if (isFinite(s) && s > 0) surface = s;
    }

    // Extract postal/city from card text
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

    if (!city) {
      const cityM = text.match(/\b(\d{5})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})/);
      if (cityM) {
        postal = postal || cityM[1];
        city = cityM[2].trim();
      }
    }

    if (!city) {
      const locM = text.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,30}\s+\d{1,2}(?:er|ème|e)?)\b/i);
      if (locM) {
        city = locM[1].trim();
      }
    }

    // Fallback: extract postal code from URL slug if not found in text
    if (!postal && url) {
      const slugPostalM = url.match(/-(\d{5})(?:\/|\?|$)/);
      if (slugPostalM) {
        postal = slugPostalM[1];
      }
    }

    return { price, surface, postal, city, cardText: text };
  }

  function findCardContainer(link) {
    const knownContainer = link.closest('article, [class*="ad-overview"], [class*="sideListArticle"], [class*="search-result"], [class*="card"]');
    if (knownContainer) return knownContainer;

    let current = link;
    while (current.parentElement) {
      const parent = current.parentElement;
      if (parent.tagName === 'BODY' || parent.tagName === 'HTML') {
        break;
      }
      const allLinks = parent.querySelectorAll('a[href*="/annonce/"]');
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
    // 1. Standard search result cards
    const links = document.querySelectorAll('a[href*="/annonce/"], a[href*="/realEstateAd/"]');
    for (const link of links) {
      const val = link.getAttribute('href');
      if (!val || !isDetailLink(val)) continue;

      const cleanVal = val.split('?')[0].split('#')[0];
      if (link.dataset.chhProcessed === cleanVal) continue;

      const id = extractListingId(val);
      if (!id || checkingIds.has(id)) continue;

      let cardEl = findCardContainer(link);
      if (!cardEl) continue;

      if (cardEl.querySelector('.chh-card-chh-badge')) {
        link.dataset.chhProcessed = cleanVal;
        continue;
      }

      let details = extractDetailsFromCard(cardEl, val);

      // Safety fallback: climb parent to extract full card details if incomplete
      let attempts = 0;
      let current = cardEl;
      while ((!details.price || !details.surface) && current.parentElement && attempts < 3) {
        const parent = current.parentElement;
        if (parent.tagName === 'BODY' || parent.tagName === 'HTML') {
          break;
        }
        const siblingLinks = parent.querySelectorAll('a[href*="/annonce/"]');
        const uniqueIds = new Set();
        for (const sibling of siblingLinks) {
          const siblingVal = sibling.getAttribute('href') || '';
          const siblingId = extractListingId(siblingVal);
          if (siblingId) {
            uniqueIds.add(siblingId);
          }
        }
        if (uniqueIds.size > 1) {
          break;
        }

        current = parent;
        const parentDetails = extractDetailsFromCard(current, val);
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

      const hasEnoughData = (details.postal && (details.surface || details.price)) || (details.surface && details.price);
      if (!hasEnoughData) {
        continue;
      }

      link.dataset.chhProcessed = cleanVal;
      checkingIds.add(id);

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'CHECK_NOTION',
          payload: { ...details },
        });
        if (response && response.ok && response.result && response.result.match) {
          cardEl.dataset.chhMatchUrl = response.result.match.url;
          ui.markCardAsMatched(cardEl, response.result.match);
        }
      } catch (err) {
      } finally {
        checkingIds.delete(id);
      }
    }

    // 2. Map popup check
    const mapPopups = document.querySelectorAll(
      '.leaflet-popup-content-wrapper, .leaflet-popup, .mapboxgl-popup-content, .gm-style-iw, .gm-style-iw-c, [class*="map-popup" i], [class*="MapPopup" i]'
    );
    for (const popup of mapPopups) {
      if (popup.querySelector('.chh-card-chh-badge')) continue;

      let details = extractDetailsFromCard(popup);
      if (ui.checkAndMarkExcluded(popup, (details?.title || "") + " " + (details?.city || ""), true)) {
        continue;
      }

      const hasEnoughData = (details.postal && (details.surface || details.price)) || (details.surface && details.price);
      if (!hasEnoughData) continue;

      const link = popup.querySelector('a[href*="/annonce/"], a[href*="/realEstateAd/"]');
      let id = null;
      if (link) {
        id = extractListingId(link.getAttribute('href'));
      }
      if (!id) {
        id = 'popup-' + (popup.innerText || '').slice(0, 30).replace(/\s/g, '');
      }

      if (checkingIds.has(id)) continue;
      checkingIds.add(id);

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'CHECK_NOTION',
          payload: { ...details, forceRefresh: true },
        });
        if (response && response.ok && response.result && response.result.match) {
          popup.dataset.chhMatchUrl = response.result.match.url;
          ui.markCardAsMatched(popup, response.result.match, true);
        }
      } catch (err) {
      } finally {
        checkingIds.delete(id);
      }
    }
  }

  let detailFlowInFlight = false;

  async function startDetailPageFlow() {
    if (detailFlowInFlight) return;
    detailFlowInFlight = true;

    // Keep "Analyse en cours…" loading badge active during analysis
    ui.setFloatingContainerLoading('Analyse en cours…');

    let payload = null;
    let attempts = 0;
    while (attempts < 20) {
      payload = tryExtract();
      if (payload && (payload.postal || payload.city) && (payload.surface || payload.price)) {
        break;
      }
      attempts++;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!payload) {
      payload = { url: location.href, siteName: 'BienIci', title: document.title };
    }

    // 1. Asynchronously check Notion FIRST
    let notionMatchLocal = null;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHECK_NOTION',
        payload: { ...payload, isDetailPage: true, forceRefresh: true },
      });
      if (response && response.ok && response.result && response.result.active && response.result.match) {
        notionMatchLocal = response.result.match;
        notionMatch = notionMatchLocal;
      }
    } catch (err) {
    }

    // 2. Asynchronously run address auto-lookup
    let foundAddress = null;
    let foundScore = null;
    let foundDvfPrice = null;
    let foundDvfDate = null;
    let foundCandidates = null;

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

    // 3. Render final state ONLY after analysis completes
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
      ui.setFloatingContainerAddress({
        address: foundAddress,
        confidence: foundScore,
        dvfPrice: foundDvfPrice,
        dvfDate: foundDvfDate,
        candidates: foundCandidates,
        getPayload: () => (tryExtract() || payload)
      });
    }

    detailFlowInFlight = false;
  }

  async function runLookup(payload) {
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
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP', payload }).catch(() => {});
    } catch {}
  }

  function tryExtract() {
    const listingId = extractListingId(location.href);

    // Try window.__INITIAL_STATE__ (sometimes set synchronously)
    let state = readInitialState();

    // Fallback 1: __NEXT_DATA__ (Next.js)
    if (!state) {
      const nextNode = document.getElementById('__NEXT_DATA__');
      if (nextNode && nextNode.textContent) {
        try { state = JSON.parse(nextNode.textContent); } catch {}
      }
    }

    // Fallback 2: scan scripts for JSON blob containing ad data
    if (!state) {
      for (const tag of document.querySelectorAll('script:not([src])')) {
        const t = tag.textContent || '';
        // BienIci sometimes embeds ad as window.realEstateAd or window.__ad__
        if (t.includes('surfaceArea') && t.includes('postalCode')) {
          const m = t.match(/(?:window\.(?:realEstateAd|__ad__|ad)\s*=\s*|"realEstateAd"\s*:\s*)(\{[\s\S]{20,8000}?\})\s*[;,\n]/);
          if (m) {
            try {
              const ad = JSON.parse(m[1]);
              if (ad && (ad.surfaceArea || ad.postalCode)) {
                state = { realEstateAd: ad };
                break;
              }
            } catch {}
          }
        }
      }
    }

    const ad = findAd(state, listingId);
    let payload = ad ? extractFromAd(ad) : null;

    const jsonLd = extractFromJsonLd();
    if (jsonLd) {
      payload = { ...(jsonLd || {}), ...(payload || {}) };
    }

    const fallback = extractFromDom();
    if (fallback) {
      payload = {
        ...(fallback || {}),
        ...(payload || {}),
        price: payload?.price || fallback.price || null,
        postal: payload?.postal || fallback.postal || null,
        city: payload?.city || fallback.city || null,
        surface: payload?.surface || fallback.surface || null,
        energyClass: payload?.energyClass || fallback.energyClass || null,
        gesClass: payload?.gesClass || fallback.gesClass || null,
        rooms: payload?.rooms || fallback.rooms || null,
        bedrooms: payload?.bedrooms || fallback.bedrooms || null,
        description: payload?.description || fallback.description || null,
        imageUrl: payload?.imageUrl || fallback.imageUrl || null,
      };
    }

    if (payload) {
      const pageTitle = document.querySelector('h1, [class*="adTitle"], [class*="ad-title"]')?.textContent || document.title || '';
      const bodyTextEarly = document.body.innerText || '';
      payload.cardText = [pageTitle, bodyTextEarly].filter(Boolean).join(' ');
      payload.title = payload.title || pageTitle || document.title;
      payload.url = location.href;
      payload.siteName = 'BienIci';
      payload.imageUrl = payload.imageUrl || document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;

      const fullText = bodyTextEarly;

      if (!payload.price) {
        // Do NOT scan body text — it includes prices from similar listings sections.
        // Try document.title and og:title, which contain only the current listing's price.
        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
        const titleSources = [document.title, ogTitle, pageTitle].join(' ');
        for (const m of titleSources.matchAll(/(\d[\d \t\u202f\u00a0\.]*) *€/g)) {
          const val = parseInt(m[1].replace(/[\. \t\u202f\u00a0]/g, ''), 10);
          if (isFinite(val) && val >= 50000 && val < 100000000) {
            payload.price = val;
            break;
          }
        }
      }

      if (!payload.rooms) {
        const rm = pageTitle.match(/(\d+)\s*pi[eè]ces?/i) || fullText.match(/(\d+)\s*pi[eè]ces?\b/i);
        if (rm) payload.rooms = parseInt(rm[1], 10) || null;
      }

      if (!payload.bedrooms) {
        const bm = fullText.match(/(\d+)\s*chambres?\b/i);
        if (bm) payload.bedrooms = parseInt(bm[1], 10) || null;
      }

      if (!payload.landSurface) {
        const lm = fullText.match(/(\d[\d\s]*)\s*m[²2]\s*de\s*terrain/i)
                || fullText.match(/terrain\s+(?:de\s+)?(\d[\d\s]*)\s*m[²2]/i);
        if (lm) payload.landSurface = ex.normalizeLandSurface(lm[1].replace(/\s/g, ''));
      }

      if (!payload.buildingType) {
        if (/\bmaison\b/i.test(pageTitle)) payload.buildingType = 'maison';
        else if (/\bappart/i.test(pageTitle)) payload.buildingType = 'appartement';
      }

      if (!payload.description || payload.description.length < 120) {
        const descEl = document.querySelector(
          '.fullAdDescription, [class*="fullAdDescription"], [class*="ad-description"], ' +
          '[class*="description__content"], [data-testid="description"], section[class*="description"]'
        );
        if (descEl && descEl.innerText && descEl.innerText.trim().length > 80) {
          payload.description = descEl.innerText.trim().slice(0, 2000);
        } else {
          const descMatch = fullText.match(
            /DESCRIPTIF[^\n]*\n([\s\S]{80,3000}?)(?=\nLire\s+plus|\nJe\s+souhaite\s+être|\nÀ\s+PROPOS\s+DE\s+CETTE\s+ANNONCE|\nSERVICES\s+PARTENAIRES|\nDIAGNOSTIC\s+DE\s+PERFORMANCE)/i
          );
          if (descMatch) {
            payload.description = descMatch[1].trim().slice(0, 2000);
          } else {
            payload.description = (document.querySelector('meta[name="description"]')?.getAttribute('content') || '').slice(0, 2000) || null;
          }
        }
      }
    }

    return payload;
  }

  function onButtonClick() {
    const payload = tryExtract();
    if (payload) {
      runLookup(payload);
    } else {
      ui.showError('Impossible d\'extraire les données de cette annonce.', null);
    }
  }

  function init() {
    // 1. Search results cards check (runs on all pages)
    processListingCards();
    registerInterval(processListingCards, 2000);

    // 2. Detail page logic
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
    detailFlowInFlight = false;
    notionMatch = null;
    clearAllIntervals();
    ui.removeFloatingContainer();
    ui.closeCard();
    ui.resetFloatingButton();
    setTimeout(init, 300);
  });
})();
