/**
 * Notion API client & matcher for property items.
 */

// Helper to extract values from Notion properties depending on their type
export function getPropertyValue(property) {
  if (!property) return null;
  switch (property.type) {
    case 'number':
      return property.number;
    case 'rich_text':
      return property.rich_text && Array.isArray(property.rich_text)
        ? property.rich_text.map(t => t.plain_text).join('').trim()
        : null;
    case 'title':
      return property.title && Array.isArray(property.title)
        ? property.title.map(t => t.plain_text).join('').trim()
        : null;
    case 'select':
      return property.select ? property.select.name : null;
    case 'multi_select':
      return property.multi_select ? property.multi_select.map(s => s.name).join(', ') : null;
    case 'url':
      return property.url;
    case 'phone_number':
      return property.phone_number;
    case 'email':
      return property.email;
    case 'formula':
      if (!property.formula) return null;
      const f = property.formula;
      return f[f.type]; // returns f.string, f.number, f.boolean, f.date
    case 'rollup':
      if (!property.rollup || !Array.isArray(property.rollup.array)) return null;
      return property.rollup.array
        .map(item => getPropertyValue(item))
        .filter(val => val !== null && val !== undefined)
        .join(', ')
        .trim();
    case 'place':
      return property.place ? (property.place.address || property.place.name || null) : null;
    default:
      return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Délai d'attente réseau dépassé (8s) lors du requêtage de l'API Notion.`);
    }
    throw err;
  }
}

export async function fetchNotionPage(token, pageId) {
  const res = await fetchWithTimeout(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch Notion page ${pageId}: ${res.status}`);
  }
  return await res.json();
}

/**
 * Patches (updates) properties on an existing Notion page.
 * @param {string} token - Notion API secret
 * @param {string} pageId - Page ID to update
 * @param {object} properties - Notion API properties object (already typed, e.g. { "Derni\u00e8re vente": { number: 594357 } })
 */
