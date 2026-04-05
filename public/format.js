// Overwatch formatters. Loaded by the browser via <script src="format.js"> and
// by Node tests via require(). No framework, no bundler.
(function(root) {
  function formatUptime(raw) {
    if (!raw) return '\u2014';
    // ps etime formats: MM:SS | HH:MM:SS | DD-HH:MM:SS
    var days = 0, hours = 0, mins = 0, secs = 0;
    var s = String(raw);
    var dayMatch = s.match(/^(\d+)-(.+)$/);
    if (dayMatch) {
      days = parseInt(dayMatch[1], 10);
      s = dayMatch[2];
    }
    var parts = s.split(':').map(function(x) { return parseInt(x, 10); });
    if (parts.some(isNaN)) return raw;
    if (parts.length === 2) { mins = parts[0]; secs = parts[1]; }
    else if (parts.length === 3) { hours = parts[0]; mins = parts[1]; secs = parts[2]; }
    else return raw;

    if (days > 0) return hours > 0 ? days + 'd ' + hours + 'h' : days + 'd';
    if (hours > 0) return mins > 0 ? hours + 'h ' + mins + 'm' : hours + 'h';
    if (mins > 0) return secs > 0 && mins < 10 ? mins + 'm ' + secs + 's' : mins + 'm';
    return secs + 's';
  }

  var api = { formatUptime: formatUptime };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.OverwatchFormat = api;
    root.formatUptime = formatUptime;
  }
})(typeof window !== 'undefined' ? window : globalThis);
