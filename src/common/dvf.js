/**
 * Etalab DVF API client & matching algorithms.
 */

export async function geocodeAddress(address) {
  const url = `https://data.geopf.fr/geocodage/search?q=${encodeURIComponent(address)}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const data = await res.json();
  const f = data.features?.[0];
  if (!f) return null;
  
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties || {};
  return {
    lon,
    lat,
    housenumber: p.housenumber || null,
    street: p.street || p.name || null,
    postcode: p.postcode || null,
    city: p.city || null
  };
}

export async function getParcelId(lon, lat) {
  const geom = { type: 'Point', coordinates: [lon, lat] };
  const url = `https://apicarto.ign.fr/api/cadastre/parcelle?geom=${encodeURIComponent(JSON.stringify(geom))}`;
  const res = await fetch(url);
  if (!res.ok) {
    return null;
  }
  const data = await res.json();
  const f = data.features?.[0];
  return f?.properties?.idu || null;
}

async function fetchDvfMutations(parcelleId) {
  const url = `https://dvf-api.data.gouv.fr/dvf?parcelle=${parcelleId}`;
  const res = await fetch(url);
  if (!res.ok) {
    return [];
  }
  const data = await res.json();
  return data?.data || [];
}

export async function fetchPappersDvfMutations(parcelleId) {
  try {
    const url = `https://immobilier.pappers.fr/api/parcelles/parcelle/${parcelleId}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parcelle_cadastrale: parcelleId,
        bases: 'ventes',
        afficher_correspondance_requete: 'true'
      })
    });
    if (!res.ok) {
      return [];
    }
    const data = await res.json();
    const parcel = data?.resultats?.[0];
    if (!parcel || !Array.isArray(parcel.ventes)) return [];
    
    let mNum = '';
    let mStreet = '';
    if (parcel.adresse) {
      const match = parcel.adresse.match(/^(\d+)\s+(.+?)\s+\d{5}/);
      if (match) {
        mNum = match[1];
        mStreet = match[2];
      } else {
        mStreet = parcel.adresse;
      }
    }

    return parcel.ventes.map(v => {
      let typeLocal = v.type_local;
      if (typeLocal) {
        if (typeLocal.toLowerCase().includes('appartement')) {
          typeLocal = 'Appartement';
        } else if (typeLocal.toLowerCase().includes('maison')) {
          typeLocal = 'Maison';
        }
      }
      
      let nature = v.nature;
      if (nature) {
        nature = nature.charAt(0).toUpperCase() + nature.slice(1);
      }

      return {
        date_mutation: v.date,
        nature_mutation: nature,
        valeur_fonciere: v.valeur_fonciere,
        type_local: typeLocal,
        surface_reelle_bati: v.surface_reelle_bati,
        surface_terrain: v.surface_terrain,
        adresse_numero: mNum,
        adresse_nom_voie: mStreet,
        code_postal: parcel.codes_postaux?.[0] || '',
        nom_commune: parcel.commune || ''
      };
    });
  } catch (err) {
    return [];
  }
}

export function cleanStreetName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\b(rue|avenue|boulevard|place|chemin|impasse|r|av|bd|pl|route|rte|allee|square|sq|cours|crs|voie|all|che|imp)\b/gi, "")
    .replace(/\s+/g, "")
    .trim();
}

export function findBestMutation(mutations, { surface, buildingType, housenumber, street }) {
  if (!Array.isArray(mutations) || mutations.length === 0) return null;

  const cleanSearchStreet = cleanStreetName(street);
  const searchHousenumber = housenumber ? String(housenumber).trim() : null;

  let targetTypeLocal = null;
  if (buildingType) {
    const t = String(buildingType).toLowerCase();
    if (t.includes('appartement') || t.includes('flat') || t.includes('apt')) {
      targetTypeLocal = 'Appartement';
    } else if (t.includes('maison') || t.includes('house') || t.includes('villa')) {
      targetTypeLocal = 'Maison';
    }
  }

  const candidates = [];

  // Strict check
  for (const m of mutations) {
    const nature = String(m.nature_mutation || '').toLowerCase();
    if (!nature.includes('vente') && !nature.includes('adjudication')) {
      continue;
    }

    if (cleanSearchStreet && m.adresse_nom_voie) {
      const cleanMStreet = cleanStreetName(m.adresse_nom_voie);
      if (cleanMStreet !== cleanSearchStreet && !cleanMStreet.includes(cleanSearchStreet) && !cleanSearchStreet.includes(cleanMStreet)) {
        continue;
      }
    }

    if (searchHousenumber && m.adresse_numero) {
      const mNum = String(m.adresse_numero).trim();
      if (mNum !== searchHousenumber) {
        continue;
      }
    }

    if (targetTypeLocal && m.type_local) {
      if (m.type_local !== targetTypeLocal) {
        continue;
      }
    }

    candidates.push(m);
  }

  if (candidates.length === 0) {
    // Fallback 1: relax street & number filters (keep type)
    for (const m of mutations) {
      const nature = String(m.nature_mutation || '').toLowerCase();
      if (!nature.includes('vente') && !nature.includes('adjudication')) {
        continue;
      }
      if (targetTypeLocal && m.type_local && m.type_local !== targetTypeLocal) {
        continue;
      }
      candidates.push(m);
    }
  }

  if (candidates.length === 0) {
    // Fallback 2: relax type matching (keep street & number)
    for (const m of mutations) {
      const nature = String(m.nature_mutation || '').toLowerCase();
      if (!nature.includes('vente') && !nature.includes('adjudication')) {
        continue;
      }
      if (cleanSearchStreet && m.adresse_nom_voie) {
        const cleanMStreet = cleanStreetName(m.adresse_nom_voie);
        if (cleanMStreet !== cleanSearchStreet && !cleanMStreet.includes(cleanSearchStreet) && !cleanSearchStreet.includes(cleanMStreet)) {
          continue;
        }
      }
      if (searchHousenumber && m.adresse_numero) {
        const mNum = String(m.adresse_numero).trim();
        if (mNum !== searchHousenumber) {
          continue;
        }
      }
      candidates.push(m);
    }
  }

  if (candidates.length === 0) {
    // Fallback 3: completely relaxed (allow any transaction on the parcel)
    for (const m of mutations) {
      const nature = String(m.nature_mutation || '').toLowerCase();
      if (nature.includes('vente') || nature.includes('adjudication')) {
        candidates.push(m);
      }
    }
  }

  if (candidates.length === 0) return null;

  if (surface != null) {
    const targetSurface = parseFloat(surface);
    candidates.sort((a, b) => {
      const surfA = parseFloat(a.surface_reelle_bati || a.surface_terrain || 0);
      const surfB = parseFloat(b.surface_reelle_bati || b.surface_terrain || 0);
      const diffA = Math.abs(surfA - targetSurface);
      const diffB = Math.abs(surfB - targetSurface);
      
      if (Math.abs(diffA - diffB) > 5) {
        return diffA - diffB;
      }
      
      const dateA = new Date(a.date_mutation || 0).getTime();
      const dateB = new Date(b.date_mutation || 0).getTime();
      return dateB - dateA;
    });
  } else {
    candidates.sort((a, b) => {
      const dateA = new Date(a.date_mutation || 0).getTime();
      const dateB = new Date(b.date_mutation || 0).getTime();
      return dateB - dateA;
    });
  }

  const best = candidates[0];
  return {
    price: best.valeur_fonciere ? parseFloat(best.valeur_fonciere) : null,
    date: best.date_mutation || null,
    surface: best.surface_reelle_bati || best.surface_terrain || null,
    type: best.type_local || null,
    address: [best.adresse_numero, best.adresse_nom_voie, best.code_postal, best.nom_commune].filter(Boolean).join(' ')
  };
}

export async function findLastSellingPrice(address, surface, buildingType) {
  try {
    const geo = await geocodeAddress(address);
    if (!geo) return null;
    
    const parcelId = await getParcelId(geo.lon, geo.lat);
    if (!parcelId) return null;
    
    let mutations = await fetchDvfMutations(parcelId);
    if (!mutations || mutations.length === 0) {
      mutations = await fetchPappersDvfMutations(parcelId);
    }
    
    if (!mutations || mutations.length === 0) return null;
    
    const best = findBestMutation(mutations, {
      surface,
      buildingType,
      housenumber: geo.housenumber,
      street: geo.street
    });
    
    if (!best) return null;
    return {
      ...best,
      parcelleId: parcelId
    };
  } catch (err) {
    return null;
  }
}