export async function patchNotionPage(token, pageId, properties) {
  const res = await fetchWithTimeout(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to patch Notion page ${pageId}: ${res.status} — ${errText}`);
  }
  return await res.json();
}


/**
 * Fetches all database items from Notion database
 * @param {string} token Notion API secret token
 * @param {string} databaseId Notion Database ID
 * @returns {Promise<Array>} List of simplified parsed records
 */
export async function fetchNotionDatabase(token, databaseId, mappings = {}) {
  // If a mapping is explicitly empty string, it means it's disabled.
  // If it's undefined (not saved yet), we fallback to defaults for backward compatibility.
  const priceProp = mappings.price !== undefined ? mappings.price : 'Prix';
  const surfaceProp = mappings.surface !== undefined ? mappings.surface : 'Surface';
  const otherSurfacesProp = mappings.otherSurfaces !== undefined ? mappings.otherSurfaces : 'Autre surface';
  const postalProp = mappings.postal !== undefined ? mappings.postal : 'Code postal';
  const cityProp = mappings.city !== undefined ? mappings.city : 'Ville';
  const prevPricesProp = mappings.prevPrices !== undefined ? mappings.prevPrices : 'Prix précédents';
  const addressProp = mappings.address !== undefined ? mappings.address : 'Adresse';
  const lastSaleProp = mappings.lastSale !== undefined ? mappings.lastSale : 'Dernière vente';

  let results = [];
  let hasMore = true;
  let nextCursor = undefined;

  const dbId = formatNotionId(databaseId);
  while (hasMore) {
    const body = {
      page_size: 100,
    };
    if (nextCursor) {
      body.start_cursor = nextCursor;
    }

    const res = await fetchWithTimeout(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Notion API returned status ${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (data.results && Array.isArray(data.results)) {
      for (const page of data.results) {
        const props = page.properties || {};
        
        const getPropValueCaseInsensitive = (name) => {
          if (!name) return null;
          const lower = name.toLowerCase();
          for (const key of Object.keys(props)) {
            if (key.toLowerCase() === lower) {
              return getPropertyValue(props[key]);
            }
          }
          return null;
        };
        
        const rawPrice = priceProp ? getPropValueCaseInsensitive(priceProp) : null;
        const rawSurface = surfaceProp ? getPropValueCaseInsensitive(surfaceProp) : null;
        const rawOtherSurfaces = otherSurfacesProp ? getPropValueCaseInsensitive(otherSurfacesProp) : null;
        const rawPostal = postalProp ? getPropValueCaseInsensitive(postalProp) : null;
        const rawCity = cityProp ? getPropValueCaseInsensitive(cityProp) : null;
        const rawPrevPrices = prevPricesProp ? getPropValueCaseInsensitive(prevPricesProp) : null;
        const rawAddress = addressProp ? getPropValueCaseInsensitive(addressProp) : null;

        // Last sale: human-readable rich_text e.g. "594 357 € (17/04/2018)" or just "594 357 €"
        let lastSalePrice = null;
        let lastSaleDate = null;
        if (lastSaleProp) {
          const rawLastSale = getPropValueCaseInsensitive(lastSaleProp);
          if (rawLastSale !== null && rawLastSale !== undefined) {
            const str = String(rawLastSale).trim();
            // Extract price: digits before "€"
            const priceMatch = str.match(/([\d\s\u202f\u00a0]+)\s*€/);
            if (priceMatch) {
              lastSalePrice = parseFloat(priceMatch[1].replace(/[\s\u202f\u00a0]/g, '')) || null;
            }
            // Extract date: inside parentheses, French format dd/mm/yyyy
            const dateMatch = str.match(/\((\d{1,2})\/(\d{1,2})\/(\d{4})\)/);
            if (dateMatch) {
              // Convert dd/mm/yyyy → ISO yyyy-mm-dd for internal consistency
              lastSaleDate = `${dateMatch[3]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[1]).padStart(2, '0')}`;
            }
          }
        }

        let previousPrices = [];
        if (prevPricesProp && rawPrevPrices) {
          const parts = String(rawPrevPrices).split(/[,;\/]/);
          for (const part of parts) {
            const cleaned = part.replace(/\D/g, '');
            if (cleaned) {
              const val = parseInt(cleaned, 10);
              if (!isNaN(val)) {
                previousPrices.push(val);
              }
            }
          }
        }

        let otherSurfaces = [];
        if (otherSurfacesProp && rawOtherSurfaces) {
          const parts = String(rawOtherSurfaces).split(/[,;\/]/);
          for (const part of parts) {
            const cleaned = part.replace(',', '.').replace(/[^\d.]/g, '');
            if (cleaned) {
              const val = parseFloat(cleaned);
              if (!isNaN(val)) {
                otherSurfaces.push(val);
              }
            }
          }
        }

        // Extract listing URL from any URL / Portal URL / Annonce property
        let listingUrl = null;
        for (const [key, propObj] of Object.entries(props)) {
          if (propObj.type === 'url' && propObj.url) {
            listingUrl = propObj.url;
            break;
          }
        }
        if (!listingUrl) {
          for (const [key, propObj] of Object.entries(props)) {
            if (/url|annonce|lien|portal/i.test(key)) {
              const val = getPropertyValue(propObj);
              if (val && /^https?:\/\//i.test(String(val))) {
                listingUrl = String(val).trim();
                break;
              }
            }
          }
        }

        results.push({
          id: page.id,
          url: page.url,
          listingUrl: listingUrl || undefined,
          price: priceProp ? (rawPrice ? parseInt(String(rawPrice).replace(/\D/g, ''), 10) : null) : undefined,
          surface: surfaceProp ? (rawSurface ? parseFloat(String(rawSurface)) : null) : undefined,
          otherSurfaces: otherSurfacesProp ? otherSurfaces : undefined,
          rawOtherSurfaces: rawOtherSurfaces || undefined,
          postal: postalProp ? (rawPostal ? String(rawPostal).replace(/\D/g, '') : null) : undefined,
          city: cityProp ? (rawCity ? String(rawCity).trim() : null) : undefined,
          address: addressProp ? (rawAddress ? String(rawAddress).trim() : null) : undefined,
          isNotionAddress: !!(addressProp && rawAddress && String(rawAddress).trim()),
          previousPrices: prevPricesProp ? previousPrices : undefined,
          rawPrevPrices: rawPrevPrices || undefined,
          lastSalePrice: lastSaleProp ? lastSalePrice : undefined,
          lastSaleDate: lastSaleProp ? lastSaleDate : undefined,
        });
      }
    }

    hasMore = data.has_more;
    nextCursor = data.next_cursor;
  }

  return results;
}

export function extractListingId(url) {
  if (!url) return null;
  const clean = String(url).split('?')[0].split('#')[0];

  // 1. Leboncoin: /ad/.../12345678, /vi/12345678.htm, /locations/12345678, /ventes_immobilieres/12345678
  const lbcMatch = clean.match(/\/(?:ad|vi|locations|ventes_immobilieres)\/(?:[^\/]+\/)*(\d{5,})(?:\.htm)?$/i) || clean.match(/\/(\d{6,})(?:\.htm)?$/i);
  if (lbcMatch) return lbcMatch[1];

  // 2. Standard portal path end: /annonce/.../12345678 or /realEstateAd/.../12345678
  const annonceMatch = clean.match(/\/(?:annonce|annonces|realEstateAd|detail|a)\/(?:[^\/]+\/)*([^\/]+?)(?:\.html?|\.php)?$/i);
  if (annonceMatch) return annonceMatch[1];

  // 3. Fallback: match any 6+ digit ID in path
  const digitMatch = clean.match(/\/(\d{6,})/);
  if (digitMatch) return digitMatch[1];

  return null;
}

export function findNotionMatch(payload, notionItems) {
  if (!payload || !Array.isArray(notionItems) || notionItems.length === 0) {
    return null;
  }

  const payloadPrice = payload.price ? parseInt(String(payload.price).replace(/\D/g, ''), 10) : null;
  const payloadSurface = payload.surface ? parseFloat(String(payload.surface)) : null;
  const payloadPostal = payload.postal ? String(payload.postal).replace(/\D/g, '') : null;
  const payloadCity = payload.city ? String(payload.city).trim() : null;

  const payloadUrlClean = payload.url ? payload.url.split('?')[0].split('#')[0] : null;
  const payloadListingId = extractListingId(payload.url);

  // 1. Priority 1: Exact URL or Listing ID Match
  if (payloadUrlClean || payloadListingId) {
    for (const item of notionItems) {
      if (item.listingUrl) {
        const itemUrlClean = String(item.listingUrl).split('?')[0].split('#')[0];
        const itemListingId = extractListingId(item.listingUrl);
        if (payloadUrlClean && itemUrlClean === payloadUrlClean) {
          return item;
        }
        if (payloadListingId && itemListingId && payloadListingId === itemListingId) {
          return item;
        }
        if (payloadListingId && itemUrlClean.includes(payloadListingId)) {
          return item;
        }
      }
    }
  }

  // Require at least one numeric identifying metric from payload
  if (payloadPrice === null && payloadSurface === null) {
    return null;
  }

  const cardTextNormal = payload.cardText ? normalizeString(payload.cardText) : '';

  let bestMatch = null;
  let bestScore = -1;

  for (const item of notionItems) {
    let hasNumericMatch = false;

    // 1. Price check
    // If listing has a price, and Notion item has a price set, they MUST match.
    if (payloadPrice !== null) {
      if (item.price !== undefined && item.price !== null) {
        const matchMainPrice = item.price === payloadPrice;
        const matchPrevPrice = Array.isArray(item.previousPrices) && item.previousPrices.includes(payloadPrice);
        if (!matchMainPrice && !matchPrevPrice) {
          continue; // Price explicitly set in Notion, but differs from listing
        }
        hasNumericMatch = true;
      }
    }

    // 2. Surface check
    // If listing has a surface, and Notion item has a surface set, they MUST match.
    // DO NOT add a ±1 m² tolerance here — each portal may report slightly different
    // surfaces for the same property. The correct approach is to store the alternate
    // value in the "Autre surface" (otherSurfaces) field in Notion, and the alternate
    // price in "Prix précédents" (previousPrices). Matching is always exact.
    if (payloadSurface !== null) {
      if (item.surface !== undefined && item.surface !== null) {
        const matchMainSurface = item.surface === payloadSurface;
        const matchOtherSurface = Array.isArray(item.otherSurfaces) && item.otherSurfaces.includes(payloadSurface);
        if (!matchMainSurface && !matchOtherSurface) {
          continue; // Surface explicitly set in Notion, but differs from listing
        }
        hasNumericMatch = true;
      }
    }

    // If Notion item specifies BOTH price and surface, do NOT match if listing is missing surface (payloadSurface === null)
    if (item.price != null && item.surface != null) {
      if (payloadSurface === null && payloadPrice !== null) {
        continue;
      }
    }

    // Must have at least one numeric match (price or surface)
    if (!hasNumericMatch) {
      continue;
    }

    // 3. Location check (postal and/or city)
    const hasNotionPostal = item.postal !== undefined && item.postal !== null && String(item.postal).trim() !== '';
    const hasNotionCity = item.city !== undefined && item.city !== null && String(item.city).trim() !== '';
    const hasNotionLocation = hasNotionPostal || hasNotionCity;

    let score = 0;

    if (hasNotionLocation) {
      // Reject explicit postal code mismatch (allowing same city/dept district variants like 34000 vs 34090)
      if (payloadPostal !== null && hasNotionPostal) {
        const itemPostalNormal = String(item.postal).replace(/\D/g, '');
        if (itemPostalNormal !== payloadPostal) {
          const sameDept = itemPostalNormal.slice(0, 2) === payloadPostal.slice(0, 2);
          const cityMatches =
            (hasNotionCity && payloadCity)
              ? (normalizeString(item.city) === normalizeString(payloadCity) || shareSignificantWord(item.city, payloadCity))
              : (hasNotionCity && (cardTextNormal && shareSignificantWord(item.city, payload.cardText)));
          if (!sameDept || !cityMatches) {
            continue; // Real postal mismatch
          }
        }
      }

      // Reject explicit city mismatch
      if (payloadCity !== null && hasNotionCity) {
        const itemCityNormal = normalizeString(item.city);
        const payloadCityNormal = normalizeString(payloadCity);
        if (payloadCityNormal !== itemCityNormal && !shareSignificantWord(item.city, payloadCity)) {
          continue; // City mismatch
        }
      }

      let locationMatch = false;

      // Check postal code
      if (hasNotionPostal) {
        const itemPostalNormal = String(item.postal).replace(/\D/g, '');
        if (payloadPostal !== null) {
          if (itemPostalNormal === payloadPostal) {
            locationMatch = true;
          } else if (itemPostalNormal.slice(0, 2) === payloadPostal.slice(0, 2)) {
            const cityMatches =
              (hasNotionCity && payloadCity)
                ? (normalizeString(item.city) === normalizeString(payloadCity) || shareSignificantWord(item.city, payloadCity))
                : (hasNotionCity && (cardTextNormal && shareSignificantWord(item.city, payload.cardText)));
            if (cityMatches) {
              locationMatch = true;
            }
          }
        } else if (cardTextNormal && cardTextNormal.includes(itemPostalNormal)) {
          locationMatch = true;
        }
      }

      // Check city name
      if (!locationMatch && hasNotionCity) {
        const itemCityNormal = normalizeString(item.city);
        if (payloadCity !== null) {
          if (normalizeString(payloadCity) === itemCityNormal || shareSignificantWord(item.city, payloadCity)) {
            locationMatch = true;
          }
        } else if (cardTextNormal && shareSignificantWord(item.city, payload.cardText)) {
          locationMatch = true;
        }
      }

      if (!locationMatch) {
        continue; // Location mismatch
      }

      score += 20; // Specific location match
    } else {
      score += 10; // Generic match
    }

    // Add bonus for exact main vs alternate surface match
    if (payloadSurface !== null && item.surface !== undefined && item.surface !== null) {
      if (item.surface === payloadSurface) {
        score += 5;
      } else if (Array.isArray(item.otherSurfaces) && item.otherSurfaces.includes(payloadSurface)) {
        score += 4;
      }
    }

    // Add bonus for exact price match (vs previous prices)
    if (payloadPrice !== null && item.price !== undefined && item.price !== null) {
      if (item.price === payloadPrice) {
        score += 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  return bestMatch;
}

function normalizeString(str) {
  if (!str) return '';
  return str.toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]/g, "");
}

function shareSignificantWord(notionCity, cardText) {
  if (!notionCity || !cardText) return false;

  const normNotion = normalizeString(notionCity);
  const normCard = normalizeString(cardText);

  if (normCard.includes(normNotion) || normNotion.includes(normCard)) {
    return true;
  }

  // Split Notion city into words and clean them
  const words = notionCity.toLowerCase()
                          .normalize("NFD")
                          .replace(/[\u0300-\u036f]/g, "")
                          .split(/[^a-z0-9]/)
                          .map(w => w.trim())
                          .filter(w => w.length >= 3);

  const STOP_WORDS = new Set([
    'les', 'aux', 'sur', 'sous', 'dans', 'chez', 'avec', 'pour',
    'nord', 'sud', 'port', 'pont', 'fort', 'saint', 'sainte', 'centre'
  ]);

  for (const word of words) {
    if (word.length < 3) continue;
    if (STOP_WORDS.has(word)) continue;
    if (normCard.includes(word)) {
      return true;
    }
  }

  return false;
}

export function formatNotionId(id) {
  if (!id) return '';
  const clean = String(id).trim().split('?')[0].replace(/[^a-f0-9]/gi, '');
  if (clean.length === 32) {
    return clean.replace(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/i, '$1-$2-$3-$4-$5');
  }
  return String(id).trim().split('?')[0];
}

export async function fetchNotionDatabaseSchema(token, databaseId) {
  const dbId = formatNotionId(databaseId);
  const res = await fetchWithTimeout(`https://api.notion.com/v1/databases/${dbId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to fetch Notion database schema: ${res.status} — ${errText}`);
  }
  return await res.json();
}

