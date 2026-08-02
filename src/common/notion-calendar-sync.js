/**
 * Notion → Google Calendar synchronisation logic.
 *
 * Fetches Notion pages having a visit date,
 * then creates/updates/deletes the corresponding Google Calendar events.
 *
 * Storage keys used (chrome.storage.local):
 *   gcal.lastSync      — ISO timestamp of last successful sync
 *   gcal.syncStatus    — 'ok' | 'error' | 'syncing'
 *   gcal.syncError     — error message (when status = 'error')
 *   gcal.syncCount     — number of events managed in last sync
 */

import { getAccessToken, invalidateAccessToken, buildEventBody, findEventByNotionId, createEvent, updateEvent, deleteEvent, listManagedEvents } from './google-calendar.js';
import { getPropertyValue, fetchNotionPage } from './notion.js';

// Centralized configurations for Notion database mapping (hardcoded in code, not in UI)
const NOTION_MAPPINGS = {
  // Main database properties
  dateProp: 'Date visite',
  addressProp: 'Adresse',
  agentProp: 'Agent',
  // Agent card database properties (fetched via relation)
  agentAgencyProp: 'Agence',
  agentPhoneProp: 'Tél',
  agentEmailProp: 'Email',
};

/**
 * Fetch Notion pages that have a visit date.
 * Uses properties defined in NOTION_MAPPINGS.
 *
 * @param {string} notionToken
 * @param {string} databaseId
 * @returns {Promise<Array<{notionId, title, notionUrl, startDate, address, agent, rawAddress, rawAgent}>>}
 */
