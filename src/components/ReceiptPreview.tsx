import { Printer, RotateCcw } from 'lucide-react';

interface ReceiptItem {
    id: string;
    orderId: string;
    productId: string;
    variantId?: string | null;
    variantName?: string | null;
    name?: string;
    quantity: number;
    subtotal: number;
    dealChoices?: string | null;
}

interface ReceiptData {
    id: string;
    total: number;
    paymentMethod: string;
    tenderedAmount: number;
    status: string;
    customerName?: string | null;
    customerPhone?: string | null;
    customerAddress?: string | null;
    deliveryFee: number;
    discount?: number;
    items: ReceiptItem[];
    createdAt?: string;
    dailyOrderNumber?: number;
}

interface ReceiptPreviewProps {
    data: ReceiptData;
    cartNames?: Record<string, { name: string; variantName?: string }>;
    onPrint: () => void;
    onClose: () => void;
}

export default function ReceiptPreview({ data, cartNames, onPrint, onClose }: ReceiptPreviewProps) {
    const change = Math.max(0, (data.tenderedAmount || data.total) - data.total);
    const dateStr = data.createdAt
        ? new Date(data.createdAt).toLocaleString()
        : new Date().toLocaleString();

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-gray-100 rounded-3xl shadow-2xl w-full max-w-sm p-6 flex flex-col max-h-[90vh]">
                {/* Receipt Paper */}
                <div className="bg-white rounded-2xl shadow-inner border border-gray-200 px-6 py-8 flex-1 overflow-y-auto"
                     style={{ fontFamily: "'Courier New', Courier, monospace" }}>
                    {/* Header with Logo */}
                    <div className="text-center mb-4">
                        <img src="/logo.png" alt="Food Factory" className="h-16 w-auto mx-auto mb-2" />
                        <p className="text-[10px] text-gray-400 font-bold uppercase tracking-widest">Customer Receipt</p>
                    </div>

                    <div className="border-t-2 border-dashed border-gray-300 my-3" />

                    {/* Order Info */}
                    <div className="text-xs space-y-1 text-gray-600">
                        <div className="flex justify-between items-center bg-gray-200 p-2 rounded-lg mb-2">
                            <span>Order #</span>
                            <div className="text-right">
                                <div className="text-[10px] text-gray-500">{data.id}</div>
                                {data.dailyOrderNumber && (
                                    <div className="font-black text-gray-900 text-xl tracking-tight">Q-{data.dailyOrderNumber}</div>
                                )}
                            </div>
                        </div>
                        <div className="flex justify-between">
                            <span>Date</span>
                            <span>{dateStr}</span>
                        </div>
                        <div className="flex justify-between">
                            <span>Payment</span>
                            <span className="font-bold">{data.paymentMethod}</span>
                        </div>
                        {data.status === 'Pending' && (
                            <div className="flex justify-between">
                                <span>Status</span>
                                <span className="font-bold text-amber-600">DELIVERY</span>
                            </div>
                        )}
                    </div>

                    {/* Customer Info for Delivery */}
                    {data.customerName && (
                        <>
                            <div className="border-t-2 border-dashed border-gray-300 my-3" />
                            <div className="text-xs space-y-1 text-gray-600">
                                <div className="flex justify-between">
                                    <span>Customer</span>
                                    <span className="font-bold text-gray-900">{data.customerName}</span>
                                </div>
                                {data.customerPhone && (
                                    <div className="flex justify-between">
                                        <span>Phone</span>
                                        <span>{data.customerPhone}</span>
                                    </div>
                                )}
                                {data.customerAddress && (
                                    <div className="text-gray-500 mt-1">
                                        <span className="text-gray-400">Addr: </span>{data.customerAddress}
                                    </div>
                                )}
                            </div>
                        </>
                    )}

                    <div className="border-t-2 border-dashed border-gray-300 my-3" />

                    {/* Items */}
                    <div className="space-y-2">
                        {data.items.map((item, idx) => {
                            const displayName = cartNames?.[item.productId]?.name || item.name || 'Item';
                            const displayVariant = item.variantName || cartNames?.[item.productId]?.variantName;
                            return (
                                <div key={idx} className="text-xs">
                                    <div className="flex justify-between">
                                        <span className="text-gray-800 font-bold flex-1 pr-2">
                                            {item.quantity}x {displayName}
                                        </span>
                                        <span className="text-gray-900 font-bold whitespace-nowrap">
                                            PKR {item.subtotal.toFixed(0)}
                                        </span>
                                    </div>
                                    {displayVariant && (
                                        <div className="text-[10px] text-purple-500 ml-4">({displayVariant})</div>
                                    )}
                                    {item.dealChoices && JSON.parse(item.dealChoices).map((choice: any, cidx: number) => (
                                        <div key={cidx} className="text-[10px] text-blue-500 ml-4 italic">
                                            ↪ {choice.quantity ? `${choice.quantity}x ` : ''}{choice.productName}{choice.variantName ? `: ${choice.variantName}` : ''}
                                        </div>
                                    ))}
                                </div>
                            );
                        })}
                    </div>

                    <div className="border-t-2 border-dashed border-gray-300 my-3" />

                    {/* Totals */}
                    <div className="space-y-1">
                        {data.discount && data.discount > 0 && (
                            <div className="flex justify-between text-xs text-blue-600 mb-1">
                                <span>Discount</span>
                                <span className="font-bold">-PKR {data.discount.toFixed(0)}</span>
                            </div>
                        )}
                        <div className="flex justify-between text-sm font-black text-gray-900 border-t border-gray-100 pt-1 mt-1">
                            <span>TOTAL</span>
                            <span>PKR {data.total.toFixed(0)}</span>
                        </div>
                        {data.discount && data.discount > 0 && (
                            <div className="flex justify-between text-[10px] text-blue-400 font-bold uppercase tracking-tight italic">
                                <span>* Discount Applied</span>
                                <span>Save PKR {data.discount.toFixed(0)}</span>
                            </div>
                        )}
                        {data.deliveryFee > 0 && (
                            <div className="flex justify-between text-[10px] text-gray-400 font-bold uppercase tracking-tight italic">
                                <span>* Delivery Fee Included (PKR {data.deliveryFee})</span>
                            </div>
                        )}
                        {data.paymentMethod === 'CASH' && (
                            <>
                                <div className="flex justify-between text-xs text-gray-500">
                                    <span>Tendered</span>
                                    <span>PKR {(data.tenderedAmount || data.total).toFixed(0)}</span>
                                </div>
                                <div className="flex justify-between text-xs font-bold text-green-600">
                                    <span>Change</span>
                                    <span>PKR {change.toFixed(0)}</span>
                                </div>
                            </>
                        )}
                    </div>

                    <div className="border-t-2 border-dashed border-gray-300 my-4" />

                    {/* Footer */}
                    <div className="text-center text-[10px] text-gray-400 space-y-1">
                        <p className="font-bold">Thank you for dining with us!</p>
                        <p>Food Factory — A taste you will remember</p>
                    </div>
                </div>

                {/* Action Buttons */}
                <div className="flex space-x-3 mt-4">
                    <button
                        onClick={onPrint}
                        className="flex-1 flex items-center justify-center space-x-2 py-3.5 bg-gray-900 text-white rounded-2xl font-bold text-sm hover:bg-gray-800 transition-all active:scale-[0.98] shadow-lg"
                    >
                        <Printer size={18} />
                        <span>Print Receipt</span>
                    </button>
                    <button
                        onClick={onClose}
                        className="flex-1 flex items-center justify-center space-x-2 py-3.5 bg-white text-gray-700 border border-gray-200 rounded-2xl font-bold text-sm hover:bg-gray-50 transition-all active:scale-[0.98]"
                    >
                        <RotateCcw size={18} />
                        <span>New Order</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
