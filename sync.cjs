const { getDb } = require('./db.cjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let API_URL = 'https://food-factory-cloud-backend.onrender.com';
try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const match = envContent.match(/^VITE_API_URL=(.*)$/m);
        if (match && match[1]) {
            API_URL = match[1].trim();
        }
    }
} catch (e) {}

const SYNC_INTERVAL_MS = 15000;
const FETCH_TIMEOUT_MS = 20000;
const ORDER_PUSH_CHUNK = 25;

// Hash of the last payload written per endpoint. The pull endpoints return everything on
// every call (products include base64 images), so rewriting the tables and reloading the UI
// every 15s blocked the main process — which also handles orders and printing.
const lastPayloadHash = {};
// ETag of the last saved response per endpoint; an unchanged poll then gets an empty 304
const lastEtag = {};

const IMAGE_BATCH = 20;

// Downloads product images by id in small batches. Returns a Map of id -> image for the ones
// that arrived; on a network error it stops early and the rest are retried next sync.
async function fetchImages(ids, headers) {
    const images = new Map();
    for (let i = 0; i < ids.length; i += IMAGE_BATCH) {
        const batch = ids.slice(i, i + IMAGE_BATCH);
        try {
            const response = await fetch(`${API_URL}/sync/images?ids=${batch.map(encodeURIComponent).join(',')}`, {
                headers,
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
            });
            if (!response.ok) break;
            const list = await response.json();
            if (!Array.isArray(list)) break;
            for (const row of list) if (row && row.id) images.set(row.id, row.image || null);
        } catch (e) {
            break;
        }
    }
    return images;
}

const CUSTOMER_PAGE = 2000;
const CUSTOMER_FULL_REFRESH_MS = 24 * 60 * 60 * 1000;

