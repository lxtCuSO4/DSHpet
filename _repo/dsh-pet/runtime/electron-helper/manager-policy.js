'use strict';
const MODES = new Set(['smart', 'normal', 'topmost']);
function desktopEnabled(display) {
  return display === 'desktop' || display === 'both';
}
function displayWithDesktop(display, enabled) {
  const web = display === 'web' || display === 'both';
  return enabled ? (web ? 'both' : 'desktop') : web ? 'web' : 'none';
}
function intersects(a, b) {
  return a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function coversMonitor(rect, monitor, tolerance = 8) {
  return (
    !!rect &&
    !!monitor &&
    Math.abs(rect.x - monitor.x) <= tolerance &&
    Math.abs(rect.y - monitor.y) <= tolerance &&
    Math.abs(rect.x + rect.width - monitor.x - monitor.width) <= tolerance &&
    Math.abs(rect.y + rect.height - monitor.y - monitor.height) <= tolerance
  );
}
function visibilityFor(pet, mode, hiddenAll, box, fullscreens) {
  if (!desktopEnabled(pet.display)) return 'disabled';
  if (hiddenAll) return 'hidden-all';
  if (mode === 'smart' && fullscreens.some((rect) => intersects(box, rect))) return 'fullscreen';
  return 'visible';
}
module.exports = { MODES, desktopEnabled, displayWithDesktop, coversMonitor, visibilityFor, intersects };
