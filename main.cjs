const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Keep the local database (orders, printer settings, login) where existing installs have it.
// Electron derives this folder from package.json's name, which has changed before
// (pos-desktop -> food-factory-pos); use whichever folder already holds a database so a
// rename or a different build tool can never start a terminal on an empty database.
(function pinUserDataDir() {
    const appData = app.getPath('appData');
    const candidates = ['food-factory-pos', 'pos-desktop', 'FoodFactoryPOS'].map(name => path.join(appData, name));
    const existing = candidates.find(dir => fs.existsSync(path.join(dir, 'pos-local.db')));
    app.setPath('userData', existing || candidates[0]);
})();

const { initDb, getDb } = require('./db.cjs');
const { createFileLogger } = require('./logger.cjs');
const { startSyncWorker, performSync, getLastPushError } = require('./sync.cjs');
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

// ── Print queues ──
// Jobs for the same printer go through that printer's queue, so two jobs never connect to it
// at the same time. LAN thermal printers accept only one connection on port 9100; overlapping
// jobs were being refused and the slip silently lost. Different printers (receipt vs kitchen)
// have separate queues, so they print in parallel and an offline kitchen printer's retries
// never hold up receipts.
const PRINT_CONNECT_TIMEOUT_MS = 3000; // a reachable LAN printer answers in milliseconds
const PRINT_TIMEOUT_MS = 8000;
const PRINT_ATTEMPTS = 3;
const PRINT_RETRY_DELAY_MS = 1000;
const printQueues = new Map();

const printerKey = (cfg) => `${cfg.type}|${cfg.addr || ''}|${cfg.type === 'LAN' ? cfg.port : ''}`;

function readPrinterConfig(prefix) {
    const db = getDb();
    const get = (key) => db.prepare("SELECT value FROM settings WHERE key = ?").get(`${prefix}_PRINTER_${key}`)?.value;
    return { type: get('TYPE') || 'NONE', addr: get('ADDR'), port: get('PORT') || '9100' };
}

// Resolves once the connection is fully closed, so the next job can connect.
// graceful: after a successful write, let the bytes drain and wait for the printer to close;
// after a failure there's nothing to deliver, so drop the socket at once.
function closeDevice(device, graceful) {
    return new Promise((resolve) => {
        if (!device) return resolve();
        try {
            if (device instanceof escpos.Network) {
                const sock = device.device;
                if (!sock || sock.destroyed) return resolve();
                if (!graceful || sock.connecting) {
                    sock.destroy();
                    return resolve();
                }
                // end() lets buffered bytes reach the printer; escpos-network's close() destroys outright
                const timer = setTimeout(() => { sock.destroy(); resolve(); }, 1500);
                sock.once('close', () => { clearTimeout(timer); resolve(); });
                sock.end();
            } else {
                device.close();
                resolve();
            }
        } catch (e) {
            console.error('Printer close error:', e);
            resolve();
        }
    });
}

// One connect → write → close cycle. `build` writes commands into the escpos buffer.
function runPrintJob(cfg, build) {
    return new Promise((resolve, reject) => {
        let device = null;
        let done = false;
        const finish = (err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            clearTimeout(connectTimer);
            closeDevice(device, !err).then(() => (err ? reject(err) : resolve()));
        };
        const timer = setTimeout(() => finish(new Error('Printer did not respond (timeout)')), PRINT_TIMEOUT_MS);
        // Fail fast when the printer is off or unreachable instead of waiting out the OS's
        // much longer TCP connect timeout, so retries and the Retry dialog come sooner
        const connectTimer = setTimeout(() => finish(new Error('Could not connect to printer (timeout)')), PRINT_CONNECT_TIMEOUT_MS);

        try {
            device = getPrinterDevice(cfg.type, cfg.addr, cfg.port);
            if (!device) throw new Error('Printer is not configured');
            device.open((err) => {
                // escpos-network calls this again on any later socket error; ignore once finished
                if (done) return;
                clearTimeout(connectTimer);
                if (err) return finish(err);
                try {
                    const printer = new escpos.Printer(device);
                    build(printer);
                    printer.flush((writeErr) => finish(writeErr || null));
                } catch (e) {
                    finish(e);
                }
            });
        } catch (e) {
            finish(e);
        }
    });
}

