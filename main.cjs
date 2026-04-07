const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { initDb, getDb } = require('./db.cjs');
const { startSyncWorker, performSync } = require('./sync.cjs');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
escpos.Network = require('escpos-network');

function getPrinterDevice(type, addr) {
    if (type === 'USB') {
        // If addr is in "vendorId:productId" hex format, target that specific device
        if (addr && addr.includes(':')) {
            const [vid, pid] = addr.split(':').map(v => parseInt(v, 16));
            return new escpos.USB(vid, pid);
        }
        return new escpos.USB(); // fallback: first available USB printer
    }
    if (type === 'LAN' && addr) return new escpos.Network(addr);
    return null;
}

// Auto-detect connected USB printers for dropdown selection
ipcMain.handle('detect-usb-printers', async () => {
    try {
        const usb = require('usb');
        const devices = usb.getDeviceList();
        const printers = [];
        for (const device of devices) {
            const desc = device.deviceDescriptor;
            // Filter for printer class (7) or show all devices and let user pick
            let name = `USB Device`;
            try {
                device.open();
                const manufacturer = device.getStringDescriptor(desc.iManufacturer);
                const product = device.getStringDescriptor(desc.iProduct);
                // getStringDescriptor is async in newer usb versions, handle both
                if (typeof manufacturer === 'string') name = `${manufacturer} ${product}`;
                device.close();
            } catch (_e) {
                // Some devices won't allow opening - that's fine
            }
            const vid = desc.idVendor.toString(16).padStart(4, '0');
            const pid = desc.idProduct.toString(16).padStart(4, '0');
            printers.push({
                vendorId: vid,
                productId: pid,
                addr: `0x${vid}:0x${pid}`,
                name: `${name} (${vid}:${pid})`,
            });
        }
        return printers;
    } catch (e) {
        console.error('USB detection error:', e);
        // Fallback: try escpos.USB.findPrinter if available
        try {
            const found = escpos.USB.findPrinter();
            if (found && found.length) {
                return found.map((d, i) => ({
                    vendorId: d.deviceDescriptor?.idVendor?.toString(16) || 'unknown',
                    productId: d.deviceDescriptor?.idProduct?.toString(16) || 'unknown',
                    addr: `0x${(d.deviceDescriptor?.idVendor || 0).toString(16).padStart(4, '0')}:0x${(d.deviceDescriptor?.idProduct || 0).toString(16).padStart(4, '0')}`,
                    name: `Printer ${i + 1} (${(d.deviceDescriptor?.idVendor || 0).toString(16)}:${(d.deviceDescriptor?.idProduct || 0).toString(16)})`,
                }));
            }
        } catch (_e2) { /* no-op */ }
        return [];
    }
});

function createWindow() {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

    if (isDev) {
        win.loadURL('http://localhost:5173');
    } else {
        win.loadFile(path.join(__dirname, 'dist', 'index.html'));
    }
}

// B8 - Exposing SQLite CRUD operations via IPC
ipcMain.handle('get-products', async () => {
    const db = getDb();
    const products = db.prepare('SELECT * FROM products').all();
    const getVariants = db.prepare('SELECT * FROM item_variants WHERE productId = ?');
    return products.map(p => ({
        ...p,
        variants: getVariants.all(p.id)
    }));
});

ipcMain.handle('get-categories', async () => {
    try {
        const db = getDb();
        return db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
    } catch (e) {
        console.error("Failed to fetch categories:", e);
        return [];
    }
});

ipcMain.handle('create-order', async (event, orderData) => {
    const db = getDb();
    const { id, total, status, items, paymentMethod, tenderedAmount, customerName, customerPhone, customerAddress } = orderData;
    const insertOrder = db.prepare('INSERT INTO orders (id, total, status, paymentMethod, tenderedAmount, customerName, customerPhone, customerAddress) VALUES (@id, @total, @status, @paymentMethod, @tenderedAmount, @customerName, @customerPhone, @customerAddress)');
    const insertItem = db.prepare('INSERT INTO order_items (id, orderId, productId, variantId, variantName, quantity, subtotal) VALUES (@id, @orderId, @productId, @variantId, @variantName, @quantity, @subtotal)');

    const transaction = db.transaction((order, cartItems) => {
        insertOrder.run(order);
        for (const item of cartItems) {
            insertItem.run({
                id: item.id,
                orderId: item.orderId || order.id,
                productId: item.productId,
                variantId: item.variantId || null,
                variantName: item.variantName || null,
                quantity: item.quantity,
                subtotal: item.subtotal
            });
        }
    });

    try {
        const pm = paymentMethod || 'CASH';
        const ta = tenderedAmount !== undefined ? tenderedAmount : total;
        transaction({
            id, total, status, paymentMethod: pm, tenderedAmount: ta,
            customerName: customerName || null,
            customerPhone: customerPhone || null,
            customerAddress: customerAddress || null
        }, items);
        return { success: true };
    } catch (e) {
        console.error("Order Creation Error:", e);
        return { success: false, error: e.message };
    }
});
ipcMain.handle('get-settings', async (event, keys) => {
    try {
        const db = getDb();
        const placeholders = keys.map(() => '?').join(',');
        return db.prepare(`SELECT * FROM settings WHERE key IN (${placeholders})`).all(...keys);
    } catch (e) {
        console.error("Failed to get settings:", e);
        return [];
    }
});

