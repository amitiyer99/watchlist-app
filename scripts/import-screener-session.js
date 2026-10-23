'use strict';

// The Screener.in login lives in the Chrome profile on this laptop. Opening that
// profile from this script, headless or with a debugging port, rewrote Chrome's
// cookie store and dropped saved logins. Do not launch Chrome against that
// profile from here. The weekday refresh keeps the previous lists when this
// cannot run.

console.log('Screener.in login was not copied. Chrome has to be opened normally for that login; this refresh will not launch it.');
process.exit(0);