export async function fetchNotionVisits(notionToken, databaseId) {
  let results = [];
  let hasMore = true;
  let nextCursor = undefined;
  const agentCache = new Map();

  while (hasMore) {
    const body = {
      page_size: 100,
      filter: {
        property: NOTION_MAPPINGS.dateProp,
        date: { is_not_empty: true },
      },
    };

    if (nextCursor) {
      body.start_cursor = nextCursor;
    }

    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${notionToken}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      let extraHelp = '';
      try {
        const dbRes = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${notionToken}`,
            'Notion-Version': '2022-06-28',
          },
        });
        if (dbRes.ok) {
          const dbInfo = await dbRes.json();
          const props = Object.keys(dbInfo.properties || {}).map(p => `"${p}"`).join(', ');
          extraHelp = `\nColonnes disponibles dans votre base Notion : ${props}`;
        }
      } catch (_) { /* ignore schema fetch failures */ }
      
      throw new Error(`Notion API returned status ${res.status}: ${errText}${extraHelp}`);
    }

    const data = await res.json();

    if (data.results && Array.isArray(data.results)) {
      for (const pageSummary of data.results) {
        // Query the page details with Notion-Version: 2026-03-11 to deserialize place/location properties properly!
        let page;
        try {
          page = await fetchNotionPage(notionToken, pageSummary.id);
        } catch (err) {
          continue;
        }

        const props = page.properties || {};

        // Title
        let title = null;
        for (const prop of Object.values(props)) {
          if (prop.type === 'title') {
            title = getPropertyValue(prop);
            break;
          }
        }

        // Visit date
        const dateProp_ = props[NOTION_MAPPINGS.dateProp];
        let startDate = null;
        if (dateProp_ && dateProp_.type === 'date' && dateProp_.date) {
          startDate = dateProp_.date.start; // ISO 8601 string
        }

        if (!startDate) {
          continue; // skip pages without a date
        }

        // Location Address mapping
        let address = null;
        if (props[NOTION_MAPPINGS.addressProp]) {
          address = getPropertyValue(props[NOTION_MAPPINGS.addressProp]);
        }

        // Agent Relation mapping
        let agent = null;
        const agentRel = props[NOTION_MAPPINGS.agentProp];
        if (agentRel && agentRel.type === 'relation' && agentRel.relation?.length > 0) {
          const agentPageId = agentRel.relation[0].id;
          if (agentCache.has(agentPageId)) {
            agent = agentCache.get(agentPageId);
          } else {
            try {
              const agentPage = await fetchNotionPage(notionToken, agentPageId);
              const agentProps = agentPage.properties || {};

              // Extract Name (Title of the agent page)
              let agentName = null;
              for (const prop of Object.values(agentProps)) {
                if (prop.type === 'title') {
                  agentName = getPropertyValue(prop);
                  break;
                }
              }

              const agency = agentProps[NOTION_MAPPINGS.agentAgencyProp] ? getPropertyValue(agentProps[NOTION_MAPPINGS.agentAgencyProp]) : null;
              const phone = agentProps[NOTION_MAPPINGS.agentPhoneProp] ? getPropertyValue(agentProps[NOTION_MAPPINGS.agentPhoneProp]) : null;
              const email = agentProps[NOTION_MAPPINGS.agentEmailProp] ? getPropertyValue(agentProps[NOTION_MAPPINGS.agentEmailProp]) : null;

              agent = {
                name: agentName,
                agency,
                phone,
                email,
              };
              agentCache.set(agentPageId, agent);
            } catch (err) {
            }
          }
        }

        results.push({
          notionId: page.id,
          title: title || 'Visite',
          notionUrl: page.url,
          startDate,
          address,
          agent,
        });
      }
    }

    hasMore = data.has_more;
    nextCursor = data.next_cursor;
  }

  return results;
}

/**
 * Main sync function: Notion visits → Google Calendar events.
 *
 * @param {object} notionConfig
 * @param {string} notionConfig.token
 * @param {string} notionConfig.databaseId
 * @param {object} gcalConfig
 * @param {string} gcalConfig.calendarId
 * @returns {Promise<{created: number, updated: number, deleted: number}>}
 */
export async function syncNotionToCalendar(notionConfig, gcalConfig) {
  // Mark as syncing
  await chrome.storage.local.set({ 'gcal.syncStatus': 'syncing', 'gcal.syncError': '' });

  try {
    // Get token silently (non-interactive — user must have consented via popup first)
    const token = await getAccessToken(false);

    // Fetch Notion visits
    const visits = await fetchNotionVisits(notionConfig.token, notionConfig.databaseId);

    // Upsert Calendar events
    const notionIdsSeen = new Set();
    let created = 0;
    let updated = 0;

    for (const visit of visits) {
      notionIdsSeen.add(visit.notionId);
      const eventBody = buildEventBody(visit);

      try {
        const existing = await findEventByNotionId(token, gcalConfig.calendarId, visit.notionId);
        if (existing) {
          await updateEvent(token, gcalConfig.calendarId, existing.id, eventBody);
          updated++;
        } else {
          await createEvent(token, gcalConfig.calendarId, eventBody);
          created++;
        }
      } catch (err) {
        if (err.status === 401) {
          await invalidateAccessToken(token);
          throw new Error('Token Google invalide. Reconnectez-vous via le popup CHH.');
        }
        // ignore — continue to next visit
      }
    }

    // Delete managed events whose Notion page no longer qualifies (e.g. no date anymore)
    let deleted = 0;
    try {
      const managed = await listManagedEvents(token, gcalConfig.calendarId);
      for (const event of managed) {
        const notionId = event.extendedProperties?.private?.notionId;
        if (notionId && !notionIdsSeen.has(notionId)) {
          try {
            await deleteEvent(token, gcalConfig.calendarId, event.id);
            deleted++;
          } catch (err) {
            // ignore
          }
        }
      }
    } catch (err) {
      // ignore — cleanup is best-effort
    }

    // Persist success state
    await chrome.storage.local.set({
      'gcal.syncStatus': 'ok',
      'gcal.syncError': '',
      'gcal.lastSync': new Date().toISOString(),
      'gcal.syncCount': visits.length,
    });

    return { created, updated, deleted };
  } catch (err) {
    await chrome.storage.local.set({
      'gcal.syncStatus': 'error',
      'gcal.syncError': err.message || String(err),
    });
    throw err;
  }
}
