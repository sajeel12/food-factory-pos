import { Wifi, Battery, Clock, Bell, Cloud, CloudOff, RefreshCw } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

// Safely require ipcRenderer
const ipcRenderer = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;

export default function Header({ shiftId }: { shiftId?: string }) {
    const { user } = useAuth();
    const [time, setTime] = useState(new Date());
    const [syncStatus, setSyncStatus] = useState<{ isOnline: boolean; unsynced: number }>({
        isOnline: navigator.onLine,
        unsynced: 0
    });
    const [isSyncing, setIsSyncing] = useState(false);

    // Shift modal states
    const [showEndShiftModal, setShowEndShiftModal] = useState(false);
    const [actualCash, setActualCash] = useState('');
    const [ending, setEnding] = useState(false);

    useEffect(() => {
        const timer = setInterval(() => setTime(new Date()), 1000);

        const handleOnline = () => setSyncStatus(prev => ({ ...prev, isOnline: true }));
        const handleOffline = () => setSyncStatus(prev => ({ ...prev, isOnline: false }));

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        // Poll for healthcheck and unsynced orders
        let syncTimer: ReturnType<typeof setInterval> | null = null;
        if (ipcRenderer) {
            syncTimer = setInterval(async () => {
                try {
                    // Check cloud connection via health ping
                    try {
                        const healthRes = await fetch('http://localhost:3000/api/health', { signal: AbortSignal.timeout(2000) });
                        setSyncStatus(prev => ({ ...prev, isOnline: healthRes.ok }));
                    } catch {
                        setSyncStatus(prev => ({ ...prev, isOnline: false }));
                    }

                    const result = await ipcRenderer.invoke('get-sync-status');
                    setSyncStatus(prev => {
                        // If we drop from some unsynced to 0, it means a sync just happened
                        if (prev.unsynced > 0 && result.unsynced === 0) {
                            setIsSyncing(true);
                            setTimeout(() => setIsSyncing(false), 2000); // UI visual indication
                        }
                        return { ...prev, unsynced: result.unsynced };
                    });
                } catch (e) {
                    console.error('Failed to get sync status', e);
                }
            }, 3000); // Polling every 3s
        }

        return () => {
            clearInterval(timer);
            if (syncTimer) clearInterval(syncTimer);
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    return (
        <>
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 shadow-sm z-10 shrink-0 select-none">
            <div className="flex items-center space-x-6 text-gray-800">
                <h1 className="text-xl font-bold tracking-tight">
                    {user?.branchName || 'Terminal'}
                </h1>

                {/* Sync Status Badge */}
                <div className="flex items-center space-x-2">
                    <span className={`px-3 py-1 text-xs font-semibold rounded-full uppercase tracking-wider flex items-center shadow-sm ${!syncStatus.isOnline
                        ? 'bg-red-100 text-red-700'
                        : syncStatus.unsynced > 0
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-green-100 text-green-700'
                        }`}>
                        {!syncStatus.isOnline ? (
                            <>
                                <CloudOff size={14} className="mr-1.5" /> Offline
                            </>
                        ) : syncStatus.unsynced > 0 ? (
                            <>
                                <Cloud size={14} className="mr-1.5" /> Unsynced: {syncStatus.unsynced}
                            </>
                        ) : (
                            <>
                                <span className="w-2 h-2 rounded-full bg-green-500 mr-2 animate-pulse"></span> Online
                            </>
                        )}
                    </span>

                    {/* Temporary sync animation overlay if catching up */}
                    {isSyncing && (
                        <span className="px-3 py-1 bg-blue-100 text-blue-700 text-xs font-semibold rounded-full uppercase tracking-wider flex items-center shadow-sm">
                            <RefreshCw size={14} className="mr-1.5 animate-spin" /> Syncing
                        </span>
                    )}

                    <button
                        onClick={async () => {
                            if (ipcRenderer && syncStatus.isOnline) {
                                setIsSyncing(true);
                                await ipcRenderer.invoke('force-sync');
                                const result = await ipcRenderer.invoke('get-sync-status');
                                setSyncStatus(prev => ({ ...prev, unsynced: result.unsynced }));
                                window.dispatchEvent(new Event('sync-completed'));
                                setIsSyncing(false);
                            }
                        }}
                        disabled={!syncStatus.isOnline || isSyncing}
                        className="ml-2 px-3 py-1 bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed text-xs font-semibold rounded-full uppercase tracking-wider flex items-center shadow-sm border border-gray-200 transition-colors"
                    >
                        <RefreshCw size={14} className={`mr-1.5 ${isSyncing ? 'animate-spin' : ''}`} /> Sync Now
                    </button>
                </div>
            </div>
            <div className="flex items-center space-x-6 text-gray-500 text-sm font-medium">
                <div className="flex items-center space-x-2 bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-100">
                    <Clock size={16} className="text-blue-500" />
                    <span>{time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="flex items-center space-x-4">
                    <button className="relative p-2 rounded-full hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-white"></span>
                        <Bell size={20} className="text-gray-600" />
                    </button>
                    <div className="p-2 rounded-full bg-gray-100 flex items-center justify-center">
                        <Wifi size={18} className="text-green-500" />
                    </div>
                    <div className="p-2 rounded-full bg-gray-100 flex items-center justify-center">
                        <Battery size={18} className="text-gray-600" />
                    </div>
                </div>
                <div className="w-px h-6 bg-gray-200"></div>
                <div
                    onClick={() => { if (shiftId) setShowEndShiftModal(true); }}
                    className="flex items-center space-x-3 bg-blue-50 hover:bg-blue-100 cursor-pointer p-1.5 rounded-xl border border-blue-100 transition-colors"
                >
                    <img src="https://i.pravatar.cc/150?u=sajeel" alt="User" className="w-8 h-8 rounded-full border border-white shadow-sm" />
                    <div className="flex flex-col pr-3">
                        <span className="text-xs font-bold text-gray-900 leading-tight">{user?.username || 'Cashier'}</span>
                        <span className="text-[10px] text-gray-500 uppercase font-semibold">End Shift</span>
                    </div>
                </div>
            </div>
        </header>

            {/* End Shift Modal overlay */}
            {showEndShiftModal && (
                <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-gray-900/40 backdrop-blur-sm">
                    <div className="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-sm">
                        <h2 className="text-2xl font-black mb-2 text-center text-gray-800">End Shift</h2>
                        <p className="text-gray-500 text-sm text-center mb-6">Enter the actual cash currently in the drawer to close your shift.</p>
                        <form onSubmit={async (e) => {
                            e.preventDefault();
                            if (!ipcRenderer || !shiftId) return;
                            setEnding(true);
                            const res = await ipcRenderer.invoke('end-shift', { id: shiftId, actualCash: parseFloat(actualCash) });
                            if (res.success) {
                                setShowEndShiftModal(false);
                                setActualCash('');
                                window.dispatchEvent(new Event('shift-ended'));
                            } else {
                                alert(`Failed to end shift: ${res.error}`);
                            }
                            setEnding(false);
                        }}>
                            <div className="mb-6">
                                <label className="block text-sm font-bold text-gray-700 mb-2">Actual Cash (PKR)</label>
                                <input
                                    type="number"
                                    required
                                    min="0"
                                    value={actualCash}
                                    onChange={e => setActualCash(e.target.value)}
                                    className="w-full text-2xl font-black p-4 bg-gray-50 border border-gray-200 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none"
                                    placeholder="0"
                                />
                            </div>
                            <div className="flex space-x-3">
                                <button type="button" onClick={() => setShowEndShiftModal(false)} className="flex-1 bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-4 rounded-xl transition-colors text-lg">
                                    Cancel
                                </button>
                                <button type="submit" disabled={ending} className="flex-1 bg-red-600 hover:bg-red-700 text-white font-bold py-4 rounded-xl shadow-md transition-colors text-lg disabled:opacity-50">
                                    {ending ? 'Closing...' : 'Close Shift'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}