/**
 * Creates a new page in a Notion database for a real estate listing.
 * @param {string} token - Notion API secret
 * @param {string} databaseId - Notion Database ID
 * @param {object} listingData - Extracted listing data (title, url, price, surface, etc.)
 * @param {object} mappings - Configured Notion property names
 * @returns {Promise<object>} Created Notion page object
 */
export async function createNotionPage(token, databaseId, listingData, mappings = {}) {
  const dbId = formatNotionId(databaseId);
  // Fetch DB schema to match property names and types
  const schema = await fetchNotionDatabaseSchema(token, dbId);
  const schemaProps = schema.properties || {};

  // Find exact property key in schemaProps case-insensitively
  const findPropKeyAndType = (targetName) => {
    if (!targetName) return { key: null, type: null, def: null };
    const lower = targetName.toLowerCase();
    for (const key of Object.keys(schemaProps)) {
      if (key.toLowerCase() === lower) {
        return { key, type: schemaProps[key].type, def: schemaProps[key] };
      }
    }
    return { key: null, type: null, def: null };
  };

  // Find title property in database schema
  let titlePropKey = null;
  for (const [key, propDef] of Object.entries(schemaProps)) {
    if (propDef.type === 'title') {
      titlePropKey = key;
      break;
    }
  }

  const payloadProps = {};

  // 1. Title property
  const titleText = listingData.title || 'Annonce immobilière';
  if (titlePropKey) {
    payloadProps[titlePropKey] = {
      title: [{ type: 'text', text: { content: titleText } }]
    };
  }

  // Helper to format values according to Notion prop type and user preferences
  const addFormattedProp = (configuredName, defaultName, valueFormatter) => {
    const name = configuredName !== undefined && configuredName !== '' ? configuredName : defaultName;
    if (!name) return;
    const { key, type } = findPropKeyAndType(name);
    if (!key || !type) return;

    const formatted = valueFormatter(type);
    if (formatted !== null && formatted !== undefined) {
      payloadProps[key] = formatted;
    }
  };

  // 2. URL (Portal URL)
  if (listingData.url) {
    addFormattedProp(mappings.url, 'Portal URL', (type) => {
      if (type === 'url') return { url: listingData.url };
      if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: listingData.url } }] };
      return null;
    });
    // Fallback search for URL or Portal URL column if unmapped
    if (!mappings.url) {
      const urlInfo = findPropKeyAndType('URL') || findPropKeyAndType('Annonce') || findPropKeyAndType('Lien');
      if (urlInfo.key && !payloadProps[urlInfo.key]) {
        if (urlInfo.type === 'url') payloadProps[urlInfo.key] = { url: listingData.url };
        else if (urlInfo.type === 'rich_text') payloadProps[urlInfo.key] = { rich_text: [{ type: 'text', text: { content: listingData.url } }] };
      }
    }
  }

  // 3. Price ("1 234 567 €" for text, number for numeric)
  if (listingData.price !== null && listingData.price !== undefined) {
    const priceNum = parseInt(String(listingData.price).replace(/\D/g, ''), 10);
    if (!isNaN(priceNum)) {
      const priceFormatted = `${new Intl.NumberFormat('fr-FR').format(priceNum).replace(/\s|[\u202f\u00a0\u200b\u2000-\u200A]/g, ' ')} €`;
      addFormattedProp(mappings.price, 'Prix', (type) => {
        if (type === 'number') return { number: priceNum };
        if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: priceFormatted } }] };
        return null;
      });
    }
  }

  // 4. Surface ("123 m²" for text, number for numeric)
  if (listingData.surface !== null && listingData.surface !== undefined) {
    const surfNum = parseFloat(String(listingData.surface));
    if (!isNaN(surfNum)) {
      const surfFormatted = `${surfNum} m²`;
      addFormattedProp(mappings.surface, 'Surface', (type) => {
        if (type === 'number') return { number: surfNum };
        if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: surfFormatted } }] };
        return null;
      });
    }
  }

  // 5. Land surface / Terrain ("123 m²" for text, number for numeric)
  if (listingData.landSurface !== null && listingData.landSurface !== undefined) {
    const landNum = parseFloat(String(listingData.landSurface));
    if (!isNaN(landNum)) {
      const landFormatted = `${landNum} m²`;
      addFormattedProp(mappings.landSurface, 'Terrain', (type) => {
        if (type === 'number') return { number: landNum };
        if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: landFormatted } }] };
        return null;
      });
    }
  }

  // 6. Rooms / Pièces ("4 p." for text, number for numeric)
  if (listingData.rooms !== null && listingData.rooms !== undefined) {
    const roomsNum = parseInt(String(listingData.rooms), 10);
    if (!isNaN(roomsNum)) {
      const roomsFormatted = `${roomsNum} p.`;
      addFormattedProp(mappings.rooms, 'Pièces', (type) => {
        if (type === 'number') return { number: roomsNum };
        if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: roomsFormatted } }] };
        return null;
      });
    }
  }

  // 7. Bedrooms / Chambres ("5 ch." for text, number for numeric)
  if (listingData.bedrooms !== null && listingData.bedrooms !== undefined) {
    const bedNum = parseInt(String(listingData.bedrooms), 10);
    if (!isNaN(bedNum)) {
      const bedFormatted = `${bedNum} ch.`;
      addFormattedProp(mappings.bedrooms, 'Chambres', (type) => {
        if (type === 'number') return { number: bedNum };
        if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: bedFormatted } }] };
        return null;
      });
    }
  }

  // 8. Statut ("À contacter" by default)
  const statusVal = listingData.status || 'À contacter';
  addFormattedProp(mappings.status, 'Statut', (type) => {
    if (type === 'select') return { select: { name: statusVal } };
    if (type === 'status') return { status: { name: statusVal } };
    if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: statusVal } }] };
    return null;
  });

  // 9. Code postal
  if (listingData.postal) {
    addFormattedProp(mappings.postal, 'Code postal', (type) => {
      if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: String(listingData.postal) } }] };
      if (type === 'number') return { number: parseInt(String(listingData.postal).replace(/\D/g, ''), 10) };
      return null;
    });
  }

  // 10. Ville
  if (listingData.city) {
    addFormattedProp(mappings.city, 'Ville', (type) => {
      if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: listingData.city } }] };
      if (type === 'select') return { select: { name: listingData.city } };
      return null;
    });
  }

  // 11. Adresse (CHH found address)
  if (listingData.address) {
    addFormattedProp(mappings.address, 'Adresse', (type) => {
      if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: listingData.address } }] };
      return null;
    });
  }

  // 12. Dernière vente (DVF)
  if (listingData.lastSale || listingData.dvfPrice) {
    let saleStr = listingData.lastSale;
    if (!saleStr && listingData.dvfPrice) {
      const formattedPrice = new Intl.NumberFormat('fr-FR').format(listingData.dvfPrice).replace(/[\u202f\u00a0]/g, ' ');
      const formattedDate = listingData.dvfDate
        ? new Date(listingData.dvfDate).toLocaleDateString('fr-FR')
        : null;
      saleStr = formattedDate ? `${formattedPrice} € (${formattedDate})` : `${formattedPrice} €`;
    }
    if (saleStr) {
      addFormattedProp(mappings.lastSale, 'Dernière vente', (type) => {
        if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: saleStr } }] };
        return null;
      });
    }
  }

  // 13. Description
  if (listingData.description) {
    const cleanDesc = String(listingData.description).trim().slice(0, 2000);
    if (cleanDesc) {
      addFormattedProp(mappings.description, 'Description', (type) => {
        if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: cleanDesc } }] };
        return null;
      });
    }
  }

  // 14. Ajouté le (Date)
  const nowIso = new Date().toISOString();
  addFormattedProp(mappings.addedAt, 'Ajouté le', (type) => {
    if (type === 'date') return { date: { start: nowIso } };
    if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: new Date().toLocaleDateString('fr-FR') } }] };
    return null;
  });

  // 15. Site / Source (e.g. "BienIci", "LeBonCoin", "SeLoger", etc.)
  if (listingData.siteName) {
    addFormattedProp(mappings.site, 'Site', (type) => {
      if (type === 'select') return { select: { name: listingData.siteName } };
      if (type === 'rich_text') return { rich_text: [{ type: 'text', text: { content: listingData.siteName } }] };
      return null;
    });
  }

  const body = {
    parent: { database_id: dbId },
    properties: payloadProps,
  };

  // Cover image & Page Icon if imageUrl is provided
  if (listingData.imageUrl && /^https?:\/\//i.test(listingData.imageUrl)) {
    body.cover = {
      type: 'external',
      external: { url: listingData.imageUrl },
    };
    body.icon = {
      type: 'external',
      external: { url: listingData.imageUrl },
    };
  }

  const res = await fetchWithTimeout('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    let userMsg = `Erreur API Notion (${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.message) userMsg += `: ${parsed.message}`;
    } catch (e) {
      userMsg += `: ${errText}`;
    }
    throw new Error(userMsg);
  }

  return await res.json();
}

