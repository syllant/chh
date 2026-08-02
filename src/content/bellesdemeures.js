(function () {
  'use strict';

  const ex = window.__chhExtract;
  const ui = window.__chhOverlay;

  const STATE = { injectedFor: null };
  let notionCheckInFlight = false;
  let notionCheckDone = false;
  let notionMatch = null;
  let activeIntervals = [];
  const checkingIds = new Set();

  function extractListingId(href) {
    if (!href) return null;
    const match = href.match(/\b\d{7,12}\b/);
    return match ? match[0] : null;
  }

  function isDetailLink(href) {
    if (!href) return false;
    const cleanUrl = href.split('?')[0].split('#')[0];
    if (cleanUrl.includes('/annonces/') && /\b\d{7,12}\b/.test(cleanUrl)) {
      return true;
    }
    return false;
  }

  function registerInterval(fn, delay) {
    const id = setInterval(fn, delay);
    activeIntervals.push(id);
    return id;
  }

  function clearAllIntervals() {
    activeIntervals.forEach(clearInterval);
    activeIntervals = [];
  }

  function isAdPage() {
    const path = window.location.pathname;
    return path.includes('/annonces/') && /\b\d{7,12}\b/.test(path);
  }

  function findPriceInJson(obj) {
    if (!obj || typeof obj !== 'object') return null;
    
    // Direct matches for price
    if (obj.price && typeof obj.price === 'number' && obj.price > 5000) return obj.price;
    if (obj.amount && typeof obj.amount === 'number' && obj.amount > 5000) return obj.amount;
    
    // Check specific pricing object
    if (obj.pricing && typeof obj.pricing === 'object') {
      if (obj.pricing.amount && typeof obj.pricing.amount === 'number') return obj.pricing.amount;
      if (obj.pricing.price && typeof obj.pricing.price === 'number') return obj.pricing.price;
      if (obj.pricing.rawPrice && typeof obj.pricing.rawPrice === 'number') return obj.pricing.rawPrice;
    }
    
    // Check rawData
    if (obj.rawData && typeof obj.rawData === 'object') {
      const p = findPriceInJson(obj.rawData);
      if (p) return p;
    }

    // Check sections
    if (obj.sections && typeof obj.sections === 'object') {
      if (obj.sections.financial && typeof obj.sections.financial === 'object') {
        const p = findPriceInJson(obj.sections.financial);
        if (p) return p;
      }
    }

    // General recursive fallback
    for (const key of Object.keys(obj)) {
      if (key === 'rawData' || key === 'sections' || key === 'pricing' || key === 'financial') continue;
      if (typeof obj[key] === 'object' && obj[key] !== null) {
        const p = findPriceInJson(obj[key]);
        if (p) return p;
      }
    }
    
    return null;
  }

  function readLifecycleData() {
    // 1. Try __UFRN_LIFECYCLE_SERVERREQUEST__ first (SeLoger legacy format)
    const node = document.getElementById('__UFRN_LIFECYCLE_SERVERREQUEST__');
    if (node && node.textContent) {
      const m = node.textContent.match(/JSON\.parse\((".*")\)/s);
      if (m) {
        try {
          const inner = JSON.parse(m[1]);
          return JSON.parse(inner);
        } catch (err) {
        }
      }
    }
    // 2. Try __NEXT_DATA__ (Next.js format)
    const nextNode = document.getElementById('__NEXT_DATA__');
    if (nextNode && nextNode.textContent) {
      try {
        return JSON.parse(nextNode.textContent);
      } catch (err) {
      }
    }
    return null;
  }

  function mergePayloads(primary, secondary) {
    if (!primary) return secondary;
    if (!secondary) return primary;
    const merged = { ...primary };
    for (const [key, val] of Object.entries(secondary)) {
      if (val !== null && val !== undefined && val !== '' && (merged[key] === null || merged[key] === undefined || merged[key] === '')) {
        merged[key] = val;
      }
    }
    return merged;
  }

  function extractFromJsonLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      if (!script.textContent) continue;
      try {
        const json = JSON.parse(script.textContent);
        if (!json) continue;
        const items = Array.isArray(json) ? json : (json['@graph'] || [json]);
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const typeStr = String(item['@type'] || '');
          if (/RealEstateListing|SingleFamilyResidence|Apartment|House|Product|Offer|Place/i.test(typeStr) || item.numberOfRooms || item.numberOfBedrooms || item.description) {
            let rooms = null;
            if (item.numberOfRooms || item.rooms) {
              rooms = parseInt(String(item.numberOfRooms || item.rooms).replace(/\D/g, ''), 10) || null;
            }
            let bedrooms = null;
            if (item.numberOfBedrooms || item.bedrooms) {
              bedrooms = parseInt(String(item.numberOfBedrooms || item.bedrooms).replace(/\D/g, ''), 10) || null;
            }
            const description = item.description || null;
            
            let price = findPriceInJson(item);
            let surface = null;
            if (item.floorSize?.value) {
              surface = ex.normalizeSurface(item.floorSize.value);
            }
            const address = item.address || {};
            const postal = ex.normalizePostal(address.postalCode);
            const city = address.addressLocality || null;

            if (rooms || bedrooms || description || price || surface || postal) {
              return {
                rooms,
                bedrooms,
                description,
                price,
                surface,
                postal,
                city,
                source: 'json-ld'
              };
            }
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function findClassified(lifecycle) {
    if (!lifecycle) return null;
    // SeLoger style
    for (const key of Object.keys(lifecycle)) {
      const app = lifecycle[key];
      const c = app?.data?.classified;
      if (c) return c;
    }
    // NextProps search / General fallback
    return ex.deepFind(
      lifecycle,
      (n) => n && typeof n === 'object' && 'sections' in n && 'rawData' in n
    );
  }

  function extractDescriptionFromSection(descData) {
    if (!descData) return '';
    if (typeof descData === 'string') return descData.trim();
    if (typeof descData !== 'object') return String(descData);

    const title = (
      descData.title ||
      descData.header ||
      descData.heading ||
      descData.tagline ||
      descData.headline ||
      descData.caption ||
      descData.subtitle ||
      ''
    ).trim();

    let body = '';
    if (Array.isArray(descData.paragraphs) && descData.paragraphs.length > 0) {
      body = descData.paragraphs
        .map((p) => (typeof p === 'string' ? p : p?.text || p?.value || p?.content || '')?.trim())
        .filter(Boolean)
        .join('\n\n');
    }

    if (!body) {
      body = (
        (typeof descData.description === 'string' ? descData.description : null) ||
        descData.description?.text ||
        descData.description?.description ||
        descData.text ||
        descData.rawText ||
        descData.value ||
        descData.body ||
        descData.content ||
        ''
      ).trim();
    }

    if (title && body) {
      if (body.toLowerCase().startsWith(title.toLowerCase())) {
        return body;
      }
      return `${title}\n\n${body}`;
    }

    return title || body || '';
  }

  function extractFromClassified(classified) {
    if (!classified) return null;

    if (classified.id) {
      const match = location.pathname.match(/\b(\d{7,12})\b/);
      if (match && match[1] && String(classified.id) !== match[1]) {
        return null;
      }
    }

    const sections = classified.sections || {};
    const address = sections.location?.address || {};
    const postal = ex.normalizePostal(address.zipCode);
    const city = address.city || null;
    const rawType = classified.rawData?.propertyType || '';
    const hardTitle = sections.hardFacts?.title || '';
    const price = findPriceInJson(classified);

    const facts = sections.hardFacts?.facts || [];
    let landSpace = null;
    let livingSpace = null;
    for (const f of facts) {
      if (f.type === 'landSpace') landSpace = ex.normalizeLandSurface(f.splitValue || f.value);
      else if (f.type === 'livingSpace') livingSpace = ex.normalizeSurface(f.splitValue || f.value);
    }

    const isLand = /terrain/i.test(rawType) || /terrain/i.test(hardTitle);

    if (isLand) {
      const description = 
        extractDescriptionFromSection(sections.description) ||
        extractDescriptionFromSection(classified.rawData?.description) ||
        extractDescriptionFromSection(classified.description) ||
        '';
      const surface = landSpace != null ? landSpace : ex.normalizeLandSurface(livingSpace);
      const section = ex.normalizeSection(description);
      return {
        kind: 'land',
        postal,
        city,
        surface,
        price,
        section,
        description,
        source: 'bellesdemeures-json',
      };
    }

    const surface = livingSpace;

    let energyClass = null;
    let gesClass = null;
    const certs = sections.energy?.certificates || [];
    for (const cert of certs) {
      for (const scale of cert.scales || []) {
        const rating = scale.efficiencyClass?.rating;
        if (!rating) continue;
        const type = String(scale.type || '').toUpperCase();
        if (type.includes('GHG') || type.includes('GES')) {
          gesClass = gesClass || ex.normalizeClass(rating);
        } else if (type.includes('ENERGY') || type.includes('DPE')) {
          energyClass = energyClass || ex.normalizeClass(rating);
        }
      }
    }

    let buildingType = null;
    if (/maison|house/i.test(rawType) || /maison/i.test(hardTitle)) buildingType = 'maison';
    else if (/appart|flat/i.test(rawType) || /appart/i.test(hardTitle)) buildingType = 'appartement';

    const description = 
      extractDescriptionFromSection(sections.description) ||
      extractDescriptionFromSection(classified.rawData?.description) ||
      extractDescriptionFromSection(classified.description) ||
      '';
    const dateParsed = ex.extractDateFromText(description);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = classified.metadata?.isNewBuildProject === true || /neuf|vefa/i.test(description);

    const title = hardTitle || document.querySelector('h1')?.textContent || document.title || '';
    const imageUrl = sections.photos?.photos?.[0]?.url ||
      document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;

    let rooms = null;
    let bedrooms = null;

    // Direct check in rawData
    const rd = classified.rawData || {};
    if (rd.roomsCount || rd.rooms || rd.nbRooms || rd.numberOfRooms) {
      rooms = parseInt(String(rd.roomsCount || rd.rooms || rd.nbRooms || rd.numberOfRooms).replace(/\D/g, ''), 10) || null;
    }
    if (rd.bedroomsCount || rd.bedrooms || rd.nbBedrooms || rd.numberOfBedrooms) {
      bedrooms = parseInt(String(rd.bedroomsCount || rd.bedrooms || rd.nbBedrooms || rd.numberOfBedrooms).replace(/\D/g, ''), 10) || null;
    }

    // Check facts array across all potential section containers
    const allFacts = [
      ...facts,
      ...(sections.features || []),
      ...(sections.keyFeatures || []),
      ...(sections.specifications || [])
    ];
    for (const f of allFacts) {
      if (!f) continue;
      const type = String(f.type || f.tag || f.id || f.key || '').toLowerCase();
      const label = String(f.label || f.name || f.title || f.type || '').toLowerCase();
      const valStr = String(f.value !== undefined ? f.value : (f.splitValue !== undefined ? f.splitValue : f.val || f.text || f.count || ''));

      if (!rooms && (/rooms|numberofrooms|roomcount|nbrooms|pieces/i.test(type) || /pièce|piece/i.test(label))) {
        rooms = parseInt(valStr.replace(/\D/g, ''), 10) || null;
      }
      if (!bedrooms && (/bedrooms|numberofbedrooms|bedroomcount|nbbedrooms|chambres/i.test(type) || /chambre/i.test(label))) {
        bedrooms = parseInt(valStr.replace(/\D/g, ''), 10) || null;
      }
    }

    // Regex fallbacks on title/hardTitle
    if (!rooms) {
      const roomM = (hardTitle + ' ' + title).match(/\b(\d+)\s*(?:pièce[s]?|p\.?\b)/i);
      if (roomM) rooms = parseInt(roomM[1], 10) || null;
    }
    if (!bedrooms) {
      const bedM = (hardTitle + ' ' + title + ' ' + description).match(/\b(\d+)\s*(?:chambre[s]?|ch\.?\b)/i);
      if (bedM) bedrooms = parseInt(bedM[1], 10) || null;
    }

    return {
      kind: 'dpe',
      title,
      url: location.href,
      siteName: 'BellesDemeures',
      imageUrl,
      rooms,
      bedrooms,
      description,
      postal,
      city,
      surface,
      price,
      landSurface: landSpace,
      energyClass,
      gesClass,
      buildingType,
      dateRange,
      isNewBuild,
      source: 'bellesdemeures-json',
    };
  }

  function extractFromDom() {
    const title = document.title || '';
    const metaDesc =
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      '';
    const h1Text = document.querySelector('h1')?.textContent || '';
    const bodyText = document.body.innerText || '';
    const sources = [h1Text, title, metaDesc, bodyText];

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
      const m = text.match(/\?(\d{5})\)?\s*$/) || text.match(/\b\d{5}\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})/);
      if (m && m[1] && /[A-Za-z]/.test(m[1])) {
        city = m[1].trim();
        break;
      }
    }

    const isLand =
      /\bterrain[s]?\b/i.test(title) ||
      /\/terrain/i.test(location.pathname) ||
      /\bterrain[s]?\b/i.test(metaDesc);

    let price = null;
    const priceM = bodyText.match(/(\d[\d \t\u202f\u00a0]*)\s*€/);
    if (priceM) {
      price = parseInt(priceM[1].replace(/[ \t\u202f\u00a0]/g, ''), 10);
    }

    // Extract Description from DOM
    let description = null;
    const descSelectors = [
      '[data-testid="description"]',
      '[data-test*="description" i]',
      '[class*="description__content" i]',
      '[class*="fullDescription" i]',
      'section[class*="description" i]',
      'div[class*="description" i]',
      'div[class*="Description" i]',
      '#description',
      '.description'
    ];
    for (const selector of descSelectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt.length > 50) {
        description = txt.slice(0, 2000);
        break;
      }
    }
    if (!description) {
      const descMatch = bodyText.match(/(?:description|descriptif)\s*[\n:]+\s*([\s\S]{50,2000})/i);
      if (descMatch && descMatch[1]) {
        description = descMatch[1].trim().slice(0, 2000);
      } else if (metaDesc) {
        description = metaDesc.trim().slice(0, 2000);
      }
    }

    // Extract Rooms & Bedrooms from DOM
    let rooms = null;
    let bedrooms = null;

    for (const text of [h1Text, title, metaDesc]) {
      if (!rooms) {
        const rM = text.match(/\b(\d+)\s*(?:pièce[s]?|pi&egrave;ce[s]?|\bpc[s]?\b)/i);
        if (rM) rooms = parseInt(rM[1], 10) || null;
      }
      if (!bedrooms) {
        const bM = text.match(/\b(\d+)\s*(?:chambre[s]?|\bch\b)/i);
        if (bM) bedrooms = parseInt(bM[1], 10) || null;
      }
    }

    if (!rooms || !bedrooms) {
      const criteriaEls = document.querySelectorAll('[class*="criteria" i], [class*="fact" i], [class*="feature" i], [class*="tag" i], [class*="characteristic" i], [data-testid*="criteria" i], li, span');
      for (const el of criteriaEls) {
        if (!el.textContent || el.children.length > 2 || el.textContent.length > 50) continue;
        const txt = el.textContent.trim();
        if (!rooms) {
          const rM = txt.match(/^(\d+)\s*(?:pièce[s]?|pi&egrave;ce[s]?|\bpc[s]?\b)$/i) || txt.match(/\b(\d+)\s*pièce[s]?\b/i);
          if (rM) rooms = parseInt(rM[1], 10) || null;
        }
        if (!bedrooms) {
          const bM = txt.match(/^(\d+)\s*(?:chambre[s]?|\bch\b)$/i) || txt.match(/\b(\d+)\s*chambre[s]?\b/i);
          if (bM) bedrooms = parseInt(bM[1], 10) || null;
        }
        if (rooms && bedrooms) break;
      }
    }

    if (isLand) {
      let landSurface = null;
      const landM = bodyText.match(/(\d[\d \t\u202f\u00a0]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)\s*(?:de\s*)?terrain/i);
      if (landM) {
        landSurface = ex.normalizeLandSurface(landM[1]);
      }
      const section = ex.normalizeSection(bodyText);
      return {
        kind: 'land',
        postal,
        city,
        surface: landSurface,
        price,
        section,
        description,
        source: 'bellesdemeures-dom',
      };
    }

    let surface = null;
    const surfaceM = bodyText.match(/(\d[\d \t\u202f\u00a0]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/i);
    if (surfaceM) {
      surface = ex.normalizeSurface(surfaceM[1]);
    }

    // Energy / GES estimation
    let energyClass = null;
    let gesClass = null;

    const energyBadge = document.querySelector('[class*="energyClassification"], [class*="dpe"]');
    if (energyBadge && energyBadge.textContent) {
      energyClass = ex.normalizeClass(energyBadge.textContent);
    }
    const gesBadge = document.querySelector('[class*="greenhouseGasEmissionClassification"], [class*="ges"]');
    if (gesBadge && gesBadge.textContent) {
      gesClass = ex.normalizeClass(gesBadge.textContent);
    }

    const energyMatch = bodyText.match(/\bDPE\s*:\s*([A-G])\b/i) || bodyText.match(/classe\s+énergie\s+([A-G])\b/i);
    if (energyMatch) energyClass = energyClass || energyMatch[1].toUpperCase();

    const gesMatch = bodyText.match(/\bGES\s*:\s*([A-G])\b/i) || bodyText.match(/classe\s+climat\s+([A-G])\b/i);
    if (gesMatch) gesClass = gesClass || gesMatch[1].toUpperCase();

    let buildingType = null;
    if (/maison|villa|propriété|manoir|château/i.test(title)) buildingType = 'maison';
    else if (/appartement/i.test(title)) buildingType = 'appartement';

    const dateParsed = ex.extractDateFromText(bodyText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = /neuf|vefa/i.test(title) || /neuf|vefa/i.test(bodyText);

    return {
      kind: 'dpe',
      title: document.title || '',
      url: location.href,
      siteName: 'BellesDemeures',
      imageUrl: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
      description,
      rooms,
      bedrooms,
      postal,
      city,
      surface,
      price,
      energyClass,
      gesClass,
      buildingType,
      dateRange,
      isNewBuild,
      source: 'bellesdemeures-dom',
    };
  }

  function tryExtract() {
    const lifecycle = readLifecycleData();
    const classified = findClassified(lifecycle);
    let payload = extractFromClassified(classified);
    const jsonLd = extractFromJsonLd();
    if (jsonLd) {
      payload = mergePayloads(payload, jsonLd);
    }
    if (!payload || !payload.surface || !payload.postal || !payload.price || !payload.rooms || !payload.description) {
      const fallback = extractFromDom();
      if (fallback) payload = mergePayloads(payload, fallback);
    }
    if (payload && (!payload.description || payload.description.length < 50)) {
      const fallback = extractFromDom();
      if (fallback && fallback.description && fallback.description.length > (payload.description || '').length) {
        payload.description = fallback.description;
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

    // Extract postal/city from text
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

    // Fallback: try to extract city from href URL slug
    if (!city && href) {
      const urlMatch = href.match(/\/annonces\/[^/]+\/[^/]+\/([^/]+)\//i);
      if (urlMatch) {
        const slug = urlMatch[1];
        const slugParts = slug.split('-');
        const last = slugParts[slugParts.length - 1];
        if (/^\d{5}$/.test(last)) {
          postal = postal || last;
        }
        const cityParts = slugParts.filter(p => !/^\d+$/.test(p) && !/^eme$/i.test(p) && !/^er$/i.test(p));
        city = cityParts.join(' ').trim();
      }
    }

    return { price, surface, postal, city, cardText: text };
  }

  async function processListingCards() {
    // 1. Existing cards check (standard list view / generic elements)
    const elements = document.querySelectorAll('a, [data-href], [data-url], [data-id]');
    for (const el of elements) {
      const val = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-id') || '';
      if (!isDetailLink(val)) {
        continue;
      }

      const cleanVal = val.split('?')[0].split('#')[0];
      if (el.dataset.chhProcessed === cleanVal) continue;

      const id = extractListingId(val);
      if (!id) continue;

      if (checkingIds.has(id)) continue;

      let cardEl = findCardContainer(el);
      if (cardEl.querySelector('.chh-card-chh-badge')) {
        el.dataset.chhProcessed = cleanVal;
        continue;
      }

      let details = extractDetailsFromCard(cardEl, val);

      let attempts = 0;
      let current = cardEl;
      while ((!details.price || !details.surface) && current.parentElement && attempts < 3) {
        const parent = current.parentElement;
        if (parent.tagName === 'BODY' || parent.tagName === 'HTML') {
          break;
        }
        const siblingLinks = parent.querySelectorAll('a, [data-href], [data-url], [data-id]');
        const uniqueIds = new Set();
        for (const sibling of siblingLinks) {
          const siblingVal = sibling.getAttribute('href') || sibling.getAttribute('data-href') || sibling.getAttribute('data-url') || sibling.getAttribute('data-id') || '';
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

      if (ui.checkAndMarkExcluded(cardEl, (details?.title || "") + " " + (details?.city || "") + " " + val)) {
        el.dataset.chhProcessed = cleanVal;
        continue;
      }

      // Check if we have enough details to identify the property in Notion
      const hasEnoughData = (details.postal && (details.surface || details.price)) || (details.surface && details.price);
      if (!hasEnoughData) {
        continue;
      }

      el.dataset.chhProcessed = cleanVal;
      checkingIds.add(id);

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
      } finally {
        checkingIds.delete(id);
      }
    }

    // 2. Map popup check (for map views if any)
    const mapPopups = document.querySelectorAll('.leaflet-popup-content-wrapper, .leaflet-popup, .mapboxgl-popup-content, .gm-style-iw, .gm-style-iw-c, [class*="map-popup" i], [class*="MapPopup" i]');
    for (const popup of mapPopups) {
      if (popup.querySelector('.chh-card-chh-badge')) continue;
      
      const link = popup.matches('a, [data-href], [data-url], [data-id]') ? popup : popup.querySelector('a, [data-href], [data-url], [data-id]');
      if (link) {
        const val = link.getAttribute('href') || link.getAttribute('data-href') || link.getAttribute('data-url') || link.getAttribute('data-id') || '';
        if (isDetailLink(val)) {
          const id = extractListingId(val);
          if (id) {
            if (checkingIds.has(id)) continue;

            let details = extractDetailsFromCard(popup, val);
            if (ui.checkAndMarkExcluded(popup, (details?.title || "") + " " + (details?.city || ""), true)) {
              continue;
            }

            const hasEnoughData = (details.postal && (details.surface || details.price)) || (details.surface && details.price);
            if (!hasEnoughData) {
              continue;
            }
            
            checkingIds.add(id);
            try {
              const response = await chrome.runtime.sendMessage({ 
                type: 'CHECK_NOTION', 
                payload: details 
              });
              if (response && response.ok && response.result && response.result.match) {
                ui.markCardAsMatched(popup, response.result.match, true);
              }
            } catch (err) {
              // ignore
            } finally {
              checkingIds.delete(id);
            }
          }
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
        if (fallback) payload = mergePayloads(payload, fallback);
      }
      if (payload && (payload.postal || payload.city || payload.surface || payload.price)) {
        break;
      }
      attempts++;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!payload) {
      payload = { url: location.href, siteName: 'BellesDemeures', title: document.title };
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
