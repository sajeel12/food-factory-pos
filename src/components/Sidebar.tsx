import { Link, useLocation } from 'react-router-dom';
import { Home, Truck, Settings, LogOut, Coffee, History } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const allNavItems = [
    { path: '/', label: 'POS Terminal', icon: Home, roles: ['POS_COUNTER', null] },
    { path: '/', label: 'Delivery POS', icon: Truck, roles: ['POS_DELIVERY'] },
    { path: '/history', label: 'History', icon: History, roles: ['POS_COUNTER', 'POS_DELIVERY', null] },
    { path: '/delivery', label: 'Delivery Hub', icon: Truck, roles: ['POS_COUNTER', null] },
    { path: '/settings', label: 'Settings', icon: Settings, roles: ['POS_COUNTER', 'POS_DELIVERY', null] },
];

export default function Sidebar() {
    const location = useLocation();
    const { user, logout } = useAuth();

    const posRole = user?.posRole || null;

    // Filter nav items by the user's posRole
    const navItems = allNavItems.filter(item => item.roles.includes(posRole));

    const isActive = (path: string) => location.pathname === path;

    return (
        <aside
            className="w-24 bg-gray-900 flex-shrink-0 text-white min-h-screen border-r border-gray-800 shadow-xl z-20 flex flex-col items-center py-6"
        >
            <div className="w-14 h-14 bg-gradient-to-tr from-blue-600 to-blue-400 rounded-2xl flex items-center justify-center text-white font-bold shadow-lg mb-8">
                <Coffee size={28} />
            </div>

            <nav className="flex-1 space-y-6 w-full px-4 text-center">
                {navItems.map((item) => {
                    const Icon = item.icon;
                    const active = isActive(item.path);
                    return (
                        <Link
                            key={item.path + item.label}
                            to={item.path}
                            className={`flex flex-col items-center justify-center space-y-2 p-3 rounded-2xl group relative ${active
                                ? 'bg-blue-600 shadow-md text-white'
                                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                                }`}
                        >
                            <div className="relative z-10 flex flex-col items-center">
                                <Icon size={24} className={active ? 'text-white' : 'text-gray-400 group-hover:text-white'} />
                                <span className="text-[10px] font-semibold mt-1 hidden lg:block uppercase tracking-wider">{item.label}</span>
                            </div>
                        </Link>
                    );
                })}
            </nav>

            <div className="mt-auto px-4 w-full">
                <button
                    onClick={logout}
                    className="w-full flex flex-col items-center p-3 rounded-2xl text-red-400 hover:bg-red-500/10 hover:text-red-500"
                >
                    <LogOut size={24} />
                    <span className="text-[10px] font-semibold mt-1 uppercase tracking-wider">Logout</span>
                </button>
            </div>
        </aside>
    );
}
