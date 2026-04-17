import { useState, useEffect, useCallback } from 'react';
import { Search, ShoppingBag, Plus, Minus, Trash2, Truck, X, MapPin, CheckCircle2, User, UserPlus, Ticket } from 'lucide-react';
import ReceiptPreview from '../components/ReceiptPreview';
// Removed useAuth import as it is currently unused in this component

declare global {
    interface Window {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        require?: (module: string) => any;
    }
}

const ipcRenderer = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;

interface Category {
    id: string;
    name: string;
}

interface Product {
    id: string;
    name: string;
    price: number;
    category: string;
    categoryId?: string | null;
    img: string;
    image?: string | null;
    variants?: { id: string; name: string; price: number }[];
    isDeal?: boolean;
    dealItems?: { name: string; quantity: number }[];
}

interface ReceiptItem {
    id: string;
    orderId: string;
    productId: string;
    variantId: string | null;
    variantName: string | null;
    quantity: number;
    subtotal: number;
}

interface DeliveryOrder {
    id: string;
    customerName: string;
    customerPhone?: string | null;
    customerAddress?: string | null;
    status: string;
    deliveryFee: number;
    items: ReceiptItem[];
    createdAt: string;
    rider?: string | null;
}

interface Rider {
    id: string;
    name: string;
}

