import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ipcRenderer = (window as any).require?.('electron')?.ipcRenderer;

export interface PosUser {
    id: string;
    username: string;
    role: string;
    posRole: string | null;
    branchId: string | null;
    branchName: string | null;
}

interface AuthContextType {
    user: PosUser | null;
    token: string | null;
    loading: boolean;
    login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
    user: null,
    token: null,
    loading: true,
    login: async () => ({ success: false }),
    logout: async () => { },
});

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<PosUser | null>(null);
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // Check for cached session on mount
        async function loadSession() {
            if (!ipcRenderer) {
                setLoading(false);
                return;
            }
            try {
                const settings = await ipcRenderer.invoke('get-settings', ['POS_SESSION_USER', 'POS_SESSION_TOKEN']);
                const userSetting = settings.find((s: { key: string; value: string }) => s.key === 'POS_SESSION_USER');
                const tokenSetting = settings.find((s: { key: string; value: string }) => s.key === 'POS_SESSION_TOKEN');

                if (userSetting?.value && tokenSetting?.value) {
                    setUser(JSON.parse(userSetting.value));
                    setToken(tokenSetting.value);
                }
            } catch (e) {
                console.error('Failed to load cached session:', e);
            }
            setLoading(false);
        }
        loadSession();
    }, []);

    const login = async (username: string, password: string) => {
        try {
            const response = await fetch(`${import.meta.env.VITE_API_URL || 'https://food-factory-cloud-backend.onrender.com'}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                return { success: false, error: errData.message || 'Login failed' };
            }

            const data = await response.json();
            setUser(data.user);
            setToken(data.token);

            // Cache the session in SQLite
            if (ipcRenderer) {
                await ipcRenderer.invoke('save-settings', [
                    { key: 'POS_SESSION_USER', value: JSON.stringify(data.user) },
                    { key: 'POS_SESSION_TOKEN', value: data.token },
                ]);
            }

            return { success: true };
        } catch {
            return { success: false, error: 'Cannot reach server. Check your connection.' };
        }
    };

    const logout = async () => {
        setUser(null);
        setToken(null);
        if (ipcRenderer) {
            await ipcRenderer.invoke('save-settings', [
                { key: 'POS_SESSION_USER', value: '' },
                { key: 'POS_SESSION_TOKEN', value: '' },
            ]);
        }
    };

    return (
        <AuthContext.Provider value={{ user, token, loading, login, logout }}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    return useContext(AuthContext);
}
