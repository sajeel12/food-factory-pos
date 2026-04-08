const { performSync } = require('./sync.cjs');
performSync().then(() => console.log('Done')).catch(e => console.error(e));
