import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@shopify/polaris/build/esm/styles.css';

const container = document.getElementById('app');
if (container) {
  const root = createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

// Export for Shopify extension system
export default App;
