// lib/statusBadge.js
// Shows a small pulsing green dot in the toolbar icon's bottom-right corner
// while any task is running. chrome.action's text-badge API can't do a
// small corner dot (it draws a colored box sized to fit the text — roughly
// a third of the icon even for one character) and can't animate at all, so
// this redraws the actual icon on an interval instead.

const SIZES = [16, 32]; // the only sizes Chrome's toolbar actually renders
const bitmapCache = new Map(); // size -> ImageBitmap, decoded once and reused

async function loadBitmap(size) {
  if (bitmapCache.has(size)) return bitmapCache.get(size);
  // icon48 downscales to 32 more cleanly than icon16 would upscale.
  const src = size <= 16 ? "icons/icon16.png" : "icons/icon48.png";
  const res = await fetch(chrome.runtime.getURL(src));
  const bitmap = await createImageBitmap(await res.blob());
  bitmapCache.set(size, bitmap);
  return bitmap;
}

function drawFrame(bitmap, size, pulse) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, size, size);
  const cx = size * 0.78;
  const cy = size * 0.78;
  const r = size * (0.15 + 0.045 * pulse);
  // Faint white ring first so the dot stays legible over a dark icon background.
  ctx.beginPath();
  ctx.arc(cx, cy, r + size * 0.05, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(26,127,55,${0.7 + 0.3 * pulse})`;
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

let pulseTimer = null;
// Desired state, set synchronously (unlike pulseTimer, which is only set
// once the bitmap load below finishes) — startRunningBadge awaits a fetch
// before it can start the interval, so a run fast enough to call
// stopRunningBadge before that await resolves would otherwise find
// pulseTimer still null, no-op, and then get its dot started anyway a
// moment later with nothing left to ever clear it. Checking `running` again
// after the await closes that race.
let running = false;

export async function startRunningBadge() {
  if (running) return; // already animating (or already loading)
  running = true;
  const bitmaps = await Promise.all(SIZES.map(loadBitmap));
  if (!running) return; // stopRunningBadge ran while the bitmaps were loading
  const render = () => {
    // Driven off Date.now() (not a frame counter) so a throttled/delayed
    // tick can't accumulate drift — the pulse phase is always correct for
    // whatever moment the frame actually renders.
    const pulse = (Math.sin((Date.now() / 1500) * Math.PI * 2) + 1) / 2;
    const imageData = {};
    SIZES.forEach((size, i) => { imageData[size] = drawFrame(bitmaps[i], size, pulse); });
    chrome.action.setIcon({ imageData }).catch(() => {});
  };
  render();
  // ponytail: fixed 200ms/5fps tick, not configurable — smooth enough for a
  // slow pulse without redrawing/calling setIcon any more than it has to.
  pulseTimer = setInterval(render, 200);
}

export function stopRunningBadge() {
  running = false;
  if (pulseTimer) {
    clearInterval(pulseTimer);
    pulseTimer = null;
  }
  // Unconditional (not gated on pulseTimer having been set) so this always
  // wins over a start that's still mid-load — see `running` above.
  chrome.action.setIcon({ path: { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" } }).catch(() => {});
}
