const fs = require('fs');
const path = require('path');

const MAX_BYTES = 400 * 1024;
const KEEP_BYTES = 200 * 1024;
const TRIM_CHECK_EVERY = 200; // writes

// Appends timestamped lines to <userData>/<fileName>, e.g. %APPDATA%\food-factory-pos\sync.log.
// An installed app has no visible console, so these files are where problems can be read.
// Trimmed to the last ~200KB once past ~400KB (a POS can run for days); logging never throws.
function createFileLogger(fileName) {
    let file = null;
    let writes = 0;

    const trim = () => {
        try {
            if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
                fs.writeFileSync(file, fs.readFileSync(file, 'utf8').slice(-KEEP_BYTES));
            }
        } catch (e) { /* ignore */ }
    };

    // Resolved on first write so it follows the userData folder main.cjs pins at startup
    const resolveFile = () => {
        if (!file) {
            const { app } = require('electron');
            file = path.join(app.getPath('userData'), fileName);
            trim();
        }
        return file;
    };

    const write = (level) => (...args) => {
        try {
            const target = resolveFile();
            const line = args
                .map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
                .join(' ');
            fs.appendFileSync(target, `${new Date().toISOString()} [${level}] ${line}\n`);
            if (++writes % TRIM_CHECK_EVERY === 0) trim();
        } catch (e) { /* logging must never break the app */ }
    };

    return { info: write('info'), warn: write('warn'), error: write('error'), debug: () => { } };
}

module.exports = { createFileLogger };
