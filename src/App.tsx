import { HashRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import POS from './pages/POS';
import Delivery from './pages/Delivery';
import OrderHistory from './pages/OrderHistory';
import Settings from './pages/Settings';
import Login from './pages/Login';
import DeliveryPOS from './pages/DeliveryPOS';
import { AuthProvider, useAuth } from './context/AuthContext';

function AppRoutes() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex w-screen h-screen bg-gray-900 items-center justify-center">
        <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  // F38: Role-based routing
  const posRole = user.posRole;

  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          {posRole === 'POS_DELIVERY' ? (
            <>
              <Route index element={<DeliveryPOS />} />
              <Route path="history" element={<OrderHistory />} />
              <Route path="settings" element={<Settings />} />
            </>
          ) : (
            <>
              <Route index element={<POS />} />
              <Route path="history" element={<OrderHistory />} />
              <Route path="delivery" element={<Delivery />} />
              <Route path="settings" element={<Settings />} />
            </>
          )}
        </Route>
      </Routes>
    </HashRouter>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
