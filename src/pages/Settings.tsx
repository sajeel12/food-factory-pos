import { useState, useEffect } from 'react';
import { Save, Printer, Network, Usb, Trash2, DollarSign, RefreshCw, LogOut } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ipcRenderer = (window as any).require?.('electron')?.ipcRenderer;

interface Setting {
    key: string;
    value: string;
}

interface UsbDevice {
    vendorId: string;
    productId: string;
    addr: string;
    name: string;
}

interface SettingsState {
    RECEIPT_PRINTER_TYPE: string;
    RECEIPT_PRINTER_ADDR: string;
    KITCHEN_PRINTER_TYPE: string;
    KITCHEN_PRINTER_ADDR: string;
    CASH_DRAWER_ENABLED: string;
    [key: string]: string;
}

export default function Settings() {
    const { user, logout } = useAuth();
    const [settings, setSettings] = useState<SettingsState>({
        RECEIPT_PRINTER_TYPE: 'NONE',
        RECEIPT_PRINTER_ADDR: '',
        RECEIPT_PRINTER_PORT: '9100',
        KITCHEN_PRINTER_TYPE: 'NONE',
        KITCHEN_PRINTER_ADDR: '',
        KITCHEN_PRINTER_PORT: '9100',
        CASH_DRAWER_ENABLED: 'false',
    });

    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState<string | null>(null);
    const [usbDevices, setUsbDevices] = useState<UsbDevice[]>([]);
    const [scanning, setScanning] = useState(false);

    useEffect(() => {
        async function loadSettings() {
            if (!ipcRenderer) return;
            const keys = ['RECEIPT_PRINTER_TYPE', 'RECEIPT_PRINTER_ADDR', 'RECEIPT_PRINTER_PORT', 'KITCHEN_PRINTER_TYPE', 'KITCHEN_PRINTER_ADDR', 'KITCHEN_PRINTER_PORT', 'CASH_DRAWER_ENABLED'];
            const currentList: Setting[] = await ipcRenderer.invoke('get-settings', keys);

            setSettings(prev => {
                const next = { ...prev };
                currentList.forEach(s => {
                    if (s.value !== null && s.value !== undefined) {
                        next[s.key] = s.value;
                    }
                });
                return next;
            });
        }
        loadSettings();
    }, []);

    const scanUsbPrinters = async () => {
        if (!ipcRenderer) return;
        setScanning(true);
        try {
            const devices: UsbDevice[] = await ipcRenderer.invoke('detect-usb-printers');
            setUsbDevices(devices);
        } catch (e) {
            console.error('Scan failed:', e);
            setUsbDevices([]);
        }
        setScanning(false);
    };

    const handleChange = (key: string, value: string) => {
        setSettings(prev => ({ ...prev, [key]: value }));
    };

    const saveSettings = async () => {
        if (!ipcRenderer) return;
        setSaving(true);
        const updates = Object.entries(settings).map(([key, value]) => ({ key, value }));
        await ipcRenderer.invoke('save-settings', updates);
        setSaving(false);
    };

    const testPrint = async (printer: 'RECEIPT' | 'KITCHEN') => {
        if (!ipcRenderer) return;
        setTesting(printer);
        try {
            if (printer === 'RECEIPT') {
                const payload = {
                    id: 'TEST-1234',
                    total: 1050,
                    tenderedAmount: 1100,
                    paymentMethod: 'CASH',
                    createdAt: new Date().toISOString(),
                    items: [
                        { id: '1', name: 'Zinger Burger', quantity: 1, subtotal: 550 },
                        { id: '2', name: 'Large Cola', quantity: 2, subtotal: 300 },
                        { id: '3', name: 'Fries', quantity: 1, subtotal: 200 }
                    ]
                };
                await ipcRenderer.invoke('print-receipt', payload);
            } else {
                const payload = {
                    id: 'TEST-1234',
                    items: [
                        { id: '1', name: 'Zinger Burger', quantity: 1 },
                        { id: '2', name: 'Fries', quantity: 1 }
                    ]
                };
                await ipcRenderer.invoke('print-kitchen', payload);
            }
        } catch (e) {
            console.error(e);
            alert('Print test failed. Check console.');
        }
        setTesting(null);
    };

    const testDrawer = async () => {
        if (!ipcRenderer) return;
        setTesting('DRAWER');
        await ipcRenderer.invoke('open-cash-drawer');
        setTesting(null);
    };

    const renderPrinterConfig = (title: string, prefix: 'RECEIPT' | 'KITCHEN') => {
        const type = settings[`${prefix}_PRINTER_TYPE`];
        const currentAddr = settings[`${prefix}_PRINTER_ADDR`];
        return (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold flex items-center text-gray-800">
                        <Printer className="mr-3 text-blue-500" /> {title}
                    </h3>
                    <button
                        onClick={() => testPrint(prefix)}
                        disabled={testing === prefix || type === 'NONE'}
                        className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-200 transition-colors disabled:opacity-50"
                    >
                        {testing === prefix ? 'Testing...' : 'Test Print'}
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <button
                        onClick={() => handleChange(`${prefix}_PRINTER_TYPE`, 'NONE')}
                        className={`flex flex-col items-center justify-center p-4 border-2 rounded-xl transition-all ${type === 'NONE' ? 'border-red-500 bg-red-50 text-red-600' : 'border-gray-200 hover:border-gray-300 text-gray-500'}`}
                    >
                        <Trash2 size={24} className="mb-2" />
                        <span className="font-semibold">Disabled</span>
                    </button>
                    <button
                        onClick={() => handleChange(`${prefix}_PRINTER_TYPE`, 'USB')}
                        className={`flex flex-col items-center justify-center p-4 border-2 rounded-xl transition-all ${type === 'USB' ? 'border-blue-500 bg-blue-50 text-blue-600' : 'border-gray-200 hover:border-gray-300 text-gray-500'}`}
                    >
                        <Usb size={24} className="mb-2" />
                        <span className="font-semibold">Raw USB</span>
                    </button>
                    <button
                        onClick={() => handleChange(`${prefix}_PRINTER_TYPE`, 'LAN')}
                        className={`flex flex-col items-center justify-center p-4 border-2 rounded-xl transition-all ${type === 'LAN' ? 'border-blue-500 bg-blue-50 text-blue-600' : 'border-gray-200 hover:border-gray-300 text-gray-500'}`}
                    >
                        <Network size={24} className="mb-2" />
                        <span className="font-semibold">Network (LAN)</span>
                    </button>
                </div>

                {type === 'USB' && (
                    <div className="pt-4 border-t border-gray-100 space-y-3">
                        <div className="flex items-center justify-between">
                            <label className="block text-sm font-semibold text-gray-700">
                                Select USB Printer
                            </label>
                            <button
                                onClick={scanUsbPrinters}
                                disabled={scanning}
                                className="flex items-center space-x-2 px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg text-sm font-semibold hover:bg-blue-100 transition-colors disabled:opacity-50"
                            >
                                <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
                                <span>{scanning ? 'Scanning...' : 'Scan for Printers'}</span>
                            </button>
                        </div>
                        {usbDevices.length > 0 ? (
                            <select
                                value={currentAddr}
                                onChange={(e) => handleChange(`${prefix}_PRINTER_ADDR`, e.target.value)}
                                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none appearance-none cursor-pointer"
                            >
                                <option value="">-- Select a printer --</option>
                                {usbDevices.map((dev) => (
                                    <option key={dev.addr} value={dev.addr}>
                                        {dev.name}
                                    </option>
                                ))}
                            </select>
                        ) : (
                            <div className="flex flex-col items-center justify-center p-6 bg-gray-50 rounded-xl border border-dashed border-gray-300">
                                <Usb size={32} className="text-gray-400 mb-2" />
                                <p className="text-sm text-gray-500 text-center">
                                    {scanning ? 'Scanning USB ports...' : 'Click "Scan for Printers" to detect connected USB printers'}
                                </p>
                                {currentAddr && (
                                    <p className="text-xs text-blue-500 mt-2">Currently set: {currentAddr}</p>
                                )}
                            </div>
                        )}
                    </div>
                )}

                {type === 'LAN' && (
                    <div className="pt-4 border-t border-gray-100 space-y-3">
                        <div className="grid grid-cols-3 gap-3">
                            <div className="col-span-2">
                                <label className="block text-sm font-semibold text-gray-700 mb-2">
                                    Printer IP Address
                                </label>
                                <input
                                    type="text"
                                    value={currentAddr}
                                    onChange={(e) => handleChange(`${prefix}_PRINTER_ADDR`, e.target.value)}
                                    placeholder="192.168.1.100"
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-semibold text-gray-700 mb-2">
                                    Port
                                </label>
                                <input
                                    type="text"
                                    value={settings[`${prefix}_PRINTER_PORT`] || '9100'}
                                    onChange={(e) => handleChange(`${prefix}_PRINTER_PORT`, e.target.value)}
                                    placeholder="9100"
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:outline-none"
                                />
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="h-full flex flex-col bg-gray-50 p-6 overflow-y-auto w-full">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-black tracking-tight text-gray-900">Hardware & Settings</h1>
                    <p className="text-gray-500 mt-1">Configure local printers, cash drawer, and terminal sync limits.</p>
                </div>
                <button
                    onClick={saveSettings}
                    disabled={saving}
                    className="flex items-center space-x-2 px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl shadow-lg shadow-blue-500/30 transition-all active:scale-95 disabled:opacity-50"
                >
                    <Save size={20} />
                    <span>{saving ? 'Saving...' : 'Save Configuration'}</span>
                </button>
            </div>

            <div className="max-w-4xl space-y-6 pb-24 mx-auto w-full">
                {renderPrinterConfig("Frontend Receipt Printer", "RECEIPT")}

                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
                    <div className="flex justify-between items-center">
                        <h3 className="text-xl font-bold flex items-center text-gray-800">
                            <DollarSign className="mr-3 text-green-500" /> Cash Drawer Kick
                        </h3>
                        <button
                            onClick={testDrawer}
                            disabled={testing === 'DRAWER' || settings.CASH_DRAWER_ENABLED === 'false' || settings.RECEIPT_PRINTER_TYPE === 'NONE'}
                            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-semibold hover:bg-gray-200 transition-colors disabled:opacity-50"
                        >
                            Test Drawer
                        </button>
                    </div>
                    <p className="text-sm text-gray-500">
                        The cash drawer is physically wired into the Receipt Printer via RJ11. Opening requires the receipt printer to be configured and connected.
                    </p>
                    <label className="flex items-center space-x-3 cursor-pointer mt-4 group">
                        <input
                            type="checkbox"
                            checked={settings.CASH_DRAWER_ENABLED === 'true'}
                            onChange={(e) => handleChange('CASH_DRAWER_ENABLED', e.target.checked ? 'true' : 'false')}
                            className="w-6 h-6 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        />
                        <span className="font-semibold text-gray-700 group-hover:text-blue-600 transition-colors">Enable Kick on Checkout</span>
                    </label>
                </div>

                {renderPrinterConfig("Kitchen Slip Printer", "KITCHEN")}

                {/* Logout Section */}
                <div className="bg-white rounded-2xl shadow-sm border border-red-100 p-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="text-xl font-bold flex items-center text-gray-800">
                                <LogOut className="mr-3 text-red-500" /> Session
                            </h3>
                            <p className="text-sm text-gray-500 mt-1">
                                Logged in as <strong>{user?.username}</strong> ({user?.posRole || user?.role})
                                {user?.branchName && <span> — {user.branchName}</span>}
                            </p>
                        </div>
                        <button
                            onClick={logout}
                            className="flex items-center space-x-2 px-5 py-3 bg-red-600 hover:bg-red-700 text-white font-bold rounded-xl shadow-lg shadow-red-500/30 transition-all active:scale-95"
                        >
                            <LogOut size={18} />
                            <span>Log Out</span>
                        </button>
                    </div>
                </div>

            </div>
        </div>
    );
}
