# Privacy Policy — sobelpdf

_Last updated: 27 November 2026_

sobelpdf ("the extension") is a PDF reader and annotator for Google Chrome, developed
by Umakanta Maharana. This policy explains what data the extension handles and how.

## Summary

sobelpdf processes your documents **only on your own device**. It does not collect,
sell, share or transmit your personal data or the content of your documents. It has
no analytics, no tracking and no accounts.

## What the extension accesses

- **The PDF documents you open.** When you open a PDF (a web link, a local file you
  allow, or a file you drop into the reader), the extension downloads and displays it
  inside your browser. Document content is processed locally for display, search,
  annotations and read-aloud, and is never sent to the developer or any third party.
- **Web addresses of PDF links.** To open `.pdf` links in the reader, the extension
  recognises navigations to URLs ending in `.pdf` and opens them in its viewer. These
  addresses are not stored or transmitted.

## What the extension stores

All of this is stored using Chrome's extension storage (`chrome.storage`) on your
device:

- your settings (theme, shortcuts, read-aloud preferences, and so on)
- your annotations (highlights, notes, drawings, text boxes, images you add as stamps),
  linked to an anonymous fingerprint of each document

If you turn on **sync** in the extension's settings, Chrome syncs your settings through
your own Google account, using Chrome's built-in sync. The developer has no access to
this data. You can delete everything at any time by removing the extension or using
"Reset" on the settings page.

## Network requests

The extension makes no network requests of its own, with one exception:

- **Neural voice model (optional).** The first time you use the neural read-aloud
  voice, the extension downloads the open-source Kokoro-82M voice model from Hugging
  Face (`huggingface.co`). This is a data file, not executable code. No document
  content or personal data is sent with the request. The model is cached in your browser
  for offline use afterwards. Hugging Face's own privacy policy applies to that download.
  If you don't use the neural voice, this download never happens.

PDFs you open from the web are fetched from the website that hosts them, exactly as your
browser would fetch them without the extension.

## Permissions

- **storage / unlimitedStorage:** saves your settings and annotations, and caches the
  voice model, on your device.
- **declarativeNetRequest:** opens `.pdf` links in the sobelpdf viewer.
- **contextMenus:** adds "Open in sobelpdf" to the right-click menu.
- **Host access to all sites:** needed to open and read PDFs from whichever website you
  view them on.

## Children

The extension is not directed at children and collects no data from anyone.

## Changes

If this policy changes, the updated version will be published at the same address,
with a new "Last updated" date.

## Contact

Umakanta Maharana — umakantamaharana70@gmail.com