export default function DeliveryPOS() {
    // POS State
    const [activeCategory, setActiveCategory] = useState('All');
    const [posSearch, setPosSearch] = useState('');
    const [cart, setCart] = useState<{ uniqueId: string; id: string; name: string; price: number; qty: number; variantId?: string; variantName?: string }[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedProductForVariant, setSelectedProductForVariant] = useState<Product | null>(null);
    const [selectedDealForDetails, setSelectedDealForDetails] = useState<Product | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [deliveryMode, setDeliveryMode] = useState(false);
    const [deliveryInfo, setDeliveryInfo] = useState({ name: '', phone: '', address: '' });
    const [customerSuggestions, setCustomerSuggestions] = useState<{ id: string; name: string; phone: string; address: string | null; loyaltyPoints: number }[]>([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [receiptData, setReceiptData] = useState<any>(null);

    // Delivery Queue State
    const [orders, setOrders] = useState<DeliveryOrder[]>([]);
    const [riders, setRiders] = useState<Rider[]>([]);
    const [queueSearch, setQueueSearch] = useState('');
    const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
    const [configDeliveryFee, setConfigDeliveryFee] = useState<number>(0);
    const [waiveDeliveryFee, setWaiveDeliveryFee] = useState(false);
    const [couponCode, setCouponCode] = useState('');
    const [appliedVoucher, setAppliedVoucher] = useState<any>(null);
    const [discountError, setDiscountError] = useState<string | null>(null);

    const fetchQueue = useCallback(async () => {
        if (ipcRenderer) {
            const result = await ipcRenderer.invoke('get-delivery-orders');
            setOrders(result);
            const ridersResult = await ipcRenderer.invoke('get-riders');
            setRiders(ridersResult);
        }
    }, []);

    const loadProducts = useCallback(async () => {
        if (ipcRenderer) {
            try {
                const cats = await ipcRenderer.invoke('get-categories');
                setCategories(cats);
                const catMap: Record<string, string> = {};
                cats.forEach((c: Category) => { catMap[c.id] = c.name; });

                const rows = await ipcRenderer.invoke('get-products');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mapped = rows.filter((r: any) => !(r.sku || '').startsWith('RAW-')).map((r: any) => {
                    const nameLower = r.name.toLowerCase();
                    let img = '🍽️';
                    if (nameLower.includes('burger')) img = '🍔';
                    else if (nameLower.includes('fries') || nameLower.includes('nugget')) img = '🍟';
                    else if (nameLower.includes('shake') || nameLower.includes('drink') || nameLower.includes('cola')) img = '🥤';
                    else if (nameLower.includes('cake') || nameLower.includes('ice') || nameLower.includes('sweet')) img = '🍰';
                    
                    const isDeal = !!r.isDeal;
                    let dealItems = [];
                    if (isDeal && r.dealItems) {
                        try { dealItems = JSON.parse(r.dealItems); } catch { /* ignore */ }
                    }

                    return {
                        id: r.id,
                        name: r.name,
                        price: r.price,
                        category: r.categoryId && catMap[r.categoryId] ? catMap[r.categoryId] : 'Uncategorized',
                        categoryId: r.categoryId,
                        img,
                        image: r.image,
                        variants: r.variants,
                        isDeal,
                        dealItems
                    };
                });
                setProducts(mapped);
            } catch (err) {
                console.error('Failed to load products', err);
            }
        }
    }, []);

    const loadSettings = useCallback(async () => {
        if (ipcRenderer) {
            try {
                const settings = await ipcRenderer.invoke('get-settings');
                const feeSetting = settings.find((s: any) => s.key === 'DELIVERY_FEE');
                if (feeSetting) setConfigDeliveryFee(Number(feeSetting.value) || 0);
            } catch (err) {
                console.error('Failed to load settings', err);
            }
        }
    }, []);

    useEffect(() => {
        let isMounted = true;
        const init = async () => {
            if (isMounted) {
                await loadProducts();
                await loadSettings();
                await fetchQueue();
            }
        };
        init();
        const interval = setInterval(() => {
            if (isMounted) fetchQueue();
        }, 10000);
        
        const handleSync = () => {
            if (isMounted) {
                loadProducts();
                loadSettings();
                fetchQueue();
            }
        };
        window.addEventListener('sync-completed', handleSync);
        
        return () => {
            isMounted = false;
            clearInterval(interval);
            window.removeEventListener('sync-completed', handleSync);
        };
    }, [loadProducts, fetchQueue, loadSettings]);

    // POS Logic
    const filteredProducts = products.filter((p: Product) =>
        (activeCategory === 'All' || p.category === activeCategory) &&
        p.name.toLowerCase().includes(posSearch.toLowerCase())
    );

    const handleProductClick = (product: Product) => {
        if (product.variants && product.variants.length > 0) {
            setSelectedProductForVariant(product);
        } else {
            addToCartAction(product);
        }
    };

    const addToCartAction = (product: Product, variant?: { id: string; name: string; price: number }) => {
        setCart(prev => {
            const uniqueId = variant ? `${product.id}-${variant.id}` : product.id;
            const exists = prev.find(item => item.uniqueId === uniqueId);
            if (exists) return prev.map(item => item.uniqueId === uniqueId ? { ...item, qty: item.qty + 1 } : item);
            return [...prev, { 
                uniqueId, 
                id: product.id, 
                name: product.name, 
                price: variant ? variant.price : product.price, 
                qty: 1,
                variantId: variant?.id,
                variantName: variant?.name
            }];
        });
        setSelectedProductForVariant(null);
    };

    const updateQty = (uniqueId: string, delta: number) => {
        setCart(prev => prev.map(item => {
            if (item.uniqueId === uniqueId) {
                const newQty = item.qty + delta;
                return newQty > 0 ? { ...item, qty: newQty } : item;
            }
            return item;
        }).filter(item => item.qty > 0));
    };

    const removeItem = (uniqueId: string) => {
        setCart(prev => prev.filter(item => item.uniqueId !== uniqueId));
    };

    const handleApplyCoupon = async () => {
        if (!couponCode || !ipcRenderer) return;
        setDiscountError(null);
        try {
            // Need to pass branchId if we want branch-specific validation
            const res = await ipcRenderer.invoke('validate-voucher', { code: couponCode.toUpperCase(), branchId: null });
            if (res.success) {
                setAppliedVoucher(res.voucher);
                setCouponCode('');
            } else {
                setDiscountError(res.message);
            }
        } catch (e) {
            setDiscountError('Error validating coupon');
        }
    };

    const removeVoucher = () => {
        setAppliedVoucher(null);
        setDiscountError(null);
    };

    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const deliveryFee = !waiveDeliveryFee ? configDeliveryFee : 0;
    
    let discount = 0;
    if (appliedVoucher) {
        if (appliedVoucher.type === 'PERCENTAGE') {
            discount = subtotal * (appliedVoucher.value / 100);
        } else {
            discount = Math.min(subtotal, appliedVoucher.value);
        }
    }

    const tax = subtotal * 0; // matching POS.tsx behavior
    const total = Math.max(0, subtotal + tax + deliveryFee - discount);

    const handlePhoneChange = async (val: string) => {
        setDeliveryInfo({ ...deliveryInfo, phone: val });
        if (val.length >= 3 && ipcRenderer) {
            try {
                const matches = await ipcRenderer.invoke('search-customer', val);
                setCustomerSuggestions(matches);
            } catch (e) {
                console.error(e);
            }
        } else {
            setCustomerSuggestions([]);
        }
    };

    const handleCheckout = async () => {
        if (cart.length === 0 || isProcessing) return;
        if (!deliveryInfo.name || !deliveryInfo.phone || !deliveryInfo.address) {
            alert('Please fill customer details');
            return;
        }

        setIsProcessing(true);
        if (ipcRenderer) {
            try {
                const generateShortId = () => {
                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                    let id = '';
                    for (let i = 0; i < 6; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
                    return id;
                };
                const orderId = generateShortId();
                const payload = {
                    id: orderId,
                    total: total,
                    paymentMethod: 'CASH',
                    tenderedAmount: total,
                    status: 'Pending',
                    customerName: deliveryInfo.name,
                    customerPhone: deliveryInfo.phone,
                    customerAddress: deliveryInfo.address,
                    voucherId: appliedVoucher?.id || null,
                    discount: discount,
                    createdAt: new Date().toISOString(),
                    items: cart.map(item => ({
                        id: 'ITM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                        orderId: orderId,
                        productId: item.id,
                        variantId: item.variantId || null,
                        variantName: item.variantName || null,
                        quantity: item.qty,
                        subtotal: item.price * item.qty
                    })),
                    deliveryFee: deliveryFee
                };

                await ipcRenderer.invoke('create-order', payload);
                // Kitchen ticket prints immediately
                await ipcRenderer.invoke('print-kitchen', payload);

                // Show receipt preview instead of auto-printing
                setReceiptData(payload);
                setDeliveryInfo({ name: '', phone: '', address: '' });
                setCustomerSuggestions([]);
                setDeliveryMode(false);

                // INSTANT REFRESH QUEUE
                await fetchQueue();
            } catch (err) {
                console.error('Checkout failed', err);
                alert('Order Failed processing.');
            }
        }
        setIsProcessing(false);
    };

    const handlePrintReceipt = async () => {
        if (ipcRenderer && receiptData) {
            await ipcRenderer.invoke('print-receipt', receiptData);
        }
        setReceiptData(null);
        setCart([]);
        setAppliedVoucher(null);
    };

    const handleSkipPrint = () => {
        setReceiptData(null);
        setCart([]);
        setAppliedVoucher(null);
    };

    // Queue Logic
    const filteredOrders = orders.filter((o: DeliveryOrder) =>
        o.id.includes(queueSearch) ||
        o.customerName?.toLowerCase().includes(queueSearch.toLowerCase()) ||
        o.customerAddress?.toLowerCase().includes(queueSearch.toLowerCase())
    );

    const assignRider = async (id: string, riderName: string) => {
        if (ipcRenderer) {
            await ipcRenderer.invoke('update-order-status', { id, status: 'Assigned', rider: riderName });
            fetchQueue();
            setSelectedOrderId(null);
        }
    };

    const markDelivered = async (id: string) => {
        if (ipcRenderer) {
            await ipcRenderer.invoke('update-order-status', { id, status: 'Completed' });
            fetchQueue();
            setSelectedOrderId(null);
        }
    };

    const selectedOrder = orders.find(o => o.id === selectedOrderId);

    return (
        <div className="flex w-full h-full bg-gray-50 overflow-hidden font-sans">
            {/* COLUMN 1: MENU (High Density) */}
            <div className="flex-[2.2] flex flex-col h-full border-r border-gray-200 bg-white min-w-0">
                <div className="p-4 border-b border-gray-100 space-y-3 shrink-0">
                    <div className="flex items-center bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus-within:ring-2 ring-blue-500 transition-all">
                        <Search size={18} className="text-gray-400" />
                        <input
                            type="text"
                            placeholder="Quick search menu..."
                            value={posSearch}
                            onChange={(e) => setPosSearch(e.target.value)}
                            className="bg-transparent border-none ml-2 w-full outline-none text-sm font-semibold"
                        />
                    </div>
                    <div className="flex space-x-2 overflow-x-auto pb-1 scrollbar-hide">
                        {['All', ...categories.map(c => c.name), 'Uncategorized'].map(c => (
                            <button
                                key={c}
                                onClick={() => setActiveCategory(c)}
                                className={`px-4 py-1.5 rounded-xl whitespace-nowrap font-bold text-sm transition-all ${activeCategory === c
                                    ? 'bg-blue-600 text-white shadow-md'
                                    : 'bg-white text-gray-500 border border-gray-200 hover:bg-gray-100'
                                }`}
                            >
                                {c}
                            </button>
                        ))}
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 scrollbar-hide min-h-0">
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                        {filteredProducts.map(product => (
                            <div
                                key={product.id}
                                onClick={() => handleProductClick(product)}
                                className="bg-white p-3 rounded-2xl border border-gray-200 shadow-sm hover:border-blue-400 hover:shadow-md cursor-pointer flex flex-col items-center text-center group transition-all"
                            >
                                <div className="text-4xl mb-3 p-3 bg-gray-50 rounded-2xl group-hover:bg-blue-50 w-full aspect-square flex items-center justify-center overflow-hidden transition-colors relative">
                                    {product.image ? (
                                        <img src={product.image} className="w-full h-full object-cover" />
                                    ) : (
                                        product.img
                                    )}
                                    {product.isDeal && (
                                        <span className="absolute top-1 right-1 bg-red-500 text-white text-[10px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider">Deal</span>
                                    )}
                                </div>
                                <h3 className="font-bold text-gray-800 leading-tight mb-1 line-clamp-2">{product.name}</h3>
                                {product.isDeal && product.dealItems && product.dealItems.length > 0 && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setSelectedDealForDetails(product); }}
                                        className="text-[10px] bg-purple-100 text-purple-700 font-bold px-2 py-1 rounded-md mt-1 mb-2 hover:bg-purple-200 transition-colors uppercase tracking-wider outline-none"
                                    >
                                        View Contents
                                    </button>
                                )}
                                <p className="text-blue-600 font-extrabold mt-auto pt-2">PKR {Number(product.price).toFixed(0)}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* COLUMN 2: CART & CUSTOMER */}
            <div className="flex-[1.5] flex flex-col h-full border-r border-gray-200 bg-gray-50/30 min-w-0">
                <div className="p-4 bg-white border-b border-gray-200 flex items-center justify-between shrink-0">
                    <div className="flex items-center space-x-2">
                        <div className="p-2 bg-amber-100 text-amber-600 rounded-lg">
                            <ShoppingBag size={18} />
                        </div>
                        <h2 className="font-black text-gray-900 tracking-tight uppercase text-base">Draft Order</h2>
                    </div>
                    {cart.length > 0 && (
                        <button onClick={() => setCart([])} className="text-gray-400 hover:text-red-500 p-2 rounded-lg transition-colors">
                            <Trash2 size={16} />
                        </button>
                    )}
                </div>

                {/* Cart Items - Scrollable Area */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0">
                    {cart.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3 opacity-40">
                            <ShoppingBag size={48} />
                            <p className="font-bold text-sm">Cart is empty</p>
                        </div>
                    ) : (
                        cart.map(item => (
                            <div key={item.uniqueId} className="bg-white p-3 rounded-xl border border-gray-100 shadow-sm">
                                <div className="flex justify-between items-start mb-2">
                                    <div className="flex flex-col">
                                        <span className="font-bold text-gray-800 text-sm leading-tight">{item.name}</span>
                                        {item.variantName && (
                                            <span className="text-xs text-purple-600 font-bold bg-purple-50 px-1.5 py-0.5 rounded mt-1">{item.variantName}</span>
                                        )}
                                    </div>
                                    <div className="flex items-center space-x-2">
                                        <span className="font-black text-gray-900 text-sm">PKR {item.price * item.qty}</span>
                                        <button onClick={() => removeItem(item.uniqueId)} className="p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"><X size={14} /></button>
                                    </div>
                                </div>
                                <div className="flex justify-between items-center">
                                    <p className="text-xs text-gray-400 font-bold">PKR {item.price} x {item.qty}</p>
                                    <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
                                        <button onClick={() => updateQty(item.uniqueId, -1)} className="p-1 hover:bg-white rounded shadow-sm transition-all"><Minus size={14} /></button>
                                        <span className="font-black w-5 text-center text-sm">{item.qty}</span>
                                        <button onClick={() => updateQty(item.uniqueId, 1)} className="p-1 hover:bg-white rounded shadow-sm transition-all"><Plus size={14} /></button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {/* Coupon Area */}
                <div className="p-3 bg-gray-50 border-t border-gray-100">
                    {appliedVoucher ? (
                        <div className="flex items-center justify-between bg-blue-50 p-2.5 rounded-xl border border-blue-100">
                            <div className="flex items-center space-x-2">
                                <Ticket size={16} className="text-blue-600" />
                                <div>
                                    <p className="text-[10px] font-black text-blue-900 uppercase tracking-widest">{appliedVoucher.code}</p>
                                    <p className="text-[9px] text-blue-600 font-bold">
                                        -{appliedVoucher.type === 'PERCENTAGE' ? `${appliedVoucher.value}%` : `PKR ${appliedVoucher.value}`} Applied
                                    </p>
                                </div>
                            </div>
                            <button 
                                onClick={removeVoucher}
                                className="p-1 hover:bg-blue-200 text-blue-600 rounded-full transition-colors"
                            >
                                <X size={14} />
                            </button>
                        </div>
                    ) : (
                        <div className="flex space-x-2">
                            <div className="relative flex-1">
                                <Ticket size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                                <input
                                    type="text"
                                    placeholder="COUPON"
                                    value={couponCode}
                                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                                    onKeyDown={(e) => e.key === 'Enter' && handleApplyCoupon()}
                                    className="w-full pl-8 pr-2 py-1.5 bg-white border border-gray-200 rounded-lg text-[10px] font-bold uppercase tracking-widest outline-none focus:border-blue-500 transition-colors"
                                />
                            </div>
                            <button 
                                onClick={handleApplyCoupon}
                                disabled={!couponCode}
                                className="px-3 py-1.5 bg-gray-900 text-white rounded-lg text-[10px] font-bold hover:bg-blue-600 transition-colors disabled:opacity-30"
                            >
                                APPLY
                            </button>
                        </div>
                    )}
                    {discountError && <p className="text-[9px] text-red-500 mt-1 ml-1 font-bold italic">{discountError}</p>}
                </div>

                {/* Checkout/Customer Area - Persistent at Bottom */}
                <div className="p-4 bg-white border-t border-gray-200 shrink-0">
                    {!deliveryMode ? (
                        <div className="space-y-4">
                            {appliedVoucher && (
                                <div className="flex justify-between items-center px-1">
                                    <span className="text-sm font-black text-gray-400 uppercase">Subtotal</span>
                                    <span className="text-sm font-black text-gray-900">PKR {subtotal.toFixed(0)}</span>
                                </div>
                            )}
                            {appliedVoucher && (
                                <div className="flex justify-between items-center px-1">
                                    <span className="text-sm font-black text-blue-600 uppercase">Discount</span>
                                    <span className="text-sm font-black text-blue-600">-PKR {discount.toFixed(0)}</span>
                                </div>
                            )}
                            {!appliedVoucher && (
                                <div className="flex justify-between items-center px-1">
                                    <span className="text-base font-black text-gray-400 uppercase">Subtotal</span>
                                    <span className="text-base font-black text-gray-900">PKR {total.toFixed(0)}</span>
                                </div>
                            )}
                            <button
                                disabled={cart.length === 0}
                                onClick={() => setDeliveryMode(true)}
                                className="w-full py-3 bg-gray-900 text-white rounded-xl font-black text-sm uppercase tracking-widest shadow-lg hover:bg-gray-800 disabled:opacity-50 transition-all flex items-center justify-center space-x-2"
                            >
                                <span>Next: Customer Details</span>
                            </button>
                        </div>
                    ) : (
                        <div className="space-y-3 animate-in slide-in-from-bottom-2 duration-200">
                            <div className="flex items-center justify-between">
                                <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest">Customer Setup</h3>
                                <button onClick={() => setDeliveryMode(false)} className="text-blue-600 text-xs font-bold hover:underline">Back to Cart</button>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-2">
                                <div className="relative">
                                    <input
                                        type="text"
                                        placeholder="Phone..."
                                        value={deliveryInfo.phone}
                                        onChange={(e) => handlePhoneChange(e.target.value)}
                                        className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg outline-none focus:border-blue-500 text-sm font-bold"
                                    />
                                    {customerSuggestions.length > 0 && (
                                        <div className="absolute bottom-full mb-1 z-50 w-full bg-white border border-gray-200 shadow-2xl rounded-xl max-h-32 overflow-y-auto">
                                            {customerSuggestions.map(c => (
                                                <div
                                                    key={c.id}
                                                    onClick={() => {
                                                        setDeliveryInfo({ name: c.name, phone: c.phone, address: c.address || '' });
                                                        setCustomerSuggestions([]);
                                                    }}
                                                    className="p-2 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-0"
                                                >
                                                    <div className="font-black text-gray-900 text-xs">{c.phone}</div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                                <input
                                    type="text"
                                    placeholder="Name..."
                                    value={deliveryInfo.name}
                                    onChange={(e) => setDeliveryInfo({ ...deliveryInfo, name: e.target.value })}
                                    className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-lg outline-none focus:border-blue-500 text-sm font-bold"
                                />
                            </div>
                            
                            <textarea
                                placeholder="Address..."
                                value={deliveryInfo.address}
                                onChange={(e) => setDeliveryInfo({ ...deliveryInfo, address: e.target.value })}
                                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg outline-none focus:border-blue-500 text-sm font-bold h-14 resize-none"
                            />

                            <div className="pt-4 space-y-3">
                                <div className="flex justify-between items-center px-1">
                                    <span className="text-xs font-black text-gray-400 uppercase">Subtotal</span>
                                    <span className="text-xs font-black text-gray-900">PKR {subtotal.toFixed(0)}</span>
                                </div>

                                {configDeliveryFee > 0 && (
                                    <div className="flex items-center justify-between bg-gray-50 p-2 rounded-xl border border-gray-100">
                                        <div className="flex items-center space-x-2">
                                            <Truck size={14} className="text-amber-600" />
                                            <span className="text-xs font-bold text-gray-700">Fee (PKR {configDeliveryFee})</span>
                                        </div>
                                        <button 
                                            onClick={() => setWaiveDeliveryFee(!waiveDeliveryFee)}
                                            className={`px-3 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all ${waiveDeliveryFee ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}
                                        >
                                            {waiveDeliveryFee ? 'Waived' : 'Apply'}
                                        </button>
                                    </div>
                                )}

                                <div className="flex justify-between items-center px-1 pb-1">
                                    <span className="text-sm font-black text-blue-600 uppercase">Total</span>
                                    <span className="text-sm font-black text-blue-600 text-lg">PKR {total.toFixed(0)}</span>
                                </div>
                                {appliedVoucher && (
                                    <div className="text-[10px] text-center font-bold text-blue-600 mb-2 uppercase tracking-tight">
                                        Savings: PKR {discount.toFixed(0)}
                                    </div>
                                )}
                                <button
                                    onClick={handleCheckout}
                                    disabled={isProcessing || !deliveryInfo.name || !deliveryInfo.phone || !deliveryInfo.address}
                                    className="w-full py-4 bg-amber-600 text-white rounded-2xl font-bold text-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
                                >
                                    {isProcessing ? '...' : 'Confirm Delivery Order'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* COLUMN 3: WAR ROOM (Unified Queue & Fleet) */}
            <div className="flex-[1.6] flex flex-col h-full bg-gray-900 text-white min-w-0">
                <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
                    <div className="flex items-center space-x-3">
                        <div className="p-2 bg-blue-500 rounded-lg shadow-lg">
                            <Truck size={20} className="text-white" />
                        </div>
                        <h2 className="font-black tracking-tight uppercase text-base">Dispatch War Room</h2>
                    </div>
                    <div className="flex items-center bg-white/5 border border-white/10 rounded-xl px-3 py-1.5 w-48 focus-within:ring-2 ring-blue-500 transition-all">
                        <Search size={14} className="text-white/30" />
                        <input
                            type="text"
                            placeholder="Find order..."
                            value={queueSearch}
                            onChange={(e) => setQueueSearch(e.target.value)}
                            className="bg-transparent border-none ml-2 w-full outline-none text-sm font-bold text-white placeholder:text-white/20"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-hidden flex flex-col p-4 space-y-4 min-h-0">
                    <div className="flex-1 overflow-y-auto pr-2 space-y-3 custom-scrollbar min-h-0">
                        {filteredOrders.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-white/20 space-y-3">
                                <div className="w-16 h-16 border-2 border-dashed border-white/10 rounded-full flex items-center justify-center">
                                    <Truck size={32} />
                                </div>
                                <p className="font-bold text-sm uppercase tracking-tighter">No live deliveries</p>
                            </div>
                        ) : (
                            filteredOrders.map(order => (
                                <div
                                    key={order.id}
                                    onClick={() => setSelectedOrderId(order.id === selectedOrderId ? null : order.id)}
                                    className={`p-4 rounded-2xl border transition-all cursor-pointer ${selectedOrderId === order.id
                                        ? 'border-blue-500 bg-blue-500/10 shadow-[0_0_20px_rgba(59,130,246,0.2)]'
                                        : 'border-white/5 bg-white/5 hover:bg-white/10'
                                    }`}
                                >
                                    <div className="flex justify-between items-start mb-3">
                                        <div className="flex flex-col">
                                            <span className="font-black text-sm text-white tracking-wide uppercase">{order.id}</span>
                                            <span className="text-xs text-white/40 font-bold">{new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        </div>
                                        <span className={`px-2.5 py-1 rounded text-xs font-black uppercase tracking-wide ${
                                            order.status === 'Pending' ? 'bg-amber-500 text-white' :
                                            order.status === 'Assigned' ? 'bg-blue-500 text-white' :
                                            'bg-green-500 text-white'
                                        }`}>
                                            {order.status}
                                        </span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="flex items-center space-x-2">
                                            <div className="p-1.5 bg-white/5 rounded-lg">
                                                <User size={12} className="text-white/40" />
                                            </div>
                                            <div className="flex flex-col">
                                                <span className="text-sm font-bold text-white/90 leading-none">{order.customerName}</span>
                                                <span className="text-xs font-medium text-white/40">{order.customerPhone}</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center space-x-2">
                                            <div className="p-1.5 bg-white/5 rounded-lg">
                                                <MapPin size={12} className="text-white/40" />
                                            </div>
                                            <span className="text-xs font-bold text-white/60 line-clamp-1">{order.customerAddress}</span>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    {/* Manager Actions - Fixed Height at Bottom */}
                    <div className="h-[180px] bg-white/5 border border-white/10 rounded-2xl p-3 flex flex-col shrink-0">
                        {selectedOrder ? (
                            <div className="h-full flex flex-col">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center space-x-2">
                                        <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                                        <h3 className="text-xs font-black uppercase tracking-widest text-white/40">Control: {selectedOrder.id}</h3>
                                    </div>
                                    <button onClick={() => setSelectedOrderId(null)} className="text-white/20 hover:text-white transition-colors"><X size={16}/></button>
                                </div>

                                <div className="flex-1 overflow-y-auto custom-scrollbar">
                                    {selectedOrder.status === 'Pending' ? (
                                        <div className="space-y-2">
                                            <p className="text-xs font-bold text-white/60">Dispatch Fleet:</p>
                                            <div className="grid grid-cols-2 gap-2">
                                                {riders.map(rider => (
                                                    <button
                                                        key={rider.id}
                                                        onClick={() => assignRider(selectedOrder.id, rider.name)}
                                                        className="flex items-center justify-between px-3 py-2 bg-white/5 border border-white/5 rounded-lg hover:bg-blue-600 hover:border-blue-400 transition-all group"
                                                    >
                                                        <span className="text-xs font-bold uppercase truncate">{rider.name}</span>
                                                        <UserPlus size={14} className="text-white/20 group-hover:text-white shrink-0 ml-1" />
                                                    </button>
                                                ))}
                                                {riders.length === 0 && <p className="col-span-2 text-xs text-white/30 italic text-center py-2">No riders online</p>}
                                            </div>
                                        </div>
                                    ) : selectedOrder.status === 'Assigned' ? (
                                        <div className="h-full flex flex-col items-center justify-center space-y-3">
                                            <div className="text-center">
                                                <p className="text-xs font-black uppercase tracking-widest text-white/40 mb-1">Assigned To</p>
                                                <p className="text-sm font-bold text-blue-400 mb-2">{selectedOrder.rider}</p>
                                            </div>
                                            <button
                                                onClick={() => markDelivered(selectedOrder.id)}
                                                className="w-full py-2.5 bg-green-500 text-white rounded-lg font-black text-sm uppercase tracking-widest shadow-lg hover:bg-green-600 transition-all flex items-center justify-center space-x-2"
                                            >
                                                <CheckCircle2 size={14} />
                                                <span>Complete Dropoff</span>
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="h-full flex flex-col items-center justify-center text-green-500 space-y-1">
                                            <CheckCircle2 size={24} />
                                            <p className="text-sm font-black uppercase tracking-widest">Delivered</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="h-full flex flex-col items-center justify-center text-white/20 space-y-2">
                                <Truck size={24} />
                                <p className="text-sm font-bold uppercase tracking-widest">Select Order</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Variant Modal */}
            {selectedProductForVariant && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
                    <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-sm p-8 relative overflow-hidden">
                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-purple-500" />
                        <button onClick={() => setSelectedProductForVariant(null)} className="absolute top-6 right-6 p-2 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-full transition-all outline-none"><X size={20}/></button>
                        <div className="text-center mb-8">
                            <div className="text-6xl mb-6 p-6 bg-gray-50 rounded-3xl w-32 h-32 mx-auto flex items-center justify-center overflow-hidden shadow-inner">
                                {selectedProductForVariant.image ? (
                                    <img src={selectedProductForVariant.image} className="w-full h-full object-cover" />
                                ) : (
                                    selectedProductForVariant.img
                                )}
                            </div>
                            <h2 className="text-2xl font-black text-gray-900 leading-tight mb-2 tracking-tight">{selectedProductForVariant.name}</h2>
                            <p className="text-[10px] font-black text-gray-400 uppercase tracking-[0.2em]">Select Configuration</p>
                        </div>
                        <div className="space-y-3">
                            {selectedProductForVariant.variants?.map((v) => (
                                <button
                                    key={v.id}
                                    onClick={() => addToCartAction(selectedProductForVariant, v)}
                                    className="w-full flex justify-between items-center p-5 bg-white border border-gray-100 hover:border-blue-500 hover:bg-blue-50/50 rounded-2xl transition-all group active:scale-[0.98] outline-none"
                                >
                                    <span className="font-extrabold text-gray-800 text-xl tracking-tight">{v.name}</span>
                                    <span className="font-black text-blue-600 px-3 py-1 bg-blue-50 rounded-lg group-hover:bg-blue-100 transition-colors uppercase text-sm">PKR {v.price}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Deal Details Modal */}
            {selectedDealForDetails && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
                    <div className="bg-white rounded-[2rem] shadow-2xl w-full max-w-sm p-8 relative overflow-hidden">
                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 to-purple-500" />
                        <button onClick={() => setSelectedDealForDetails(null)} className="absolute top-6 right-6 p-2 text-gray-400 hover:text-gray-900 hover:bg-gray-100 rounded-full transition-all outline-none"><X size={20}/></button>
                        <div className="text-center mb-6">
                            <h2 className="text-2xl font-black text-gray-900 leading-tight mb-2 tracking-tight pr-4">{selectedDealForDetails.name}</h2>
                            <p className="text-[10px] font-black text-purple-600 uppercase tracking-[0.2em]">Deal Contents</p>
                        </div>
                        <div className="space-y-2 mb-6">
                            {selectedDealForDetails.dealItems?.map((item, idx) => (
                                <div key={idx} className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl border border-gray-100">
                                    <span className="font-extrabold text-gray-800 text-sm tracking-tight">{item.name}</span>
                                    <span className="font-black text-gray-500 bg-white px-2 py-1 rounded-lg text-sm shadow-sm">x{item.quantity}</span>
                                </div>
                            ))}
                        </div>
                        <button
                            onClick={() => { setSelectedDealForDetails(null); handleProductClick(selectedDealForDetails); }}
                            className="w-full py-4 bg-blue-600 text-white rounded-2xl font-black text-sm uppercase tracking-widest hover:bg-blue-700 transition-all shadow-md active:scale-[0.98]"
                        >
                            Add to Order
                        </button>
                    </div>
                </div>
            )}

            <style>{`
                .scrollbar-hide::-webkit-scrollbar { display: none; }
                .scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }
                .custom-scrollbar::-webkit-scrollbar { width: 4px; }
                .custom-scrollbar::-webkit-scrollbar-track { background: rgba(255,255,255,0.02); }
                .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); borderRadius: 10px; }
                .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
            `}</style>

            {/* Receipt Preview Modal */}
            {receiptData && (
                <ReceiptPreview
                    data={receiptData}
                    onPrint={handlePrintReceipt}
                    onClose={handleSkipPrint}
                />
            )}
        </div>
    );
}
