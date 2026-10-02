import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';

const ipcRenderer = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;

// The live queues only show the last 24h. This points staff to older orders that were never
// paid or never marked delivered, so hiding them from the queue doesn't mean forgetting them.
export default function StaleOrdersNotice({ kind = 'pending' }: { kind?: 'pending' | 'delivery' }) {
    const [count, setCount] = useState(0);
    const navigate = useNavigate();

    useEffect(() => {
        if (!ipcRenderer) return;
        let active = true;
        const load = async () => {
            try {
                const c = await ipcRenderer.invoke('get-stale-pending-count', kind);
                if (active) setCount(Number(c) || 0);
            } catch (e) {
                console.error('Failed to count older pending orders', e);
            }
        };
        load();
        const interval = setInterval(load, 60000);
        window.addEventListener('sync-completed', load);
        return () => {
            active = false;
            clearInterval(interval);
            window.removeEventListener('sync-completed', load);
        };
    }, [kind]);

    if (count === 0) return null;

    return (
        <button
            onClick={() => navigate('/history?status=PENDING')}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl text-[11px] font-bold hover:bg-amber-100"
            title="Pending orders older than 24 hours are hidden from this queue"
        >
            <AlertTriangle size={14} className="shrink-0" />
            {count} older pending order{count === 1 ? '' : 's'} (24h+), view in History
        </button>
    );
}
