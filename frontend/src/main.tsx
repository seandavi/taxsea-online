import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import App from './App';
import { initAnalytics } from './analytics';
import './index.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root element not found');
}

initAnalytics();

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
