import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Bundled (not CDN) so the text layer renders identically offline, in preview and export.
import '@fontsource/inter/800.css';
import '@fontsource/michroma/400.css';
import '@fontsource/space-mono/700.css';
import App from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
