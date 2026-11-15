import {
  AnimatePresence,
  domAnimation,
  LazyMotion,
  useIsPresent,
  useReducedMotion,
} from 'motion/react';
import * as m from 'motion/react-m';
import { Button } from './Controls';
import Icon from './Icon';

type FeedbackToastProps = {
  message: string;
  failed: boolean;
  onDismiss: () => void;
};

function Toast({ message, failed, onDismiss }: FeedbackToastProps) {
  const isPresent = useIsPresent();
  const reduceMotion = useReducedMotion();

  return (
    <m.div
      className={`notification gap-[12px] border border-solid border-[#40695e] px-[15px] py-[13px] fixed right-[24px] bottom-[22px] z-[30] flex items-center w-[max-content] max-w-[min(580px,_calc(100vw_-_48px))] rounded-[12px] [background:#20352f] text-[#d5eee4] [box-shadow:0_8px_32px_#0005] text-[13px] leading-[1.5] [&_>_svg]:shrink-0 [&.error]:border-[#89564c] [&.error]:[background:#382824] [&.error]:text-[#ffd2c8]${failed ? ' error' : ''}`}
      role="status"
      aria-live="polite"
      aria-hidden={!isPresent}
      inert={!isPresent}
      initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: 'easeOut' } }}
      exit={{
        opacity: 0,
        y: reduceMotion ? 0 : 6,
        transition: { duration: 0.16, ease: 'easeIn' },
      }}
    >
      <Icon name={failed ? 'logs' : 'check'} size={18} />
      <span className="[overflow-wrap:anywhere]">{message}</span>
      <Button
        intent="quiet"
        size="icon"
        className="shrink-0"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <Icon name="close" size={16} />
      </Button>
    </m.div>
  );
}

export default function FeedbackToast(props: FeedbackToastProps) {
  return (
    <LazyMotion features={domAnimation}>
      <AnimatePresence>
        {props.message ? <Toast key="feedback" {...props} /> : null}
      </AnimatePresence>
    </LazyMotion>
  );
}
