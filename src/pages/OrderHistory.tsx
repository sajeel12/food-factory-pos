import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, Calendar, RefreshCcw, CheckCircle2, Clock, ShoppingBag, Printer, X, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import ReceiptPreview from '../components/ReceiptPreview';

const ipcRenderer = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;

interface Order {
    id: string;
    total: number;
    paymentMethod: string;
    tenderedAmount: number;
    status: string;
    synced: number;
    createdAt: string;
    customerName?: string;
    customerPhone?: string;
    customerAddress?: string;
    deliveryFee?: number;
    orderType?: string;
    tableNo?: string;
    dailyOrderNumber?: number;
    cashierName?: string;
    discount?: number;
    voucherId?: string;
}

interface HistoryPage {
    orders: Order[];
    total: number;
    page: number;
    totalPages: number;
}

const PAGE_SIZE = 50;

const STATUS_FILTERS = [
    { value: 'ALL', label: 'All' },
    { value: 'COMPLETED', label: 'Completed' },
    { value: 'PENDING', label: 'Pending' },
    { value: 'CANCELLED', label: 'Cancelled' },
];

export default function OrderHistory() {
    const [data, setData] = useState<HistoryPage>({ orders: [], total: 0, page: 1, totalPages: 1 });
    const [page, setPage] = useState(1);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const [date, setDate] = useState('');
    const [searchParams] = useSearchParams();
    // Links like /history?status=PENDING (from the queue's older-orders notice) preselect a filter
    const [status, setStatus] = useState(() => {
        const fromUrl = (searchParams.get('status') || '').toUpperCase();
        return STATUS_FILTERS.some(f => f.value === fromUrl) ? fromUrl : 'ALL';
    });
    const [loading, setLoading] = useState(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [receiptData, setReceiptData] = useState<any>(null);
    const requestId = useRef(0);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Wait for the cashier to stop typing before querying
    useEffect(() => {
        const t = setTimeout(() => {
            setDebouncedSearch(search);
            setPage(1);
        }, 300);
        return () => clearTimeout(t);
    }, [search]);

    const fetchHistory = useCallback(async () => {
        if (!ipcRenderer) return;
        // Ignore responses that arrive after a newer request (fast typing / paging)
        const id = ++requestId.current;
        setLoading(true);
        try {
            const result = await ipcRenderer.invoke('get-order-history', {
                page,
                pageSize: PAGE_SIZE,
                search: debouncedSearch,
                date,
                status,
            });
            if (id !== requestId.current) return;
            setData(result);
            // The backend clamps out-of-range pages (e.g. after a void); follow it
            if (result.page !== page) setPage(result.page);
        } catch (err) {
            console.error('Failed to fetch history', err);
        }
        if (id === requestId.current) setLoading(false);
    }, [page, debouncedSearch, date, status]);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        fetchHistory();
    }, [fetchHistory]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: 0 });
    }, [page]);

    const orders = data.orders;
    const hasFilters = !!(debouncedSearch.trim() || date || status !== 'ALL');
    const firstRow = data.total === 0 ? 0 : (data.page - 1) * PAGE_SIZE + 1;
    const lastRow = Math.min(data.page * PAGE_SIZE, data.total);

    const clearFilters = () => {
        setSearch('');
        setDebouncedSearch('');
        setDate('');
        setStatus('ALL');
        setPage(1);
    };

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

    const handleReprint = async (order: Order) => {
        if (!ipcRenderer) return;
        try {
            const items = await ipcRenderer.invoke('get-order-items', order.id);
            setReceiptData({
                id: order.id,
                total: order.total,
                paymentMethod: order.paymentMethod,
                tenderedAmount: order.tenderedAmount || order.total,
                status: order.status,
                createdAt: order.createdAt,
                customerName: order.customerName || null,
                customerPhone: order.customerPhone || null,
                customerAddress: order.customerAddress || null,
                deliveryFee: order.deliveryFee || 0,
                orderType: order.orderType || 'TAKE_AWAY',
                tableNo: order.tableNo || null,
                dailyOrderNumber: order.dailyOrderNumber || 0,
                cashierName: order.cashierName || null,
                discount: order.discount || 0,
                items: items || []
            });
        } catch (err) {
            console.error('Failed to load order items for reprint', err);
        }
    };

    const handlePrintReceipt = async () => {
        if (ipcRenderer && receiptData) {
            await ipcRenderer.invoke('print-receipt', receiptData);
        }
        setReceiptData(null);
    };

    return (
        <div className="flex flex-col h-full bg-gray-50 p-6 overflow-hidden">
            <div className="flex justify-between items-center mb-4">
                <div>
                    <h1 className="text-3xl font-black text-gray-900 tracking-tight">Order History</h1>
                    <p className="text-gray-500 font-medium">View and track all past transactions</p>
                </div>

                <div className="flex items-center space-x-4">
                    <button
                        onClick={fetchHistory}
                        title="Refresh"
                        className="p-3 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors shadow-sm text-gray-600"
                    >
                        <RefreshCcw size={20} className={loading ? 'animate-spin' : ''} />
                    </button>

                    <div className="flex items-center bg-white border border-gray-200 rounded-xl px-4 py-2.5 w-96 shadow-sm focus-within:ring-2 focus-within:ring-blue-500 transition-all">
                        <Search size={18} className="text-gray-400 shrink-0" />
                        <input
                            type="text"
                            placeholder="Order #, ID, customer, phone, item, table..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Escape') setSearch(''); }}
                            className="bg-transparent border-none ml-2 w-full outline-none text-sm text-gray-800 font-medium"
                        />
                        {search && (
                            <button onClick={() => setSearch('')} title="Clear search" className="text-gray-400 hover:text-gray-600 shrink-0">
                                <X size={16} />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-2">
                    {STATUS_FILTERS.map(f => (
                        <button
                            key={f.value}
                            onClick={() => { setStatus(f.value); setPage(1); }}
                            className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wider border ${status === f.value
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                                }`}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>

                <div className="flex items-center space-x-3">
                    <div className="flex items-center bg-white border border-gray-200 rounded-xl px-3 py-1.5 shadow-sm" title="Business day (6am to 6am), same as daily order numbers">
                        <Calendar size={16} className="text-gray-400 mr-2" />
                        <input
                            type="date"
                            value={date}
                            onChange={(e) => { setDate(e.target.value); setPage(1); }}
                            className="bg-transparent outline-none text-sm text-gray-700 font-medium"
                        />
                    </div>
                    {hasFilters && (
                        <button onClick={clearFilters} className="text-xs font-bold text-blue-600 hover:text-blue-800 uppercase tracking-wider">
                            Clear filters
                        </button>
                    )}
                </div>
            </div>

            <div className="flex-1 bg-white rounded-3xl border border-gray-100 shadow-xl overflow-hidden flex flex-col">
                <div ref={scrollRef} className={`overflow-y-auto flex-1 ${loading ? 'opacity-60' : ''}`}>
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
                            {orders.length > 0 ? orders.map((order) => (
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
                                        <div className="flex items-center space-x-2">
                                            {!!order.dailyOrderNumber && (
                                                <span className="text-sm font-black text-gray-700">#{order.dailyOrderNumber}</span>
                                            )}
                                            <span className="text-sm font-bold text-gray-900 font-mono bg-gray-100 px-2 py-1 rounded-lg">
                                                {order.id}
                                            </span>
                                        </div>
                                        {(order.customerName || order.customerPhone || order.tableNo) && (
                                            <div className="text-xs text-gray-400 font-medium mt-1">
                                                {[order.tableNo && `Table ${order.tableNo}`, order.customerName, order.customerPhone].filter(Boolean).join(' · ')}
                                            </div>
                                        )}
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
                                            <button
                                                onClick={() => handleReprint(order)}
                                                className="p-1.5 bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200 rounded transition-colors"
                                                title="Reprint Receipt"
                                            >
                                                <Printer size={14} />
                                            </button>
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
                                            <p className="text-gray-400 font-bold">
                                                {loading ? 'Loading...' : hasFilters ? 'No orders match your search' : 'No orders found in history'}
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="p-4 bg-gray-50/50 border-t border-gray-100 flex justify-between items-center text-xs font-bold text-gray-400 uppercase tracking-widest">
                    <span>
                        {data.total > 0
                            ? `Showing ${firstRow}–${lastRow} of ${data.total.toLocaleString()} records`
                            : 'No records'}
                    </span>
                    <div className="flex items-center space-x-1">
                        <button
                            onClick={() => setPage(1)}
                            disabled={data.page <= 1}
                            title="First page"
                            className="p-2 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <ChevronsLeft size={16} />
                        </button>
                        <button
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            disabled={data.page <= 1}
                            title="Previous page"
                            className="p-2 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <ChevronLeft size={16} />
                        </button>
                        <span className="px-3 text-gray-500">Page {data.page} of {data.totalPages}</span>
                        <button
                            onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                            disabled={data.page >= data.totalPages}
                            title="Next page"
                            className="p-2 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <ChevronRight size={16} />
                        </button>
                        <button
                            onClick={() => setPage(data.totalPages)}
                            disabled={data.page >= data.totalPages}
                            title="Last page"
                            className="p-2 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            <ChevronsRight size={16} />
                        </button>
                    </div>
                </div>
            </div>

            {/* Receipt Preview Modal for Reprint */}
            {receiptData && (
                <ReceiptPreview
                    data={receiptData}
                    onPrint={handlePrintReceipt}
                    onClose={() => setReceiptData(null)}
                />
            )}
        </div>
    );
}
