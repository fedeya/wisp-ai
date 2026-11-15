import { createRoot } from 'react-dom/client';
import UpdaterWindow from './components/updates/UpdaterWindow';
import './style.css';

createRoot(document.getElementById('app')!).render(<UpdaterWindow />);