async function printWithRetry(label, cfg, build) {
    let lastErr;
    for (let attempt = 1; attempt <= PRINT_ATTEMPTS; attempt++) {
        try {
            await runPrintJob(cfg, build);
            return;
        } catch (e) {
            lastErr = e;
            console.error(`${label}: attempt ${attempt}/${PRINT_ATTEMPTS} failed:`, e.message);
            if (attempt < PRINT_ATTEMPTS) await new Promise(r => setTimeout(r, PRINT_RETRY_DELAY_MS));
        }
    }
    throw lastErr;
}

// Queues the job and returns immediately so checkout never waits on the printer.
// If every attempt fails, the cashier gets a dialog with a Retry button instead of a silent loss.
function queuePrint(label, cfg, build) {
    const key = printerKey(cfg);
    const job = (printQueues.get(key) || Promise.resolve()).then(() => printWithRetry(label, cfg, build));
    const tail = job.catch(() => { });
    printQueues.set(key, tail);
    // Drop the entry once this printer's queue is idle
    tail.then(() => { if (printQueues.get(key) === tail) printQueues.delete(key); });
    job.catch(async (err) => {
        const opts = {
            type: 'error',
            title: 'Printer Error',
            message: `${label} did not print`,
            detail: `${err.message}\n\nPrinter: ${cfg.addr || cfg.type}${cfg.type === 'LAN' ? `:${cfg.port}` : ''}\nCheck the printer is on and connected to the network, then press Retry.`,
            buttons: ['Retry', 'Dismiss'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
        };
        const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
        if (response === 0) queuePrint(label, cfg, build);
    });
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
            contextIsolation: false,
            // A POS doesn't need it, and it runs on every keystroke in every input
            spellcheck: false
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
            // The createdAt lower bound (2 days back) lets the index skip old orders instead of
            // running datetime() over the whole table on every order.
            const prevOrderQuery = db.prepare("SELECT MAX(dailyOrderNumber) as maxNum FROM orders WHERE createdAt >= ? AND datetime(createdAt, 'localtime', '-6 hours') LIKE ?");
            const since = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
            const prevOrder = prevOrderQuery.get(since, `${localBizDate}%`);
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
        const cfg = readPrinterConfig('RECEIPT');
        const drawerEnabled = false;

        if (cfg.type === 'NONE') return { success: true, message: 'Printer disabled' };

        const label = `Receipt for order #${printData.dailyOrderNumber || printData.id || '-'}`;
        queuePrint(label, cfg, (printer) => {
            let dateObj = new Date(printData.createdAt);
            let dateStr = dateObj.toLocaleDateString();
            let timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const isDelivery = !!printData.customerAddress || printData.orderType === 'DELIVERY';
            const isDineIn = printData.orderType === 'DINE_IN';
            const orderTypeStr = isDineIn ? 'DINE IN' : (isDelivery ? 'DELIVERY' : 'TAKE AWAY');

            let detailStr = '';
            if (isDineIn) {
                detailStr = `Table No: ${printData.tableNo || '-'} - ${printData.customerName || 'Walk-in'}`;
            } else if (isDelivery) {
                detailStr = `Customer: ${printData.customerName || ''}\nPhone: ${printData.customerPhone || ''}`;
                if (printData.customerAddress) {
                    detailStr += `\nAddress: ${printData.customerAddress}`;
                }
            } else {
                detailStr = `Take Away: ${printData.customerName || 'Walk-in'}`;
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

            printer.cut();
        });
        return { success: true, queued: true };
    } catch (e) {
        console.error("Receipt Print Error:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('print-kitchen', async (event, printData) => {
    try {
        const db = getDb();
        const cfg = readPrinterConfig('KITCHEN');

        if (cfg.type === 'NONE') return { success: true, message: 'Kitchen printer disabled' };

        const label = `${printData.isUpdate ? 'Kitchen update' : 'Kitchen slip'} for order #${printData.dailyOrderNumber || printData.id || '-'}`;
        queuePrint(label, cfg, (printer) => {

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
                .cut();
        });
        return { success: true, queued: true };
    } catch (e) {
        console.error("Kitchen Print Error:", e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('open-cash-drawer', async () => {
    try {
        const cfg = readPrinterConfig('RECEIPT');

        if (cfg.type === 'NONE') return { success: true, message: 'Printer disabled, cannot open drawer' };

        // Goes through the queue so it never collides with a receipt on the same printer
        queuePrint('Cash drawer', cfg, (printer) => {
            // printer.cashdraw(2);
        });
        return { success: true, queued: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// The live queues only show the last 24h. Orders left Pending/Assigned longer than that
// (never paid or never marked delivered) used to pile up in the queue forever; they stay
// in the database untouched and are reachable from Order History (see get-stale-pending-count).
const QUEUE_WINDOW_MS = 24 * 60 * 60 * 1000;
const queueCutoff = () => new Date(Date.now() - QUEUE_WINDOW_MS).toISOString();
// julianday() reads both ISO ('…T…Z') and SQLite ('YYYY-MM-DD HH:MM:SS') createdAt values
const PENDING_SQL = "status IN ('Pending', 'Assigned')";
const DELIVERY_SQL = "customerName IS NOT NULL AND status IN ('Pending', 'Assigned')";

ipcMain.handle('get-pending-orders', async () => {
    try {
        const db = getDb();
        return db.prepare(`SELECT * FROM orders WHERE ${PENDING_SQL} AND julianday(createdAt) >= julianday(?) ORDER BY createdAt DESC`).all(queueCutoff());
    } catch (e) {
        console.error("Failed to fetch pending orders:", e);
        return [];
    }
});

ipcMain.handle('get-delivery-orders', async () => {
    try {
        const db = getDb();
        return db.prepare(`SELECT * FROM orders WHERE ${DELIVERY_SQL} AND julianday(createdAt) >= julianday(?) ORDER BY createdAt DESC`).all(queueCutoff());
    } catch (e) {
        console.error("Failed to fetch delivery orders:", e);
        return [];
    }
});

// How many orders the queue is hiding because they're older than the window
ipcMain.handle('get-stale-pending-count', async (event, kind) => {
    try {
        const db = getDb();
        const where = kind === 'delivery' ? DELIVERY_SQL : PENDING_SQL;
        return db.prepare(`SELECT COUNT(*) AS c FROM orders WHERE ${where} AND julianday(createdAt) < julianday(?)`).get(queueCutoff()).c;
    } catch (e) {
        console.error("Failed to count stale pending orders:", e);
        return 0;
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
        // Why the last upload failed (status + message), so the header can say it out loud
        return { unsyncedOrders: result.count, pushError: getLastPushError() };
    } catch (e) {
        return { unsyncedOrders: 0, error: e.message };
    }
});

// Escapes LIKE wildcards so a typed % or _ is matched literally
const likeTerm = (s) => `%${s.replace(/[\\%_]/g, '\\$&')}%`;

// Builds the WHERE clause for one search word. Every word must match somewhere (AND),
// so "ali zinger" finds Ali's orders that contained a Zinger.
function historySearchCondition(token, params) {
    // "#12" means the daily order number only
    if (/^#\d+$/.test(token)) {
        params.push(parseInt(token.slice(1), 10));
        return 'dailyOrderNumber = ?';
    }

    const like = likeTerm(token);
    const conds = [
        "id LIKE ? ESCAPE '\\'",
        "customerName LIKE ? ESCAPE '\\'",
        "customerAddress LIKE ? ESCAPE '\\'",
        "customerPhone LIKE ? ESCAPE '\\'",
        "tableNo LIKE ? ESCAPE '\\'",
        "paymentMethod LIKE ? ESCAPE '\\'",
        "status LIKE ? ESCAPE '\\'",
        "REPLACE(orderType, '_', ' ') LIKE ? ESCAPE '\\'",
        `EXISTS (SELECT 1 FROM order_items oi LEFT JOIN products p ON p.id = oi.productId
                 WHERE oi.orderId = orders.id AND (p.name LIKE ? ESCAPE '\\' OR oi.variantName LIKE ? ESCAPE '\\'))`,
    ];
    params.push(like, like, like, like, like, like, like, like, like, like);

    // Phone numbers: ignore formatting, and treat 0300… and +92300… as the same number
    const compact = token.replace(/[\s\-+()]/g, '');
    if (/^\d{3,}$/.test(compact)) {
        const variants = new Set([compact]);
        if (compact.startsWith('0')) variants.add('92' + compact.slice(1));
        if (compact.startsWith('92')) variants.add('0' + compact.slice(2));
        for (const v of variants) {
            conds.push("REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(customerPhone, '-', ''), ' ', ''), '+', ''), '(', ''), ')', '') LIKE ?");
            params.push(`%${v}%`);
        }
    }

    // Plain numbers can also be the daily order number or the bill total
    if (/^\d+$/.test(token)) {
        const n = parseInt(token, 10);
        conds.push('dailyOrderNumber = ?', 'CAST(ROUND(total) AS INTEGER) = ?');
        params.push(n, n);
    }

    return `(${conds.join(' OR ')})`;
}

// Paginated + searchable history. Filtering happens in SQLite so the UI only ever
// receives one page instead of every order ever taken.
ipcMain.handle('get-order-history', async (event, opts = {}) => {
    try {
        const db = getDb();
        const pageSize = Math.min(Math.max(parseInt(opts.pageSize, 10) || 50, 1), 200);
        const where = [];
        const params = [];

        // Business day (6am–6am), the same day boundary the daily order numbers use
        if (opts.date && /^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
            const dayStart = new Date(`${opts.date}T00:00:00`).getTime();
            // Loose createdAt bounds let the index narrow the scan before the exact day check
            where.push("createdAt >= ? AND createdAt < ? AND date(createdAt, 'localtime', '-6 hours') = ?");
            params.push(
                new Date(dayStart - 86400000).toISOString(),
                new Date(dayStart + 2 * 86400000).toISOString(),
                opts.date
            );
        }

        // Status is stored as both 'Completed' and 'COMPLETED', so compare upper-cased
        if (opts.status === 'COMPLETED') where.push("UPPER(status) = 'COMPLETED'");
        else if (opts.status === 'PENDING') where.push("UPPER(status) IN ('PENDING', 'ASSIGNED')");
        else if (opts.status === 'CANCELLED') where.push("UPPER(status) LIKE 'CANCELLED%'");

        const tokens = String(opts.search || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
        for (const token of tokens) where.push(historySearchCondition(token, params));

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = db.prepare(`SELECT COUNT(*) AS c FROM orders ${whereSql}`).get(...params).c;
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        const page = Math.min(Math.max(parseInt(opts.page, 10) || 1, 1), totalPages);
        const orders = db.prepare(`SELECT * FROM orders ${whereSql} ORDER BY createdAt DESC LIMIT ? OFFSET ?`)
            .all(...params, pageSize, (page - 1) * pageSize);

        return { orders, total, page, pageSize, totalPages };
    } catch (e) {
        console.error("Failed to fetch order history:", e);
        return { orders: [], total: 0, page: 1, pageSize: 50, totalPages: 1, error: e.message };
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

// ── Auto-update ──
// Installed builds check GitHub Releases for a newer version, download it in the background,
// and install it when the app is closed, or right away if the cashier clicks Restart in the
// header. The repo is private, so the release workflow writes a read-only UPDATE_TOKEN into
// the packaged .env (.github/workflows/release.yml).
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
let autoUpdater = null;
let updateReady = null;

function readEnvValue(key) {
    try {
        const content = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
        const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
        return match ? match[1].trim() : null;
    } catch (e) {
        return null;
    }
}

// Update activity goes to <userData>\update.log (e.g. %APPDATA%\food-factory-pos\update.log),
// since an installed app has no visible console to check why an update didn't arrive.
function setupAutoUpdates() {
    if (!app.isPackaged) return;
    try {
        ({ autoUpdater } = require('electron-updater'));
    } catch (e) {
        console.error('Auto-update unavailable:', e.message);
        return;
    }
    autoUpdater.logger = createFileLogger('update.log');
    autoUpdater.logger.info(`App ${app.getVersion()} started; checking for updates`);
    const token = readEnvValue('UPDATE_TOKEN');
    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'sajeel12',
        repo: 'food-factory-pos',
        ...(token ? { private: true, token } : {}),
    });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
        updateReady = { version: info.version };
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) win.webContents.send('update-ready', updateReady);
        });
    });
    // Offline or GitHub unreachable: just try again at the next interval
    autoUpdater.on('error', (e) => console.error('Auto-update error:', e?.message || e));
    const check = () => autoUpdater.checkForUpdates().catch(e => console.error('Update check failed:', e?.message || e));
    check();
    setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

ipcMain.handle('get-update-status', () => updateReady);

// Installed version (set from the release tag by CI), shown in the header and login screen
ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('install-update', async () => {
    if (!autoUpdater || !updateReady) return { success: false };
    // Let slips that are already queued finish printing before the app restarts
    const deadline = Date.now() + 10000;
    while (printQueues.size > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
    }
    autoUpdater.quitAndInstall(true, true); // silent install, relaunch afterwards
    return { success: true };
});

app.whenReady().then(() => {
    initDb();
    createWindow();
    startSyncWorker(() => {
        BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) win.webContents.send('sync-completed');
        });
    });
    setupAutoUpdates();

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
