# CHH — Charsyka Home Hunting

Chrome extension to assist with real estate search. Personal use only — specific to my Notion setup.

Originally cloned from [immodex](https://github.com/sylvaincharzat/immodex).

## What it does

The core goal is to **centralize real estate listings from all portals into a single Notion database**, making it the source of truth for the search. Notion provides multiple views to track properties (by status, location, price…), visits (with dates synced to Google Calendar), and agent contacts — all in one place, regardless of which portal a listing came from.

The extension bridges the gap between the portals and Notion:

- **Notion matching**: As you browse, listings already saved in Notion are visually flagged (✔︎ CHH badge). Listings matching excluded keywords are grayed out (✖ CHH badge).
- **Save to Notion**: One-click save of a listing's data (price, surface, rooms, city, address, DVF history, description…) into Notion.
- **Address lookup**: A floating button resolves the actual address of a property by cross-referencing the ADEME DPE register (via surface, energy classes, and date) or IGN cadastral parcels for land listings.
- **DVF history**: Automatically fetches the last known selling price for a matched address from the DVF API.
- **Google Calendar sync**: Syncs visit dates from Notion into a Google Calendar (hourly alarm + manual trigger from popup).
- **Keyword exclusions**: Hide listings containing unwanted terms (configurable in the popup).

Supported portals: Leboncoin, BienIci, SeLoger, Jinka, Belles Demeures, Paruvendu, Figaro Immobilier, Castorus, MoteurImmo.

## Stack

Vanilla JS Chrome Extension (Manifest V3). No build step — loaded directly from source.

## Configuration

All settings are stored in the popup:
- Notion API token and database ID
- Property name mappings (Prix, Surface, Code postal, Ville, Adresse…)
- Excluded terms for keyword filtering
- Google Calendar ID for visit sync
