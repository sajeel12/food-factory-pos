import { useState, useEffect } from 'react';
import { Search, ShoppingBag, Plus, Minus, Trash2, Printer, CreditCard, X, Truck, Ticket, Clock, CheckCircle2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import ReceiptPreview from '../components/ReceiptPreview';

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
    dealItems?: { productId: string; name: string; quantity: number, variantId?: string | null }[];
}

export default function POS() {
    const { user } = useAuth();
    const isDeliveryRole = user?.posRole === 'POS_DELIVERY';

    const [activeCategory, setActiveCategory] = useState('All');
    const [search, setSearch] = useState('');
    const [cart, setCart] = useState<{ uniqueId: string; id: string; name: string; price: number; qty: number; variantId?: string; variantName?: string; dealChoices?: any[] }[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedProductForVariant, setSelectedProductForVariant] = useState<Product | null>(null);
    const [selectedDealForChoices, setSelectedDealForChoices] = useState<Product | null>(null);
    const [selectedDealForDetails, setSelectedDealForDetails] = useState<Product | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [configDeliveryFee, setConfigDeliveryFee] = useState<number>(0);
    const [waiveDeliveryFee, setWaiveDeliveryFee] = useState(false);
    const [couponCode, setCouponCode] = useState('');
    const [appliedVoucher, setAppliedVoucher] = useState<any>(null);
    const [discountError, setDiscountError] = useState<string | null>(null);

    const [checkoutMode, setCheckoutMode] = useState<'Cash' | 'Card' | 'Delivery' | null>(null);
    const [tendered, setTendered] = useState<string>('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [receiptData, setReceiptData] = useState<any>(null);

    const [deliveryInfo, setDeliveryInfo] = useState({ name: '', phone: '', address: '' });
    const [customerSuggestions, setCustomerSuggestions] = useState<{ id: string; name: string; phone: string; address: string | null; loyaltyPoints: number }[]>([]);

    const [orderType, setOrderType] = useState<'DINE_IN' | 'TAKE_AWAY'>('TAKE_AWAY');
    const [tableNo, setTableNo] = useState('');
    const [pendingOrders, setPendingOrders] = useState<any[]>([]);
    const [activePendingOrderId, setActivePendingOrderId] = useState<string | null>(null);
    const [queueSearch, setQueueSearch] = useState('');
    const [deliveryModalOrder, setDeliveryModalOrder] = useState<any | null>(null);
    const [riders, setRiders] = useState<{ id: string; name: string }[]>([]);

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

    const selectCustomer = (c: { id: string; name: string; phone: string; address: string | null; loyaltyPoints: number }) => {
        setDeliveryInfo({ name: c.name, phone: c.phone, address: c.address || '' });
        setCustomerSuggestions([]);
    };

    useEffect(() => {
        const loadProducts = async () => {
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
                    console.error('Failed to load products from IPC', err);
                }
            }
        };
        loadProducts();

        const loadSettings = async () => {
            if (ipcRenderer) {
                try {
                    const settings = await ipcRenderer.invoke('get-settings');
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const fee = settings.find((s: any) => s.key === 'DELIVERY_FEE');
                    if (fee) setConfigDeliveryFee(Number(fee.value) || 0);
                } catch (e) {
                    console.error('Failed to load settings', e);
                }
            }
        };
        loadSettings();

        const fetchPending = async () => {
            if (ipcRenderer) {
                const pending = await ipcRenderer.invoke('get-pending-orders');
                setPendingOrders(pending);
            }
        };
        const fetchRiders = async () => {
            if (ipcRenderer) {
                try {
                    const r = await ipcRenderer.invoke('get-riders');
                    setRiders(r || []);
                } catch (e) {
                    console.error('Failed to load riders', e);
                }
            }
        };
        fetchPending();
        fetchRiders();
        const pendingInterval = setInterval(fetchPending, 10000);

        const handleSync = () => {
            loadProducts();
            loadSettings();
            fetchPending();
            fetchRiders();
        };
        if (ipcRenderer) {
            ipcRenderer.on('sync-completed', handleSync);
        }
        window.addEventListener('sync-completed', handleSync);
        return () => {
            if (ipcRenderer) {
                ipcRenderer.removeListener('sync-completed', handleSync);
            }
            window.removeEventListener('sync-completed', handleSync);
            clearInterval(pendingInterval);
        };
    }, [user?.branchId]);

    const filteredProducts = products.filter(p =>
        (activeCategory === 'All' || p.category === activeCategory) &&
        p.name.toLowerCase().includes(search.toLowerCase())
    );

    const handleProductClick = (product: Product) => {
        if (product.isDeal) {
            // Check if any deal items require choices (has variants but no fixed variantId)
            const itemsRequiringChoice = product.dealItems?.filter(di => {
                const subP = products.find(p => p.id === di.productId);
                return subP && subP.variants && subP.variants.length > 0 && !di.variantId;
            }) || [];

            if (itemsRequiringChoice.length > 0) {
                setSelectedDealForChoices(product);
            } else {
                addToCartAction(product);
            }
        } else if (product.variants && product.variants.length > 0) {
            setSelectedProductForVariant(product);
        } else {
            addToCartAction(product);
        }
    };

    const handleDealChoicesComplete = (product: Product, choices: any[]) => {
        const allDealChoices = product.dealItems?.map(di => {
             const choice = choices.find(c => c.productId === di.productId);
             if (choice) return { productName: choice.productName, variantName: choice.variantName, quantity: di.quantity };
             const subP = products.find(p => p.id === di.productId);
             const subVariant = subP?.variants?.find(v => v.id === di.variantId);
             return { productName: subP?.name || di.name, variantName: subVariant?.name || '', quantity: di.quantity };
        }) || [];

        setCart(prev => {
            const uniqueId = `${product.id}-${Date.now()}`; // Deals with choices always unique
            return [...prev, {
                uniqueId,
                id: product.id,
                name: product.name,
                price: product.price,
                qty: 1,
                dealChoices: allDealChoices
            }];
        });
        setSelectedDealForChoices(null);
    };

    const addToCartAction = (product: Product, variant?: { id: string; name: string; price: number }) => {
        let finalDealChoices = undefined;
        if (product.isDeal && product.dealItems) {
             finalDealChoices = product.dealItems.map(di => {
                 const subP = products.find(p => p.id === di.productId);
                 const subVariant = subP?.variants?.find(v => v.id === di.variantId);
                 return { productName: subP?.name || di.name, variantName: subVariant?.name || '', quantity: di.quantity };
             });
        }
        
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
                variantName: variant?.name,
                dealChoices: finalDealChoices
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
            const res = await ipcRenderer.invoke('validate-voucher', { code: couponCode.toUpperCase(), branchId: user?.branchId });
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

    const subtotal = cart.reduce((sum, item) => sum + (Number(item.price) * Number(item.qty)), 0);
    const deliveryFee = (checkoutMode === 'Delivery' && !waiveDeliveryFee) ? configDeliveryFee : 0;
    
    let discount = 0;
    if (appliedVoucher) {
        if (appliedVoucher.type === 'PERCENTAGE') {
            discount = subtotal * (appliedVoucher.value / 100);
        } else {
            discount = Math.min(subtotal, appliedVoucher.value);
        }
    }

    const tax = 0; 
    const total = Math.max(0, subtotal + tax + deliveryFee - discount);

    const handleCheckout = async (paymentMethod: 'Cash' | 'Card' | 'Delivery') => {
        if (cart.length === 0 || isProcessing) return;

        setIsProcessing(true);
        if (ipcRenderer) {
            try {
                const generateShortId = () => {
                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                    let id = '';
                    for (let i = 0; i < 6; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
                    return id;
                };
                const orderId = activePendingOrderId || generateShortId();
                const payload = {
                    id: orderId,
                    total: total,
                    paymentMethod: paymentMethod === 'Delivery' ? 'CASH' : paymentMethod.toUpperCase(),
                    tenderedAmount: paymentMethod === 'Cash' ? Number(tendered) || total : total,
                    status: paymentMethod === 'Delivery' ? 'Pending' : 'Completed',
                    customerName: deliveryInfo.name || null,
                    customerPhone: deliveryInfo.phone || null,
                    customerAddress: paymentMethod === 'Delivery' ? deliveryInfo.address : null,
                    deliveryFee: deliveryFee,
                    voucherId: appliedVoucher?.id || null,
                    discount: discount,
                    branchId: user?.branchId || null,
                    branchAddress: user?.branchAddress || null,
                    cashierName: user?.username || 'Cashier',
                    createdAt: new Date().toISOString(),
                    items: cart.map(item => ({
                        id: 'ITM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                        orderId: orderId,
                        productId: item.id,
                        variantId: item.variantId || null,
                        variantName: item.variantName || null,
                        name: item.name,
                        quantity: item.qty,
                        subtotal: item.price * item.qty,
                        dealChoices: item.dealChoices ? JSON.stringify(item.dealChoices) : null
                    })),
                    orderType: orderType,
                    tableNo: orderType === 'DINE_IN' ? tableNo : null
                };

                const orderResult = await ipcRenderer.invoke('create-order', payload);
                if (orderResult.dailyOrderNumber) {
                    (payload as any).dailyOrderNumber = orderResult.dailyOrderNumber;
                }
                // Kitchen ticket prints immediately — no preview needed
                await ipcRenderer.invoke('print-kitchen', payload);

                // Show receipt preview instead of auto-printing
                setReceiptData(payload);
                setCheckoutMode(null);
                setTendered('');
                setDeliveryInfo({ name: '', phone: '', address: '' });
                setTableNo('');
                setCart([]);
                setAppliedVoucher(null);
                setActivePendingOrderId(null);
                window.dispatchEvent(new Event('sync-completed'));
            } catch (err) {
                console.error('Checkout failed', err);
                alert('Order Failed processing.');
            }
        }
        setIsProcessing(false);
    };

    const handleHoldOrder = async () => {
        if (cart.length === 0 || isProcessing) return;
        if (orderType === 'DINE_IN' && !tableNo) {
            alert("Please enter a Table Number for Dine-In");
            return;
        }

        setIsProcessing(true);
        if (ipcRenderer) {
            try {
                const generateShortId = () => {
                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                    let id = '';
                    for (let i = 0; i < 6; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
                    return id;
                };
                const orderId = activePendingOrderId || generateShortId();
                const payload = {
                    id: orderId,
                    total: total,
                    paymentMethod: 'CASH',
                    tenderedAmount: total,
                    status: 'Pending',
                    customerName: deliveryInfo.name || null,
                    customerPhone: deliveryInfo.phone || null,
                    orderType: orderType,
                    tableNo: orderType === 'DINE_IN' ? tableNo : null,
                    branchId: user?.branchId || null,
                    cashierName: user?.username || 'Cashier',
                    createdAt: new Date().toISOString(),
                    items: cart.map(item => ({
                        id: 'ITM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                        orderId: orderId,
                        productId: item.id,
                        variantId: item.variantId || null,
                        variantName: item.variantName || null,
                        name: item.name,
                        quantity: item.qty,
                        subtotal: item.price * item.qty,
                        dealChoices: item.dealChoices ? JSON.stringify(item.dealChoices) : null
                    }))
                };

                const orderResult = await ipcRenderer.invoke('create-order', payload);
                if (orderResult.dailyOrderNumber) {
                    (payload as any).dailyOrderNumber = orderResult.dailyOrderNumber;
                }
                await ipcRenderer.invoke('print-kitchen', payload);

                setCart([]);
                setTableNo('');
                setDeliveryInfo({ name: '', phone: '', address: '' });
                setAppliedVoucher(null);
                setActivePendingOrderId(null);
                window.dispatchEvent(new Event('sync-completed'));
            } catch (err) {
                console.error('Hold Order failed', err);
                alert('Failed to hold order.');
            }
        }
        setIsProcessing(false);
    };

    const handlePendingOrderClick = (order: any) => {
        if (order.customerAddress) {
            setDeliveryModalOrder(order);
            return;
        }
        resumeOrder(order);
    };

    const assignRider = async (orderId: string, riderName: string) => {
        if (!ipcRenderer) return;
        try {
            await ipcRenderer.invoke('update-order-status', { id: orderId, status: 'Assigned', rider: riderName });
            setDeliveryModalOrder(null);
            window.dispatchEvent(new Event('sync-completed'));
        } catch (e) {
            console.error('Failed to assign rider', e);
            alert('Failed to assign rider');
        }
    };

    const markDeliveryComplete = async (orderId: string) => {
        if (!ipcRenderer) return;
        try {
            await ipcRenderer.invoke('update-order-status', { id: orderId, status: 'Completed' });
            setDeliveryModalOrder(null);
            window.dispatchEvent(new Event('sync-completed'));
        } catch (e) {
            console.error('Failed to mark delivered', e);
            alert('Failed to mark delivered');
        }
    };

    const resumeOrder = async (order: any) => {
        if (activePendingOrderId === order.id) {
            // Unselect if already selected
            setActivePendingOrderId(null);
            setCart([]);
            setTableNo('');
            setDeliveryInfo({ name: '', phone: '', address: '' });
            return;
        }

        if (cart.length > 0) {
            if (!confirm("Discard current cart and resume this order?")) return;
        }

        try {
            const items = await ipcRenderer.invoke('get-order-items', order.id);
            const mappedCart = items.map((item: any) => ({
                uniqueId: item.variantId ? `${item.productId}-${item.variantId}` : item.productId,
                id: item.productId,
                name: item.name,
                price: item.subtotal / item.quantity,
                qty: item.quantity,
                variantId: item.variantId,
                variantName: item.variantName,
                dealChoices: item.dealChoices ? JSON.parse(item.dealChoices) : undefined
            }));

            setCart(mappedCart);
            setOrderType(order.orderType || 'TAKE_AWAY');
            setTableNo(order.tableNo || '');
            setDeliveryInfo({ name: order.customerName || '', phone: order.customerPhone || '', address: order.customerAddress || '' });
            setActivePendingOrderId(order.id);
        } catch (e) {
            console.error("Failed to resume order", e);
        }
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

    return (
        <div className="flex w-full h-full bg-gray-50 overflow-hidden">

            {/* COLUMN 2: MENU GRID */}
            <div className="flex-1 flex flex-col p-6 overflow-hidden min-w-0">
                <div className="flex justify-between items-center mb-6">
                    <div className="flex space-x-2 overflow-x-auto pb-2 scrollbar-hide">
                        {['All', ...categories.map(c => c.name), 'Uncategorized'].map(c => (
                            <button
                                key={c}
                                onClick={() => setActiveCategory(c)}
                                className={`px-5 py-2.5 rounded-2xl whitespace-nowrap font-semibold text-sm ${activeCategory === c
                                    ? 'bg-gray-900 text-white shadow-lg'
                                    : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-100'
                                    }`}
                            >
                                {c}
                            </button>
                        ))}
                    </div>

                    <div className="flex items-center bg-white border border-gray-200 rounded-xl px-4 py-2 w-72 focus-within:ring-2 focus-within:ring-blue-500 shadow-sm">
                        <Search size={20} className="text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search main menu..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="bg-transparent border-none ml-2 w-full outline-none text-sm text-gray-800"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto pr-2 pb-24">
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-4">
                        {filteredProducts.map(product => (
                            <div
                                key={product.id}
                                onClick={() => handleProductClick(product)}
                                className="bg-white p-4 rounded-3xl border border-gray-100 shadow-sm hover:border-blue-300 hover:shadow-xl cursor-pointer flex flex-col items-center text-center group transition-all relative"
                            >
                                {product.isDeal && (
                                    <div className="absolute top-2 right-2 bg-purple-600 text-white text-[10px] uppercase font-black px-2 py-1 rounded-md shadow-sm z-10">
                                        DEAL
                                    </div>
                                )}
                                <div className="text-5xl mb-3 p-4 bg-gray-50 rounded-2xl group-hover:bg-blue-50 w-full aspect-square flex items-center justify-center overflow-hidden">
                                    {product.image ? (
                                        <img src={product.image} className="w-full h-full object-cover" />
                                    ) : (
                                        product.img
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

            <div className="w-[400px] h-full bg-white border-l border-gray-200 flex flex-col shadow-2xl relative z-10 shrink-0">
                <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-white">
                    <div className="flex items-center space-x-3">
                        <div className="p-2.5 bg-blue-100 text-blue-600 rounded-xl shadow-inner">
                            <ShoppingBag size={20} />
                        </div>
                        <h2 className="text-lg font-bold text-gray-900 tracking-tight">Current Order</h2>
                    </div>
                    <button
                        onClick={() => setCart([])}
                        className="text-gray-400 hover:text-red-500 hover:bg-red-50 p-2 rounded-xl"
                        disabled={cart.length === 0 || isProcessing}
                    >
                        <Trash2 size={16} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/50">
                    {cart.map(item => (
                        <div key={item.uniqueId} className="bg-white p-3 rounded-2xl border border-gray-100 shadow-sm flex flex-col transition-all">
                            <div className="flex justify-between items-start mb-3">
                                <span className="font-bold text-gray-800 text-sm w-3/4 leading-snug">
                                    {item.name}
                                    {item.variantName && (
                                        <div className="text-xs text-purple-600 bg-purple-50 inline-block px-2 py-0.5 rounded-md mt-1 font-semibold ml-2">
                                            {item.variantName}
                                        </div>
                                    )}
                                    {item.dealChoices && (item.dealChoices as any[]).map((choice, cidx) => (
                                        <div key={cidx} className="text-[10px] text-blue-600 font-bold bg-blue-50 px-2 py-0.5 rounded-md mt-1 ml-4 border border-blue-100 flex items-center">
                                            <span className="opacity-50 mr-1">↪</span> {choice.productName}: {choice.variantName}
                                        </div>
                                    ))}
                                </span>
                                <div className="flex items-center space-x-2">
                                    <span className="font-bold text-gray-900 text-sm">PKR {Math.round(item.price * item.qty)}</span>
                                    <button onClick={() => removeItem(item.uniqueId)} className="p-1 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"><X size={14} /></button>
                                </div>
                            </div>
                            <div className="flex justify-between items-center text-xs">
                                <p className="text-gray-400 font-semibold">PKR {item.price} x {item.qty}</p>
                                <div className="flex items-center space-x-3 bg-gray-100 rounded-xl p-1">
                                    <button onClick={() => updateQty(item.uniqueId, -1)} className="p-1 hover:bg-white rounded-lg"><Minus size={14} /></button>
                                    <span className="font-bold w-4 text-center">{item.qty}</span>
                                    <button onClick={() => updateQty(item.uniqueId, 1)} className="p-1 hover:bg-white rounded-lg"><Plus size={14} /></button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Coupon Area */}
                <div className="p-4 bg-gray-50 border-t border-gray-100">
                    {appliedVoucher ? (
                        <div className="flex items-center justify-between bg-blue-50 p-3 rounded-2xl border border-blue-100">
                            <div className="flex items-center space-x-2">
                                <Ticket size={18} className="text-blue-600" />
                                <div>
                                    <p className="text-xs font-black text-blue-900 uppercase tracking-widest">{appliedVoucher.code}</p>
                                    <p className="text-[10px] text-blue-600 font-bold">
                                        -{appliedVoucher.type === 'PERCENTAGE' ? `${appliedVoucher.value}%` : `PKR ${appliedVoucher.value}`} Applied
                                    </p>
                                </div>
                            </div>
                            <button 
                                onClick={removeVoucher}
                                className="p-1.5 hover:bg-blue-200 text-blue-600 rounded-full transition-colors"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    ) : (
                        <div className="flex space-x-2">
                            <div className="relative flex-1">
                                <Ticket size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                                <input
                                    type="text"
                                    placeholder="COUPON CODE"
                                    value={couponCode}
                                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                                    onKeyDown={(e) => e.key === 'Enter' && handleApplyCoupon()}
                                    className="w-full pl-9 pr-3 py-2 bg-white border border-gray-200 rounded-xl text-xs font-bold uppercase tracking-widest outline-none focus:border-blue-500 transition-colors"
                                />
                            </div>
                            <button 
                                onClick={handleApplyCoupon}
                                disabled={!couponCode}
                                className="px-4 py-2 bg-gray-900 text-white rounded-xl text-xs font-bold hover:bg-blue-600 transition-colors disabled:opacity-30 disabled:hover:bg-gray-900"
                            >
                                APPLY
                            </button>
                        </div>
                    )}
                    {discountError && <p className="text-[10px] text-red-500 mt-1 ml-1 font-bold italic">{discountError}</p>}
                </div>

                {/* Totals & Order Type Toggle */}
                <div className="bg-white border-t border-gray-200 p-5 rounded-t-3xl shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.1)] relative z-20">
                    {/* Order Type Selection */}
                    {!checkoutMode && (
                        <div className="mb-4">
                            <div className="grid grid-cols-2 gap-2 bg-gray-100 p-1 rounded-2xl mb-3">
                                <button
                                    onClick={() => setOrderType('TAKE_AWAY')}
                                    className={`py-2 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] transition-all ${orderType === 'TAKE_AWAY' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                                >
                                    Take Away
                                </button>
                                <button
                                    onClick={() => setOrderType('DINE_IN')}
                                    className={`py-2 rounded-xl text-[10px] font-black uppercase tracking-[0.2em] transition-all ${orderType === 'DINE_IN' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}
                                >
                                    Dine In
                                </button>
                            </div>

                            {/* Contextual Inputs */}
                            {orderType === 'DINE_IN' ? (
                                <div className="animate-in slide-in-from-bottom-2 duration-200 space-y-2">
                                    <div className="relative">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-black text-gray-400 tracking-tighter">TABLE</span>
                                        <input
                                            type="text"
                                            placeholder="00"
                                            value={tableNo}
                                            onChange={(e) => setTableNo(e.target.value)}
                                            className="w-full pl-14 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-blue-500 font-black text-xl text-blue-600"
                                        />
                                    </div>
                                    <input
                                        type="text"
                                        placeholder="Customer Name (Optional)"
                                        value={deliveryInfo.name}
                                        onChange={(e) => setDeliveryInfo({ ...deliveryInfo, name: e.target.value })}
                                        className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-blue-500 text-xs font-bold"
                                    />
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 gap-2 animate-in slide-in-from-bottom-2 duration-200">
                                    <input
                                        type="text"
                                        placeholder="Customer Name (Optional)"
                                        value={deliveryInfo.name}
                                        onChange={(e) => setDeliveryInfo({ ...deliveryInfo, name: e.target.value })}
                                        className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-blue-500 text-xs font-bold"
                                    />
                                    <div className="relative">
                                        <input
                                            type="text"
                                            placeholder="Phone (Optional)"
                                            value={deliveryInfo.phone}
                                            onChange={(e) => handlePhoneChange(e.target.value)}
                                            className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-blue-500 text-xs font-bold"
                                        />
                                        {customerSuggestions.length > 0 && (
                                            <div className="absolute bottom-full mb-1 z-50 w-full bg-white border border-gray-200 shadow-2xl rounded-xl max-h-48 overflow-y-auto">
                                                {customerSuggestions.map(c => (
                                                    <div
                                                        key={c.id}
                                                        onClick={() => {
                                                            setDeliveryInfo({ name: c.name, phone: c.phone, address: c.address || '' });
                                                            setCustomerSuggestions([]);
                                                        }}
                                                        className="p-2 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-0"
                                                    >
                                                        <div className="font-bold text-gray-900 text-xs">{c.phone}</div>
                                                        <div className="text-[10px] text-gray-500">{c.name}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {appliedVoucher && (
                        <div className="space-y-1 mb-2 border-b border-gray-100 pb-2">
                            <div className="flex justify-between items-center text-xs font-black text-gray-400 uppercase tracking-wider">
                                <span>Subtotal</span>
                                <span>PKR {subtotal.toFixed(0)}</span>
                            </div>
                            <div className="flex justify-between items-center text-xs font-black text-blue-600 uppercase tracking-wider">
                                <span>Discount</span>
                                <span>-PKR {discount.toFixed(0)}</span>
                            </div>
                        </div>
                    )}
                    {checkoutMode === 'Delivery' && configDeliveryFee > 0 && (
                        <div className="space-y-1 mb-4 border-b border-gray-100 pb-2">
                            <div className="flex justify-between items-center text-xs font-black text-gray-400 uppercase tracking-wider">
                                <span>Subtotal</span>
                                <span>PKR {subtotal.toFixed(0)}</span>
                            </div>
                            <div className="flex justify-between items-center text-xs font-black text-amber-600 uppercase tracking-wider">
                                <span>Delivery Fee</span>
                                <span>{waiveDeliveryFee ? 'WAIVED' : `PKR ${configDeliveryFee}`}</span>
                            </div>
                        </div>
                    )}
                    <div className="flex justify-between items-center mb-6">
                        <span className="text-xl font-black text-gray-900">Total</span>
                        <span className="text-3xl font-black text-blue-600">PKR {total.toFixed(0)}</span>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                        {!isDeliveryRole && (
                            <>
                                <button
                                    onClick={() => setCheckoutMode('Cash')}
                                    disabled={cart.length === 0 || isProcessing}
                                    className="flex flex-col items-center justify-center py-4 rounded-2xl font-bold bg-green-50 text-green-700 hover:bg-green-100 transition-colors"
                                >
                                    <Printer size={20} className="mb-1" />
                                    <span className="text-xs font-black tracking-tighter">CASH</span>
                                </button>
                                <button
                                    onClick={handleHoldOrder}
                                    disabled={cart.length === 0 || isProcessing}
                                    className="flex flex-col items-center justify-center py-4 rounded-2xl font-bold bg-amber-50 text-amber-700 hover:bg-amber-100 transition-colors"
                                >
                                    <Clock size={20} className="mb-1" />
                                    <span className="text-xs font-black tracking-tighter">HOLD</span>
                                </button>
                            </>
                        )}
                        <button
                            onClick={() => setCheckoutMode(isDeliveryRole ? 'Delivery' : 'Card')}
                            disabled={cart.length === 0 || isProcessing}
                            className={`flex flex-col items-center justify-center py-4 rounded-2xl font-bold transition-colors ${isDeliveryRole ? 'col-span-3 bg-gray-900 text-white hover:bg-black shadow-md' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}
                        >
                            {isDeliveryRole ? <Truck size={20} className="mb-1" /> : <CreditCard size={20} className="mb-1" />}
                            <span className="text-xs font-black tracking-tighter">{isDeliveryRole ? 'CHECKOUT' : 'CARD'}</span>
                        </button>
                    </div>
                    
                    {!isDeliveryRole && (
                        <button
                            onClick={() => setCheckoutMode('Delivery')}
                            disabled={cart.length === 0 || isProcessing}
                            className="w-full py-2.5 text-blue-600 text-[10px] font-black uppercase tracking-[0.2em] hover:bg-blue-50 rounded-xl transition-all"
                        >
                            Switch to Delivery Mode
                        </button>
                    )}
                </div>
            </div>

            {/* Cash Modal */}
            {checkoutMode === 'Cash' && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-8">
                        <div className="flex justify-between items-center mb-8">
                            <h2 className="text-2xl font-bold">Cash Checkout</h2>
                            <button onClick={() => setCheckoutMode(null)} className="p-2 hover:bg-gray-100 rounded-full"><X /></button>
                        </div>
                        <div className="space-y-6">
                            <div className="text-center">
                                <p className="text-gray-500 font-semibold mb-1">Total Due</p>
                                <p className="text-4xl font-black">PKR {total.toFixed(0)}</p>
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-gray-700 mb-2">Tendered</label>
                                <input
                                    type="number" autoFocus value={tendered}
                                    onChange={(e) => setTendered(e.target.value)}
                                    className="w-full p-4 text-2xl font-bold bg-gray-50 border-2 border-gray-200 rounded-2xl outline-none focus:border-blue-500"
                                />
                            </div>
                            <div className="flex justify-between text-lg font-bold">
                                <span>Change Due:</span>
                                <span className="text-green-600">PKR {Math.max(0, Number(tendered) - total).toFixed(0)}</span>
                            </div>
                            <button
                                onClick={() => handleCheckout('Cash')}
                                disabled={Number(tendered) < total || isProcessing}
                                className="w-full py-4 bg-green-600 text-white rounded-2xl font-bold text-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                            >
                                {isProcessing ? 'Processing...' : 'Complete Order'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Card Checkout Confirmation */}
            {checkoutMode === 'Card' && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-8 text-center">
                        <CreditCard size={48} className="mx-auto text-blue-600 mb-4" />
                        <h2 className="text-2xl font-bold mb-2">Card Payment</h2>
                        <p className="text-4xl font-black text-gray-900 mb-8">PKR {total.toFixed(0)}</p>
                        <button
                            onClick={() => handleCheckout('Card')}
                            disabled={isProcessing}
                            className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                        >
                            {isProcessing ? 'Processing...' : 'Confirm Card Payment'}
                        </button>
                        <button onClick={() => setCheckoutMode(null)} className="mt-4 text-gray-500 font-semibold">Cancel</button>
                    </div>
                </div>
            )}

            {/* Delivery Modal */}
            {checkoutMode === 'Delivery' && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-8">
                        <div className="flex justify-between items-center mb-6">
                            <h2 className="text-2xl font-bold flex items-center"><Truck className="mr-2" /> Delivery Details</h2>
                            <button onClick={() => setCheckoutMode(null)} className="p-2 hover:bg-gray-100 rounded-full"><X /></button>
                        </div>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-bold text-gray-700 mb-1">Customer Name</label>
                                <input
                                    type="text" value={deliveryInfo.name}
                                    onChange={(e) => setDeliveryInfo({ ...deliveryInfo, name: e.target.value })}
                                    className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-blue-500"
                                />
                            </div>
                            <div className="relative">
                                <label className="block text-sm font-bold text-gray-700 mb-1">Phone Number</label>
                                <input
                                    type="text" value={deliveryInfo.phone}
                                    onChange={(e) => handlePhoneChange(e.target.value)}
                                    className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-blue-500"
                                    placeholder="Enter to search customers..."
                                />
                                {customerSuggestions.length > 0 && (
                                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 shadow-xl rounded-xl max-h-48 overflow-y-auto">
                                        {customerSuggestions.map(c => (
                                            <div
                                                key={c.id}
                                                onClick={() => selectCustomer(c)}
                                                className="p-3 hover:bg-blue-50 cursor-pointer border-b border-gray-100 last:border-0"
                                            >
                                                <div className="font-bold text-gray-900">{c.phone}</div>
                                                <div className="text-xs text-gray-500 flex justify-between">
                                                    <span>{c.name}</span>
                                                    {c.loyaltyPoints > 0 && <span className="text-blue-600 font-semibold">{c.loyaltyPoints} pts</span>}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div>
                                <label className="block text-sm font-bold text-gray-700 mb-1">Delivery Address</label>
                                <textarea
                                    value={deliveryInfo.address}
                                    onChange={(e) => setDeliveryInfo({ ...deliveryInfo, address: e.target.value })}
                                    className="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl outline-none focus:border-blue-500 h-24 resize-none"
                                />
                            </div>
                             <div className="pt-4 space-y-3">
                                <p className="text-center font-bold text-gray-500 tracking-wide uppercase text-xs">Total: PKR {total.toFixed(0)}</p>
                                
                                {configDeliveryFee > 0 && (
                                    <div className="flex items-center justify-between bg-gray-50 p-3 rounded-xl border border-gray-100">
                                        <div className="flex items-center space-x-2">
                                            <Truck size={16} className="text-amber-600" />
                                            <span className="text-sm font-bold text-gray-700">Delivery Fee (PKR {configDeliveryFee})</span>
                                        </div>
                                        <button 
                                            onClick={() => setWaiveDeliveryFee(!waiveDeliveryFee)}
                                            className={`px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all ${waiveDeliveryFee ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}
                                        >
                                            {waiveDeliveryFee ? 'Waived' : 'Apply'}
                                        </button>
                                    </div>
                                )}

                                <button
                                    onClick={() => handleCheckout('Delivery')}
                                    disabled={!deliveryInfo.name || !deliveryInfo.phone || !deliveryInfo.address || isProcessing}
                                    className="w-full py-4 bg-amber-600 text-white rounded-2xl font-bold text-lg hover:bg-amber-700 transition-colors disabled:opacity-50"
                                >
                                    Confirm Delivery Order
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Variant Selection Modal */}
            {selectedProductForVariant && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 relative">
                        <button onClick={() => setSelectedProductForVariant(null)} className="absolute top-4 right-4 p-2 bg-transparent text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition-colors outline-none"><X size={20}/></button>
                        <div className="text-center mb-6">
                            <div className="text-5xl mb-4 p-4 bg-gray-50 rounded-2xl w-32 h-32 mx-auto flex items-center justify-center overflow-hidden">
                                {selectedProductForVariant.image ? (
                                    <img src={selectedProductForVariant.image} className="w-full h-full object-cover" />
                                ) : (
                                    selectedProductForVariant.img
                                )}
                            </div>
                            <h2 className="text-2xl font-black text-gray-900 leading-tight">{selectedProductForVariant.name}</h2>
                            <p className="text-sm font-semibold text-gray-500 mt-1 uppercase tracking-wide">Select Variant</p>
                        </div>
                        <div className="space-y-3">
                            {selectedProductForVariant.variants?.map((v) => (
                                <button
                                    key={v.id}
                                    onClick={() => addToCartAction(selectedProductForVariant, v)}
                                    className="w-full flex justify-between items-center p-4 bg-white border border-gray-200 hover:border-blue-500 hover:bg-blue-50 rounded-2xl transition-all group active:scale-[0.98] outline-none focus:ring-2 focus:ring-blue-500"
                                >
                                    <span className="font-bold text-gray-800 text-xl">{v.name}</span>
                                    <span className="font-black text-blue-600 text-xl group-hover:text-blue-700">PKR {v.price}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Deal Details Modal */}
            {selectedDealForDetails && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 relative">
                        <button onClick={() => setSelectedDealForDetails(null)} className="absolute top-4 right-4 p-2 bg-transparent text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition-colors outline-none"><X size={20}/></button>
                        <div className="text-center mb-6">
                            <h2 className="text-2xl font-black text-gray-900 leading-tight pr-4">{selectedDealForDetails.name}</h2>
                            <p className="text-sm font-semibold text-purple-600 mt-1 uppercase tracking-wide">Deal Contents</p>
                        </div>
                        <div className="space-y-2">
                            {selectedDealForDetails.dealItems?.map((item, idx) => (
                                <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl border border-gray-100">
                                    <span className="font-bold text-gray-800">{item.name}</span>
                                    <span className="text-sm font-black text-gray-500 bg-white px-2 py-1 rounded-md shadow-sm">x{item.quantity}</span>
                                </div>
                            ))}
                        </div>
                        <button
                            onClick={() => { setSelectedDealForDetails(null); handleProductClick(selectedDealForDetails); }}
                            className="w-full mt-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors"
                        >
                            Add to Order
                        </button>
                    </div>
                </div>
            )}
            
            {/* Deal Choice Modal */}
            {selectedDealForChoices && (
                <DealChoiceModal
                    deal={selectedDealForChoices}
                    allProducts={products}
                    onClose={() => setSelectedDealForChoices(null)}
                    onComplete={(choices) => handleDealChoicesComplete(selectedDealForChoices, choices)}
                />
            )}

            {/* Delivery Order Manage Modal */}
            {deliveryModalOrder && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md p-6 relative">
                        <button onClick={() => setDeliveryModalOrder(null)} className="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition-colors outline-none"><X size={20} /></button>
                        <div className="mb-5">
                            <p className="text-[10px] font-black uppercase tracking-widest text-blue-600">Delivery Order</p>
                            <h2 className="text-2xl font-black text-gray-900">#{deliveryModalOrder.id}</h2>
                            <p className="text-sm font-semibold text-gray-600 mt-1">
                                {deliveryModalOrder.customerName || '—'} • {deliveryModalOrder.customerPhone || '—'}
                            </p>
                            <p className="text-xs text-gray-500 mt-1">{deliveryModalOrder.customerAddress}</p>
                            <p className="text-lg font-black text-gray-900 mt-3">PKR {Number(deliveryModalOrder.total).toFixed(0)}</p>
                        </div>

                        {deliveryModalOrder.status === 'Pending' && (
                            <div>
                                <h3 className="font-bold text-gray-700 text-xs tracking-widest uppercase mb-3">Assign Rider</h3>
                                {riders.length === 0 ? (
                                    <p className="text-sm text-gray-500 italic p-3 text-center bg-gray-50 rounded-xl">No available riders. Check admin panel or wait for sync.</p>
                                ) : (
                                    <div className="space-y-2 max-h-56 overflow-y-auto">
                                        {riders.map(r => (
                                            <button
                                                key={r.id}
                                                onClick={() => assignRider(deliveryModalOrder.id, r.name)}
                                                className="w-full p-3 bg-white border border-gray-200 rounded-2xl hover:border-blue-500 hover:bg-blue-50 flex justify-between items-center font-medium"
                                            >
                                                <div className="flex items-center space-x-3">
                                                    <Truck size={18} className="text-gray-400" />
                                                    <span>{r.name}</span>
                                                </div>
                                                <span className="text-blue-600 font-bold text-xs">ASSIGN</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        <button
                            onClick={() => markDeliveryComplete(deliveryModalOrder.id)}
                            className="w-full mt-5 bg-green-500 hover:bg-green-600 text-white font-bold py-3 rounded-2xl shadow-lg flex items-center justify-center space-x-2 transition-transform active:scale-95"
                        >
                            <CheckCircle2 size={20} />
                            <span>Mark Delivered</span>
                        </button>
                    </div>
                </div>
            )}

            {/* Receipt Preview Modal */}
            {/* COLUMN 3: PENDING ORDERS QUEUE */}
            <div className="w-[400px] h-full bg-white border-l border-gray-200 flex flex-col shadow-xl shrink-0 relative z-10">
                <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-white sticky top-0 z-10">
                    <div className="flex items-center space-x-3">
                        <div className="p-2.5 bg-amber-100 text-amber-600 rounded-xl">
                            <Clock size={20} />
                        </div>
                        <h2 className="text-lg font-bold text-gray-900">Pending Orders</h2>
                    </div>
                    <span className="bg-amber-100 text-amber-700 text-xs font-black px-2.5 py-1 rounded-lg">
                        {pendingOrders.length}
                    </span>
                </div>

                <div className="p-4 border-b border-gray-50">
                    <div className="relative">
                        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Search by ID, Table, or Customer..."
                            value={queueSearch}
                            onChange={(e) => setQueueSearch(e.target.value)}
                            className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-xl text-xs outline-none focus:border-blue-500 transition-all font-bold"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50/30">
                    {pendingOrders
                        .filter(order => {
                            const term = queueSearch.toLowerCase();
                            return (order.id || '').toLowerCase().includes(term) || 
                                   (order.tableNo || '').toLowerCase().includes(term) ||
                                   (order.customerName || '').toLowerCase().includes(term);
                        })
                        .sort((a, b) => {
                            const parseDate = (s: string) => new Date(s && s.includes('T') ? s : (s || '').replace(' ', 'T') + 'Z');
                            const diff = parseDate(b.createdAt).getTime() - parseDate(a.createdAt).getTime();
                            if (diff !== 0) return diff;
                            return (b.dailyOrderNumber || 0) - (a.dailyOrderNumber || 0);
                        })
                        .map(order => (
                            <div
                                key={order.id}
                                onClick={() => handlePendingOrderClick(order)}
                                className={`group p-4 rounded-2xl border-2 transition-all cursor-pointer relative overflow-hidden ${
                                    activePendingOrderId === order.id 
                                    ? 'bg-blue-600 border-blue-600 shadow-lg scale-[1.02]' 
                                    : 'bg-white border-gray-100 hover:border-blue-200 hover:shadow-md'
                                }`}
                            >
                                <div className="flex justify-between items-start mb-2 relative z-10">
                                    <div>
                                        <p className={`text-[10px] font-black uppercase tracking-widest ${activePendingOrderId === order.id ? 'text-blue-100' : 'text-gray-400'}`}>
                                            Order #{order.id}
                                        </p>
                                        <h3 className={`font-black text-lg ${activePendingOrderId === order.id ? 'text-white' : 'text-gray-900'}`}>
                                            PKR {Number(order.total).toFixed(0)}
                                        </h3>
                                    </div>
                                    <div className={`px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-tighter ${
                                        activePendingOrderId === order.id ? 'bg-white/20 text-white' : 'bg-amber-100 text-amber-700'
                                    }`}>
                                        {order.orderType === 'DINE_IN'
                                            ? `TABLE ${order.tableNo || '--'}`
                                            : order.customerAddress
                                                ? 'DELIVERY'
                                                : 'TAKE AWAY'}
                                    </div>
                                </div>

                                {order.customerName && (
                                    <p className={`text-xs font-bold mb-2 flex items-center ${activePendingOrderId === order.id ? 'text-blue-50' : 'text-gray-500'}`}>
                                        <span className="opacity-60 mr-1 italic">Customer:</span> {order.customerName}
                                    </p>
                                )}

                                <div className={`text-[10px] font-bold py-2 border-t mt-2 ${activePendingOrderId === order.id ? 'border-white/20 text-blue-100' : 'border-gray-50 text-gray-400'}`}>
                                    {new Date(order.createdAt && order.createdAt.includes('T') ? order.createdAt : (order.createdAt || '').replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} • {order.cashierName}
                                </div>

                                {activePendingOrderId === order.id && (
                                    <div className="absolute top-0 right-0 p-2 text-white/50">
                                        <CheckCircle2 size={16} />
                                    </div>
                                )}
                            </div>
                        ))}
                    
                    {pendingOrders.length === 0 && (
                        <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-40">
                            <Clock size={48} className="text-gray-300 mb-4" />
                            <p className="text-sm font-bold text-gray-400">No pending orders</p>
                        </div>
                    )}
                </div>
            </div>

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

function DealChoiceModal({ deal, allProducts, onClose, onComplete }: { deal: Product; allProducts: Product[]; onClose: () => void; onComplete: (choices: any[]) => void }) {
    const itemsToSelect = deal.dealItems?.filter(di => {
        const subP = allProducts.find(p => p.id === di.productId);
        return subP && subP.variants && subP.variants.length > 0 && !di.variantId;
    }) || [];

    const [currentStep, setCurrentStep] = useState(0);
    const [selections, setSelections] = useState<any[]>([]);

    const currentItem = itemsToSelect[currentStep];
    const currentProduct = currentItem ? allProducts.find(p => p.id === currentItem.productId) : null;

    const handleSelectVariant = (variant: any) => {
        const newSelections = [...selections, {
            productId: currentProduct!.id,
            productName: currentProduct!.name,
            variantId: variant.id,
            variantName: variant.name
        }];

        if (currentStep < itemsToSelect.length - 1) {
            setSelections(newSelections);
            setCurrentStep(currentStep + 1);
        } else {
            onComplete(newSelections);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-6 relative">
                <button onClick={onClose} className="absolute top-4 right-4 p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-full transition-colors"><X size={20}/></button>
                
                <div className="text-center mb-6">
                    <p className="text-[10px] bg-purple-100 text-purple-700 font-black px-2 py-1 rounded-md inline-block uppercase tracking-widest mb-2">Combo Choice Required</p>
                    <h2 className="text-2xl font-black text-gray-900 leading-tight">{deal.name}</h2>
                    <div className="flex justify-center space-x-1 mt-3">
                        {itemsToSelect.map((_, i) => (
                            <div key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i === currentStep ? 'w-8 bg-blue-600' : (i < currentStep ? 'w-3 bg-green-500' : 'w-3 bg-gray-200')}`} />
                        ))}
                    </div>
                </div>

                {currentProduct && (
                    <div className="animate-in slide-in-from-right-4 duration-300">
                        <p className="text-sm font-bold text-gray-500 mb-4 uppercase text-center">Step {currentStep + 1}: Choose {currentProduct.name}</p>
                        <div className="space-y-2">
                            {currentProduct.variants?.map(v => (
                                <button
                                    key={v.id}
                                    onClick={() => handleSelectVariant(v)}
                                    className="w-full flex justify-between items-center p-4 bg-white border border-gray-200 hover:border-blue-500 hover:bg-blue-50 rounded-2xl transition-all group active:scale-[0.98] outline-none"
                                >
                                    <span className="font-bold text-gray-800 text-lg">{v.name}</span>
                                    <Plus size={18} className="text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity" />
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
