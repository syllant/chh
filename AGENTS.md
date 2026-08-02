- Never launch the browser yourself for testing, ask me to relay the debug logs.

## Notion Matching Rules

- **Surface and price matching is always EXACT** — never add a ±N m² or ±N € tolerance.
  - Each real estate portal may report slightly different values for the same property.
  - The correct way to handle this is to store the alternate surface value in the **"Autre surface"** (`otherSurfaces`) field in Notion, and the alternate price in **"Prix précédents"** (`previousPrices`). The matching logic already checks these fields.
  - Adding a fuzzy tolerance causes false positives (wrong matches between different properties).

## Surface format

- Surface regex in content scripts must always accept both `m²` (U+00B2) and `m2` (ASCII "2").
  Use `m(?:²|2)` in all regex patterns that parse surface values from web page text.