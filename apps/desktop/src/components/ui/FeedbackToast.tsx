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
      className={`notification${failed ? ' error' : ''} fixed right-4 bottom-4 z-[30] flex w-[360px] max-w-[calc(100vw_-_32px)] items-start gap-3 rounded-[6px] border border-solid border-border bg-raised py-2.5 pr-2 pl-3.5 text-base leading-[1.45] text-foreground shadow-floating`}
      role="status"
      aria-live="polite"
      aria-hidden={!isPresent}
      inert={!isPresent}
      initial={{ opacity: 0, x: reduceMotion ? 0 : 16 }}
      animate={{ opacity: 1, x: 0, transition: { duration: 0.15, ease: 'easeOut' } }}
      exit={{
        opacity: 0,
        x: reduceMotion ? 0 : 16,
        transition: { duration: 0.12, ease: 'easeIn' },
      }}
    >
      <span className={`mt-[3px] flex shrink-0 ${failed ? 'text-danger' : 'text-accent'}`}>
        <Icon name={failed ? 'circleAlert' : 'circleCheck'} size={16} />
      </span>
      <span className="min-w-0 flex-1 py-px [overflow-wrap:anywhere]">{message}</span>
      <Button
        intent="quiet"
        size="icon"
        className="-my-1 shrink-0 text-muted enabled:hover:text-foreground"
        aria-label="Dismiss notification"
        onClick={onDismiss}
      >
        <Icon name="close" size={14} />
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
