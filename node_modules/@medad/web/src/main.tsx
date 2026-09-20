import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createHashRouter, Navigate } from 'react-router-dom';
import './theme.css';
import { AuthProvider, Login, useAuth } from './auth.js';
import { Shell } from './Shell.js';
import { BrandLoader, PageLoader, TopLoader } from './Loader.js';
import { Dashboard } from './pages/Dashboard.js';
import { Pos } from './pages/Pos.js';
import { Sales } from './pages/Sales.js';
import { Inventory } from './pages/Inventory.js';
import { Purchases } from './pages/Purchases.js';
import { Parties } from './pages/Parties.js';
import { LedgerPage } from './pages/Ledger.js';
import { Counts } from './pages/Counts.js';
import { Transfers } from './pages/Transfers.js';
import { Tasks } from './pages/Tasks.js';
import { Labels } from './pages/Labels.js';
import { Sync } from './pages/Sync.js';
import { Settings } from './pages/Settings.js';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return <PageLoader text="جارٍ التحقق من الجلسة..." />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

const router = createHashRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <RequireAuth><Shell /></RequireAuth>,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'pos', element: <Pos /> },
      { path: 'sales', element: <Sales /> },
      { path: 'inventory', element: <Inventory /> },
      { path: 'purchases', element: <Purchases /> },
      { path: 'parties', element: <Parties /> },
      { path: 'ledger', element: <LedgerPage /> },
      { path: 'counts', element: <Counts /> },
      { path: 'transfers', element: <Transfers /> },
      { path: 'tasks', element: <Tasks /> },
      { path: 'labels', element: <Labels /> },
      { path: 'sync', element: <Sync /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);

function App() {
  const [booted, setBooted] = useState(() => sessionStorage.getItem('medad_booted') === '1');
  if (!booted) {
    return (
      <BrandLoader
        onDone={() => {
          sessionStorage.setItem('medad_booted', '1');
          setBooted(true);
        }}
      />
    );
  }
  return (
    <>
      <TopLoader />
      <RouterProvider router={router} fallbackElement={<PageLoader />} />
    </>
  );
}
