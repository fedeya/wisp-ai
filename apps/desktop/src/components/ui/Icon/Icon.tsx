import ArrowRight from 'lucide-react/icons/arrow-right';
import Check from 'lucide-react/icons/check';
import ChevronDown from 'lucide-react/icons/chevron-down';
import Copy from 'lucide-react/icons/copy';
import Folder from 'lucide-react/icons/folder';
import House from 'lucide-react/icons/house';
import Link2 from 'lucide-react/icons/link-2';
import PanelsTopLeft from 'lucide-react/icons/panels-top-left';
import Plus from 'lucide-react/icons/plus';
import RefreshCw from 'lucide-react/icons/refresh-cw';
import Sparkles from 'lucide-react/icons/sparkles';
import SquareTerminal from 'lucide-react/icons/square-terminal';
import Wrench from 'lucide-react/icons/wrench';
import X from 'lucide-react/icons/x';

const icons = {
  arrow: ArrowRight,
  check: Check,
  chevronDown: ChevronDown,
  close: X,
  copy: Copy,
  folder: Folder,
  home: House,
  link: Link2,
  logs: SquareTerminal,
  panel: PanelsTopLeft,
  plus: Plus,
  refresh: RefreshCw,
  spark: Sparkles,
  tools: Wrench,
};

export default function Icon({ name, size = 20 }: { name: keyof typeof icons; size?: number }) {
  const Glyph = icons[name];
  return <Glyph size={size} strokeWidth={1.6} aria-hidden="true" />;
}
