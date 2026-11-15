import { createRoot } from 'react-dom/client';
import App, { createDesktopRouter } from './App';
import './style.css';

const router = createDesktopRouter();
createRoot(document.getElementById('app')!).render(<App router={router} />);
