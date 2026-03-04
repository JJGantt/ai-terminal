import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import App from './App';
import './index.css';

console.log('[renderer] mounting');
createRoot(document.getElementById('root')!).render(createElement(App));
