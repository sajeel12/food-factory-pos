import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Header from './Header';
import { useState, useEffect } from 'react';

const ipcRenderer = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;

export default function Layout() {
    const [shift, setShift] = useState<{ id: string } | null>(null);
    const [loading, setLoading] = useState(!!ipcRenderer);
    const [openingCash, setOpeningCash] = useState('');

    useEffect(() => {
        if (!ipcRenderer) return;

        ipcRenderer.invoke('get-current-shift').then((s: { id: string } | null) => {
            setShift(s);
            setLoading(false);
        });

        const handleShiftEnded = () => setShift(null);
        window.addEventListener('shift-ended', handleShiftEnded);
        return () => window.removeEventListener('shift-ended', handleShiftEnded);
    }, []);

    const handleStartShift = async (e: React.FormEvent) => {
        e.preventDefault();
        const res = await ipcRenderer?.invoke('start-shift', { openingCash: parseFloat(openingCash) });
        if (res?.success) {
            setShift({ id: res.id });
            setOpeningCash('');
        }
    };

    if (loading) return null;

    if (!shift && ipcRenderer) {
        return (
            <div className="flex w-screen h-screen bg-gray-900 items-center justify-center font-sans select-none text-gray-900">
                <div className="bg-white p-8 rounded-2xl shadow-2xl w-full max-w-sm">
                    <h2 className="text-2xl font-black mb-2 text-center text-gray-800">Start Shift</h2>
                    <p className="text-gray-500 text-sm text-center mb-6">Enter the opening cash amount in the drawer to begin.</p>
                    <form onSubmit={handleStartShift}>
                        <div className="mb-6">
                            <label className="block text-sm font-bold text-gray-700 mb-2">Opening Cash (PKR)</label>
                            <input
                                type="number"
                                required
                                min="0"
                                value={openingCash}
                                onChange={e => setOpeningCash(e.target.value)}
                                className="w-full text-2xl font-black p-4 bg-gray-50 border border-gray-200 rounded-xl focus:ring-4 focus:ring-blue-100 outline-none"
                                placeholder="0"
                            />
                        </div>
                        <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-xl shadow-md transition-colors text-lg">
                            Open Register
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    return (
        <div className="flex w-screen h-screen bg-gray-50 overflow-hidden font-sans select-none text-gray-900">
            <Sidebar />
            <div className="flex flex-col flex-1 overflow-hidden h-full">
                <Header shiftId={shift?.id} />
                <main className="flex-1 overflow-hidden flex relative shadow-inner">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}
