(function () {
  'use strict';

  // Jinka listing pages: https://www.jinka.fr/ad/<uuid>
  // Jinka uses Next.js React Server Components streaming — no classic __NEXT_DATA__
  // with ad properties. All extraction is done from the DOM and og: meta tags.
  //
  // Key DOM signals on /ad/ pages (observed from real page):
  //   - <meta property="og:title"> → "Maison 8 pièces 217m² - Montpellier (34000)"
  //   - <h1>                       → "Montpellier (34000)"
  //   - Surface span               → "217 m²" inside a flex row
  //   - DPE / GES colored bars     → active bar (h-24) has a child <span> with the letter
  //                                   CSS classes: bg-dpe-a..g / bg-ges-a..g

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

  // ── 1. JSON extraction (kept as opportunistic fallback) ─────────────────────

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
    const direct = ex.getNestedValue(nextData, [
      ['props', 'pageProps', 'ad'],
      ['props', 'pageProps', 'announcement'],
      ['props', 'pageProps', 'listing'],
      ['props', 'pageProps', 'data', 'ad'],
    ]);
    if (direct && typeof direct === 'object') return direct;
    return ex.deepFind(
      nextData,
      (n) =>
        n &&
        typeof n === 'object' &&
        (('surface' in n && 'zipCode' in n) ||
          ('surfaceArea' in n && 'postalCode' in n) ||
          ('energyClass' in n && 'postalCode' in n))
    );
  }

  function extractFromAd(ad) {
    if (!ad) return null;
    const postalRaw =
      ad.postalCode ?? ad.zipCode ?? ad.zip ??
      ad.location?.postalCode ?? ad.location?.zipCode;
    const postal = ex.normalizePostal(postalRaw);
    const city = ad.city ?? ad.location?.city ?? null;
    const rawType = String(ad.propertyType ?? ad.type ?? ad.category ?? '');
    const rawTitle = String(ad.title ?? ad.subject ?? '');
    const rawDesc = String(ad.description ?? ad.body ?? '');
    const fullText = [rawTitle, rawDesc].filter(Boolean).join('\n');
    const priceRaw = ad.price ?? ad.priceCents ?? ad.amount ?? ad.priceAmount;
    const price = priceRaw ? parseInt(String(priceRaw).replace(/\D/g, ''), 10) : null;

    const isLand = /terrain|land/i.test(rawType) || /\bterrain[s]?\b/i.test(rawTitle);
    if (isLand) {
      const surface = ex.normalizeLandSurface(
        ad.landSurface ?? ad.plotSurface ?? ad.landArea ?? ad.surfaceArea ?? ad.surface
      );
      return { kind: 'land', postal, city, surface, price, section: ex.normalizeSection(fullText), source: 'jinka-json' };
    }
    const surface = ex.normalizeSurface(ad.surfaceArea ?? ad.surface ?? ad.area ?? ad.livingArea);
    let energyClass = ex.normalizeClass(ad.energyClass ?? ad.energyClassification ?? ad.dpeClass);
    let gesClass = ex.normalizeClass(ad.gesClass ?? ad.greenhouseGasClass ?? ad.ghgClass);
    if (ad.dpe && typeof ad.dpe === 'object') {
      energyClass = energyClass || ex.normalizeClass(ad.dpe.energyClass ?? ad.dpe.class ?? ad.dpe.rating);
      gesClass = gesClass || ex.normalizeClass(ad.dpe.gesClass ?? ad.dpe.ges ?? ad.dpe.ghg);
    }
    const buildingType = ex.normalizePropertyType(rawType) || ex.normalizePropertyType(rawTitle);
    const dateParsed = ex.extractDateFromText(fullText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = ad.isNewBuild === true || /neuf|vefa/i.test(fullText);
    const landSurface = ex.normalizeLandSurface(ad.landSurface ?? ad.plotSurface ?? ad.landArea);
    return { kind: 'dpe', postal, city, surface, landSurface, price, energyClass, gesClass, buildingType, dateRange, isNewBuild, source: 'jinka-json' };
  }

  // ── 2. DOM extraction (primary path for Jinka RSC pages) ────────────────────

  function extractFromDom() {
    const h1 = document.querySelector('h1')?.textContent || '';
    const ogTitle =
      document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '';
    const metaDesc =
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      '';
    const bodyText = document.body?.innerText || '';

    // ── Price ────────────────────────────────────────────────────────────────
    let price = null;
    const priceM = (metaDesc + ' ' + bodyText).match(/(\d[\d \t\u202f\u00a0]*)\s*€/);
    if (priceM) {
      const cleaned = priceM[1].replace(/[ \t\u202f\u00a0]/g, '');
      const parsedPrice = parseInt(cleaned, 10);
      if (isFinite(parsedPrice) && parsedPrice > 0) {
        price = parsedPrice;
      }
    }

    // ── Postal + city ───────────────────────────────────────────────────────
    // Jinka h1: "Montpellier (34000)" • og:title: "Maison 8 pièces 217m² - Montpellier (34000)"
    let postal = null;
    let city = null;
    for (const src of [h1, ogTitle, metaDesc, bodyText]) {
      const mParen = src.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\s*\((\d{5})\)/);
      if (mParen) { city = mParen[1].trim(); postal = mParen[2]; break; }
      const mBefore = src.match(/\b(\d{5})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})/);
      if (mBefore) { postal = mBefore[1]; city = mBefore[2].trim(); break; }
    }
    if (!postal) {
      for (const src of [h1, ogTitle, metaDesc, bodyText]) {
        const m = src.match(/\b(\d{5})\b/);
        if (m) { postal = m[1]; break; }
      }
    }

    // ── Land detection ───────────────────────────────────────────────────────
    const isLand =
      /\bterrain[s]?\b/i.test(h1 + ' ' + ogTitle + ' ' + document.title) ||
      /\/terrain/i.test(location.pathname);

    // ── Surfaces ─────────────────────────────────────────────────────────────
    // og:title is the most reliable: "Maison 8 pièces 217m²" (habitable surface)
    // Body may contain "Terrain 2 400 m²" for the land surface
    let surface = null;
    let landSurface = null;

    // og:title: first number before "m²"
    const ogSurfaceM = ogTitle.match(/(\d[\d \t\u202f\u00a0]*)\s*m(?:²|2)(?!\w)/i);
    if (ogSurfaceM) surface = ex.normalizeSurface(ogSurfaceM[1].replace(/[ \t\u202f\u00a0]/g, ''));

    // "Terrain NNN m²" in body — space-separated thousands
    const terrainM = bodyText.match(/[Tt]errain\s+([\d \t\u202f\u00a0]{1,10})\s*m(?:²|2)(?!\w)/);
    if (terrainM) landSurface = ex.normalizeLandSurface(terrainM[1].replace(/[ \t\u202f\u00a0]/g, ''));

    if (!surface) {
      for (const src of [h1, metaDesc, bodyText]) {
        const m = src.match(/(\d{1,4})\s*m(?:²|2)(?!\w)/i);
        if (m) { surface = ex.normalizeSurface(m[1]); if (surface) break; }
      }
    }

    if (isLand) {
      if (!landSurface) {
        for (const src of [h1, ogTitle, metaDesc, bodyText]) {
          const m = src.match(/(\d[\d \t\u202f\u00a0]{0,6})\s*m(?:²|2)(?!\w)/i);
          if (m) { landSurface = ex.normalizeLandSurface(m[1].replace(/[ \t\u202f\u00a0]/g, '')); if (landSurface) break; }
        }
      }
      if (!landSurface || !postal) return null;
      return { kind: 'land', postal, city, surface: landSurface, price, section: ex.normalizeSection(bodyText), source: 'jinka-dom' };
    }

    // ── DPE / GES from Jinka's colored-bar widget ────────────────────────────
    // Structure: a row of divs with class "bg-dpe-a" … "bg-dpe-g".
    // The active (highlighted) bar is larger (contains a <span> with the letter).
    // Inactive bars have no child <span> with a letter.
    let energyClass = null;
    let gesClass = null;

    for (const div of document.querySelectorAll('div')) {
      const cls = div.className || '';
      if (!energyClass && /\bbg-dpe-[a-g]\b/i.test(cls)) {
        const span = div.querySelector('span');
        if (span && /^[A-G]$/i.test(span.textContent.trim())) {
          energyClass = ex.normalizeClass(span.textContent.trim());
        }
      }
      if (!gesClass && /\bbg-ges-[a-g]\b/i.test(cls)) {
        const span = div.querySelector('span');
        if (span && /^[A-G]$/i.test(span.textContent.trim())) {
          gesClass = ex.normalizeClass(span.textContent.trim());
        }
      }
      if (energyClass && gesClass) break;
    }

    // ── Building type ────────────────────────────────────────────────────────
    let buildingType = null;
    const typeSource = ogTitle + ' ' + h1;
    if (/\bmaison\b/i.test(typeSource)) buildingType = 'maison';
    else if (/\bappart/i.test(typeSource)) buildingType = 'appartement';

    // ── DPE date ─────────────────────────────────────────────────────────────
    const dateParsed = ex.extractDateFromText(bodyText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = /neuf|vefa/i.test(bodyText);

    if (!surface && !postal) return null;
    return { kind: 'dpe', postal, city, surface, landSurface, price, energyClass, gesClass, buildingType, dateRange, isNewBuild, source: 'jinka-dom' };
  }

  // ── 3. Orchestration ────────────────────────────────────────────────────────

  function tryExtract() {
    const nextData = readNextData();
    const ad = findAd(nextData);
    let payload = ad ? extractFromAd(ad) : null;

    const fallback = extractFromDom();
    if (fallback) {
      if (!payload) {
        payload = fallback;
      } else {
        for (const [key, val] of Object.entries(fallback)) {
          if (payload[key] == null || payload[key] === '') {
            payload[key] = val;
          }
        }
      }
    }
    if (payload) {
      payload.title = payload.title || document.querySelector('h1')?.textContent || document.title || '';
      payload.url = location.href;
      payload.siteName = 'Jinka';
      payload.imageUrl = payload.imageUrl ||
        document.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
        document.querySelector('img[src*="jinka"], img[src*="photos"]')?.src || null;

      if (!payload.description || payload.description.length < 120) {
        // 1. Try DOM selectors for description container
        const descEl = document.querySelector(
          '[class*="description"], [class*="prose"], article p, [data-testid="description"]'
        );
        if (descEl && descEl.innerText && descEl.innerText.trim().length > 80) {
          payload.description = descEl.innerText.trim().slice(0, 2000);
        } else {
          // 2. Extract from body text up to known end markers
          const bodyText = document.body.innerText || '';
          const descMatch = bodyText.match(
            /(?:Description\s*[:\n]|Descriptif\s*[:\n])([\s\S]{80,3000}?)(?=\nRéférence|\nR\u00e9f\.|\nContact|\nSignaler|\nPartager|\nAgence|\nEn savoir plus)/i
          );
          if (descMatch) {
            payload.description = descMatch[1].trim().slice(0, 2000);
          } else if (bodyText.length > 80) {
            // 3. Body text up to first major break
            const firstBreak = bodyText.search(/\n(?:Référence|R\u00e9f\.|Agence|DPE|Diagnostic|Contact|Partager)/i);
            payload.description = (firstBreak > 80 ? bodyText.slice(0, firstBreak) : bodyText.slice(0, 2000)).trim();
          }
        }
      }
    }
    return payload;
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




  function extractDetailsFromCard(cardEl) {
    const text = (cardEl.innerText || cardEl.textContent || '').trim();
    
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

    return { price, surface, postal, city, cardText: text };
  }



  function findCardContainer(link) {
    let current = link;
    while (current.parentElement) {
      const parent = current.parentElement;
      if (parent.tagName === 'BODY' || parent.tagName === 'HTML') {
        break;
      }
      const allLinks = parent.querySelectorAll('a[href*="/ad/"]');
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
    const links = document.querySelectorAll('a[href*="/ad/"]');
    for (const link of links) {
      const val = link.getAttribute('href');
      if (!val) continue;
      
      const cleanVal = val.split('?')[0].split('#')[0];
      if (link.dataset.chhProcessed === cleanVal) continue;

      let cardEl = findCardContainer(link);
      if (cardEl.querySelector('.chh-card-chh-badge')) {
        link.dataset.chhProcessed = cleanVal;
        continue;
      }

      let details = extractDetailsFromCard(cardEl);

      // Safety fallback: if price or surface is missing, climb parent to find the full card container text
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

  let autoLookupDone = false;
  let autoLookupInFlight = false;

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
    return window.location.pathname.startsWith('/ad/');
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
      payload = { url: location.href, siteName: 'Jinka', title: document.title };
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
    // 1. Universal listing cards check (runs on all pages, e.g. /alerts)
    processListingCards();
    registerInterval(processListingCards, 2000);

    // 2. Detail page specific logic
    if (isAdPage()) {
      startDetailPageFlow();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Jinka is a Next.js SPA — listen for client-side navigation
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