// Customers are pulled as a delta: only rows changed after the stored (updatedAt, id) cursor.
// The full list grows with every new customer, so re-downloading it was getting heavier.
// Deletions can't show up in a delta, so a full refresh replaces the table once a day.
// Returns false if the backend doesn't have /customers/sync yet, so the caller can fall back.
async function syncCustomersDelta(db, headers) {
    const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value || null;
    const setSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP)');

    const lastFull = Number(getSetting('LOCAL_CUSTOMERS_FULL_AT') || 0);
    const full = !getSetting('LOCAL_CUSTOMERS_CURSOR_AT') || Date.now() - lastFull > CUSTOMER_FULL_REFRESH_MS;
    let cursorAt = full ? null : getSetting('LOCAL_CUSTOMERS_CURSOR_AT');
    let cursorId = full ? null : getSetting('LOCAL_CUSTOMERS_CURSOR_ID');

    const rows = [];
    for (;;) {
        const qs = new URLSearchParams({ limit: String(CUSTOMER_PAGE) });
        if (cursorAt) qs.set('updatedSince', cursorAt);
        if (cursorId) qs.set('afterId', cursorId);
        const response = await fetch(`${API_URL}/customers/sync?${qs}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (response.status === 404) return false;
        if (!response.ok) {
            // 403 means this backend predates POS access to customers; anything else is transient
            if (response.status === 403) return false;
            throw new Error(`customers/sync responded ${response.status}`);
        }
        // An old backend routes "sync" to GET /customers/:id and returns an empty body
        const page = await response.json().catch(() => null);
        if (!Array.isArray(page)) return false;
        rows.push(...page);
        if (page.length < CUSTOMER_PAGE) break;
        const last = page[page.length - 1];
        cursorAt = last.updatedAt;
        cursorId = last.id;
    }

    if (rows.length > 0) {
        const last = rows[rows.length - 1];
        cursorAt = last.updatedAt;
        cursorId = last.id;
    }

    // INSERT OR REPLACE also replaces a stale local row holding the same phone number
    const upsert = db.prepare('INSERT OR REPLACE INTO customers (id, name, phone, address, loyaltyPoints, branchId) VALUES (@id, @name, @phone, @address, @loyaltyPoints, @branchId)');
    db.transaction(() => {
        if (full) db.prepare('DELETE FROM customers').run();
        for (const c of rows) {
            upsert.run({
                id: c.id,
                name: c.name,
                phone: c.phone,
                address: c.address ?? null,
                loyaltyPoints: c.loyaltyPoints ?? 0,
                branchId: c.branchId ?? null
            });
        }
        if (cursorAt) {
            setSetting.run('LOCAL_CUSTOMERS_CURSOR_AT', cursorAt);
            setSetting.run('LOCAL_CUSTOMERS_CURSOR_ID', cursorId);
        }
        if (full) setSetting.run('LOCAL_CUSTOMERS_FULL_AT', String(Date.now()));
    })();
    return true;
}

async function runSync() {
    let changed = false;

    // Returns { data, commit } when the payload differs from the last one written, else null.
    // Call commit() only after the data is saved, so a failed write is retried next time.
    // `pick` selects the part that's actually stored, so volatile extras don't count as changes.
    const fetchChanged = async (key, url, headers, pick = (d) => d) => {
        const reqHeaders = { ...headers };
        if (lastEtag[key]) {
            reqHeaders['If-None-Match'] = lastEtag[key];
            // fetch adds "Cache-Control: no-cache" to conditional requests, which makes Express
            // ignore If-None-Match; an explicit value keeps the 304 working
            reqHeaders['Cache-Control'] = 'max-age=0';
        }
        const response = await fetch(url, { headers: reqHeaders, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (response.status === 304 || !response.ok) return null;
        const etag = response.headers.get('etag');
        let data;
        try { data = JSON.parse(await response.text()); } catch (e) { return null; }
        const hash = crypto.createHash('sha1').update(JSON.stringify(pick(data) ?? null)).digest('hex');
        if (lastPayloadHash[key] === hash) {
            if (etag) lastEtag[key] = etag;
            return null;
        }
        return {
            data,
            commit: () => {
                lastPayloadHash[key] = hash;
                if (etag) lastEtag[key] = etag;
                changed = true;
            }
        };
    };

    try {
        const db = getDb();

        let branchId = null;
        let token = null;
        try {
            const userStr = db.prepare("SELECT value FROM settings WHERE key = 'POS_SESSION_USER'").get();
            const tokenStr = db.prepare("SELECT value FROM settings WHERE key = 'POS_SESSION_TOKEN'").get();
            if (userStr?.value) branchId = JSON.parse(userStr.value).branchId;
            if (tokenStr?.value) token = tokenStr.value;
        } catch (e) {
            // Ignore
        }

        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        // Push offline unsynced orders, oldest first, in small chunks so a large backlog
        // never exceeds the server's body limit and one bad chunk can't block the rest.
        const unsyncedOrders = db.prepare('SELECT * FROM orders WHERE synced = 0 ORDER BY createdAt ASC').all();

        if (unsyncedOrders.length > 0) {
            console.log(`Pushing ${unsyncedOrders.length} offline orders to cloud...`);

            const getItems = db.prepare('SELECT * FROM order_items WHERE orderId = ?');
            // Skip orders edited while the push was in flight (a resumed held order or a status
            // change resets synced = 0 with new data); they go up again on the next sync.
            const markSynced = db.prepare('UPDATE orders SET synced = 1 WHERE id = ? AND status = ? AND total = ?');
            const markAllSynced = db.transaction((orders) => {
                for (const o of orders) markSynced.run(o.id, o.status, o.total);
            });

            for (let i = 0; i < unsyncedOrders.length; i += ORDER_PUSH_CHUNK) {
                const chunk = unsyncedOrders.slice(i, i + ORDER_PUSH_CHUNK);
                const fullOrders = chunk.map(order => ({
                    ...order,
                    branchId, // Force the current POS branchId into every order pushed
                    items: getItems.all(order.id)
                }));

                let response;
                try {
                    response = await fetch(`${API_URL}/orders/sync`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ orders: fullOrders }),
                        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
                    });
                } catch (netErr) {
                    break; // offline or timed out; the remaining chunks would fail the same way
                }

                if (!response.ok) {
                    console.error(`Order push rejected (${response.status}) for ${chunk.length} orders; will retry`);
                    continue;
                }

                const body = await response.json().catch(() => null);
                // The backend reports which orders it actually saved; older backends don't,
                // in which case the whole chunk is treated as saved like before.
                const savedIds = Array.isArray(body?.syncedIds) ? new Set(body.syncedIds) : null;
                const saved = savedIds ? chunk.filter(o => savedIds.has(o.id)) : chunk;
                markAllSynced(saved);
                if (saved.length > 0) changed = true;
                if (body?.failed?.length) {
                    console.error(`Cloud could not save ${body.failed.length} orders; will retry:`, body.failed);
                }
            }
        }

        // Pull items from cloud
        try {
            // images=separate: the list carries an imageHash per product instead of the image,
            // and only new/changed images are downloaded. Older backends ignore the flag and
            // still send images inline (no imageHash), which is handled the old way.
            const url = `${API_URL}/sync/pull?lastSyncDate=1970-01-01&images=separate${branchId ? `&branchId=${branchId}` : ''}`;
            // Older backends add a per-request timestamp and stock levels; only products are stored
            const result = await fetchChanged('products', url, headers, (d) => d.products);
            if (result) {
                const data = result.data;
                if (data.products) {
                    let imagesComplete = true;
                    const separateImages = data.products.some(p => 'imageHash' in p);
                    if (separateImages) {
                        const local = new Map(db.prepare('SELECT id, image, imageHash FROM products').all().map(r => [r.id, r]));
                        const needed = data.products.filter(p => p.imageHash && local.get(p.id)?.imageHash !== p.imageHash);
                        const fetched = await fetchImages(needed.map(p => p.id), headers);
                        for (const p of data.products) {
                            const have = local.get(p.id);
                            if (!p.imageHash) {
                                p.image = null;
                            } else if (have?.imageHash === p.imageHash) {
                                p.image = have.image;
                            } else if (fetched.has(p.id)) {
                                p.image = fetched.get(p.id);
                            } else {
                                // Download failed: keep the old image and hash so it's retried next sync
                                imagesComplete = false;
                                p.image = have?.image || null;
                                p.imageHash = have?.imageHash || null;
                            }
                        }
                    }

                    const clearVariants = db.prepare('DELETE FROM item_variants');
                    const clearProducts = db.prepare('DELETE FROM products');
                    const insertOrReplace = db.prepare('INSERT OR REPLACE INTO products (id, name, sku, price, updatedAt, categoryId, isDeal, dealItems, image, imageHash) VALUES (@id, @name, @sku, @price, @updatedAt, @categoryId, @isDeal, @dealItems, @image, @imageHash)');
                    const insertVariant = db.prepare('INSERT OR REPLACE INTO item_variants (id, productId, name, price) VALUES (@id, @productId, @name, @price)');
                    
                    const transaction = db.transaction((products) => {
                        clearVariants.run();
                        clearProducts.run();
                        for (const p of products) {
                            const isDeal = p.isDeal ? 1 : 0;
                            let dealItemsStr = null;
                            if (isDeal && p.dealItemsAsDeal) {
                                dealItemsStr = JSON.stringify(p.dealItemsAsDeal.map(d => ({
                                    productId: d.productId,
                                    name: d.product?.name,
                                    quantity: d.quantity,
                                    variantId: d.variantId || null,
                                    variantName: d.variant?.name
                                })));
                            }
                            insertOrReplace.run({
                                id: p.id,
                                name: p.name,
                                sku: p.sku,
                                price: p.price,
                                updatedAt: p.updatedAt || new Date().toISOString(),
                                categoryId: p.categoryId || null,
                                isDeal: isDeal,
                                dealItems: dealItemsStr,
                                image: p.image || null,
                                imageHash: p.imageHash || null
                            });
                            if (p.variants && p.variants.length > 0) {
                                for (const v of p.variants) {
                                    insertVariant.run({ id: v.id, productId: p.id, name: v.name, price: v.price });
                                }
                            }
                        }
                    });
                    transaction(data.products);
                    // Leaving it uncommitted makes the next sync fetch the list again and
                    // retry only the images that are still missing
                    if (imagesComplete) result.commit();
                    else changed = true;
                }
            }
        } catch (netErr) {
            console.error('Network or SQLite error during product sync:', netErr);
        }

        // Pull settings from cloud
        try {
            const result = await fetchChanged('settings', `${API_URL}/settings`, headers);
            if (result) {
                const settings = result.data;
                if (settings && settings.length > 0) {
                    const insertOrReplaceSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES (@key, @value, @updatedAt)');
                    const transaction = db.transaction((settingsList) => {
                        for (const s of settingsList) insertOrReplaceSetting.run(s);
                    });
                    transaction(settings);
                }
                result.commit();
            }
        } catch (netErr) {
            // Ignore, maybe no network
        }

        // Pull Riders from Cloud
        if (branchId && token) {
            try {
                const result = await fetchChanged('riders', `${API_URL}/riders?branchId=${branchId}`, headers);
                if (result) {
                    const riders = result.data;
                    const clearRiders = db.prepare('DELETE FROM riders');
                    const insertOrReplaceRider = db.prepare('INSERT OR REPLACE INTO riders (id, name, phone, status, branchId) VALUES (@id, @name, @phone, @status, @branchId)');
                    const transaction = db.transaction((ridersList) => {
                        clearRiders.run();
                        for (const r of ridersList) insertOrReplaceRider.run(r);
                    });
                    transaction(riders || []);
                    result.commit();
                }
            } catch (e) {
                console.error('Failed to sync riders', e);
            }

            // Sync Customers: only what changed since last time (see syncCustomersDelta);
            // falls back to the full list on backends without /customers/sync
            try {
                const deltaSupported = await syncCustomersDelta(db, headers);
                // totalOrders / totalSpent change on every synced order but aren't stored here
                const result = deltaSupported ? null : await fetchChanged('customers', `${API_URL}/customers`, headers, (list) =>
                    Array.isArray(list) ? list.map(c => [c.id, c.name, c.phone, c.address, c.loyaltyPoints, c.branchId]) : list);
                if (result) {
                    const customers = result.data;
                    const clearCustomers = db.prepare('DELETE FROM customers');
                    const insertOrReplaceCustomer = db.prepare('INSERT OR REPLACE INTO customers (id, name, phone, address, loyaltyPoints, branchId) VALUES (@id, @name, @phone, @address, @loyaltyPoints, @branchId)');
                    const transaction = db.transaction((customersList) => {
                        clearCustomers.run();
                        for (const c of customersList) insertOrReplaceCustomer.run({
                            id: c.id,
                            name: c.name,
                            phone: c.phone,
                            address: c.address,
                            loyaltyPoints: c.loyaltyPoints,
                            branchId: c.branchId
                        });
                    });
                    transaction(customers || []);
                    result.commit();
                }
            } catch (e) {
                console.error('Failed to sync customers', e);
            }

            // Sync Categories
            try {
                const catUrl = branchId && branchId !== 'null' ? `${API_URL}/categories?branchId=${branchId}` : `${API_URL}/categories`;
                const result = await fetchChanged('categories', catUrl, headers);
                if (result) {
                    const categories = result.data;
                    const clearCats = db.prepare('DELETE FROM categories');
                    const insertOrReplaceCat = db.prepare('INSERT OR REPLACE INTO categories (id, name, branchId) VALUES (@id, @name, @branchId)');
                    const transaction = db.transaction((list) => {
                        clearCats.run();
                        for (const c of list) {
                            insertOrReplaceCat.run({ id: c.id, name: c.name, branchId: c.branchId || null });
                        }
                    });
                    transaction(categories || []);
                    result.commit();
                }
            } catch (e) {
                console.error('Failed to sync categories', e);
            }

            // Sync Vouchers
            try {
                const result = await fetchChanged('vouchers', `${API_URL}/vouchers?branchId=${branchId}`, headers);
                if (result) {
                    const vouchers = result.data;
                    const clearVouchers = db.prepare('DELETE FROM vouchers');
                    const insertOrReplaceVoucher = db.prepare('INSERT OR REPLACE INTO vouchers (id, code, name, type, value, expiryDate, isActive, branchId) VALUES (@id, @code, @name, @type, @value, @expiryDate, @isActive, @branchId)');
                    const transaction = db.transaction((list) => {
                        clearVouchers.run();
                        for (const v of list) {
                            insertOrReplaceVoucher.run({
                                id: v.id,
                                code: v.code,
                                name: v.name || null,
                                type: v.type,
                                value: v.value,
                                expiryDate: v.expiryDate,
                                isActive: v.isActive ? 1 : 0,
                                branchId: v.branchId || null
                            });
                        }
                    });
                    transaction(vouchers || []);
                    result.commit();
                }
            } catch (e) {
                console.error('Failed to sync vouchers', e);
            }
        }

    } catch (error) {
        console.error("Sync worker encountered an error:", error.message);
    }
    return changed;
}

// Only one sync runs at a time; a call during a running sync shares its result.
// Previously a slow backend let 15s syncs pile up on top of each other.
let syncInFlight = null;
function performSync() {
    if (!syncInFlight) syncInFlight = runSync().finally(() => { syncInFlight = null; });
    return syncInFlight;
}

function startSyncWorker(onSyncComplete) {
    console.log("Starting Background Sync Worker...");
    const tick = async () => {
        const changed = await performSync();
        // Only make the UI reload when something actually changed
        if (changed && onSyncComplete) onSyncComplete();
        setTimeout(tick, SYNC_INTERVAL_MS);
    };
    setTimeout(tick, SYNC_INTERVAL_MS);
}

module.exports = { startSyncWorker, performSync };
