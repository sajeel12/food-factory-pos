const { getDb } = require('./db.cjs');
const fs = require('fs');
const path = require('path');

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

async function performSync() {
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

        // Push offline unsynced orders
        const unsyncedOrders = db.prepare('SELECT * FROM orders WHERE synced = 0').all();

        if (unsyncedOrders.length > 0) {
            console.log(`Pushing ${unsyncedOrders.length} offline orders to cloud...`);

            // Fetch items for each order
            const getItems = db.prepare('SELECT * FROM order_items WHERE orderId = ?');
            const fullOrders = unsyncedOrders.map(order => ({
                ...order,
                branchId, // Force the current POS branchId into every order pushed
                items: getItems.all(order.id)
            }));

            try {
                const response = await fetch(`${API_URL}/orders/sync`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ orders: fullOrders })
                });

                if (response.ok) {
                    const markSynced = db.prepare('UPDATE orders SET synced = 1 WHERE id = ?');
                    const transaction = db.transaction((orders) => {
                        for (const o of orders) markSynced.run(o.id);
                    });
                    transaction(unsyncedOrders);
                }
            } catch (netErr) {
                // Ignore, maybe no network
            }
        }

        // Pull items from cloud
        try {
            const url = `${API_URL}/sync/pull?lastSyncDate=1970-01-01${branchId ? `&branchId=${branchId}` : ''}`;
            const response = await fetch(url, { headers });
            if (response.ok) {
                const data = await response.json();
                if (data.products) {
                    const clearVariants = db.prepare('DELETE FROM item_variants');
                    const clearProducts = db.prepare('DELETE FROM products');
                    const insertOrReplace = db.prepare('INSERT OR REPLACE INTO products (id, name, sku, price, updatedAt, categoryId, isDeal, dealItems, image) VALUES (@id, @name, @sku, @price, @updatedAt, @categoryId, @isDeal, @dealItems, @image)');
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
                                image: p.image || null
                            });
                            if (p.variants && p.variants.length > 0) {
                                for (const v of p.variants) {
                                    insertVariant.run({ id: v.id, productId: p.id, name: v.name, price: v.price });
                                }
                            }
                        }
                    });
                    transaction(data.products);
                }
            }
        } catch (netErr) {
            console.error('Network or SQLite error during product sync:', netErr);
        }

        // Pull settings from cloud
        try {
            const response = await fetch(`${API_URL}/settings`, { headers });
            if (response.ok) {
                const settings = await response.json();
                if (settings && settings.length > 0) {
                    const insertOrReplaceSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES (@key, @value, @updatedAt)');
                    const transaction = db.transaction((settingsList) => {
                        for (const s of settingsList) insertOrReplaceSetting.run(s);
                    });
                    transaction(settings);
                }
            }
        } catch (netErr) {
            // Ignore, maybe no network
        }

        // Pull Riders from Cloud
        if (branchId && token) {
            try {
                const response = await fetch(`${API_URL}/riders?branchId=${branchId}`, { headers });
                if (response.ok) {
                    const riders = await (response.json().catch(() => []));
                    const clearRiders = db.prepare('DELETE FROM riders');
                    const insertOrReplaceRider = db.prepare('INSERT OR REPLACE INTO riders (id, name, phone, status, branchId) VALUES (@id, @name, @phone, @status, @branchId)');
                    const transaction = db.transaction((ridersList) => {
                        clearRiders.run();
                        for (const r of ridersList) insertOrReplaceRider.run(r);
                    });
                    transaction(riders || []);
                }
            } catch (e) {
                console.error('Failed to sync riders', e);
            }

            // Sync Customers
            try {
                const response = await fetch(`${API_URL}/customers`, { headers });
                if (response.ok) {
                    const customers = await (response.json().catch(() => []));
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
                }
            } catch (e) {
                console.error('Failed to sync customers', e);
            }

            // Sync Categories
            try {
                const catUrl = branchId && branchId !== 'null' ? `${API_URL}/categories?branchId=${branchId}` : `${API_URL}/categories`;
                const response = await fetch(catUrl, { headers });
                if (response.ok) {
                    const categories = await (response.json().catch(() => []));
                    const clearCats = db.prepare('DELETE FROM categories');
                    const insertOrReplaceCat = db.prepare('INSERT OR REPLACE INTO categories (id, name, branchId) VALUES (@id, @name, @branchId)');
                    const transaction = db.transaction((list) => {
                        clearCats.run();
                        for (const c of list) {
                            insertOrReplaceCat.run({ id: c.id, name: c.name, branchId: c.branchId || null });
                        }
                    });
                    transaction(categories || []);
                }
            } catch (e) {
                console.error('Failed to sync categories', e);
            }

            // Sync Vouchers
            try {
                const response = await fetch(`${API_URL}/vouchers?branchId=${branchId}`, { headers });
                if (response.ok) {
                    const vouchers = await (response.json().catch(() => []));
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
                }
            } catch (e) {
                console.error('Failed to sync vouchers', e);
            }
        }

    } catch (error) {
        console.error("Sync worker encountered an error:", error.message);
    }
}

function startSyncWorker(onSyncComplete) {
    console.log("Starting Background Sync Worker...");
    setInterval(async () => {
        await performSync();
        if (onSyncComplete) onSyncComplete();
    }, 15000); // 15 seconds
}

module.exports = { startSyncWorker, performSync };
