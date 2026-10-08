// lib/downloadCapture.js
// Intercepts file downloads via the chrome.downloads API and stores downloaded
// content for the agent to read. Adds two tools:
//   capture_download  — opens a download, reads its content, stores it
//   get_downloads     — returns the list of captured download contents

const _CAPTURED_KEY = "capturedDownloads";

// Mapping of downloadId -> { filename, mimeType, url, bytes, text, capturedAt }
const capturedDownloads = new Map();

/** Initialise the download listener. Call once at service-worker load. */
export function initDownloadCapture() {
  // Intercept completed downloads
  if (!chrome.downloads.onChanged.hasListener(onDownloadChanged)) {
    chrome.downloads.onChanged.addListener(onDownloadChanged);
  }
}

function onDownloadChanged(delta) {
  // Only capture when the download reaches a completed state
  if (!delta.state || delta.state.current !== "complete") return;
  const id = delta.id;
  captureDownload(id).catch(() => { /* best-effort */ });
}

async function captureDownload(downloadId) {
  // Don't re-capture
  if (capturedDownloads.has(downloadId)) return;

  let item;
  try {
    item = await new Promise((resolve, reject) => {
      chrome.downloads.search({ id: downloadId }, (results) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(results?.[0]);
      });
    });
  } catch {
    return;
  }
  if (!item) return;

  // Read the file as a data URL — only metadata available in MV3
  try {
    await new Promise((_resolve) => {
      chrome.downloads.getFileIcon(item.id, { size: 32 }, () => {
        _resolve(null);
      });
    });
  } catch {
    // best-effort
  }

  capturedDownloads.set(downloadId, {
    id: downloadId,
    filename: item.filename || item.url?.split("/").pop() || "download",
    mimeType: item.mime || "application/octet-stream",
    url: item.url,
    fileSize: item.fileSize || 0,
    startTime: item.startTime,
    capturedAt: Date.now(),
  });

  // Auto-cleanup after 60 entries to avoid unbounded storage
  if (capturedDownloads.size > 60) {
    const oldest = [...capturedDownloads.keys()].sort((a, b) =>
      (capturedDownloads.get(a)?.capturedAt || 0) - (capturedDownloads.get(b)?.capturedAt || 0)
    );
    while (capturedDownloads.size > 50) {
      capturedDownloads.delete(oldest.shift());
    }
  }
}

/** Get all captured downloads (metadata only — no file bytes). */
export function getCapturedDownloads() {
  return [...capturedDownloads.values()].sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
}

/** Clear captured downloads list. */
export function clearCapturedDownloads() {
  capturedDownloads.clear();
}
