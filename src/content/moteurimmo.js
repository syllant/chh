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
    const search = window.location.search;
    const hash = window.location.hash;

    if (
      path.includes('/annonce/') ||
      path.includes('/annonces/') ||
      path.includes('/detail/') ||
      search.includes('annonce=') ||
      hash.includes('annonce=')
    ) {
      return true;
    }

    // Modal or drawer detail view detection
    const modalEl = document.querySelector(
      '.modal.is-active, [class*="modal-card"], [class*="detailContainer"], [class*="drawer"], [class*="ad-detail"], [class*="AdDetail"]'
    );
    return !!modalEl;
  }

  // ── 1. Data Extraction from JSON-LD / Config / DOM ───────────────────────

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
          if (
            /realestatelisting|residence|house|apartment|singlefamily|realestate|product|place|listing/i.test(
              typeStr
            ) ||
            item.address ||
            item.offers
          ) {
            const offers = item.offers || {};
            const price =
              typeof offers.price === 'number'
                ? offers.price
                : offers.price
                ? parseInt(String(offers.price).replace(/\D/g, ''), 10)
                : null;

            const address = item.address || {};
            const postal = ex.normalizePostal(address.postalCode);
            const city = address.addressLocality || null;
            const surface = item.floorSize?.value
              ? ex.normalizeSurface(item.floorSize.value)
              : item.livingArea?.value
              ? ex.normalizeSurface(item.livingArea.value)
              : null;

            const isLand =
              /terrain|land/i.test(item.name || typeStr) ||
              /\bterrain[s]?\b/i.test(document.title);
            const rooms = item.numberOfRooms
              ? parseInt(String(item.numberOfRooms), 10) || null
              : null;

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
              siteName: 'MoteurImmo',
              source: 'moteurimmo-jsonld'
            };
          }
        }
      } catch {}
    }
    return null;
  }

  function extractFromNextOrState() {
    const script = document.getElementById('__NEXT_DATA__') || document.getElementById('__NUXT__');
    if (script && script.textContent) {
      try {
        const json = JSON.parse(script.textContent);
        const ad = ex.deepFind(
          json,
          (n) =>
            n &&
            typeof n === 'object' &&
            (('surface' in n && ('zip' in n || 'postalCode' in n || 'city' in n)) ||
              ('price' in n && 'surface' in n) ||
              ('prix' in n && 'superficie' in n))
        );
        if (ad) {
          const priceRaw = ad.price ?? ad.prix ?? ad.priceAmount;
          const price = priceRaw ? parseInt(String(priceRaw).replace(/\D/g, ''), 10) : null;
          const postal = ex.normalizePostal(ad.postalCode ?? ad.zipCode ?? ad.cp ?? ad.zip);
          const city = ad.city ?? ad.ville ?? ad.commune ?? null;
          const isLand = /terrain|land/i.test(ad.propertyType ?? ad.type ?? ad.title ?? '');
          const surface = isLand
            ? null
            : ex.normalizeSurface(ad.surface ?? ad.superficie ?? ad.surfaceArea);
          const landSurface = isLand
            ? ex.normalizeLandSurface(ad.surface ?? ad.superficie ?? ad.landSurface)
            : null;
          const buildingType = ex.normalizePropertyType(ad.propertyType ?? ad.type ?? ad.title);
          const energyClass = ex.normalizeClass(ad.energyClass ?? ad.dpe ?? ad.dpeClass);
          const gesClass = ex.normalizeClass(ad.gesClass ?? ad.ges);

          return {
            kind: isLand ? 'land' : 'dpe',
            postal,
            city,
            surface,
            landSurface,
            price,
            energyClass,
            gesClass,
            buildingType,
            title: ad.title ?? document.title ?? '',
            description: ad.description ?? null,
            url: location.href,
            siteName: 'MoteurImmo',
            source: 'moteurimmo-state'
          };
        }
      } catch {}
    }
    return null;
  }

  function extractFromDom() {
    const modalEl = document.querySelector(
      '.modal.is-active, [class*="modal-card"], [class*="detailContainer"], [class*="drawer"], [class*="ad-detail"], [class*="AdDetail"]'
    );
    const root = modalEl || document;

    const title =
      root.querySelector('h1, h2, [class*="title"], [class*="Title"]')?.textContent ||
      document.title ||
      '';
    const metaDesc =
      document.querySelector('meta[name="description"]')?.getAttribute('content') ||
      document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      '';
    const descText =
      root.querySelector('[class*="description"], [class*="Description"], .content')?.innerText ||
      metaDesc;

    const fullText = (root.innerText || document.body?.innerText || '').replace(
      /m\s*([²2])/gi,
      'm2'
    );

    let price = null;
    const priceEl = root.querySelector(
      '[class*="price"], [class*="prix"], [data-testid*="price"], .price-budget'
    );
    if (priceEl) {
      const pM = priceEl.textContent.match(/(\d[\d \t\u202f\u00a0]*)\s*€/);
      if (pM) price = parseInt(pM[1].replace(/[ \t\u202f\u00a0]/g, ''), 10);
    }
    if (!price) {
      const priceMatches = Array.from(
        fullText.matchAll(/(\d[\d \t\u202f\u00a0.]*)\s*€(?!\s*\/\s*m)/gi)
      );
      let maxPrice = 0;
      for (const m of priceMatches) {
        const val = parseInt(m[1].replace(/[ \t\u202f\u00a0.]/g, ''), 10);
        if (val > maxPrice && val < 50000000) maxPrice = val;
      }
      if (maxPrice > 0) price = maxPrice;
    }

    let postal = null;
    let city = null;

    const pM = fullText.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\s*\((\d{5})\)/);
    if (pM) {
      city = pM[1].trim();
      postal = pM[2];
    }

    if (!postal) {
      const postM = fullText.match(/\b(\d{5})\b/);
      if (postM) postal = postM[1];
    }

    if (!city) {
      const urlCityM = location.pathname.match(/\/([a-z\-]+)-(\d{5})/i);
      if (urlCityM) {
        city = urlCityM[1].replace(/-/g, ' ').toUpperCase();
        if (!postal) postal = urlCityM[2];
      }
    }

    let surface = null;
    const surfM = fullText.match(
      /(\d[\d \t\u202f\u00a0.]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/i
    );
    if (surfM) {
      surface = ex.normalizeSurface(surfM[1].replace(/[ \t\u202f\u00a0.]/g, ''));
    }

    let energyClass = null;
    let gesClass = null;

    const dpeM = fullText.match(/\bDPE\s*[:\s]?\s*([A-G])\b/i);
    if (dpeM) energyClass = ex.normalizeClass(dpeM[1]);

    const gesM = fullText.match(/\bGES\s*[:\s]?\s*([A-G])\b/i);
    if (gesM) gesClass = ex.normalizeClass(gesM[1]);

    const isLand =
      /\bterrain[s]?\b/i.test(title) ||
      /\bterrain[s]?\b/i.test(fullText.slice(0, 500)) ||
      /\/terrain/i.test(location.pathname);
    const buildingType = ex.normalizePropertyType(title) || ex.normalizePropertyType(fullText);
    const dateParsed = ex.extractDateFromText(descText);
    const dateRange = ex.parseDateRange(dateParsed);
    const isNewBuild = /neuf|vefa/i.test(descText || title);

    const imageUrl =
      document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;

    if (isLand) {
      return {
        kind: 'land',
        postal,
        city,
        surface: ex.normalizeLandSurface(surface),
        price,
        title,
        url: location.href,
        siteName: 'MoteurImmo',
        imageUrl,
        description: descText.slice(0, 2000) || null,
        section: ex.normalizeSection(descText),
        source: 'moteurimmo-dom'
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
      title,
      url: location.href,
      siteName: 'MoteurImmo',
      imageUrl,
      description: descText.slice(0, 2000) || null,
      source: 'moteurimmo-dom'
    };
  }

  function tryExtract() {
    const jsonLd = extractFromJsonLd();
    const stateData = extractFromNextOrState();
    const domData = extractFromDom();

    let merged = ex.mergePayloads
      ? ex.mergePayloads(stateData, jsonLd)
      : { ...(jsonLd || {}), ...(stateData || {}) };
    merged = ex.mergePayloads
      ? ex.mergePayloads(merged, domData)
      : { ...(domData || {}), ...(merged || {}) };

    if (merged && (merged.postal || merged.city) && (merged.surface || merged.price)) {
      return merged;
    }
    return null;
  }

  // ── 2. Search Result Cards Extraction ────────────────────────────────────

  function extractDetailsFromCard(cardEl, href = '') {
    let price = null;
    let surface = null;
    let landSurface = null;
    let postal = null;
    let city = null;

    const rawText = cardEl.innerText || cardEl.textContent || '';
    const cardText = rawText.replace(/m\s*([²2])/gi, 'm2');

    // Extract price (ignoring struck-through old prices)
    const clone = cardEl.cloneNode(true);
    const struck = clone.querySelectorAll(
      'del, s, strike, [style*="line-through" i], [class*="line-through" i], [class*="old" i], [class*="barre" i], [class*="previous" i]'
    );
    struck.forEach((s) => s.remove());
    const cleanCardText = (clone.innerText || clone.textContent || '').replace(
      /m\s*([²2])/gi,
      'm2'
    );

    const priceEl = clone.querySelector(
      '[class*="price" i]:not([class*="line-through" i]):not([class*="old" i]), [class*="prix" i]:not([class*="barre" i]), .price-budget, [data-testid*="price" i]'
    );
    if (priceEl) {
      const pM = priceEl.textContent.match(/(\d[\d \t\u202f\u00a0.]*)\s*€(?!\s*\/\s*m)/i);
      if (pM) {
        const val = parseInt(pM[1].replace(/[ \t\u202f\u00a0.]/g, ''), 10);
        if (val > 10000 && val < 50000000) price = val;
      }
    }
    if (!price || price <= 0) {
      const priceMatches = Array.from(
        cleanCardText.matchAll(/(\d[\d \t\u202f\u00a0.]*)\s*€(?!\s*\/\s*m)/gi)
      );
      for (const m of priceMatches) {
        const val = parseInt(m[1].replace(/[ \t\u202f\u00a0.]/g, ''), 10);
        if (val > 10000 && val < 50000000) {
          price = val;
          break;
        }
      }
    }

    // Surface (distinguishing living surface vs land surface)
    let livingSurfFromDom = null;

    // Direct standalone surface badge scan (e.g. bottom surface box "215 m²")
    const boxNodes = cardEl.querySelectorAll('div, span, p, b, strong');
    for (const box of boxNodes) {
      if (box.children.length > 2) continue;
      const txt = (box.textContent || '').trim();
      const m = txt.match(/^\s*(\d[\d \t\u202f\u00a0.]*)\s*(?:m(?:²|2))\s*$/i);
      if (m) {
        const val = Math.round(parseFloat(m[1].replace(',', '.').replace(/[ \t\u202f\u00a0.]/g, '')));
        if (!isNaN(val) && val > 0 && val < 10000) {
          const html = box.outerHTML || '';
          const isTerrain =
            /\b(terrain|land|tree|seedling)\b/i.test(html) ||
            box.querySelector('[class*="tree" i], [class*="terrain" i], [class*="land" i]');
          if (isTerrain) {
            if (!landSurface) landSurface = val;
          } else {
            livingSurfFromDom = val;
          }
        }
      }
    }

    if (!livingSurfFromDom) {
      const livingSurfEl = cardEl.querySelector(
        '[class*="surface" i]:not([class*="terrain" i]):not([class*="land" i]), [data-field="surface"]'
      );
      if (livingSurfEl) {
        const sM = livingSurfEl.textContent.match(/(\d[\d \t\u202f\u00a0.]*)/);
        if (sM) {
          const parsedSurf = parseFloat(sM[1].replace(',', '.').replace(/[ \t\u202f\u00a0.]/g, ''));
          if (!isNaN(parsedSurf) && parsedSurf > 0) livingSurfFromDom = Math.round(parsedSurf);
        }
      }
    }

    const landSurfEl = cardEl.querySelector(
      '[class*="terrain" i], [class*="land" i], [data-field="terrain"]'
    );
    if (landSurfEl) {
      const lM = landSurfEl.textContent.match(/(\d[\d \t\u202f\u00a0.]*)/);
      if (lM) {
        const parsedLand = parseFloat(lM[1].replace(',', '.').replace(/[ \t\u202f\u00a0.]/g, ''));
        if (!isNaN(parsedLand) && parsedLand > 0) landSurface = Math.round(parsedLand);
      }
    }

    const allSurfMatches = Array.from(
      cardText.matchAll(/(\d[\d \t\u202f\u00a0.]*)\s*(?:m(?:²|2)|mètres?\s*carrés?|etres?\s*carres?)(?!\d)/gi)
    );

    for (const m of allSurfMatches) {
      const val = Math.round(parseFloat(m[1].replace(',', '.').replace(/[ \t\u202f\u00a0.]/g, '')));
      if (isNaN(val) || val <= 0) continue;

      const matchIdx = m.index || 0;
      const contextBefore = cardText.slice(Math.max(0, matchIdx - 35), matchIdx).toLowerCase();
      const contextAfter = cardText.slice(matchIdx + m[0].length, matchIdx + m[0].length + 35).toLowerCase();
      const fullContext = contextBefore + ' ' + contextAfter;

      const isTerrain =
        /\b(terrain|parcelle|jardin|foncier|cadastre|lot)\b/.test(fullContext) ||
        /terrain\s*(?:de\s*)?$/i.test(contextBefore) ||
        /^\s*(?:de\s*)?terrain/i.test(contextAfter);

      const isHabitable =
        /\b(habitable|habitables|hab|carrez|utile|vivable)\b/.test(fullContext) ||
        /^\s*habitables?/i.test(contextAfter);

      if (isTerrain && !landSurface) {
        landSurface = val;
      } else if (isHabitable && !surface) {
        surface = val;
      } else if (!surface && !isTerrain) {
        surface = val;
      }
    }

    if (livingSurfFromDom) {
      surface = livingSurfFromDom;
    }

    // Location
    const pM = cardText.match(/([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\s*\((\d{5})\)/);
    if (pM) {
      city = pM[1].trim();
      postal = pM[2];
    } else {
      const cityPostM =
        cardText.match(/\b(\d{5})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\b/) ||
        cardText.match(/\b([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\-' ]{1,40})\s+(\d{5})\b/);
      if (cityPostM) {
        if (/^\d{5}$/.test(cityPostM[1])) {
          postal = cityPostM[1];
          city = cityPostM[2].trim();
        } else {
          city = cityPostM[1].trim();
          postal = cityPostM[2];
        }
      } else {
        const postM = cardText.match(/\b(\d{5})\b/);
        if (postM) postal = postM[1];
      }
    }

    const targetUrl = href || cardEl.getAttribute('data-href') || '';
    if (targetUrl) {
      const urlM =
        targetUrl.match(/\/([a-z\-]+)-(\d{5})\//i) || targetUrl.match(/\/([a-z\-]+)-(\d{5})\b/i);
      if (urlM) {
        if (!postal) postal = urlM[2];
        if (!city) city = urlM[1].replace(/-/g, ' ').toUpperCase();
      }
    }

    return { price, surface, landSurface, postal, city, cardText };
  }

  function isRealAdCard(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (
      el.tagName === 'BODY' ||
      el.tagName === 'MAIN' ||
      el.id === 'root' ||
      el.id === 'app' ||
      el.tagName === 'HEADER' ||
      el.tagName === 'NAV' ||
      el.tagName === 'FOOTER'
    ) {
      return false;
    }

    if (
      el.closest(
        'header, nav, footer, [class*="navbar" i], [class*="header" i], [class*="footer" i], [class*="stats" i], [class*="statistique" i]'
      )
    ) {
      return false;
    }

    const text = (el.innerText || el.textContent || '').trim();
    if (text.length < 20 || text.length > 8000) return false;

    const hasPrice = text.includes('€');
    const hasSurfaceOrLocation = text.includes('m²') || text.includes('m2') || /\b\d{5}\b/.test(text);

    return hasPrice && hasSurfaceOrLocation;
  }

  function findCardContainer(el) {
    if (!el) return null;
    let card = el.closest(
      'article, tr, [data-annonce-id], [data-id], .box, [class*="annonce-card" i], [class*="listing-card" i], [class*="property-card" i], [class*="ad-card" i], [class*="annonce-item" i]'
    );

    // Fallback: ascend until card container has both price and surface/location
    if (!card) {
      let p = el;
      while (p && p.parentElement && p.parentElement !== document.body) {
        const txt = p.innerText || p.textContent || '';
        if (txt.includes('€') && (txt.includes('m²') || txt.includes('m2') || /\(\d{5}\)/.test(txt))) {
          card = p;
          break;
        }
        p = p.parentElement;
      }
    }

    if (card) {
      let parent = card.parentElement;
      while (parent && parent !== document.body) {
        if (
          parent.tagName === 'BODY' ||
          parent.tagName === 'MAIN' ||
          parent.id === 'root' ||
          parent.id === 'app'
        ) {
          break;
        }
        const childCards = parent.querySelectorAll(
          'article, .box, [class*="annonce-card" i], [class*="property-card" i]'
        );
        if (childCards.length > 1) {
          break;
        }
        card = parent;
        parent = parent.parentElement;
      }
    }

    return card || el;
  }

  function getCardIdentifier(cardEl, href = '') {
    if (href && !href.includes('/recherche') && !href.includes('/search')) {
      return href.split('?')[0].split('#')[0];
    }
    const dataId =
      cardEl.getAttribute('data-id') ||
      cardEl.getAttribute('data-annonce-id') ||
      cardEl.getAttribute('data-key') ||
      cardEl.getAttribute('id');
    if (dataId && dataId !== 'root' && dataId !== 'app') {
      return 'card-id-' + dataId;
    }

    const text = (cardEl.innerText || cardEl.textContent || '').replace(/\s+/g, ' ').trim();
    const priceM = text.match(/(\d[\d \t\u202f\u00a0.]*)\s*€/);
    const surfM = text.match(/(\d[\d \t\u202f\u00a0.]*)\s*(?:m(?:²|2))/i);
    const titleEl = cardEl.querySelector('h1, h2, h3, h4, [class*="title" i], [class*="titre" i]');
    const titleText = titleEl ? titleEl.textContent.trim() : text.slice(0, 40);

    const fp = [
      titleText,
      priceM ? priceM[1].replace(/\D/g, '') : '',
      surfM ? surfM[1].replace(/\D/g, '') : '',
      text.slice(0, 50)
    ]
      .filter(Boolean)
      .join('_');

    return 'card-fp-' + fp;
  }

  let isProcessingCards = false;

  async function processListingCards() {
    if (isProcessingCards) return;
    isProcessingCards = true;
    try {
      const candidateElements = Array.from(
        document.querySelectorAll(
          'article, [class*="annonce-card" i], [class*="listing-card" i], [class*="property-card" i], [class*="ad-card" i], .box, [data-id], [data-annonce-id], a[href*="/annonce"], a[href*="/annonces"], a[href*="leboncoin"], a[href*="seloger"], a[href*="bienici"], a[href*="bellesdemeures"], a[href*="figaro"], a[href*="paruvendu"], a[href*="pap.fr"]'
        )
      );

      const validElements = candidateElements.filter(isRealAdCard);


      const processedCards = new Set();

      for (const el of validElements) {
        const href = el.getAttribute('href') || el.getAttribute('data-href') || '';
        const cardEl = findCardContainer(el);
        if (!cardEl || !isRealAdCard(cardEl)) continue;

        const cleanVal = getCardIdentifier(cardEl, href);
        if (!cleanVal || processedCards.has(cleanVal)) continue;

        if (
          cardEl.dataset.chhProcessed === cleanVal ||
          el.dataset.chhProcessed === cleanVal
        ) {
          continue;
        }

        if (
          cardEl.dataset.chhHasBadge ||
          cardEl.querySelector('.chh-card-chh-badge') ||
          cardEl.closest('.chh-card-has-badge')
        ) {
          el.dataset.chhProcessed = cleanVal;
          cardEl.dataset.chhProcessed = cleanVal;
          processedCards.add(cleanVal);
          continue;
        }

        const details = extractDetailsFromCard(cardEl, href);

          cleanVal,
          price: details.price,
          surface: details.surface,
          landSurface: details.landSurface,
          postal: details.postal,
          city: details.city,
          href
        });

        if (
          ui.checkAndMarkExcluded(
            cardEl,
            (details?.title || '') + ' ' + (details?.city || '') + ' ' + (details?.cardText || '')
          )
        ) {
          el.dataset.chhProcessed = cleanVal;
          cardEl.dataset.chhProcessed = cleanVal;
          processedCards.add(cleanVal);
          continue;
        }

        if (
          (details.postal && (details.surface || details.price)) ||
          (details.surface && details.price)
        ) {
          el.dataset.chhProcessed = cleanVal;
          cardEl.dataset.chhProcessed = cleanVal;
          processedCards.add(cleanVal);
          try {
            const response = await chrome.runtime.sendMessage({
              type: 'CHECK_NOTION',
              payload: details
            });
            if (response && response.ok && response.result && response.result.match) {
              ui.markCardAsMatched(cardEl, response.result.match);
            } else {
            }
          } catch (err) {
          }
        } else {
        }
      }
    } finally {
      isProcessingCards = false;
    }
  }

  // ── 3. Main Overlay / Lookup Orchestration ───────────────────────────────

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
              addressStr =
                top.parcel.address || top.parcel.street || top.parcel.nom_com || 'Parcelle identifiée';
            } else {
              addressStr = top.record.address || '(adresse inconnue)';
            }
            if (
              addressStr &&
              addressStr !== '(adresse inconnue)' &&
              addressStr !== 'Parcelle identifiée'
            ) {
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

    if (
      STATE.injectedFor === location.href &&
      document.querySelector('.chh-floating-container')
    ) {
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
        const resp = await chrome.runtime.sendMessage({
          type: 'CHECK_NOTION',
          payload: matchDetails
        });
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

  let domObserver = null;

  function setupDOMObserver() {
    if (domObserver) domObserver.disconnect();
    domObserver = new MutationObserver(() => {
      processListingCards();
    });
    domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
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
    registerInterval(processListingCards, 1000);
    setupDOMObserver();

    window.addEventListener(
      'scroll',
      () => {
        requestAnimationFrame(processListingCards);
      },
      { passive: true }
    );
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
