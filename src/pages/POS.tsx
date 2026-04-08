import { useState, useEffect } from 'react';
import { Search, ShoppingBag, Plus, Minus, Trash2, Printer, CreditCard, X, Loader2, Truck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

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

export default function POS() {
    const { user } = useAuth();
    const isDeliveryRole = user?.posRole === 'POS_DELIVERY';

    const [activeCategory, setActiveCategory] = useState('All');
    const [search, setSearch] = useState('');
    const [cart, setCart] = useState<{ uniqueId: string; id: string; name: string; price: number; qty: number; variantId?: string; variantName?: string }[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [selectedProductForVariant, setSelectedProductForVariant] = useState<Product | null>(null);
    const [selectedDealForDetails, setSelectedDealForDetails] = useState<Product | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);

    const [checkoutMode, setCheckoutMode] = useState<'Cash' | 'Card' | 'Delivery' | null>(null);
    const [tendered, setTendered] = useState<string>('');
    const [cardStatus, setCardStatus] = useState<'waiting' | 'processing' | 'approved' | 'declined'>('waiting');

    const [deliveryInfo, setDeliveryInfo] = useState({ name: '', phone: '', address: '' });
    const [customerSuggestions, setCustomerSuggestions] = useState<{ id: string; name: string; phone: string; address: string | null; loyaltyPoints: number }[]>([]);

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

        const handleSync = () => loadProducts();
        window.addEventListener('sync-completed', handleSync);
        return () => window.removeEventListener('sync-completed', handleSync);
    }, [user?.branchId]);

    const filteredProducts = products.filter(p =>
        (activeCategory === 'All' || p.category === activeCategory) &&
        p.name.toLowerCase().includes(search.toLowerCase())
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
        }));
    };

    // const removeItem = (id: string) => {
    //     setCart(prev => prev.filter(item => item.id !== id));
    // };

    const subtotal = cart.reduce((sum, item) => sum + (Number(item.price) * Number(item.qty)), 0);
    const tax = 0; // Removed implicit 16% GST as it causes total mismatch
    const total = subtotal + tax;

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
                const orderId = generateShortId();
                const payload = {
                    id: orderId,
                    total: total,
                    paymentMethod: paymentMethod === 'Delivery' ? 'CASH' : paymentMethod, // Default delivery to cash
                    tenderedAmount: paymentMethod === 'Cash' ? Number(tendered) || total : total,
                    status: paymentMethod === 'Delivery' ? 'Pending' : 'Completed',
                    customerName: paymentMethod === 'Delivery' ? deliveryInfo.name : null,
                    customerPhone: paymentMethod === 'Delivery' ? deliveryInfo.phone : null,
                    customerAddress: paymentMethod === 'Delivery' ? deliveryInfo.address : null,
                    items: cart.map(item => ({
                        id: 'ITM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
                        orderId: orderId,
                        productId: item.id,
                        variantId: item.variantId || null,
                        variantName: item.variantName || null,
                        quantity: item.qty,
                        subtotal: item.price * item.qty
                    }))
                };

                await ipcRenderer.invoke('create-order', payload);
                if (paymentMethod === 'Cash') {
                    await ipcRenderer.invoke('open-cash-drawer');
                }
                await ipcRenderer.invoke('print-receipt', payload);
                await ipcRenderer.invoke('print-kitchen', payload);

                setCart([]);
                setCheckoutMode(null);
                setTendered('');
                setCardStatus('waiting');
                setDeliveryInfo({ name: '', phone: '', address: '' });
            } catch (err) {
                console.error('Checkout failed', err);
                alert('Order Failed processing.');
            }
        }
        setIsProcessing(false);
    };

    const processCard = () => {
        setCardStatus('processing');
        setTimeout(() => {
            setCardStatus('approved');
            setTimeout(() => {
                handleCheckout('Card');
            }, 1000);
        }, 2000);
    };

    return (
        <div className="flex w-full h-full bg-gray-50">
            <div className="flex-1 flex flex-col p-6 overflow-hidden">
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
                        <div key={item.uniqueId} className="bg-white p-3 rounded-2xl border border-gray-100 shadow-sm flex flex-col">
                            <div className="flex justify-between items-start mb-3">
                                <span className="font-bold text-gray-800 text-sm w-3/4 leading-snug">
                                    {item.name}
                                    {item.variantName && (
                                        <div className="text-xs text-purple-600 bg-purple-50 inline-block px-2 py-0.5 rounded-md mt-1 font-semibold ml-2">
                                            {item.variantName}
                                        </div>
                                    )}
                                </span>
                                <span className="font-bold text-gray-900 text-sm">PKR {item.price * item.qty}</span>
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

                <div className="bg-white border-t border-gray-200 p-5 rounded-t-3xl shadow-[0_-10px_40px_-15px_rgba(0,0,0,0.1)] relative z-20">
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
                                    <span className="text-xs">Cash</span>
                                </button>
                                <button
                                    onClick={() => setCheckoutMode('Card')}
                                    disabled={cart.length === 0 || isProcessing}
                                    className="flex flex-col items-center justify-center py-4 rounded-2xl font-bold bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors"
                                >
                                    <CreditCard size={20} className="mb-1" />
                                    <span className="text-xs">Card</span>
                                </button>
                            </>
                        )}
                        <button
                            onClick={() => setCheckoutMode('Delivery')}
                            disabled={cart.length === 0 || isProcessing}
                            className={`flex flex-col items-center justify-center py-4 rounded-2xl font-bold transition-colors ${isDeliveryRole ? 'col-span-3 bg-amber-500 text-white hover:bg-amber-600 shadow-md' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}
                        >
                            <Truck size={20} className="mb-1" />
                            <span className="text-xs">{isDeliveryRole ? 'Place Delivery Order' : 'Delivery'}</span>
                        </button>
                    </div>
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

            {/* Card Modal (Stub) */}
            {checkoutMode === 'Card' && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm p-8 text-center">
                        {cardStatus === 'waiting' ? (
                            <>
                                <CreditCard size={48} className="mx-auto text-blue-600 mb-4" />
                                <h2 className="text-2xl font-bold mb-8">Swipe Card</h2>
                                <button onClick={processCard} className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold">Simulate Pay</button>
                            </>
                        ) : (
                            <div className="py-12">
                                <Loader2 size={48} className="mx-auto animate-spin text-blue-600 mb-4" />
                                <p className="font-bold">Processing...</p>
                            </div>
                        )}
                        <button onClick={() => setCheckoutMode(null)} className="mt-4 text-gray-500">Cancel</button>
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
                            <div className="pt-4">
                                <p className="text-center font-bold text-gray-500 mb-4 tracking-wide uppercase text-xs">Total: PKR {total.toFixed(0)}</p>
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
        </div>
    );
}
