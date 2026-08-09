import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import BrandBackground from './components/BrandBackground.jsx';
import './index.css';

const savedTheme = window.localStorage.getItem('megabattle-theme');
const telegramTheme = (window as any).Telegram?.WebApp?.colorScheme;
document.documentElement.classList.toggle(
  'dark-theme',
  savedTheme ? savedTheme === 'dark' : telegramTheme === 'dark',
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrandBackground />
    <div className="brand-app-layer">
      <App />
    </div>
  </StrictMode>,
);
