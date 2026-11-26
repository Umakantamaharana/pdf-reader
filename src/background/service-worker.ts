/**
 * service-worker.ts — MV3 background coordinator.
 *
 * Responsibilities (kept light — the worker may be killed after ~30s idle):
 *  - Register a dynamic declarativeNetRequest rule that redirects top-level
 *    .pdf navigations into our viewer. This is done at runtime because the
 *    redirect target needs the real extension id (chrome.runtime.getURL),
 *    which a static rule file can't express.
 *  - Provide a context-menu + command to open the current tab's PDF in sobelpdf.
 *  - Open URLs in the reader on request from the popup.
 */

const VIEWER_PATH = 'src/viewer/viewer.html';
const PDF_RULE_ID = 1001;

function viewerUrl(fileUrl: string): string {
  return chrome.runtime.getURL(VIEWER_PATH) + '?file=' + encodeURIComponent(fileUrl);
}

async function installPdfRedirectRule(): Promise<void> {
  const target = chrome.runtime.getURL(VIEWER_PATH);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [PDF_RULE_ID],
    addRules: [
      {
        id: PDF_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
          redirect: { regexSubstitution: `${target}?file=\\0` },
        },
        condition: {
          // http(s) and file:// PDFs. file:// also needs "Allow access to file
          // URLs" enabled on the extension card.
          regexFilter: '^(https?|file)://.*\\.pdf([?#].*)?$',
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
        },
      },
    ],
  });
}

// Register immediately on every service-worker spin-up, not just on the
// install/startup events (which may not fire after an idle termination).
void installPdfRedirectRule();

chrome.runtime.onInstalled.addListener(() => {
  void installPdfRedirectRule();
  chrome.contextMenus.create({
    id: 'open-in-lumen',
    title: 'Open in sobelpdf',
    contexts: ['link', 'page'],
    targetUrlPatterns: ['*://*/*.pdf*'],
    documentUrlPatterns: ['*://*/*'],
  });
});

chrome.runtime.onStartup.addListener(() => void installPdfRedirectRule());

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || info.pageUrl;
  if (url) chrome.tabs.create({ url: viewerUrl(url) });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-current-in-reader') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url) chrome.tabs.update(tab.id!, { url: viewerUrl(tab.url) });
});

// Popup / pages ask the worker to open an arbitrary URL in the reader.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'open-in-reader' && typeof msg.url === 'string') {
    chrome.tabs.create({ url: viewerUrl(msg.url) });
    sendResponse({ ok: true });
  }
  return true;
});
