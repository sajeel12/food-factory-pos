import { useState, useEffect, useCallback } from 'react';
import { Truck, Phone, MapPin, Search, CheckCircle2 } from 'lucide-react';

const ipcRenderer = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;

interface DeliveryOrder {
    id: string;
    customerName: string;
    customerPhone: string;
    customerAddress: string;
    status: string;
    createdAt: string;
    rider?: string | null;
}

interface Rider {
    id: string;
    name: string;
}

export default function Delivery() {
    const [orders, setOrders] = useState<DeliveryOrder[]>([]);
    const [riders, setRiders] = useState<Rider[]>([]);
    const [search, setSearch] = useState('');
    const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);

    const fetchOrders = useCallback(async () => {
        if (ipcRenderer) {
            const result = await ipcRenderer.invoke('get-delivery-orders');
            setOrders(result);
            const ridersResult = await ipcRenderer.invoke('get-riders');
            setRiders(ridersResult);
        }
    }, []);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        fetchOrders();
        const interval = setInterval(fetchOrders, 5000);
        return () => clearInterval(interval);
    }, [fetchOrders]);

    const filteredOrders = orders.filter(o =>
        o.id.includes(search) ||
        o.customerName?.toLowerCase().includes(search.toLowerCase()) ||
        o.customerAddress?.toLowerCase().includes(search.toLowerCase())
    );

    const assignRider = async (id: string, riderName: string) => {
        if (ipcRenderer) {
            await ipcRenderer.invoke('update-order-status', { id, status: 'Assigned', rider: riderName });
            fetchOrders();
            setSelectedOrderId(null);
        }
    };

    const markDelivered = async (id: string) => {
        if (ipcRenderer) {
            await ipcRenderer.invoke('update-order-status', { id, status: 'Completed' }); // We use 'Completed' to sync to cloud
            fetchOrders();
            setSelectedOrderId(null);
        }
    };

    const selectedOrder = orders.find(o => o.id === selectedOrderId);

    return (
        <div className="flex w-full h-full bg-gray-50 flex-col lg:flex-row shadow-inner">
            <div className="w-full lg:w-2/3 flex flex-col p-6 h-full border-r border-gray-200 bg-white z-10">
                <div className="flex justify-between items-center mb-6">
                    <div className="flex items-center space-x-3 bg-blue-50 px-4 py-2 rounded-2xl shadow-sm border border-blue-100">
                        <Truck size={24} className="text-blue-600" />
                        <h1 className="text-2xl font-black tracking-tight text-blue-900">Delivery Queue</h1>
                    </div>
                    <div className="flex items-center bg-gray-50 border border-gray-200 rounded-xl px-4 py-2.5 w-80 shadow-inner focus-within:ring-2 focus-within:ring-blue-500">
                        <Search size={20} className="text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search by ID, Customer or Area..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="bg-transparent border-none ml-2 w-full outline-none text-sm text-gray-800"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto pr-2 space-y-4 pb-20">
                    {filteredOrders.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-gray-400 py-20">
                            <Truck size={48} className="mb-4 opacity-20" />
                            <p className="font-medium text-lg">No active deliveries</p>
                        </div>
                    ) : (
                        filteredOrders.map((order) => (
                            <div
                                key={order.id}
                                onClick={() => setSelectedOrderId(order.id === selectedOrderId ? null : order.id)}
                                className={`p-5 rounded-3xl border cursor-pointer transition-all ${selectedOrderId === order.id
                                    ? 'border-blue-500 bg-blue-50/50 shadow-md ring-4 ring-blue-500/10'
                                    : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-md'
                                    }`}
                            >
                                <div className="flex justify-between items-start mb-4">
                                    <div>
                                        <span className="font-extrabold text-lg text-gray-900 mr-3">{order.id}</span>
                                        <span className={`px-3 py-1 text-xs font-bold rounded-full uppercase tracking-wider ${order.status === 'Pending' ? 'bg-amber-100 text-amber-800 border-amber-200' :
                                            order.status === 'Assigned' ? 'bg-blue-100 text-blue-800 border-blue-200' :
                                                'bg-green-100 text-green-800 border-green-200'
                                            } border`}>
                                            {order.status}
                                        </span>
                                    </div>
                                    <span className="text-xs font-semibold text-gray-400">{new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                </div>

                                <div className="grid grid-cols-2 gap-4 text-sm mt-4 p-4 bg-gray-50 rounded-2xl border border-gray-100">
                                    <div className="flex items-start space-x-2 text-gray-700">
                                        <Phone size={16} className="text-gray-400 mt-0.5" />
                                        <div className="flex flex-col">
                                            <span className="font-semibold text-gray-900">{order.customerName}</span>
                                            <span className="text-gray-50">{order.customerPhone}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-start space-x-2 text-gray-700">
                                        <MapPin size={16} className="text-gray-400 mt-0.5" />
                                        <span className="font-medium text-gray-600 line-clamp-2">{order.customerAddress}</span>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>

            <div className="w-full lg:w-1/3 bg-gray-50 p-6 shadow-2xl z-20 flex flex-col h-full border-l border-gray-200">
                {selectedOrder ? (
                    <div className="flex-1 flex flex-col h-full">
                        <h2 className="text-xl font-bold mb-6 text-gray-900 pb-4 border-b border-gray-200">
                            Manage Order {selectedOrder.id}
                        </h2>

                        {selectedOrder.status === 'Pending' && (
                            <div className="space-y-4">
                                <h3 className="font-bold text-gray-700 text-xs tracking-widest uppercase mb-4">Select Rider</h3>
                                {riders.length === 0 ? (
                                    <p className="text-sm text-gray-500 italic p-4 text-center">No AVAILABLE riders found for this branch. Please check Admin Panel or wait for sync.</p>
                                ) : (
                                    riders.map(rider => (
                                        <button
                                            key={rider.id}
                                            onClick={() => assignRider(selectedOrder.id, rider.name)}
                                            className="w-full p-4 bg-white border border-gray-200 rounded-2xl hover:border-blue-500 hover:bg-blue-50 flex justify-between items-center group font-medium"
                                        >
                                            <div className="flex items-center space-x-3">
                                                <Truck size={18} className="text-gray-400 group-hover:text-blue-500" />
                                                <span>{rider.name}</span>
                                            </div>
                                            <span className="text-blue-500 font-bold opacity-0 group-hover:opacity-100 transition-opacity">Assign</span>
                                        </button>
                                    ))
                                )}
                            </div>
                        )}

                        {selectedOrder.status === 'Assigned' && (
                            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-6">
                                <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center text-blue-600 shadow-inner">
                                    <Truck size={36} />
                                </div>
                                <div>
                                    <p className="text-gray-500 text-sm font-medium mb-1">Rider Assigned</p>
                                    <p className="font-black text-2xl text-gray-900">En Route</p>
                                </div>
                                <button
                                    onClick={() => markDelivered(selectedOrder.id)}
                                    className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-4 rounded-2xl shadow-lg flex items-center justify-center space-x-2 text-lg transition-transform active:scale-95"
                                >
                                    <CheckCircle2 size={24} />
                                    <span>Mark Delivered</span>
                                </button>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-gray-400 opacity-60">
                        <Truck size={64} className="mb-6" />
                        <p className="text-xl font-bold text-gray-800">No order selected</p>
                        <p className="text-sm font-medium mt-2 text-center">Select an order from the queue to assign a rider or mark as delivered.</p>
                    </div>
                )}
            </div>
        </div>
    );
}
