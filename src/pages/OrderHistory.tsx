import { useState, useEffect } from 'react';
import { Search, Calendar, RefreshCcw, CheckCircle2, Clock, ShoppingBag } from 'lucide-react';

const ipcRenderer = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;

interface Order {
    id: string;
    total: number;
    paymentMethod: string;
    status: string;
    synced: number;
    createdAt: string;
}

export default function OrderHistory() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);

    const fetchHistory = async () => {
        if (ipcRenderer) {
            setLoading(true);
            try {
                const results = await ipcRenderer.invoke('get-order-history');
                setOrders(results);
            } catch (err) {
                console.error('Failed to fetch history', err);
            }
            setLoading(false);
        }
    };

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        fetchHistory();
    }, []);

    const filteredOrders = orders.filter(o =>
        o.id.toLowerCase().includes(search.toLowerCase()) ||
        o.paymentMethod.toLowerCase().includes(search.toLowerCase())
    );

    const handleUpdateStatus = async (id: string, status: string) => {
        if (!ipcRenderer) return;
        const confirmMsg = status === 'CANCELLED_RESTOCK' 
            ? 'Are you sure you want to VOID this order and RESTOCK its items?' 
            : 'Are you sure you want to VOID this order and mark its items as WASTE?';
            
        if (confirm(confirmMsg)) {
            await ipcRenderer.invoke('update-order-status', { id, status });
            fetchHistory();
            window.dispatchEvent(new Event('sync-completed')); // trigger global sync
        }
    };

    return (
        <div className="flex flex-col h-full bg-gray-50 p-6 overflow-hidden">
            <div className="flex justify-between items-center mb-8">
                <div>
                    <h1 className="text-3xl font-black text-gray-900 tracking-tight">Order History</h1>
                    <p className="text-gray-500 font-medium">View and track all past transactions</p>
                </div>

                <div className="flex items-center space-x-4">
                    <button
                        onClick={fetchHistory}
                        className="p-3 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors shadow-sm text-gray-600"
                    >
                        <RefreshCcw size={20} className={loading ? 'animate-spin' : ''} />
                    </button>

                    <div className="flex items-center bg-white border border-gray-200 rounded-xl px-4 py-2.5 w-80 shadow-sm focus-within:ring-2 focus-within:ring-blue-500 transition-all">
                        <Search size={18} className="text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search by ID or Payment..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="bg-transparent border-none ml-2 w-full outline-none text-sm text-gray-800 font-medium"
                        />
                    </div>
                </div>
            </div>

            <div className="flex-1 bg-white rounded-3xl border border-gray-100 shadow-xl overflow-hidden flex flex-col">
                <div className="overflow-y-auto flex-1">
                    <table className="w-full text-left border-collapse">
                        <thead>
                            <tr className="bg-gray-50/50 border-b border-gray-100">
                                <th className="px-6 py-4 text-xs font-black text-gray-400 uppercase tracking-widest">Date</th>
                                <th className="px-6 py-4 text-xs font-black text-gray-400 uppercase tracking-widest">Order ID</th>
                                <th className="px-6 py-4 text-xs font-black text-gray-400 uppercase tracking-widest">Total</th>
                                <th className="px-6 py-4 text-xs font-black text-gray-400 uppercase tracking-widest">Method</th>
                                <th className="px-6 py-4 text-xs font-black text-gray-400 uppercase tracking-widest">Status</th>
                                <th className="px-6 py-4 text-xs font-black text-gray-400 uppercase tracking-widest text-right">Sync</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                            {filteredOrders.length > 0 ? filteredOrders.map((order) => (
                                <tr key={order.id} className="hover:bg-blue-50/30 transition-colors group">
                                    <td className="px-6 py-5">
                                        <div className="flex items-center text-sm">
                                            <Calendar size={14} className="text-gray-400 mr-2" />
                                            <span className="text-gray-600 font-semibold">
                                                {new Date(order.createdAt).toLocaleDateString()}
                                            </span>
                                            <span className="text-gray-400 ml-2 font-medium">
                                                {new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-5">
                                        <span className="text-sm font-bold text-gray-900 font-mono bg-gray-100 px-2 py-1 rounded-lg">
                                            {order.id}
                                        </span>
                                    </td>
                                    <td className="px-6 py-5">
                                        <span className="text-sm font-black text-blue-600">
                                            PKR {order.total.toFixed(0)}
                                        </span>
                                    </td>
                                    <td className="px-6 py-5">
                                        <span className={`text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-tighter ${order.paymentMethod === 'CARD' ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-700'
                                            }`}>
                                            {order.paymentMethod}
                                        </span>
                                    </td>
                                    <td className="px-6 py-5">
                                        <div className="flex items-center">
                                            <span className={`text-xs font-bold ${order.status.toUpperCase() === 'COMPLETED' ? 'text-green-600' : 'text-amber-600'
                                                }`}>
                                                {order.status}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="px-6 py-5">
                                        <div className="flex items-center justify-end space-x-3">
                                            {order.status.toUpperCase() === 'COMPLETED' && (
                                                <div className="flex space-x-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button 
                                                        onClick={() => handleUpdateStatus(order.id, 'CANCELLED_RESTOCK')} 
                                                        className="px-2.5 py-1 bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 text-[10px] font-black uppercase tracking-wider rounded transition-colors"
                                                        title="Refund payment and restock raw materials"
                                                    >
                                                        Void & Restock
                                                    </button>
                                                    <button 
                                                        onClick={() => handleUpdateStatus(order.id, 'CANCELLED_WASTE')} 
                                                        className="px-2.5 py-1 bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 text-[10px] font-black uppercase tracking-wider rounded transition-colors"
                                                        title="Refund payment but log ingredients as wasted"
                                                    >
                                                        Waste
                                                    </button>
                                                </div>
                                            )}
                                            {order.synced ? (
                                                <div className="text-emerald-500" title="Synced to Cloud">
                                                    <CheckCircle2 size={18} />
                                                </div>
                                            ) : (
                                                <div className="text-amber-500" title="Pending Sync">
                                                    <Clock size={18} />
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            )) : (
                                <tr>
                                    <td colSpan={6} className="px-6 py-20 text-center">
                                        <div className="flex flex-col items-center">
                                            <ShoppingBag size={48} className="text-gray-200 mb-4" />
                                            <p className="text-gray-400 font-bold">No orders found in history</p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="p-4 bg-gray-50/50 border-t border-gray-100 flex justify-between items-center text-xs font-bold text-gray-400 uppercase tracking-widest">
                    <span>Showing {filteredOrders.length} records</span>
                    <span>Local Database Storage</span>
                </div>
            </div>
        </div>
    );
}