ipcMain.handle('save-settings', async (event, updates) => {
    try {
        const db = getDb();
        const insertOrReplace = db.prepare('INSERT OR REPLACE INTO settings (key, value, updatedAt) VALUES (@key, @value, CURRENT_TIMESTAMP)');
        const transaction = db.transaction((list) => {
            for (const item of list) insertOrReplace.run(item);
        });
        transaction(updates);
        return { success: true };
    } catch (e) {
        console.error("Failed to save settings:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('print-receipt', async (event, printData) => {
    try {
        const db = getDb();
        const type = db.prepare("SELECT value FROM settings WHERE key = 'RECEIPT_PRINTER_TYPE'").get()?.value || 'NONE';
        const addr = db.prepare("SELECT value FROM settings WHERE key = 'RECEIPT_PRINTER_ADDR'").get()?.value;
        const drawerEnabled = db.prepare("SELECT value FROM settings WHERE key = 'CASH_DRAWER_ENABLED'").get()?.value === 'true';

        if (type === 'NONE') return { success: true, message: 'Printer disabled' };

        const device = getPrinterDevice(type, addr);
        if (!device) throw new Error("Could not initialize printer device");

        const printer = new escpos.Printer(device);

        device.open((err) => {
            if (err) {
                console.error("Printer connection error:", err);
                return;
            }
            printer
                .font('a')
                .align('ct')
                .style('b')
                .size(2, 2)
                .text('FOOD FACTORY')
                .size(1, 1)
                .text('RECEIPT')
                .text('--------------------------------')
                .align('lt')
                .text(`Order ID: ${printData.id}`)
                .text(`Date: ${new Date(printData.createdAt).toLocaleString()}`)
                .text('--------------------------------');

            printData.items.forEach(item => {
                const variantText = item.variantName ? ` (${item.variantName})` : '';
                printer.text(`${item.quantity}x ${item.name}${variantText} - $${item.subtotal.toFixed(2)}`);
            });

            printer
                .text('--------------------------------')
                .align('rt')
                .style('b')
                .text(`TOTAL: $${printData.total.toFixed(2)}`)
                .style('normal')
                .text(`TENDERED: $${(printData.tenderedAmount || printData.total).toFixed(2)}`)
                .align('ct')
                .text(' ')
                .text('Thank you for dining with us!')
                .text(' ')
                .text(' ');

            if (drawerEnabled) printer.cashdraw(2);
            printer.cut().close();
        });
        return { success: true };
    } catch (e) {
        console.error("Receipt Print Error:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('print-kitchen', async (event, printData) => {
    try {
        const db = getDb();
        const type = db.prepare("SELECT value FROM settings WHERE key = 'KITCHEN_PRINTER_TYPE'").get()?.value || 'NONE';
        const addr = db.prepare("SELECT value FROM settings WHERE key = 'KITCHEN_PRINTER_ADDR'").get()?.value;

        if (type === 'NONE') return { success: true, message: 'Kitchen printer disabled' };

        const device = getPrinterDevice(type, addr);
        if (!device) throw new Error("Could not initialize kitchen printer device");

        const printer = new escpos.Printer(device);

        device.open((err) => {
            if (err) {
                console.error("Kitchen Printer connection error:", err);
                return;
            }
            printer
                .font('a')
                .align('ct')
                .style('b')
                .size(2, 2)
                .text('*** KITCHEN SLIP ***')
                .size(1, 1)
                .text('--------------------------------')
                .align('lt')
                .text(`Order ID: ${printData.id}`)
                .text('--------------------------------')
                .size(2, 1);

            printData.items.forEach(item => {
                const variantText = item.variantName ? ` (${item.variantName})` : '';
                printer.text(`${item.quantity}x ${item.name}${variantText}`);
            });

            printer
                .size(1, 1)
                .text('--------------------------------')
                .text(' ')
                .text(' ')
                .text(' ')
                .cut()
                .close();
        });
        return { success: true };
    } catch (e) {
        console.error("Kitchen Print Error:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('open-cash-drawer', async () => {
    try {
        const db = getDb();
        const type = db.prepare("SELECT value FROM settings WHERE key = 'RECEIPT_PRINTER_TYPE'").get()?.value || 'NONE';
        const addr = db.prepare("SELECT value FROM settings WHERE key = 'RECEIPT_PRINTER_ADDR'").get()?.value;

        if (type === 'NONE') return { success: true, message: 'Printer disabled, cannot open drawer' };

        const device = getPrinterDevice(type, addr);
        if (!device) throw new Error("Could not initialize printer device");

        const printer = new escpos.Printer(device);

        device.open((err) => {
            if (err) return console.error("Drawer kick error:", err);
            printer.cashdraw(2).close();
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-delivery-orders', async () => {
    try {
        const db = getDb();
        return db.prepare("SELECT * FROM orders WHERE customerName IS NOT NULL AND status IN ('Pending', 'Assigned') ORDER BY createdAt DESC").all();
    } catch (e) {
        console.error("Failed to fetch delivery orders:", e);
        return [];
    }
});

ipcMain.handle('get-riders', async () => {
    try {
        const db = getDb();
        // Return riders that are AVAILABLE
        return db.prepare("SELECT * FROM riders WHERE status = 'AVAILABLE' ORDER BY name ASC").all();
    } catch (e) {
        console.error("Failed to fetch riders:", e);
        return [];
    }
});

ipcMain.handle('search-customer', async (event, phone) => {
    try {
        const db = getDb();
        return db.prepare("SELECT * FROM customers WHERE phone LIKE ? OR phone = ? ORDER BY loyaltyPoints DESC LIMIT 5").all(`%${phone}%`, phone);
    } catch (e) {
        console.error("Failed to search customer:", e);
        return [];
    }
});

ipcMain.handle('update-order-status', async (event, { id, status, rider }) => {
    try {
        const db = getDb();
        // We can't easily store 'rider' in the current schema without a column, 
        // but let's assume 'status' update is the main thing.
        // Actually, let's just update the status for now.
        db.prepare("UPDATE orders SET status = ?, synced = 0 WHERE id = ?").run(status, id);
        return { success: true };
    } catch (e) {
        console.error("Failed to update status:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-sync-status', async () => {
    try {
        const db = getDb();
        const result = db.prepare('SELECT COUNT(*) as count FROM orders WHERE synced = 0').get();
        return { unsyncedOrders: result.count };
    } catch (e) {
        return { unsyncedOrders: 0, error: e.message };
    }
});

ipcMain.handle('get-order-history', async () => {
    try {
        const db = getDb();
        return db.prepare('SELECT * FROM orders ORDER BY createdAt DESC').all();
    } catch (e) {
        console.error("Failed to fetch order history:", e);
        return [];
    }
});

ipcMain.handle('get-current-shift', async () => {
    try {
        const db = getDb();
        return db.prepare("SELECT * FROM shifts WHERE status = 'OPEN' ORDER BY startedAt DESC LIMIT 1").get();
    } catch (e) {
        return null;
    }
});

ipcMain.handle('start-shift', async (event, { openingCash }) => {
    try {
        const db = getDb();
        const id = require('crypto').randomUUID();
        db.prepare("INSERT INTO shifts (id, openingCash, status) VALUES (?, ?, 'OPEN')")
            .run(id, openingCash);
        return { success: true, id };
    } catch (e) {
        console.error("Failed to start shift:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('end-shift', async (event, { id, actualCash }) => {
    try {
        const db = getDb();
        const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
        if (!shift) throw new Error("Shift not found");

        // Use exactly tenderedAmount mapping or total if appropriate, here 'total' is sales sum. Let's use total for 'CASH'
        const result = db.prepare("SELECT SUM(total) as cashSales FROM orders WHERE paymentMethod = 'CASH' AND createdAt >= ?").get(shift.startedAt);
        const expectedCash = shift.openingCash + (result.cashSales || 0);

        db.prepare("UPDATE shifts SET status = 'CLOSED', endedAt = CURRENT_TIMESTAMP, expectedCash = ?, actualCash = ?, synced = 0 WHERE id = ?")
            .run(expectedCash, actualCash, id);
        return { success: true, expectedCash };
    } catch (e) {
        console.error("Failed to end shift:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('force-sync', async () => {
    try {
        await performSync();
        return { success: true };
    } catch (e) {
        console.error("Force sync failed:", e);
        return { success: false, error: e.message };
    }
});

app.whenReady().then(() => {
    initDb();
    createWindow();
    startSyncWorker();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
