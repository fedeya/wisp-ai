import ArrowLeft from 'lucide-react/icons/arrow-left';
import ArrowRight from 'lucide-react/icons/arrow-right';
import Brain from 'lucide-react/icons/brain';
import Check from 'lucide-react/icons/check';
import ChevronDown from 'lucide-react/icons/chevron-down';
import ChevronRight from 'lucide-react/icons/chevron-right';
import Copy from 'lucide-react/icons/copy';
import Database from 'lucide-react/icons/database';
import Folder from 'lucide-react/icons/folder';
import Globe from 'lucide-react/icons/globe';
import House from 'lucide-react/icons/house';
import Link2 from 'lucide-react/icons/link-2';
import PanelsTopLeft from 'lucide-react/icons/panels-top-left';
import Plug from 'lucide-react/icons/plug';
import Plus from 'lucide-react/icons/plus';
import Puzzle from 'lucide-react/icons/puzzle';
import RefreshCw from 'lucide-react/icons/refresh-cw';
import ScrollText from 'lucide-react/icons/scroll-text';
import Search from 'lucide-react/icons/search';
import Server from 'lucide-react/icons/server';
import Settings from 'lucide-react/icons/settings';
import Sparkles from 'lucide-react/icons/sparkles';
import SquareTerminal from 'lucide-react/icons/square-terminal';
import Workflow from 'lucide-react/icons/workflow';
import X from 'lucide-react/icons/x';

const icons = {
  arrow: ArrowRight,
  back: ArrowLeft,
  brain: Brain,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  close: X,
  copy: Copy,
  database: Database,
  folder: Folder,
  globe: Globe,
  home: House,
  link: Link2,
  logs: SquareTerminal,
  panel: PanelsTopLeft,
  plug: Plug,
  plus: Plus,
  puzzle: Puzzle,
  refresh: RefreshCw,
  scrollText: ScrollText,
  search: Search,
  server: Server,
  settings: Settings,
  spark: Sparkles,
  workflow: Workflow,
};

export default function Icon({ name, size = 20 }: { name: keyof typeof icons; size?: number }) {
  const Glyph = icons[name];
  return <Glyph size={size} strokeWidth={1.6} aria-hidden="true" />;
}
