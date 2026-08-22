import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/base.css';
import App from './App';
import { MiseAJour } from './components/MiseAJour';

const racine = document.getElementById('racine');
if (!racine) throw new Error('Élément #racine introuvable');

createRoot(racine).render(
  <StrictMode>
    {/* Above the app: a waiting update must be visible from any screen. */}
    <MiseAJour />
    <App />
  </StrictMode>
);
