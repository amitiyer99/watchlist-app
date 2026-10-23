'use strict';

// Disabled. Launching Chrome against the real profile from here rewrote the
// cookie store. The weekday task must not call this.
console.log('Screener catch-up is disabled so it does not open the Chrome profile.');
process.exit(0);
