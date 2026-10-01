import React from 'react';
import { createRoot } from 'react-dom/client';
import './crt.css';
import App from './App.jsx';
import PWAUpdateBanner from './components/PWAUpdateBanner.jsx';

createRoot(document.getElementById('root')).render(
  <>
    <App />
    <PWAUpdateBanner />
  </>
);
