const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { initDb, getDb } = require('./db.cjs');
const { startSyncWorker, performSync } = require('./sync.cjs');
const escpos = require('escpos');
escpos.USB = require('escpos-usb');
escpos.Network = require('escpos-network');

function getPrinterDevice(type, addr, port) {
    if (type === 'USB') {
        // If addr is in "vendorId:productId" hex format, target that specific device
        if (addr && addr.includes(':')) {
            const [vid, pid] = addr.split(':').map(v => parseInt(v, 16));
            return new escpos.USB(vid, pid);
        }
        return new escpos.USB(); // fallback: first available USB printer
    }
    if (type === 'LAN' && addr) return new escpos.Network(addr, parseInt(port) || 9100);
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
        icon: path.join(__dirname, 'build', 'icon.ico'),
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
    const { id, total, status, items, paymentMethod, tenderedAmount, customerName, customerPhone, customerAddress, deliveryFee, orderType, tableNo } = orderData;
    const insertOrder = db.prepare('INSERT OR REPLACE INTO orders (id, total, status, paymentMethod, tenderedAmount, customerName, customerPhone, customerAddress, deliveryFee, dailyOrderNumber, orderType, tableNo, createdAt) VALUES (@id, @total, @status, @paymentMethod, @tenderedAmount, @customerName, @customerPhone, @customerAddress, @deliveryFee, @dailyOrderNumber, @orderType, @tableNo, @createdAt)');
    const deleteItems = db.prepare('DELETE FROM order_items WHERE orderId = ?');
    const insertItem = db.prepare('INSERT INTO order_items (id, orderId, productId, variantId, variantName, quantity, subtotal, dealChoices) VALUES (@id, @orderId, @productId, @variantId, @variantName, @quantity, @subtotal, @dealChoices)');

    const transaction = db.transaction((order, cartItems) => {
        insertOrder.run(order);
        deleteItems.run(order.id);
        for (const item of cartItems) {
            insertItem.run({
                id: item.id,
                orderId: item.orderId || order.id,
                productId: item.productId,
                variantId: item.variantId || null,
                variantName: item.variantName || null,
                quantity: item.quantity,
                subtotal: item.subtotal,
                dealChoices: item.dealChoices || null
            });
        }
    });

    try {
        const pm = paymentMethod || 'CASH';
        const ta = tenderedAmount !== undefined ? tenderedAmount : total;

        // Calculate daily order number; preserve createdAt for existing orders
        let finalDailyOrderNumber = 0;
        const existingOrder = db.prepare("SELECT dailyOrderNumber, createdAt FROM orders WHERE id = ?").get(id);

        if (existingOrder && existingOrder.dailyOrderNumber) {
            finalDailyOrderNumber = existingOrder.dailyOrderNumber;
        } else {
            // Get business date (subtract 6 hours from current time)
            // This ensures 1:00 AM orders are grouped into the previous day's shift
            const now = new Date();
            const bizDate = new Date(now.getTime() - 6 * 60 * 60 * 1000);
            const year = bizDate.getFullYear();
            const month = String(bizDate.getMonth() + 1).padStart(2, '0');
            const day = String(bizDate.getDate()).padStart(2, '0');
            const localBizDate = `${year}-${month}-${day}`;

            // SQLite's datetime() function adjusts the UTC createdAt to local time, 
            // then subtracts 6 hours to match our business day logic.
            const prevOrderQuery = db.prepare("SELECT MAX(dailyOrderNumber) as maxNum FROM orders WHERE datetime(createdAt, 'localtime', '-6 hours') LIKE ?");
            const prevOrder = prevOrderQuery.get(`${localBizDate}%`);
            finalDailyOrderNumber = (prevOrder && prevOrder.maxNum ? prevOrder.maxNum : 0) + 1;
        }

        const createdAt = (existingOrder && existingOrder.createdAt)
            ? existingOrder.createdAt
            : (orderData.createdAt || new Date().toISOString());

        transaction({
            id, total, status, paymentMethod: pm, tenderedAmount: ta,
            customerName: customerName || null,
            customerPhone: customerPhone || null,
            customerAddress: customerAddress || null,
            deliveryFee: deliveryFee || 0,
            voucherId: orderData.voucherId || null,
            discount: orderData.discount || 0,
            orderType: orderType || 'TAKE_AWAY',
            tableNo: tableNo || null,
            dailyOrderNumber: finalDailyOrderNumber,
            createdAt
        }, items);
        return { success: true, dailyOrderNumber: finalDailyOrderNumber };
    } catch (e) {
        console.error("Order Creation Error:", e);
        return { success: false, error: e.message };
    }
});
ipcMain.handle('get-settings', async (event, keys) => {
    try {
        const db = getDb();
        if (!keys || keys.length === 0) {
            return db.prepare(`SELECT * FROM settings`).all();
        }
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

ipcMain.handle('get-order-items', async (event, orderId) => {
    try {
        const db = getDb();
        const items = db.prepare(`
            SELECT oi.*, p.name FROM order_items oi
            LEFT JOIN products p ON oi.productId = p.id
            WHERE oi.orderId = ?
        `).all(orderId);
        return items;
    } catch (e) {
        console.error("Failed to get order items:", e);
        return [];
    }
});

ipcMain.handle('print-receipt', async (event, printData) => {
    try {
        const db = getDb();
        const type = db.prepare("SELECT value FROM settings WHERE key = 'RECEIPT_PRINTER_TYPE'").get()?.value || 'NONE';
        const addr = db.prepare("SELECT value FROM settings WHERE key = 'RECEIPT_PRINTER_ADDR'").get()?.value;
        const port = db.prepare("SELECT value FROM settings WHERE key = 'RECEIPT_PRINTER_PORT'").get()?.value || '9100';
        const drawerEnabled = false;

        if (type === 'NONE') return { success: true, message: 'Printer disabled' };

        const device = getPrinterDevice(type, addr, port);
        if (!device) throw new Error("Could not initialize printer device");

        let sessionUser = null;
        try {
            const userStr = db.prepare("SELECT value FROM settings WHERE key = 'POS_SESSION_USER'").get()?.value;
            if (userStr) sessionUser = JSON.parse(userStr);
        } catch (e) { }

        const printer = new escpos.Printer(device);

        device.open((err) => {
            if (err) {
                console.error("Printer connection error:", err);
                return;
            }
            let dateObj = new Date(printData.createdAt);
            let dateStr = dateObj.toLocaleDateString();
            let timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const isDelivery = !!printData.customerAddress || printData.orderType === 'DELIVERY';
            const isDineIn = printData.orderType === 'DINE_IN';
            const orderTypeStr = isDineIn ? 'DINE IN' : (isDelivery ? 'DELIVERY' : 'TAKE AWAY');

            let detailStr = '';
            if (isDineIn) {
                detailStr = `Table No: ${printData.tableNo || '-'}`;
            } else if (isDelivery) {
                detailStr = `Detail: ${printData.customerName || 'Customer'} - ${printData.customerPhone || ''}`;
            } else {
                detailStr = `Detail: Take Away - ${printData.customerName || 'Cash'}`;
            }

            let sessionUser = null;
            try {
                const userStr = db.prepare("SELECT value FROM settings WHERE key = 'POS_SESSION_USER'").get()?.value;
                if (userStr) sessionUser = JSON.parse(userStr);
            } catch (e) { }

            const rawAddress = printData.branchAddress || sessionUser?.branchAddress || '30 FOOT BAZAR, Near masjid Aqsa. St# 24. Shaheen Abad Gujranwala';
            const rawCashier = printData.cashierName || sessionUser?.username || 'FOOD FACTORY';

            const addressLine1 = rawAddress.substring(0, 48);
            const addressLine2 = rawAddress.length > 48 ? rawAddress.substring(48, 96) : '';

            printer
                .align('ct')
                .raw(Buffer.from([0x1C, 0x70, 0x01, 0x00])) // NV Logo (Index 1)
                .text(' ') // Single flushing space
                .style('b')
                .size(0, 1)
                .text('A taste you will remember')
                .size(0, 0)
                .style('normal')
                .text(' ')
                .font('a')
                .text(addressLine1);

            if (addressLine2) printer.text(addressLine2);

            printer
                .text(' ')
                .style('b')
                .text(orderTypeStr)
                .style('normal')
                .text('--------------------------------')
                .text(detailStr)
                .text('--------------------------------')
                .align('lt')
                .text(`Date: ${dateStr}  ${timeStr}`)
                .text(' ')
                .align('ct')
                .style('b')
                .size(1, 1)
                .text(`Order No: ${printData.dailyOrderNumber || '-'}`)
                .size(0, 0)
                .style('normal')
                .text(' ')
                .align('lt')
                .text(`Cashier: ${rawCashier.substring(0, 16).toUpperCase()}`)
                .text('--------------------------------');

            printer.tableCustom([
                { text: "Deal", align: "LEFT", width: 0.40 },
                { text: "Qty", align: "CENTER", width: 0.15 },
                { text: "Price", align: "RIGHT", width: 0.20 },
                { text: "Total", align: "RIGHT", width: 0.25 }
            ]);
            printer.text('--------------------------------');

            printData.items.forEach(item => {
                const name = (item.name || 'Item').substring(0, 16);
                const pricePerItem = item.quantity > 0 ? (item.subtotal / item.quantity) : 0;

                printer.tableCustom([
                    { text: name, align: "LEFT", width: 0.40 },
                    { text: String(item.quantity), align: "CENTER", width: 0.15 },
                    { text: String(Math.round(pricePerItem)), align: "RIGHT", width: 0.20 },
                    { text: String(Math.round(item.subtotal)), align: "RIGHT", width: 0.25 }
                ]);

                if (item.variantName) {
                    printer.text(` (${item.variantName})`);
                }

                if (item.dealChoices) {
                    try {
                        const choices = JSON.parse(item.dealChoices);
                        choices.forEach(c => {
                            const variant = c.variantName ? `: ${c.variantName}` : '';
                            printer.text(`  > ${c.productName}${variant}`.substring(0, 24));
                        });
                    } catch (e) { }
                }
            });

            printer.text('--------------------------------');

            printer.tableCustom([
                { text: "Bill Amount:", align: "RIGHT", width: 0.60, style: 'B' },
                { text: String(Math.round(printData.total - (printData.deliveryFee || 0) + (printData.discount || 0))), align: "RIGHT", width: 0.40, style: 'B' }
            ]);

            if (printData.deliveryFee > 0) {
                printer.tableCustom([
                    { text: "Delivery Fee:", align: "RIGHT", width: 0.60 },
                    { text: String(Math.round(printData.deliveryFee)), align: "RIGHT", width: 0.40 }
                ]);
            }

            if (printData.discount > 0) {
                printer.tableCustom([
                    { text: "Discount:", align: "RIGHT", width: 0.60 },
                    { text: "-" + String(Math.round(printData.discount)), align: "RIGHT", width: 0.40 }
                ]);
            }

            if (printData.deliveryFee > 0 || printData.discount > 0) {
                printer.tableCustom([
                    { text: "NET TOTAL:", align: "RIGHT", width: 0.60, style: 'B' },
                    { text: String(Math.round(printData.total)), align: "RIGHT", width: 0.40, style: 'B' }
                ]);
            }

            if (printData.paymentMethod === 'CASH' || printData.paymentMethod === 'Cash') {
                const tendered = printData.tenderedAmount !== undefined ? printData.tenderedAmount : printData.total;
                const change = Math.max(0, tendered - printData.total);
                printer.text('--------------------------------');
                printer.tableCustom([
                    { text: "Tendered:", align: "RIGHT", width: 0.60 },
                    { text: String(Math.round(tendered)), align: "RIGHT", width: 0.40 }
                ]);
                printer.tableCustom([
                    { text: "Change:", align: "RIGHT", width: 0.60 },
                    { text: String(Math.round(change)), align: "RIGHT", width: 0.40 }
                ]);
            }

            printer
                .text(' ')
                .align('ct')
                .style('normal')
                .text(`Printed On: ${dateStr} ${timeStr}`)
                .text(`Bill ID: ${printData.id}`)
                .text('Developed by Food Factory')
                .text(' ')
            // .text(' ');

            const isCash = printData.paymentMethod === 'CASH' || printData.paymentMethod === 'Cash';
            // if (drawerEnabled && isCash) printer.cashdraw(2);

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
        const port = db.prepare("SELECT value FROM settings WHERE key = 'KITCHEN_PRINTER_PORT'").get()?.value || '9100';

        if (type === 'NONE') return { success: true, message: 'Kitchen printer disabled' };

        const device = getPrinterDevice(type, addr, port);
        if (!device) throw new Error("Could not initialize kitchen printer device");

        const printer = new escpos.Printer(device);

        device.open((err) => {
            if (err) {
                console.error("Kitchen Printer connection error:", err);
                return;
            }

            let dateObj = new Date(printData.createdAt);
            let dateStr = dateObj.toLocaleDateString();
            let timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const isDelivery = !!printData.customerAddress || printData.orderType === 'DELIVERY';
            const isDineIn = printData.orderType === 'DINE_IN';
            const orderTypeStr = isDineIn ? 'DINE IN' : (isDelivery ? 'DELIVERY' : 'TAKE AWAY');

            printer
                .align('ct')
                .raw(Buffer.from([0x1C, 0x70, 0x01, 0x00])) // NV Logo
                .text(' ')
                .text(`Date: ${dateStr}   ${timeStr}`)
                .text(' ')
                .font('a')
                .style('b')
                .size(2, 2)
                .text(printData.isUpdate ? 'UPDATE TICKET' : 'KITCHEN SLIP')
                .size(0, 0)
                .text('--------------------------------')
                .text(' ')
                .align('ct')
                .style('b')
                .size(2, 2)
                .text(`# ${printData.dailyOrderNumber || '-'}`)
                .size(0, 0)
                .text(' ')
                .text(orderTypeStr)
            if (printData.tableNo) {
                printer.style('b').size(1, 1).text(`Table No: ${printData.tableNo}`).size(0, 0).style('b');
            }
            printer
                .text(' ')
            printer
                .align('lt')
                .style('b')
                .size(1, 1)
                .text('Item         Qty')
                .text('----------------');

            printData.items.forEach(item => {
                const qtyLine = `${item.quantity}`;
                // Limit item name to 26 characters to fit with qty on a double-width line
                const itemName = (item.name || 'Item').substring(0, 13);

                printer
                    .style('b')
                    .size(1, 1)
                    .text(`${itemName.padEnd(13, ' ')} ${qtyLine.padStart(2, ' ')}`);

                if (item.variantName) {
                    printer
                        .style('b')
                        .size(1, 1)
                        .text(`  (${item.variantName})`.substring(0, 16));
                }

                if (item.dealChoices) {
                    try {
                        const choices = JSON.parse(item.dealChoices);
                        choices.forEach(c => {
                            const qty = c.quantity ? `${c.quantity}x ` : '';
                            const variant = c.variantName ? `: ${c.variantName}` : '';
                            printer.text(`   > ${qty}${c.productName}${variant}`.substring(0, 24));
                        });
                    } catch (e) { }
                }
                printer
                    .size(0, 0)
                    .text('--------------------------------');
            });

            printer
                .text(' ')
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
        const port = db.prepare("SELECT value FROM settings WHERE key = 'RECEIPT_PRINTER_PORT'").get()?.value || '9100';

        if (type === 'NONE') return { success: true, message: 'Printer disabled, cannot open drawer' };

        const device = getPrinterDevice(type, addr, port);
        if (!device) throw new Error("Could not initialize printer device");

        const printer = new escpos.Printer(device);

        device.open((err) => {
            if (err) return console.error("Drawer kick error:", err);
            // printer.cashdraw(2).close();
            printer.close();
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-pending-orders', async () => {
    try {
        const db = getDb();
        return db.prepare("SELECT * FROM orders WHERE status IN ('Pending', 'Assigned') ORDER BY createdAt DESC").all();
    } catch (e) {
        console.error("Failed to fetch pending orders:", e);
        return [];
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

ipcMain.handle('validate-voucher', async (event, { code, branchId }) => {
    try {
        const db = getDb();
        const voucher = db.prepare("SELECT * FROM vouchers WHERE code = ? AND isActive = 1").get(code);
        if (!voucher) return { success: false, message: 'Invalid voucher code' };

        if (new Date() > new Date(voucher.expiryDate)) {
            return { success: false, message: 'Voucher has expired' };
        }

        if (voucher.branchId && voucher.branchId !== branchId) {
            return { success: false, message: 'Voucher not valid for this branch' };
        }

        return { success: true, voucher };
    } catch (e) {
        return { success: false, message: e.message };
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
    startSyncWorker(() => {
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) win.webContents.send('sync-completed');
        });
    });

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
