/**
 * Google Calendar REST API v3 client.
 *
 * Auth: chrome.identity.getAuthToken() — Chrome manages the OAuth flow and
 * token refresh automatically. No credentials to store or rotate.
 *
 * Usage:
 *   - interactive=true  → call from popup (user gesture, shows consent if needed)
 *   - interactive=false → call from service worker (silent, fails if not yet authorized)
 */

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

// ── Token helpers ─────────────────────────────────────────────────────────────

/**
 * Get a valid Google access_token via chrome.identity.
 * @param {boolean} interactive - Show consent screen if not yet authorized
 * @returns {Promise<string>} access_token
 */
export async function getAccessToken(interactive = false) {
  const result = await chrome.identity.getAuthToken({ interactive });
  if (!result || !result.token) {
    throw new Error('Impossible d\'obtenir un token Google. Connectez-vous via le popup.');
  }
  return result.token;
}

/**
 * Revoke a cached token (call after a 401 so Chrome fetches a fresh one next time).
 * @param {string} token
 */
export async function invalidateAccessToken(token) {
  await chrome.identity.removeCachedAuthToken({ token });
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function calendarRequest(token, method, path, body = null, queryString = '') {
  const url = `${CALENDAR_API}${path}${queryString ? '?' + queryString : ''}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  if (!res.ok) {
    const errText = await res.text();
    const error = new Error(`Google Calendar API error (${res.status}): ${errText}`);
    error.status = res.status;
    throw error;
  }

  return await res.json();
}

// ── Event helpers ─────────────────────────────────────────────────────────────

/**
 * Build a Calendar event resource from a Notion visit record.
 * Duration: 60 min (1h) for timed events; all-day for date-only values.
 */
export function buildEventBody(visit) {
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(visit.startDate);

  let start, end;
  if (isDateOnly) {
    start = { date: visit.startDate };
    end = { date: visit.startDate };
  } else {
    const startMs = new Date(visit.startDate).getTime();
    const endMs = startMs + 60 * 60 * 1000;
    start = { dateTime: new Date(startMs).toISOString() };
    end = { dateTime: new Date(endMs).toISOString() };
  }

  let description = '';
  if (visit.notionUrl) {
    description += `<a href="${visit.notionUrl}">Fiche détaillée</a><br>`;
  }
  if (visit.agent) {
    description += `<br>👤 <b>Agent :</b> ${visit.agent.name || 'Inconnu'}`;
    if (visit.agent.agency) {
      description += ` (${visit.agent.agency})`;
    }
    if (visit.agent.phone) {
      description += `<br>📞 <b>Tél :</b> ${visit.agent.phone}`;
    }
    if (visit.agent.email) {
      description += `<br>✉️ <b>Email :</b> <a href="mailto:${visit.agent.email}">${visit.agent.email}</a>`;
    }
  }

  const prefix = (visit.agent && visit.agent.agency) ? `[${visit.agent.agency.toUpperCase()}] ` : '';
  const body = {
    summary: `${prefix}${visit.title || 'Visite'}`,
    description: description.trim(),
    start,
    end,
    extendedProperties: {
      private: { notionId: visit.notionId, source: 'chh' },
    },
  };

  if (visit.address) {
    body.location = visit.address;
  }

  return body;
}

/** Find an existing event by Notion page ID (stored in extendedProperties). */
export async function findEventByNotionId(token, calendarId, notionId) {
  const qs = new URLSearchParams({
    privateExtendedProperty: `notionId=${notionId}`,
    maxResults: '1',
    singleEvents: 'true',
  }).toString();

  const data = await calendarRequest(
    token, 'GET',
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    null, qs
  );
  return data?.items?.length > 0 ? data.items[0] : null;
}

export async function createEvent(token, calendarId, eventBody) {
  return await calendarRequest(
    token, 'POST',
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    eventBody
  );
}

export async function updateEvent(token, calendarId, eventId, eventBody) {
  return await calendarRequest(
    token, 'PUT',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    eventBody
  );
}

export async function deleteEvent(token, calendarId, eventId) {
  await calendarRequest(
    token, 'DELETE',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  );
}

/** List all CHH-managed events (used for orphan cleanup). */
export async function listManagedEvents(token, calendarId) {
  const qs = new URLSearchParams({
    privateExtendedProperty: 'source=chh',
    maxResults: '2500',
    singleEvents: 'true',
  }).toString();

  const data = await calendarRequest(
    token, 'GET',
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    null, qs
  );
  return data?.items ?? [];
}
