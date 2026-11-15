import ArrowLeft from 'lucide-react/icons/arrow-left';
import ArrowRight from 'lucide-react/icons/arrow-right';
import ArrowUpRight from 'lucide-react/icons/arrow-up-right';
import Check from 'lucide-react/icons/check';
import ChevronRight from 'lucide-react/icons/chevron-right';
import CornerDownLeft from 'lucide-react/icons/corner-down-left';
import Download from 'lucide-react/icons/download';
import Globe from 'lucide-react/icons/globe';
import Heart from 'lucide-react/icons/heart';
import Menu from 'lucide-react/icons/menu';
import MessageSquareText from 'lucide-react/icons/message-square-text';
import Minus from 'lucide-react/icons/minus';
import MonitorCheck from 'lucide-react/icons/monitor-check';
import Pause from 'lucide-react/icons/pause';
import Play from 'lucide-react/icons/play';
import Plus from 'lucide-react/icons/plus';
import Repeat from 'lucide-react/icons/repeat';
import X from 'lucide-react/icons/x';
import type { ComponentProps, CSSProperties } from 'react';

function WindowsLogo({ size, ...props }: ComponentProps<'svg'> & { size: number }) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 5 7-1v7H3V5Zm10-1 8-1v8h-8V4ZM3 14h7v7l-7-1v-6Zm10 0h8v9l-8-1v-8Z" />
    </svg>
  );
}

const icons = {
  arrow: ArrowRight,
  'arrow-left': ArrowLeft,
  chat: MessageSquareText,
  check: Check,
  'chevron-right': ChevronRight,
  close: X,
  connection: MonitorCheck,
  download: Download,
  enter: CornerDownLeft,
  external: ArrowUpRight,
  globe: Globe,
  heart: Heart,
  menu: Menu,
  minus: Minus,
  pause: Pause,
  play: Play,
  plus: Plus,
  repeat: Repeat,
  windows: WindowsLogo,
};

export function Icon({
  name,
  size = 20,
  style,
}: {
  name: keyof typeof icons;
  size?: number;
  style?: CSSProperties;
}) {
  const Glyph = icons[name];
  const filled = name === 'play' || name === 'pause';

  return (
    <Glyph
      size={size}
      strokeWidth={filled ? 0 : 1.5}
      fill={filled ? 'currentColor' : 'none'}
      aria-hidden="true"
      style={style}
    />
  );
}
