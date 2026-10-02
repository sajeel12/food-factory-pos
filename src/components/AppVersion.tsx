import { useEffect, useState } from 'react';

const ipcRenderer = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;

// Installed app version (from the release tag), so staff can tell which build a terminal runs
export default function AppVersion({ className = '' }: { className?: string }) {
    const [version, setVersion] = useState<string | null>(null);

    useEffect(() => {
        if (!ipcRenderer) return;
        ipcRenderer.invoke('get-app-version')
            .then((v: string) => setVersion(v))
            .catch(() => { });
    }, []);

    if (!version) return null;
    return <span className={className}>v{version}</span>;
}
