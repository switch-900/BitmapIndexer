# BRC-420 content explorer

Open the Content Explorer link on the BRC-420 page, or open brc420/content-explorer.html via a local HTTP server or GitHub Pages.

## Build the shared catalogue (Node.js 20+)

Run from the repository root:

    node brc420/content-explorer.mjs

For an existing Ord server (recommended for bulk indexing):

    node brc420/content-explorer.mjs --ord http://127.0.0.1:80

Commit the generated brc420/content-types.json alongside the site. The script checkpoints every 25 lookups, resumes previously resolved source IDs, deduplicates shared sources, follows native Ord delegate chains, and stops after five consecutive lookup failures. Nonzero exit means incomplete classification; the partial catalogue is still usable. Run again to retry unknown or failed entries. Run only one CLI writer at a time. To refresh all results, remove the catalogue first.

The browser reads the catalogue from the same GitHub Pages origin. Without it, visitors can explicitly scan unresolved IDs (if ordinals.com permits cross-origin metadata requests); progress is cached locally where supported. No third-party dependencies or wallet access. The scanner requests metadata only, and does not execute inscriptions. Preview iframes use an opaque sandbox origin; recursive content that fails there can be opened separately on Ord.

Coverage is one record per deployment in deploys.json, including zero-mint collections. Source metadata is resolved once per distinct source ID. This is not independent verification of every mint or a parser of recursively imported HTML/GLB assets. A declared MIME type is not byte-level file validation.
