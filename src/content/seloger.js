(function () {
  "use strict";

  const ex = window.__chhExtract;
  const ui = window.__chhOverlay;

  const _intervals = [];
  function registerInterval(fn, ms) {
    const id = setInterval(fn, ms);
    _intervals.push(id);
    return id;
  }
  function clearAllIntervals() {
    _intervals.forEach((id) => clearInterval(id));
    _intervals.length = 0;
  }

  const checkingIds = new Set();
  
  let notionMatch = null;
  let notionCheckInFlight = false;
  let notionCheckDone = false;
  let STATE = { injectedFor: null };

  function isAdPage() {
    return /\/annonces\/|\/locations\//i.test(location.href);
  }

  function isDetailLink(href) {
    if (!href) return false;
    return /seloger\.com\/annonces\/|seloger\.com\/locations\/|bellesdemeures\.com\/annonces\//i.test(href);
  }

  function extractListingId(val) {
    if (!val) return null;
    const m1 = val.match(/\/([0-9]{6,12})(?:\/|\?|$)/);
    if (m1) return m1[1];
    return null;
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
      if (obj.sections.pricing && typeof obj.sections.pricing === 'object') {
        const p = findPriceInJson(obj.sections.pricing);
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

  function tryExtractClassified() {
    // 1. UFRN
    const node = document.getElementById("__UFRN_LIFECYCLE_SERVERREQUEST__");
    if (node && node.textContent) {
      const m = node.textContent.match(/JSON\.parse\((".*")\)/s);
      if (m) {
        try {
          const inner = JSON.parse(m[1]);
          const parsed = JSON.parse(inner);
          for (const key of Object.keys(parsed)) {
            const app = parsed[key];
            if (app?.data?.classified) return app.data.classified;
          }
        } catch {}
      }
    }
    
    // 2. Next.js / Apollo
    let nextData = null;
    const nextNode = document.getElementById('__NEXT_DATA__');
    if (nextNode && nextNode.textContent) {
      try { nextData = JSON.parse(nextNode.textContent); } catch {}
    }
    const apolloState = nextData?.props?.pageProps?.initialApolloState || window.__APOLLO_STATE__ || window.apolloState || window.__NEXT_DATA__?.props?.pageProps?.initialApolloState;
    
    if (apolloState) {
      let classifiedRef = null;
      const listingId = extractListingId(location.href);
      if (listingId && apolloState[`Classified:${listingId}`]) {
        classifiedRef = apolloState[`Classified:${listingId}`];
      } else {
        for (const key of Object.keys(apolloState)) {
          if (key.startsWith('Classified:')) {
            classifiedRef = apolloState[key];
            break;
          }
        }
      }
      
      if (classifiedRef) {
        const deref = (obj, seen = new Set()) => {
          if (!obj) return obj;
          if (typeof obj !== 'object') return obj;
          if (obj.__ref) {
            if (seen.has(obj.__ref)) return null;
            const newSeen = new Set(seen);
            newSeen.add(obj.__ref);
            return deref(apolloState[obj.__ref], newSeen);
          }
          if (Array.isArray(obj)) return obj.map(v => deref(v, seen));
          const res = {};
          for (const [k, v] of Object.entries(obj)) res[k] = deref(v, seen);
          return res;
        };
        return deref(classifiedRef);
      }
    }
    
    // 3. Fallback generic search
    let state = nextData || window.__INITIAL_STATE__ || window.__PRELOADED_STATE__;
    if (state) {
      return ex.deepFind(state, n => 
        n && typeof n === 'object' && 
        (n.rawData || n.sections) && 
        (n.id || n.reference) && 
        ((n.sections && n.sections.location) || (n.rawData && n.rawData.propertyType))
      );
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
      const match = location.pathname.match(/\/annonces\/[^/]+\/[^/]+\/[^/]+\/(\d{5,})\//i) || location.pathname.match(/\b(\d{5,})\b/);
      if (match && match[1] && String(classified.id) !== match[1]) {
        return null;
      }
    }

    const sections = classified.sections || {};
    const address = sections.location?.address || classified.location?.address || classified.address || {};
    const postal = ex.normalizePostal(address.zipCode || address.postalCode);
    const city = address.city || address.locality || null;
    const rawType = classified.rawData?.propertyType || classified.propertyType || "";
    const hardTitle = sections.hardFacts?.title || "";
    const price = findPriceInJson(classified);

    const facts = sections.hardFacts?.facts || classified.hardFacts?.facts || [];
    let landSpace = null;
    let livingSpace = null;
    for (const f of facts) {
      if (f.type === "landSpace")
        landSpace = ex.normalizeLandSurface(f.splitValue || f.value);
      else if (f.type === "livingSpace")
        livingSpace = ex.normalizeSurface(f.splitValue || f.value);
    }

    const isLand = /terrain/i.test(rawType) || /terrain/i.test(hardTitle);

    if (isLand) {
      const description = 
        extractDescriptionFromSection(sections.description) ||
        extractDescriptionFromSection(classified.rawData?.description) ||
        extractDescriptionFromSection(classified.description) ||
        "";
      const surface =
        landSpace != null ? landSpace : ex.normalizeLandSurface(livingSpace);
      const section = ex.normalizeSection(description);
      return {
        kind: "land",
        postal,
        city,
        surface,
        price,
        section,
        description,
        source: "seloger-json",
      };
    }

    const surface = livingSpace;

    let energyClass = null;
    let gesClass = null;
    const certs = sections.energy?.certificates || classified.energy?.certificates || [];
    for (const cert of certs) {
      for (const scale of cert.scales || []) {
        const rating = scale.efficiencyClass?.rating;
        if (!rating) continue;
        const type = String(scale.type || "").toUpperCase();
        if (type.includes("GHG") || type.includes("GES")) {
          gesClass = gesClass || ex.normalizeClass(rating);
        } else if (type.includes("ENERGY") || type.includes("DPE")) {
          energyClass = energyClass || ex.normalizeClass(rating);
        }
      }
    }

    let buildingType = null;
    if (/maison|house/i.test(rawType) || /maison/i.test(hardTitle))
      buildingType = "maison";
    else if (/appart|flat/i.test(rawType) || /appart/i.test(hardTitle))
      buildingType = "appartement";

    const description = 
      extractDescriptionFromSection(sections.description) ||
      extractDescriptionFromSection(classified.rawData?.description) ||
      extractDescriptionFromSection(classified.description) ||
      "";
    const dateParsed = ex.extractDateFromText(description);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild =
      classified.metadata?.isNewBuildProject === true ||
      /neuf|vefa/i.test(description);

    const title = hardTitle || document.querySelector('h1')?.textContent || document.title || '';
    const imageUrl = sections.photos?.photos?.[0]?.url || classified.photos?.photos?.[0]?.url || document.querySelector('img[src*="seloger"]')?.src || null;
    
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

    const url = location.href;
    const siteName = 'SeLoger';

    return {
      kind: "dpe",
      title,
      url,
      siteName,
      imageUrl,
      rooms,
      bedrooms,
      description,
      landSurface: landSpace,
      postal,
      city,
      surface,
      price,
      energyClass,
      gesClass,
      buildingType,
      dateRange,
      isNewBuild,
      source: "seloger-json",
    };
  }

  function extractFromDom() {
    const title = document.title || "";
    const metaDesc =
      document
        .querySelector('meta[name="description"]')
        ?.getAttribute("content") ||
      document
        .querySelector('meta[property="og:description"]')
        ?.getAttribute("content") ||
      "";
    const h1Text = document.querySelector('h1')?.textContent || "";
    const bodyText = document.body.innerText || "";
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
      const m =
        text.match(/\(?(\d{5})\)?\s*$/) ||
        text.match(/\b\d{5}\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})/);
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
    let maxPrice = 0;
    const elements = document.querySelectorAll('span, div, p, h1, h2, strong, b');
    for (const el of elements) {
      const text = (el.textContent || '').trim();
      if (text.length > 50) continue;
      const m = text.match(/(\d[\d \t\u202f\u00a0]*)\s*€/);
      if (m) {
        const val = parseInt(m[1].replace(/[ \t\u202f\u00a0]/g, ''), 10);
        if (val > 5000 && val < 100000000) {
          if (val > maxPrice) maxPrice = val;
        }
      }
    }
    if (maxPrice > 0) {
      price = maxPrice;
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
      for (const text of sources) {
        const m = text.match(/(\d{1,6})\s*m(?:²|2)\b/i);
        if (m) {
          landSurface = ex.normalizeLandSurface(m[1]);
          if (landSurface) break;
        }
      }
      const section = ex.normalizeSection(bodyText);
      if (!landSurface || !postal) return null;
      return {
        kind: "land",
        postal,
        city,
        surface: landSurface,
        price,
        section,
        description,
        source: "seloger-dom",
      };
    }

    let surface = null;
    for (const text of sources) {
      const m = text.match(/(\d{1,4})\s*m(?:²|2)\b/i);
      if (m) {
        surface = ex.normalizeSurface(m[1]);
        if (surface) break;
      }
    }

    let buildingType = null;
    if (/maison/i.test(title)) buildingType = "maison";
    else if (/appart/i.test(title)) buildingType = "appartement";

    const dateParsed = ex.extractDateFromText(bodyText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = /neuf|vefa|programme\s+neuf/i.test(bodyText);

    let energyClass = null;
    let gesClass = null;
    const allTxt = document.body.innerText || '';
    const dpeM = allTxt.match(/\bDPE\s*[\n\r:]*\s*([A-G])\b/i) || allTxt.match(/Classe (?:énergie|énergétique)\s*[\n\r:]*\s*([A-G])\b/i);
    if (dpeM) energyClass = ex.normalizeClass(dpeM[1]);
    const gesM = allTxt.match(/\bGES\s*[\n\r:]*\s*([A-G])\b/i) || allTxt.match(/(?:Emission|Classe)[\s\S]{0,20}?gaz[\s\S]{0,20}?([A-G])\b/i);
    if (gesM) gesClass = ex.normalizeClass(gesM[1]);
    
    if (!rooms) {
      const rm = allTxt.match(/\b(\d+)\s*pièces?\b/i);
      if (rm) rooms = parseInt(rm[1], 10);
    }
    if (!bedrooms) {
      const bm = allTxt.match(/\b(\d+)\s*chambres?\b/i);
      if (bm) bedrooms = parseInt(bm[1], 10);
    }

    if (!surface || !postal) return null;
    return {
      kind: "dpe",
      title: document.title || '',
      url: location.href,
      siteName: 'SeLoger',
      imageUrl: document.querySelector('img[src*="seloger"]')?.src || null,
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
      source: "seloger-dom",
    };
  }

  function tryExtract() {
    const classified = tryExtractClassified();
    let payload = extractFromClassified(classified);
    const jsonLd = extractFromJsonLd();
    if (jsonLd) {
      payload = mergePayloads(payload, jsonLd);
    }
    if (!payload || (!payload.surface && !payload.price) || !payload.postal || !payload.rooms || !payload.description || !payload.energyClass || !payload.gesClass) {
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

  function findCardContainer(linkEl) {
    let current = linkEl;
    while (current.parentElement) {
      const parent = current.parentElement;
      if (parent.tagName === "BODY" || parent.tagName === "HTML") {
        break;
      }

      const isCardBlock =
        parent.getAttribute("data-testid") === "map-card-testid" ||
        parent.getAttribute("data-testid") === "map-card" ||
        parent.getAttribute("data-test") === "sl.listing.card" ||
        parent.getAttribute("data-test") === "sl.search.card";

      if (isCardBlock && parent !== linkEl) {
        return parent;
      }

      const siblingLinks = parent.querySelectorAll(
        "a, [data-href], [data-url], [data-id]",
      );
      const uniqueIds = new Set();
      for (const sibling of siblingLinks) {
        const val =
          sibling.getAttribute("href") ||
          sibling.getAttribute("data-href") ||
          sibling.getAttribute("data-url") ||
          sibling.getAttribute("data-id") ||
          "";
        const elId = extractListingId(val);
        if (elId) {
          uniqueIds.add(elId);
        }
      }
      
      const mainImages = parent.querySelectorAll('[aria-label*="Image principale" i]');
      
      if (uniqueIds.size > 1 || mainImages.length > 1) {
        break;
      }
      current = parent;
    }
    return current;
  }

  function extractDetailsFromCard(cardEl, href = "") {
    const text = (cardEl.innerText || cardEl.textContent || "").trim();

    // Extract price
    let price = null;
    let maxPrice = 0;
    const priceMatches = Array.from(
      text.matchAll(/(\d[\d \t\u202f\u00a0]*)\s*€/g),
    );
    for (const m of priceMatches) {
      const val = parseInt(m[1].replace(/[ \t\u202f\u00a0]/g, ""), 10);
      if (val > maxPrice) maxPrice = val;
    }
    if (maxPrice > 0) price = maxPrice;

    // Extract surface
    let surface = null;
    const surfaceM = text.match(
      /(\d[\d \t\u202f\u00a0]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/i,
    );
    if (surfaceM) {
      surface = parseFloat(surfaceM[1].replace(/[ \t\u202f\u00a0]/g, ""));
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
        const slugParts = slug.split("-");
        const last = slugParts[slugParts.length - 1];
        if (/^\d{5}$/.test(last)) {
          postal = postal || last;
        }
        const cityParts = slugParts.filter(
          (p) => !/^\d+$/.test(p) && !/^eme$/i.test(p) && !/^er$/i.test(p),
        );
        city = cityParts.join(" ").trim();
      }
    }

    return { price, surface, postal, city, cardText: text };
  }

  async function processListingCards() {
    // 1. Existing cards check
    const elements = document.querySelectorAll(
      'a, [data-href], [data-url], [data-id], [data-testid="map-card-testid"], [data-testid="map-card"], [data-test="sl.listing.card"], [data-test="sl.search.card"], [aria-label*="Image principale" i]',
    );

    for (const el of elements) {
      const isMainImage =
        el.getAttribute("aria-label") &&
        /Image principale/i.test(el.getAttribute("aria-label"));
      const isKnownCard =
        isMainImage ||
        el.getAttribute("data-testid") === "map-card-testid" ||
        el.getAttribute("data-testid") === "map-card" ||
        el.getAttribute("data-test") === "sl.listing.card" ||
        el.getAttribute("data-test") === "sl.search.card";

      const val =
        el.getAttribute("href") ||
        el.getAttribute("data-href") ||
        el.getAttribute("data-url") ||
        el.getAttribute("data-id") ||
        "";

      if (!isKnownCard && !isDetailLink(val)) {
        continue;
      }

      let cardEl = isKnownCard && !isMainImage ? el : findCardContainer(el);

      let id = extractListingId(val);
      if (!id) {
        const innerLink = cardEl.querySelector(
          "a, [data-href], [data-url], [data-id]",
        );
        if (innerLink) {
          const innerVal =
            innerLink.getAttribute("href") ||
            innerLink.getAttribute("data-href") ||
            innerLink.getAttribute("data-url") ||
            innerLink.getAttribute("data-id") ||
            "";
          id = extractListingId(innerVal);
        }
        if (!id) {
          id = "card-" + (cardEl.innerText || "").slice(0, 30).replace(/\s/g, "");
        }
      }

      if (cardEl.dataset.chhProcessed === id) {
        if (cardEl.dataset.chhMatchUrl && !cardEl.querySelector(".chh-card-chh-badge")) {
          ui.markCardAsMatched(cardEl, { url: cardEl.dataset.chhMatchUrl });
        }
        continue;
      }
      if (checkingIds.has(id)) {
        continue;
      }

      if (cardEl.querySelector(".chh-card-chh-badge")) {
        cardEl.dataset.chhProcessed = id;
        continue;
      }

      let details = extractDetailsFromCard(cardEl, val);

      let attempts = 0;
      let current = cardEl;
      while (
        !isKnownCard &&
        (!details.price || !details.surface) &&
        current.parentElement &&
        attempts < 3
      ) {
        const parent = current.parentElement;
        if (parent.tagName === "BODY" || parent.tagName === "HTML") {
          break;
        }
        const siblingLinks = parent.querySelectorAll(
          "a, [data-href], [data-url], [data-id]",
        );
        const uniqueIds = new Set();
        for (const sibling of siblingLinks) {
          const siblingVal =
            sibling.getAttribute("href") ||
            sibling.getAttribute("data-href") ||
            sibling.getAttribute("data-url") ||
            sibling.getAttribute("data-id") ||
            "";
          const siblingId = extractListingId(siblingVal);
          if (siblingId) {
            uniqueIds.add(siblingId);
          }
        }
        
        const mainImages = parent.querySelectorAll('[aria-label*="Image principale" i]');
        if (uniqueIds.size > 1 || mainImages.length > 1) {
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
        cardEl.dataset.chhProcessed = id;
        continue;
      }

      const hasEnoughData =
        (details.postal && (details.surface || details.price)) ||
        (details.surface && details.price);
        
      if (!hasEnoughData) {
        continue;
      }

      cardEl.dataset.chhProcessed = id;
      checkingIds.add(id);

      try {
        const response = await chrome.runtime.sendMessage({
          type: "CHECK_NOTION",
          payload: { ...details },
        });
        if (
          response &&
          response.ok &&
          response.result &&
          response.result.match
        ) {
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
      '.leaflet-popup-content-wrapper, .leaflet-popup, .mapboxgl-popup-content, .gm-style-iw, .gm-style-iw-c, [class*="map-popup" i], [class*="MapPopup" i]',
    );
    for (const popup of mapPopups) {
      if (popup.querySelector(".chh-card-chh-badge")) continue;

      let details = extractDetailsFromCard(popup);
      if (ui.checkAndMarkExcluded(popup, (details?.title || "") + " " + (details?.city || ""), true)) {
        continue;
      }

      const hasEnoughData =
        (details.postal && (details.surface || details.price)) ||
        (details.surface && details.price);
      if (!hasEnoughData) continue;

      const link = popup.matches("a, [data-href], [data-url], [data-id]")
        ? popup
        : popup.querySelector("a, [data-href], [data-url], [data-id]");
      let id = null;
      if (link) {
        const val =
          link.getAttribute("href") ||
          link.getAttribute("data-href") ||
          link.getAttribute("data-url") ||
          link.getAttribute("data-id") ||
          "";
        id = extractListingId(val);
      }
      if (!id)
        id = "popup-" + (popup.innerText || "").slice(0, 30).replace(/\s/g, "");

      if (checkingIds.has(id)) continue;
      checkingIds.add(id);

      try {
        const response = await chrome.runtime.sendMessage({
          type: "CHECK_NOTION",
          payload: { ...details, forceRefresh: true },
        });
        if (
          response &&
          response.ok &&
          response.result &&
          response.result.match
        ) {
          popup.dataset.chhMatchUrl = response.result.match.url;
          ui.markCardAsMatched(popup, response.result.match, true);
        } else {
        }
      } catch (err) {
      } finally {
        checkingIds.delete(id);
      }
    }
  }

  let autoLookupDone = false;
  let autoLookupInFlight = false;

  function runAutoLookup(payload) {
    if (autoLookupDone || autoLookupInFlight) return;
    autoLookupInFlight = true;

    ui.setFloatingContainerLoading("Recherche d'adresse…");

    chrome.runtime.sendMessage({ type: "LOOKUP", payload }, (response) => {
      autoLookupInFlight = false;
      autoLookupDone = true;
      if (response && response.ok && response.result) {
        if (
          response.result.candidates &&
          response.result.candidates.length > 0
        ) {
          const top = response.result.candidates[0];
          if (top.score >= 25) {
            const isLand =
              payload.kind === "land" || response.result.kind === "land";
            let addressStr;
            if (isLand) {
              addressStr =
                top.parcel.address ||
                top.parcel.street ||
                top.parcel.nom_com ||
                "Parcelle identifiée";
            } else {
              addressStr = top.record.address || "(adresse inconnue)";
            }
            if (
              addressStr &&
              addressStr !== "(adresse inconnue)" &&
              addressStr !== "Parcelle identifiée"
            ) {
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
    if (
      !payload ||
      (!payload.postal && !payload.city) ||
      (!payload.surface && !payload.price)
    ) {
      notionCheckDone = true;
      return;
    }

    notionCheckInFlight = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CHECK_NOTION",
        payload: { ...payload, isDetailPage: true },
      });
      if (response && response.ok && response.result) {
        if (response.result.active && response.result.match) {
          notionMatch = response.result.match;
          ui.setFloatingContainerChh(response.result.match);
        }
      }
    } catch (err) {
    } finally {
      notionCheckInFlight = false;
      notionCheckDone = true;
    }
  }

  async function runLookup(payload) {
    try {
      const response = await chrome.runtime.sendMessage({
        type: "LOOKUP",
        payload,
      });
      if (!response || response.ok !== true) {
        ui.showError(response?.error || "Erreur inconnue", payload);
        return;
      }
      if (payload.kind === "land" || response.result?.kind === "land") {
        ui.showLandResult(payload, response.result, () =>
          openOverride(payload),
        );
      } else {
        ui.showResult(payload, response.result, () => openOverride(payload));
      }
    } catch (err) {
      ui.showError(String(err.message || err), payload);
    }
  }

  function openOverride(payload) {
    try {
      sessionStorage.setItem(
        "chh.override.payload",
        JSON.stringify(payload),
      );
    } catch {}
    alert(
      "Ouvrez l’extension (icône dans la barre) pour modifier les champs et relancer la recherche.",
    );
  }

  async function onButtonClick() {
    try {
      ui.showLoading({
        postal: null,
        surface: null,
        energyClass: null,
        gesClass: null,
      });
      let payload = tryExtract();
      let attempts = 1;
      while (
        (!payload || !payload.surface || !payload.postal) &&
        attempts < 4
      ) {
        await new Promise((r) => setTimeout(r, 350));
        const next = tryExtract();
        if (next) payload = { ...(payload || {}), ...next };
        attempts++;
      }
      if (!payload || !payload.surface || !payload.postal) {
        ui.showError(
          "Impossible d'extraire les données DPE de cette page. Utilisez l’extension (icône) pour saisir manuellement.",
          payload,
        );
        return;
      }
      if (payload.kind === "land") {
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
      ui.showError("Erreur: " + (err.message || String(err)), null);
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
      payload = { url: location.href, siteName: 'SeLoger', title: document.title };
    } else {
      payload.url = payload.url || location.href;
      payload.siteName = payload.siteName || 'SeLoger';
      payload.title = payload.title || document.querySelector('h1')?.textContent || document.title || '';
      payload.imageUrl = payload.imageUrl || document.querySelector('img[src*="seloger"]')?.src || null;
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
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
    ui.resetFloatingButton();
    setTimeout(init, 200);
  });
})();
